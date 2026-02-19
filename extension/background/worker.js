/**
 * Tidal Collaborative — Background Service Worker (MV3)
 *
 * Responsibilities:
 *  - Maintain a WebSocket connection to the self-hosted sync server
 *  - Route incoming server events to the Tidal API (add / remove tracks)
 *  - Relay events from the content script to the server
 *  - Expose state to the popup via chrome.runtime.onMessage
 *
 * Lifecycle notes (MV3):
 *  Chrome can kill the service worker when idle. We use chrome.alarms to
 *  periodically wake the worker and ensure the WebSocket is alive. All
 *  persistent data lives in chrome.storage.local and is reloaded on each
 *  activation via initFromStorage().
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIDAL_API_BASE        = 'https://listen.tidal.com/v1';
const TIDAL_COUNTRY_CODE    = 'US';           // TODO: make this configurable in popup
const KEEPALIVE_ALARM       = 'ws-keepalive';
const KEEPALIVE_MINUTES     = 0.4;            // ~24 s — keeps service worker alive
const MAX_RECONNECT         = 5;
const RECONNECT_BASE_MS     = 1_000;
const RECONNECT_MAX_MS      = 30_000;

// ---------------------------------------------------------------------------
// In-memory state
// (Rebuilt from chrome.storage.local on every service worker activation)
// ---------------------------------------------------------------------------

const state = {
  /** @type {WebSocket|null} */
  ws:                null,

  /** @type {string|null} Server base URL, e.g. "http://192.168.100.31:3000" */
  serverUrl:         null,

  /** @type {string|null} Tidal numeric user ID */
  userId:            null,

  /** @type {string|null} Bearer token intercepted from the Tidal web app */
  tidalAccessToken:  null,

  /**
   * Maps sharedPlaylistId (number) -> tidalPlaylistId (string UUID).
   * The user explicitly links these in the popup.
   * @type {Map<number, string>}
   */
  linkedPlaylists:   new Map(),

  reconnectAttempts: 0,

  /** @type {ReturnType<typeof setTimeout>|null} */
  reconnectTimer:    null,

  isConnecting:      false,
};

// ---------------------------------------------------------------------------
// Boot — eagerly restore state so any waking event finds it ready
// ---------------------------------------------------------------------------

/**
 * Resolves once chrome.storage.local has been read and state is populated.
 * Awaited inside every message handler so late wakes are handled correctly.
 */
const storageReady = initFromStorage();

async function initFromStorage() {
  const data = await chrome.storage.local.get([
    'serverUrl',
    'userId',
    'tidalAccessToken',
    'linkedPlaylists',
  ]);

  state.serverUrl        = data.serverUrl        ?? null;
  state.userId           = data.userId           ?? null;
  state.tidalAccessToken = data.tidalAccessToken ?? null;

  // Restore linkedPlaylists Map from its serialised plain-object form
  if (data.linkedPlaylists && typeof data.linkedPlaylists === 'object') {
    state.linkedPlaylists = new Map(
      Object.entries(data.linkedPlaylists).map(([k, v]) => [Number(k), v]),
    );
  }

  log(
    `storage loaded — serverUrl=${state.serverUrl} userId=${state.userId} ` +
    `links=${state.linkedPlaylists.size} hasToken=${!!state.tidalAccessToken}`,
  );

  if (state.serverUrl && state.userId) connectWebSocket();
}

// ---------------------------------------------------------------------------
// Chrome extension lifecycle events
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  log(`onInstalled reason=${reason}`);
  await storageReady;
  setupKeepaliveAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  log('onStartup');
  await storageReady;
  setupKeepaliveAlarm();
});

// Periodic alarm: keeps the service worker alive and pings the WebSocket
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) ensureConnected();
});

function setupKeepaliveAlarm() {
  chrome.alarms.get(KEEPALIVE_ALARM, (existing) => {
    if (!existing) {
      chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_MINUTES });
    }
  });
}

