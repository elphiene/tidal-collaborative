'use strict';

const { WebSocketServer } = require('ws');
const db = require('../db');

/** Active authenticated connections. userId (string) -> WebSocket */
const clients = new Map();

/**
 * Attach a WebSocket server to an existing HTTP server on the /ws path.
 * @param {import('http').Server} httpServer
 * @param {Function} sessionParser  express-session middleware
 * @returns {WebSocketServer}
 */
function initWebSocket(httpServer, sessionParser) {
  const wss = new WebSocketServer({ noServer: true, path: '/ws' });

  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws') { socket.destroy(); return; }
    sessionParser(req, {}, () => {
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    });
  });

  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    console.log(`[ws] new connection from ${ip}`);

    ws.userId          = req.session?.userId ?? null;
    ws.isAuthenticated = !!ws.userId;

    if (ws.userId) {
      const existing = clients.get(ws.userId);
      if (existing && existing !== ws && existing.readyState === existing.OPEN) {
        console.log(`[ws] replacing stale connection for user ${ws.userId}`);
        existing.close(1000, 'Replaced by newer connection');
      }
      clients.set(ws.userId, ws);

      try {
        const links = db.getUserLinks(ws.userId);
        for (const link of links) db.updateUserLastSeen(ws.userId, link.shared_playlist_id);
      } catch (err) {
        console.warn(`[ws] presence update failed for ${ws.userId}: ${err.message}`);
      }

      console.log(`[ws] user ${ws.userId} connected (${clients.size} online)`);
      send(ws, { type: 'auth_ok', user_id: ws.userId, ts: Date.now() });
    } else {
      console.log(`[ws] unauthenticated connection from ${ip} (no session)`);
    }

    ws.on('message', raw => handleMessage(ws, raw));

    ws.on('close', code => {
      if (ws.userId && clients.get(ws.userId) === ws) {
        clients.delete(ws.userId);
      }
      console.log(`[ws] ${ws.userId ?? 'unauthed'} disconnected (code=${code}, online=${clients.size})`);
    });

    ws.on('error', err => {
      console.error(`[ws] socket error (user=${ws.userId ?? 'unauthed'}): ${err.message}`);
    });
  });

  wss.on('error', err => console.error('[ws] server error:', err.message));

  return wss;
}

// ---------------------------------------------------------------------------
// Message dispatcher — receive-only; only 'auth' message from client is supported
// ---------------------------------------------------------------------------

function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); }
  catch { return send(ws, { type: 'error', error: 'Invalid JSON' }); }

  const { type, payload } = msg;
  if (!type || typeof type !== 'string') {
    return send(ws, { type: 'error', error: 'Missing or invalid message type' });
  }

  if (type === 'auth') return handleAuth(ws, payload);

  // All write operations are now REST-only; WebSocket is receive-only
  send(ws, { type: 'error', error: `"${type}" is not supported over WebSocket — use the REST API` });
}

// ---------------------------------------------------------------------------
// Handler: auth (fallback for clients that need explicit auth after connect)
// ---------------------------------------------------------------------------

function handleAuth(ws, payload) {
  const userId = payload?.user_id?.trim?.();
  if (!userId) return send(ws, { type: 'error', error: 'auth requires payload.user_id' });

  const existing = clients.get(userId);
  if (existing && existing !== ws && existing.readyState === existing.OPEN) {
    console.log(`[ws] replacing stale connection for user ${userId}`);
    existing.close(1000, 'Replaced by newer connection');
  }

  ws.userId          = userId;
  ws.isAuthenticated = true;
  clients.set(userId, ws);

  const playlistIds = Array.isArray(payload?.shared_playlist_ids) ? payload.shared_playlist_ids : [];
  for (const id of playlistIds) {
    const spId = parseInt(id, 10);
    if (spId && !isNaN(spId)) {
      try { db.updateUserLastSeen(userId, spId); }
      catch (err) { console.warn(`[ws] updateUserLastSeen failed: ${err.message}`); }
    }
  }

  console.log(`[ws] user ${userId} auth'd (${clients.size} online)`);
  send(ws, { type: 'auth_ok', user_id: userId, ts: Date.now() });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function send(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(obj)); }
  catch (err) { console.error(`[ws] send error (user=${ws.userId ?? 'unauthed'}): ${err.message}`); }
}

/**
 * Broadcast a message to clients.
 * - sharedPlaylistId = number  → send to all users linked to that playlist
 * - sharedPlaylistId = null    → send to ALL connected clients (user-level events like sync_status)
 *
 * @param {number|null} sharedPlaylistId
 * @param {object}      message
 */
function broadcast(sharedPlaylistId, message) {
  const json = JSON.stringify(message);
  let sent = 0;

  if (sharedPlaylistId == null) {
    // User-level event (sync_status, settings_updated) → broadcast to everyone
    for (const [, ws] of clients) {
      if (ws.readyState === ws.OPEN) {
        try { ws.send(json); sent++; }
        catch (err) { console.error(`[ws] broadcast all error: ${err.message}`); }
      }
    }
    console.log(`[ws] broadcast type=${message.type} → ${sent} client(s)`);
    return;
  }

  let links;
  try { links = db.getPlaylistLinks(sharedPlaylistId); }
  catch (err) {
    console.error(`[ws] broadcast: getPlaylistLinks error (playlist=${sharedPlaylistId}): ${err.message}`);
    return;
  }

  for (const link of links) {
    const target = clients.get(link.user_id);
    if (!target || target.readyState !== target.OPEN) continue;
    try { target.send(json); sent++; }
    catch (err) { console.error(`[ws] broadcast send to ${link.user_id} failed: ${err.message}`); }
  }

  console.log(`[ws] broadcast type=${message.type} playlist=${sharedPlaylistId} → ${sent}/${links.length} client(s)`);
}

module.exports = { initWebSocket, clients, broadcast };
