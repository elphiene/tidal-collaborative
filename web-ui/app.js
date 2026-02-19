'use strict';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = `${window.location.protocol}//${window.location.host}`;
const WS_URL   = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;
const POLL_MS  = 6_000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  playlists:   [],
  users:       [],
  ws:          null,
  wsConnected: false,
  pollTimer:   null,
};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('server-url').textContent = window.location.host;

  // Button listeners
  document.getElementById('open-create-btn').addEventListener('click', () => openModal('create-modal'));
  document.getElementById('refresh-btn').addEventListener('click', () => {
    refresh();
    toast('Refreshed', 'info');
  });

  // Form submit
  document.getElementById('create-form').addEventListener('submit', handleCreateSubmit);

  // Modal close buttons (data-close="<modal-id>")
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });

  // Close on overlay backdrop click
  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal(overlay.id);
    });
  });

  // ESC to close any open modal
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('.modal-overlay.modal-open').forEach((m) => closeModal(m.id));
  });

  connectWebSocket();
  refresh();
  state.pollTimer = setInterval(refresh, POLL_MS);
});

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function refresh() {
  await Promise.allSettled([fetchPlaylists(), fetchUsers()]);
}

async function fetchPlaylists() {
  try {
    const res = await fetch(`${BASE_URL}/api/shared-playlists`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.playlists = await res.json();
    renderPlaylists();
    renderStats();
  } catch (err) {
    console.error('[app] fetchPlaylists:', err.message);
  }
}

async function fetchUsers() {
  try {
    const res = await fetch(`${BASE_URL}/api/users`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.users = await res.json();
    renderUsers();
    renderStats();
  } catch (err) {
    console.error('[app] fetchUsers:', err.message);
  }
}

async function fetchTracks(playlistId) {
  const res = await fetch(`${BASE_URL}/api/shared-playlists/${playlistId}/tracks`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Render: Stats
// ---------------------------------------------------------------------------

function renderStats() {
  const totalPlaylists = state.playlists.length;
  const totalTracks    = state.playlists.reduce((s, p) => s + (p.track_count ?? 0), 0);
  // Unique user IDs across all playlist links
  const linkedUsers    = new Set(
    state.users.map((u) => u.user_id)
  ).size;
  // "Recently active" = last_seen within past 5 minutes
  const fiveMinsAgo   = Math.floor(Date.now() / 1000) - 300;
  const onlineCount   = state.users.filter((u) => u.last_seen >= fiveMinsAgo).length;

  setElText('stat-playlists', totalPlaylists);
  setElText('stat-tracks',    totalTracks);
  setElText('stat-users',     linkedUsers);
  setElText('stat-online',    onlineCount);
}

// ---------------------------------------------------------------------------
// Render: Playlists
// ---------------------------------------------------------------------------

function renderPlaylists() {
  const grid = document.getElementById('playlists-grid');

  if (state.playlists.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <div class="empty-icon">🎵</div>
        <p class="empty-title">No shared playlists yet</p>
        <p class="empty-sub">Click <strong>New Playlist</strong> to create one and invite collaborators.</p>
      </div>`;
    return;
  }

  grid.innerHTML = state.playlists.map(playlistCardHTML).join('');

  grid.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => openViewModal(Number(btn.dataset.view)));
  });

  grid.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', () => handleDelete(Number(btn.dataset.delete), btn));
  });
}

function playlistCardHTML(pl) {
  const descHTML = pl.description
    ? `<p class="card-desc">${escHtml(pl.description)}</p>`
    : '';

  return `
    <div class="playlist-card" data-id="${pl.id}">
      <div class="card-body">
        <div class="card-icon">🎵</div>
        <h3 class="card-title">${escHtml(pl.name)}</h3>
        ${descHTML}
        <div class="card-meta">
          <span class="meta-item">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
            ${pl.user_count} ${pl.user_count === 1 ? 'user' : 'users'}
          </span>
          <span class="meta-item">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M9 18V5l12-2v13"/>
              <circle cx="6" cy="18" r="3"/>
              <circle cx="18" cy="16" r="3"/>
            </svg>
            ${pl.track_count} ${pl.track_count === 1 ? 'track' : 'tracks'}
          </span>
          <span class="meta-item meta-date">${formatDate(pl.created_at)}</span>
        </div>
      </div>
      <div class="card-actions">
        <button class="btn btn-secondary btn-sm" data-view="${pl.id}">View Tracks</button>
        <button class="btn btn-danger btn-sm" data-delete="${pl.id}">Delete</button>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Render: Users
// ---------------------------------------------------------------------------

function renderUsers() {
  const list = document.getElementById('users-list');

  if (state.users.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <p class="empty-title">No users have connected yet</p>
        <p class="empty-sub">Users appear here after they authenticate via the browser extension.</p>
      </div>`;
    return;
  }

  const rows = state.users.map((u) => {
    const fiveMinsAgo = Math.floor(Date.now() / 1000) - 300;
    const isOnline    = u.last_seen >= fiveMinsAgo;
    return `
      <tr>
        <td class="user-id">${escHtml(u.user_id)}</td>
        <td>${escHtml(u.shared_playlist_name)}</td>
        <td class="text-muted">${timeAgo(u.last_seen)}</td>
        <td>
          <span class="status-badge ${isOnline ? 'badge-online' : 'badge-offline'}">
            ${isOnline ? 'Active' : 'Away'}
          </span>
        </td>
      </tr>`;
  }).join('');

  list.innerHTML = `
    <table class="users-table">
      <thead>
        <tr>
          <th>User ID</th>
          <th>Playlist</th>
          <th>Last Seen</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ---------------------------------------------------------------------------
// Create Playlist
// ---------------------------------------------------------------------------

async function handleCreateSubmit(e) {
  e.preventDefault();

  const name    = document.getElementById('pl-name').value.trim();
  const desc    = document.getElementById('pl-desc').value.trim();
  const errEl   = document.getElementById('create-error');
  const btn     = document.getElementById('create-submit-btn');

  errEl.textContent = '';

  if (!name) {
    errEl.textContent = 'Playlist name is required.';
    document.getElementById('pl-name').focus();
    return;
  }

  setLoadingBtn(btn, true);

  try {
    const res = await fetch(`${BASE_URL}/api/shared-playlists`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, description: desc || undefined }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

    closeModal('create-modal');
    document.getElementById('create-form').reset();
    toast(`"${name}" created`, 'success');
    await fetchPlaylists();
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    setLoadingBtn(btn, false);
  }
}

// ---------------------------------------------------------------------------
// Delete Playlist  (two-click confirmation)
// ---------------------------------------------------------------------------

async function handleDelete(id, btn) {
  const pl   = state.playlists.find((p) => p.id === id);
  const name = pl?.name ?? `Playlist #${id}`;

  // First click: arm the button
  if (btn.dataset.armed !== 'true') {
    btn.dataset.armed   = 'true';
    btn.textContent     = 'Confirm?';
    // Auto-disarm after 3 s
    setTimeout(() => {
      if (btn.dataset.armed === 'true') {
        btn.dataset.armed = 'false';
        btn.textContent   = 'Delete';
      }
    }, 3000);
    return;
  }

  // Second click: execute
  btn.disabled    = true;
  btn.textContent = 'Deleting…';

  try {
    const res = await fetch(`${BASE_URL}/api/shared-playlists/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error ?? `HTTP ${res.status}`);
    }
    toast(`"${name}" deleted`, 'info');
    await fetchPlaylists();
  } catch (err) {
    toast(`Delete failed: ${err.message}`, 'error');
    btn.disabled      = false;
    btn.textContent   = 'Delete';
    btn.dataset.armed = 'false';
  }
}

// ---------------------------------------------------------------------------
// View Playlist Modal
// ---------------------------------------------------------------------------

async function openViewModal(id) {
  const pl = state.playlists.find((p) => p.id === id);
  if (!pl) return;

  document.getElementById('view-modal-title').textContent    = pl.name;
  document.getElementById('view-modal-subtitle').textContent =
    `${pl.track_count} track${pl.track_count !== 1 ? 's' : ''} · ${pl.user_count} user${pl.user_count !== 1 ? 's' : ''}`;
  document.getElementById('view-modal-body').innerHTML =
    '<div class="loading-state"><div class="spinner"></div><span>Loading tracks…</span></div>';

  openModal('view-modal');

  try {
    const tracks = await fetchTracks(id);
    renderTracksInModal(tracks, pl);
  } catch (err) {
    document.getElementById('view-modal-body').innerHTML = `
      <div class="empty-state">
        <p class="empty-title">Failed to load tracks</p>
        <p class="empty-sub">${escHtml(err.message)}</p>
      </div>`;
  }
}

function renderTracksInModal(tracks, pl) {
  const body = document.getElementById('view-modal-body');

  if (tracks.length === 0) {
    body.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎵</div>
        <p class="empty-title">No tracks yet</p>
        <p class="empty-sub">
          Users linked to <strong>${escHtml(pl.name)}</strong> will sync
          tracks here automatically via the extension.
        </p>
      </div>`;
    return;
  }

  const rows = tracks.map((t, i) => `
    <tr>
      <td class="track-pos text-muted">${i + 1}</td>
      <td class="track-id">${escHtml(t.tidal_track_id)}</td>
      <td class="user-id">${escHtml(t.added_by)}</td>
      <td class="text-muted">${formatDate(t.added_at)}</td>
    </tr>`).join('');

  body.innerHTML = `
    <table class="tracks-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Track ID</th>
          <th>Added By</th>
          <th>Added At</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ---------------------------------------------------------------------------
// WebSocket  (status + live refresh trigger)
// ---------------------------------------------------------------------------

function connectWebSocket() {
  if (state.ws) {
    state.ws.onclose = null; // prevent reconnect loop on intentional close
    state.ws.close();
  }

  let ws;
  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    console.error('[ws] Failed to construct WebSocket:', err.message);
    setWsStatus(false);
    setTimeout(connectWebSocket, 5_000);
    return;
  }

  state.ws = ws;

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'auth', payload: { user_id: 'admin-panel' } }));
    setWsStatus(true);
  });

  ws.addEventListener('message', ({ data }) => {
    try {
      const msg = JSON.parse(data);
      // Any live sync event → immediately refresh playlist stats
      if (['track_added', 'track_removed', 'tracks_reordered'].includes(msg.type)) {
        fetchPlaylists();
        showSyncNotification(msg);
      }
    } catch { /* ignore malformed messages */ }
  });

  ws.addEventListener('close', () => {
    setWsStatus(false);
    setTimeout(connectWebSocket, 3_000);
  });

  ws.addEventListener('error', () => {
    // 'close' fires right after, which handles reconnect
    ws.close();
  });
}

function setWsStatus(online) {
  state.wsConnected = online;
  const el    = document.getElementById('ws-status');
  const label = el.querySelector('.ws-label');
  el.className      = `ws-status ${online ? 'ws-connected' : 'ws-disconnected'}`;
  label.textContent = online ? 'Connected' : 'Disconnected';
  renderStats(); // update "Recently Active" counter
}

function showSyncNotification(msg) {
  const map = {
    track_added:      `Track added to playlist ${msg.shared_playlist_id}`,
    track_removed:    `Track removed from playlist ${msg.shared_playlist_id}`,
    tracks_reordered: `Playlist ${msg.shared_playlist_id} reordered`,
  };
  const text = map[msg.type];
  if (text) toast(text, 'info');
}

// ---------------------------------------------------------------------------
// Modal helpers
// ---------------------------------------------------------------------------

function openModal(id) {
  const el = document.getElementById(id);
  el.setAttribute('aria-hidden', 'false');
  el.classList.add('modal-open');
  document.body.classList.add('no-scroll');
  // Focus first focusable element
  setTimeout(() => {
    const first = el.querySelector('input:not([disabled]), textarea:not([disabled]), button:not([disabled])');
    first?.focus();
  }, 50);
}

function closeModal(id) {
  const el = document.getElementById(id);
  el.setAttribute('aria-hidden', 'true');
  el.classList.remove('modal-open');
  if (!document.querySelector('.modal-overlay.modal-open')) {
    document.body.classList.remove('no-scroll');
  }
}

// ---------------------------------------------------------------------------
// Toast notifications
// ---------------------------------------------------------------------------

function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const el        = document.createElement('div');
  el.className    = `toast toast-${type}`;
  el.innerHTML    = `
    <span>${escHtml(String(message))}</span>
    <button class="toast-close" aria-label="Dismiss">&times;</button>`;

  el.querySelector('.toast-close').addEventListener('click', () => el.remove());
  container.appendChild(el);

  setTimeout(() => el.classList.add('toast-fade'), 3_500);
  setTimeout(() => el.remove(),                    4_000);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function setElText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function setLoadingBtn(btn, loading) {
  const label   = btn.querySelector('.btn-label');
  const spinner = btn.querySelector('.btn-spinner');
  btn.disabled  = loading;
  if (label)   label.hidden   = loading;
  if (spinner) spinner.hidden = !loading;
}

/** Escape HTML entities to prevent XSS */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Format a Unix timestamp (seconds) to a short locale string */
function formatDate(unixSecs) {
  return new Date(unixSecs * 1000).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/** Convert a Unix timestamp (seconds) to a relative "X ago" string */
function timeAgo(unixSecs) {
  const diff = Math.floor(Date.now() / 1000) - unixSecs;
  if (diff < 10)    return 'just now';
  if (diff < 60)    return `${diff}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