// ---------------------------------------------------------------------------
// WebSocket lifecycle
// ---------------------------------------------------------------------------

function connectWebSocket() {
  if (state.isConnecting) {
    log('ws: already connecting — skipping');
    return;
  }
  if (state.ws?.readyState === WebSocket.OPEN) {
    log('ws: already open');
    return;
  }
  if (!state.serverUrl || !state.userId) {
    log('ws: missing serverUrl or userId — not connecting');
    return;
  }

  const wsUrl = state.serverUrl.replace(/^http/, 'ws') + '/ws';
  log(`ws: connecting → ${wsUrl}`);
  state.isConnecting = true;

  let ws;
  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    logError('ws: WebSocket constructor threw', err);
    state.isConnecting = false;
    scheduleReconnect();
    return;
  }

  state.ws = ws;

  ws.addEventListener('open', () => {
    log(`ws: connected (attempt ${state.reconnectAttempts})`);
    state.isConnecting      = false;
    state.reconnectAttempts = 0;

    wsSend({ type: 'auth', payload: { user_id: state.userId } });
    broadcastStatus(true);
  });

  ws.addEventListener('message', ({ data }) => {
    try {
      handleServerMessage(JSON.parse(data));
    } catch (err) {
      logError('ws: failed to parse server message', err);
    }
  });

  ws.addEventListener('close', ({ code, reason }) => {
    log(`ws: closed (code=${code} reason=${reason || 'none'})`);
    state.isConnecting = false;
    state.ws           = null;
    broadcastStatus(false);
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    // The 'close' event always fires immediately after 'error' — it handles cleanup
    logError('ws: socket error (close follows)');
  });
}

/**
 * Send a JSON message over the WebSocket.
 * Returns true on success, false if the socket is not ready.
 */
function wsSend(obj) {
  if (state.ws?.readyState !== WebSocket.OPEN) {
    log('ws: cannot send — not connected');
    return false;
  }
  try {
    state.ws.send(JSON.stringify(obj));
    return true;
  } catch (err) {
    logError('ws: send failed', err);
    return false;
  }
}

function ensureConnected() {
  if (state.ws?.readyState === WebSocket.OPEN) {
    // Heartbeat ping so the server knows we're still alive
    wsSend({ type: 'ping' });
  } else {
    connectWebSocket();
  }
}

function scheduleReconnect() {
  if (state.reconnectAttempts >= MAX_RECONNECT) {
    log('ws: max reconnect attempts reached — waiting for keepalive alarm');
    return;
  }
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);

  const delay = Math.min(
    RECONNECT_BASE_MS * Math.pow(2, state.reconnectAttempts),
    RECONNECT_MAX_MS,
  );
  state.reconnectAttempts++;
  log(`ws: reconnecting in ${delay}ms (attempt ${state.reconnectAttempts}/${MAX_RECONNECT})`);
  state.reconnectTimer = setTimeout(connectWebSocket, delay);
}

// ---------------------------------------------------------------------------
// Server → extension message handler
// ---------------------------------------------------------------------------

