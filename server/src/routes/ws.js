'use strict';

const { WebSocketServer } = require('ws');
const db = require('../db');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Active authenticated connections. userId (string) -> WebSocket */
const clients = new Map();

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/**
 * Attach a WebSocket server to an existing HTTP server on the /ws path.
 * @param {import('http').Server} httpServer
 * @returns {WebSocketServer}
 */
function initWebSocket(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('listening', () => {
    console.log('[ws] listening on /ws');
  });

  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    console.log(`[ws] new connection from ${ip}`);

    ws.isAuthenticated = false;
    ws.userId = null;

    ws.on('message', (raw) => handleMessage(ws, raw));

    ws.on('close', (code) => {
      if (ws.userId) {
        // Only remove this socket if it's still the current one for this user
        // (a newer connection may have already replaced it)
        if (clients.get(ws.userId) === ws) {
          clients.delete(ws.userId);
        }
        console.log(`[ws] user ${ws.userId} disconnected (code=${code}, online=${clients.size})`);
      } else {
        console.log(`[ws] unauthenticated client disconnected (code=${code})`);
      }
    });

    ws.on('error', (err) => {
      console.error(`[ws] socket error (user=${ws.userId ?? 'unauthed'}): ${err.message}`);
    });
  });

  wss.on('error', (err) => {
    console.error('[ws] server error:', err.message);
  });

  return wss;
}

// ---------------------------------------------------------------------------
// Message dispatcher
// ---------------------------------------------------------------------------

function handleMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return send(ws, { type: 'error', error: 'Invalid JSON' });
  }

  const { type, payload } = msg;

  if (!type || typeof type !== 'string') {
    return send(ws, { type: 'error', error: 'Missing or invalid message type' });
  }

  // auth is the only message allowed before authentication
  if (type === 'auth') {
    return handleAuth(ws, payload);
  }

  if (!ws.isAuthenticated) {
    return send(ws, {
      type: 'error',
      error: 'Not authenticated — send { type: "auth", payload: { user_id } } first',
    });
  }

  switch (type) {
    case 'track_added':      return handleTrackAdded(ws, payload);
    case 'track_removed':    return handleTrackRemoved(ws, payload);
    case 'tracks_reordered': return handleTracksReordered(ws, payload);
    default:
      send(ws, { type: 'error', error: `Unknown message type: "${type}"` });
  }
}

// ---------------------------------------------------------------------------
// Handler: auth
// ---------------------------------------------------------------------------

/**
 * Payload: { user_id: string, shared_playlist_id?: number }
 */
function handleAuth(ws, payload) {
  const userId = payload?.user_id?.trim?.();
  if (!userId) {
    return send(ws, { type: 'error', error: 'auth requires payload.user_id' });
  }

  // Close any pre-existing connection for this user
  const existing = clients.get(userId);
  if (existing && existing !== ws && existing.readyState === existing.OPEN) {
    console.log(`[ws] replacing stale connection for user ${userId}`);
    existing.close(1000, 'Replaced by newer connection');
  }

  ws.userId          = userId;
  ws.isAuthenticated = true;
  clients.set(userId, ws);

  // Best-effort presence update
  const spId = payload?.shared_playlist_id != null
    ? parseInt(payload.shared_playlist_id, 10)
    : null;

  if (spId && !isNaN(spId)) {
    try {
      db.updateUserLastSeen(userId, spId);
    } catch (err) {
      console.warn(`[ws] updateUserLastSeen failed for ${userId}: ${err.message}`);
    }
  }

  console.log(`[ws] user ${userId} authenticated (${clients.size} online)`);
  send(ws, { type: 'auth_ok', user_id: userId, ts: Date.now() });
}

// ---------------------------------------------------------------------------
// Handler: track_added
// ---------------------------------------------------------------------------

/**
 * Payload: { shared_playlist_id: number, tidal_track_id: string, position?: number }
 */
function handleTrackAdded(ws, payload) {
  const { shared_playlist_id, tidal_track_id, position: rawPos } = payload ?? {};

  if (!shared_playlist_id || !tidal_track_id) {
    return send(ws, {
      type: 'error',
      error: 'track_added requires payload.shared_playlist_id and payload.tidal_track_id',
    });
  }

  const spId = parseInt(shared_playlist_id, 10);
  if (isNaN(spId)) return send(ws, { type: 'error', error: 'Invalid shared_playlist_id' });

  // Resolve position: use provided value, or append after last track
  let position;
  try {
    position = rawPos != null ? parseInt(rawPos, 10) : db.getMaxPosition(spId) + 1;
  } catch (err) {
    console.error(`[ws] getMaxPosition error (playlist=${spId}): ${err.message}`);
    return send(ws, { type: 'error', error: 'Database error' });
  }

  let track;
  try {
    track = db.addTrack(spId, String(tidal_track_id), ws.userId, position);
  } catch (err) {
    console.error(`[ws] addTrack error (playlist=${spId}): ${err.message}`);
    return send(ws, { type: 'error', error: 'Database error' });
  }

  if (!track) {
    // Track already active in this playlist — idempotent, no broadcast needed
    console.log(`[ws] track ${tidal_track_id} already active in playlist ${spId} — skipping`);
    return send(ws, { type: 'track_already_exists', shared_playlist_id: spId, tidal_track_id });
  }

  console.log(`[ws] track_added: ${tidal_track_id} → playlist ${spId} by ${ws.userId} @ pos ${track.position}`);

  const outbound = {
    type:              'track_added',
    shared_playlist_id: spId,
    tidal_track_id:    String(tidal_track_id),
    added_by:          ws.userId,
    position:          track.position,
    timestamp:         Date.now(),
  };

  broadcast(spId, outbound, ws.userId);
  send(ws, { ...outbound, type: 'track_added_ok' });
}