async function handleServerMessage(msg) {
  log(`server → type=${msg.type}`);

  switch (msg.type) {
    // ------------------------------------------------------------------ auth
    case 'auth_ok':
      log('ws: authenticated with server');
      break;

    // ------------------------------------------------------------ track_added
    case 'track_added': {
      const { shared_playlist_id, tidal_track_id, added_by } = msg;
      const tidalPlaylistId = state.linkedPlaylists.get(Number(shared_playlist_id));

      if (!tidalPlaylistId) {
        log(`track_added: playlist ${shared_playlist_id} not linked locally — ignoring`);
        break;
      }

      log(`track_added: ${tidal_track_id} → ${tidalPlaylistId} (by ${added_by})`);
      try {
        await tidalAddTrack(tidalPlaylistId, tidal_track_id);
        notify(`Track added by ${added_by ?? 'a collaborator'}`);
      } catch (err) {
        logError('track_added: Tidal API failed', err);
        notifyError(`Could not add track — ${err.message}`);
      }
      break;
    }

    // ---------------------------------------------------------- track_removed
    case 'track_removed': {
      const { shared_playlist_id, tidal_track_id, removed_by } = msg;
      const tidalPlaylistId = state.linkedPlaylists.get(Number(shared_playlist_id));

      if (!tidalPlaylistId) {
        log(`track_removed: playlist ${shared_playlist_id} not linked locally — ignoring`);
        break;
      }

      log(`track_removed: ${tidal_track_id} ← ${tidalPlaylistId} (by ${removed_by})`);
      try {
        await tidalRemoveTrack(tidalPlaylistId, tidal_track_id);
        notify(`Track removed by ${removed_by ?? 'a collaborator'}`);
      } catch (err) {
        logError('track_removed: Tidal API failed', err);
        notifyError(`Could not remove track — ${err.message}`);
      }
      break;
    }

    // ------------------------------------------------------- tracks_reordered
    case 'tracks_reordered': {
      const { shared_playlist_id } = msg;
      const tidalPlaylistId = state.linkedPlaylists.get(Number(shared_playlist_id));
      if (!tidalPlaylistId) break;

      // Tidal doesn't expose a clean bulk-reorder endpoint on the unofficial
      // API; individual move calls would be noisy. Log for now — full
      // reorder support requires an official API or move-by-index looping.
      log(`tracks_reordered: best-effort only for playlist ${shared_playlist_id}`);
      break;
    }

    case 'error':
      logError('server sent error:', new Error(msg.error));
      break;

    default:
      log(`server → unknown type: ${msg.type}`);
  }
}

// ---------------------------------------------------------------------------
// Extension → background message handler  (content script + popup)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    // Ensure storage has been loaded before handling any message
    await storageReady;
    return handleExtensionMessage(msg, sender);
  })()
    .then(sendResponse)
    .catch((err) => {
      logError(`onMessage handler (type=${msg.type})`, err);
      sendResponse({ error: err.message });
    });

  return true; // keep the channel open for async sendResponse
});

async function handleExtensionMessage(msg, _sender) {
  log(`extension → type=${msg.type}`);

  switch (msg.type) {

    // ------------------------------------------------- tidal_token (content script)
    // Content script sends this whenever it captures a fresh token / userId.
    case 'tidal_token': {
      let changed = false;

      if (msg.token && msg.token !== state.tidalAccessToken) {
        state.tidalAccessToken = msg.token;
        await chrome.storage.local.set({ tidalAccessToken: msg.token });
        log('tidal token updated');
        changed = true;
      }

      if (msg.userId) {
        const uid = String(msg.userId);
        if (uid !== state.userId) {
          state.userId = uid;
          await chrome.storage.local.set({ userId: uid });
          log(`tidal userId captured: ${uid}`);
          changed = true;
        }
      }

      // Re-authenticate with the sync server if credentials changed
      if (changed && state.serverUrl) {
        state.reconnectAttempts = 0;
        connectWebSocket();
      }

      return { ok: true };
    }

    // ---------------------------------------- track_added_in_tidal (content script)
    case 'track_added_in_tidal': {
      const { tidalPlaylistId, tidalTrackId } = msg;
      const sharedId = findSharedPlaylistId(tidalPlaylistId);

      if (sharedId === null) {
        return { ok: false, reason: 'playlist not linked' };
      }

      const sent = wsSend({
        type:    'track_added',
        payload: { shared_playlist_id: sharedId, tidal_track_id: tidalTrackId },
      });

      return { ok: sent };
    }

    // --------------------------------------- track_removed_in_tidal (content script)
    case 'track_removed_in_tidal': {
      const { tidalPlaylistId, tidalTrackId } = msg;
      const sharedId = findSharedPlaylistId(tidalPlaylistId);

      if (sharedId === null) {
        return { ok: false, reason: 'playlist not linked' };
      }

      const sent = wsSend({
        type:    'track_removed',
        payload: { shared_playlist_id: sharedId, tidal_track_id: tidalTrackId },
      });

      return { ok: sent };
    }

    // ---------------------------------------------- get_user_playlists (popup)
    case 'get_user_playlists': {
      if (!state.tidalAccessToken || !state.userId) {
        return { error: 'Not authenticated with Tidal yet — open listen.tidal.com first' };
      }
      const playlists = await tidalGetUserPlaylists(state.userId);
      return { playlists };
    }

    // ----------------------------------------------- check_playlist_linked (popup)
    case 'check_playlist_linked': {
      const sharedId = findSharedPlaylistId(msg.tidalPlaylistId);
      return { linked: sharedId !== null, sharedPlaylistId: sharedId };
    }

    // ---------------------------------------------------- link_playlist (popup)
    // Called AFTER the server has created the playlist_link via REST.
    case 'link_playlist': {
      const { sharedPlaylistId, tidalPlaylistId } = msg;
      if (!sharedPlaylistId || !tidalPlaylistId) {
        return { error: 'sharedPlaylistId and tidalPlaylistId are required' };
      }
      state.linkedPlaylists.set(Number(sharedPlaylistId), tidalPlaylistId);
      await persistLinkedPlaylists();
      return { ok: true };
    }

    // -------------------------------------------------- unlink_playlist (popup)
    case 'unlink_playlist': {
      state.linkedPlaylists.delete(Number(msg.sharedPlaylistId));
      await persistLinkedPlaylists();
      return { ok: true };
    }

    // -------------------------------------------------- save_server_url (popup)
    case 'save_server_url': {
      const url = msg.serverUrl?.trim();
      if (!url) return { error: 'serverUrl is required' };

      state.serverUrl         = url;
      state.reconnectAttempts = 0;
      await chrome.storage.local.set({ serverUrl: url });

      if (state.userId) connectWebSocket();
      return { ok: true };
    }

    // ----------------------------------------------------- save_user_id (popup)
    case 'save_user_id': {
      const uid = String(msg.userId ?? '').trim();
      if (!uid) return { error: 'userId is required' };

      state.userId            = uid;
      state.reconnectAttempts = 0;
      await chrome.storage.local.set({ userId: uid });

      if (state.serverUrl) connectWebSocket();
      return { ok: true };
    }

    // --------------------------------------------------------- get_state (popup)
    case 'get_state': {
      return {
        serverUrl:       state.serverUrl,
        userId:          state.userId,
        wsConnected:     state.ws?.readyState === WebSocket.OPEN,
        hasToken:        !!state.tidalAccessToken,
        linkedPlaylists: Object.fromEntries(state.linkedPlaylists),
      };
    }

    // ----------------------------------------------------- initial_sync (popup)
    // Apply the server's canonical track list to the user's local Tidal playlist.
    // Called once when the user first links a playlist.
    case 'initial_sync': {
      const { sharedPlaylistId, serverTracks } = msg;
      const tidalPlaylistId = state.linkedPlaylists.get(Number(sharedPlaylistId));
      if (!tidalPlaylistId) return { error: 'Playlist not linked in extension' };

      await applyInitialSync(tidalPlaylistId, serverTracks);
      return { ok: true };
    }

    default:
      log(`extension → unknown type: ${msg.type}`);
      return { error: `Unknown message type: ${msg.type}` };
  }
}

// ---------------------------------------------------------------------------
// Initial sync
// Reconcile server's track list against the user's local Tidal playlist.
// Uses a set-difference: adds tracks present on server but missing locally.
// Intentionally does NOT remove local-only tracks (non-destructive merge).
// ---------------------------------------------------------------------------