// ---------------------------------------------------------------------------
// Handler: track_removed
// ---------------------------------------------------------------------------

/**
 * Payload: { shared_playlist_id: number, tidal_track_id: string }
 */
function handleTrackRemoved(ws, payload) {
  const { shared_playlist_id, tidal_track_id } = payload ?? {};

  if (!shared_playlist_id || !tidal_track_id) {
    return send(ws, {
      type: 'error',
      error: 'track_removed requires payload.shared_playlist_id and payload.tidal_track_id',
    });
  }

  const spId = parseInt(shared_playlist_id, 10);
  if (isNaN(spId)) return send(ws, { type: 'error', error: 'Invalid shared_playlist_id' });

  let result;
  try {
    result = db.removeTrack(spId, String(tidal_track_id));
  } catch (err) {
    console.error(`[ws] removeTrack error (playlist=${spId}): ${err.message}`);
    return send(ws, { type: 'error', error: 'Database error' });
  }

  if (result.changes === 0) {
    console.log(`[ws] track_removed: ${tidal_track_id} not found/already removed in playlist ${spId}`);
    return send(ws, { type: 'error', error: 'Track not found or already removed' });
  }

  console.log(`[ws] track_removed: ${tidal_track_id} ← playlist ${spId} by ${ws.userId}`);

  const outbound = {
    type:              'track_removed',
    shared_playlist_id: spId,
    tidal_track_id:    String(tidal_track_id),
    removed_by:        ws.userId,
    timestamp:         Date.now(),
  };

  broadcast(spId, outbound, ws.userId);
  send(ws, { ...outbound, type: 'track_removed_ok' });
}

// ---------------------------------------------------------------------------
// Handler: tracks_reordered
// ---------------------------------------------------------------------------

/**
 * Payload: { shared_playlist_id: number, positions: Array<{ tidal_track_id: string, position: number }> }
 */
function handleTracksReordered(ws, payload) {
  const { shared_playlist_id, positions } = payload ?? {};

  if (!shared_playlist_id || !Array.isArray(positions) || positions.length === 0) {
    return send(ws, {
      type: 'error',
      error: 'tracks_reordered requires payload.shared_playlist_id and payload.positions[]',
    });
  }

  const spId = parseInt(shared_playlist_id, 10);
  if (isNaN(spId)) return send(ws, { type: 'error', error: 'Invalid shared_playlist_id' });

  // Validate and normalise each entry before touching the DB
  const normalised = [];
  for (const entry of positions) {
    if (!entry.tidal_track_id || typeof entry.position !== 'number' || !Number.isInteger(entry.position)) {
      return send(ws, {
        type: 'error',
        error: 'Each positions entry needs tidal_track_id (string) and position (integer)',
      });
    }
    normalised.push({ tidalTrackId: String(entry.tidal_track_id), position: entry.position });
  }

  try {
    db.updateTrackPositions(spId, normalised);
  } catch (err) {
    console.error(`[ws] updateTrackPositions error (playlist=${spId}): ${err.message}`);
    return send(ws, { type: 'error', error: 'Database error' });
  }

  console.log(`[ws] tracks_reordered: playlist ${spId} (${positions.length} tracks) by ${ws.userId}`);

  const outbound = {
    type:              'tracks_reordered',
    shared_playlist_id: spId,
    positions,
    reordered_by:      ws.userId,
    timestamp:         Date.now(),
  };

  broadcast(spId, outbound, ws.userId);
  send(ws, { ...outbound, type: 'tracks_reordered_ok' });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Send JSON to a single client. Silently drops if the socket is not open.
 * @param {WebSocket} ws
 * @param {object} obj
 */
function send(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch (err) {
    console.error(`[ws] send error (user=${ws.userId ?? 'unauthed'}): ${err.message}`);
  }
}

/**
 * Broadcast a message to every user linked to sharedPlaylistId, skipping the sender.
 * @param {number}  sharedPlaylistId
 * @param {object}  message
 * @param {string}  excludeUserId
 */
function broadcast(sharedPlaylistId, message, excludeUserId) {
  let links;
  try {
    links = db.getPlaylistLinks(sharedPlaylistId);
  } catch (err) {
    console.error(`[ws] broadcast: getPlaylistLinks error (playlist=${sharedPlaylistId}): ${err.message}`);
    return;
  }

  const json       = JSON.stringify(message);
  const recipients = links.filter((l) => l.user_id !== excludeUserId);
  let   sent       = 0;

  for (const link of recipients) {
    const target = clients.get(link.user_id);
    if (!target || target.readyState !== target.OPEN) {
      console.log(`[ws] broadcast: user ${link.user_id} offline, queuing not supported yet`);
      continue;
    }
    try {
      target.send(json);
      sent++;
    } catch (err) {
      console.error(`[ws] broadcast: send to ${link.user_id} failed: ${err.message}`);
    }
  }

  console.log(
    `[ws] broadcast type=${message.type} playlist=${sharedPlaylistId} ` +
    `→ ${sent}/${recipients.length} recipients (${links.length - recipients.length} excluded)`,
  );
}

module.exports = { initWebSocket, clients };