async function applyInitialSync(tidalPlaylistId, serverTracks) {
  log(`initial_sync: reconciling ${tidalPlaylistId} (${serverTracks.length} server tracks)`);

  let localItems;
  try {
    localItems = await tidalGetPlaylistItems(tidalPlaylistId);
  } catch (err) {
    throw new Error(`Failed to read local playlist: ${err.message}`);
  }

  const localIds = new Set(
    localItems.map((item) => String(item.item?.id ?? item.id)),
  );

  const toAdd = serverTracks.filter(
    (t) => !localIds.has(String(t.tidal_track_id)),
  );

  log(`initial_sync: ${toAdd.length} tracks to add, ${localItems.length - (serverTracks.length - toAdd.length)} already present`);

  let added = 0;
  for (const track of toAdd) {
    try {
      await tidalAddTrack(tidalPlaylistId, track.tidal_track_id);
      added++;
    } catch (err) {
      // Non-fatal: log and continue — don't abort the whole sync
      logError(`initial_sync: failed to add ${track.tidal_track_id}`, err);
    }
  }

  log(`initial_sync: done — added ${added}/${toAdd.length}`);
}

// ---------------------------------------------------------------------------
// Tidal API
// ---------------------------------------------------------------------------

/**
 * Build standard Tidal request headers.
 * Throws if no token is available.
 */
function tidalHeaders() {
  if (!state.tidalAccessToken) throw new Error('No Tidal access token — open listen.tidal.com');
  return {
    'Authorization': `Bearer ${state.tidalAccessToken}`,
    'Content-Type':  'application/json',
    'X-Tidal-Token': state.tidalAccessToken,
  };
}

/**
 * Tidal fetch wrapper with unified error handling.
 *
 * Handles:
 *  - Network failures
 *  - 401 token expiry  (clears stored token so content script re-captures)
 *  - 429 rate limiting (surfaces Retry-After in the error)
 *  - Non-2xx responses (surfaces status + truncated body)
 *
 * @param {string} path - Path relative to TIDAL_API_BASE
 * @param {RequestInit} [options]
 * @returns {Promise<any|null>} Parsed JSON, or null for 204 No Content
 */
async function tidalFetch(path, options = {}) {
  const url = `${TIDAL_API_BASE}${path}`;
  let res;

  try {
    res = await fetch(url, {
      ...options,
      headers: { ...tidalHeaders(), ...(options.headers ?? {}) },
    });
  } catch (err) {
    throw new Error(`Network error: ${err.message}`);
  }

  if (res.status === 401) {
    // Stale token — clear it; content script will re-capture on next page interaction
    state.tidalAccessToken = null;
    await chrome.storage.local.remove('tidalAccessToken');
    throw new Error('Tidal token expired — please interact with the Tidal tab to refresh it');
  }

  if (res.status === 429) {
    const wait = res.headers.get('Retry-After') ?? '5';
    throw new Error(`Tidal rate limit — retry after ${wait}s`);
  }

  if (res.status === 204) return null; // No Content — success with no body

  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch { /* ignore read errors */ }
    throw new Error(`Tidal ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

/**
 * GET /v1/users/{userId}/playlists
 * Returns the user's editable playlists.
 */
async function tidalGetUserPlaylists(userId) {
  const data = await tidalFetch(
    `/users/${userId}/playlists?countryCode=${TIDAL_COUNTRY_CODE}&limit=50&offset=0`,
    { method: 'GET' },
  );
  return data?.items ?? [];
}

/**
 * GET /v1/playlists/{playlistId}/items
 * Returns up to 100 items in the playlist (pagination not yet implemented).
 */
async function tidalGetPlaylistItems(playlistId) {
  const data = await tidalFetch(
    `/playlists/${playlistId}/items?countryCode=${TIDAL_COUNTRY_CODE}&limit=100&offset=0`,
    { method: 'GET' },
  );
  return data?.items ?? [];
}

/**
 * Fetch the current ETag for a playlist (required for write operations).
 * Tidal uses optimistic concurrency: writes must supply the current ETag
 * via If-None-Match or they will be rejected with 412.
 *
 * Returns null if the ETag cannot be obtained (writes will proceed without
 * it and may fail — the caller can retry).
 */
async function tidalGetETag(playlistId) {
  try {
    const res = await fetch(`${TIDAL_API_BASE}/playlists/${playlistId}`, {
      method:  'GET',
      headers: tidalHeaders(),
    });
    return res.headers.get('ETag') ?? res.headers.get('etag') ?? null;
  } catch {
    return null;
  }
}

/**
 * POST /v1/playlists/{playlistId}/items
 * Add a single track. Fetches the current ETag first for optimistic locking.
 */
async function tidalAddTrack(playlistId, trackId) {
  const etag = await tidalGetETag(playlistId);

  await tidalFetch(`/playlists/${playlistId}/items`, {
    method:  'POST',
    headers: etag ? { 'If-None-Match': etag } : {},
    body:    JSON.stringify({ trackIds: [Number(trackId)], onDupes: 'ADD' }),
  });
}

/**
 * DELETE /v1/playlists/{playlistId}/items/{index}
 *
 * Tidal's delete endpoint works by track position (index), not by track ID.
 * We first fetch the item list to find the track's current index, then delete
 * by position. Race conditions are possible if the playlist is modified
 * concurrently — this is best-effort (last-write-wins).
 */
async function tidalRemoveTrack(playlistId, trackId) {
  const items = await tidalGetPlaylistItems(playlistId);
  const index = items.findIndex(
    (item) => String(item.item?.id ?? item.id) === String(trackId),
  );

  if (index === -1) {
    log(`tidalRemoveTrack: track ${trackId} not found in ${playlistId} — already removed`);
    return; // Idempotent
  }

  const etag = await tidalGetETag(playlistId);

  await tidalFetch(`/playlists/${playlistId}/items/${index}`, {
    method:  'DELETE',
    headers: etag ? { 'If-None-Match': etag } : {},
    body:    JSON.stringify({ order: 'INDEX', orderDirection: 'ASC' }),
  });
}

// ---------------------------------------------------------------------------
// Chrome notifications
// ---------------------------------------------------------------------------

/**
 * Show a standard sync notification.
 * @param {string} message
 */
function notify(message) {
  chrome.notifications.create(`tc-${Date.now()}`, {
    type:     'basic',
    iconUrl:  'icons/icon48.png',
    title:    'Tidal Collaborative',
    message,
    priority: 0,
  });
}

/**
 * Show an error notification with elevated priority.
 * @param {string} message
 */
function notifyError(message) {
  chrome.notifications.create(`tc-err-${Date.now()}`, {
    type:     'basic',
    iconUrl:  'icons/icon48.png',
    title:    'Tidal Collaborative — Sync Error',
    message:  String(message).slice(0, 200),
    priority: 2,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Look up the sharedPlaylistId that corresponds to a given tidalPlaylistId.
 * Returns null if the playlist is not linked.
 * @param {string} tidalPlaylistId
 * @returns {number|null}
 */
function findSharedPlaylistId(tidalPlaylistId) {
  for (const [sharedId, tidalId] of state.linkedPlaylists) {
    if (tidalId === tidalPlaylistId) return sharedId;
  }
  return null;
}

/**
 * Serialise state.linkedPlaylists to chrome.storage.local.
 * Stored as { [sharedPlaylistId]: tidalPlaylistId } so it survives
 * service worker restarts.
 */
async function persistLinkedPlaylists() {
  const obj = Object.fromEntries(state.linkedPlaylists);
  await chrome.storage.local.set({ linkedPlaylists: obj });
  log(`persistLinkedPlaylists: saved ${state.linkedPlaylists.size} links`);
}

/**
 * Notify the popup (and any other extension pages) of a WebSocket status change.
 * Silently ignores the error when the popup is not open.
 */
function broadcastStatus(connected) {
  chrome.runtime.sendMessage({ type: 'ws_status', connected }).catch(() => {});
}

/** Structured console.log prefixed with [bg] */
function log(...args) {
  console.log('[bg]', ...args);
}

/** Structured console.error prefixed with [bg] */
function logError(context, err) {
  console.error(`[bg] ${context}:`, err?.message ?? err);
}
