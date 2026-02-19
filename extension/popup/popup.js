'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  view:                   'setup',   // 'setup' | 'main' | 'linking'
  serverUrl:              null,
  wsConnected:            false,
  userId:                 null,
  hasToken:               false,

  // Tidal playlists fetched from the Tidal API via background worker
  // Each entry: { id, title, tracks }
  userPlaylists:          [],

  // Shared playlists fetched from the sync server
  // Each entry mirrors the server's shared_playlists row + user_count, track_count
  sharedPlaylists:        [],

  // Stored in chrome.storage.local — full display metadata per linked playlist
  // Shape: { [sharedPlaylistId]: { tidalPlaylistId, tidalName, sharedName, linkId } }
  linkedMeta:             {},

  // Linking-flow selections
  selectedUserPlaylist:   null,   // { id, title }
  selectedSharedPlaylist: null,   // { id, name }

  step:                   1,
  statusPollTimer:        null,
};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', init);

async function init() {
  bindStaticListeners();

  // Load persisted config
  const stored = await chrome.storage.local.get(['serverUrl', 'linkedPlaylistMeta']);
  state.serverUrl  = stored.serverUrl        ?? null;
  state.linkedMeta = stored.linkedPlaylistMeta ?? {};

  // Ask background worker for live connection state
  try {
    const bgState = await msgBackground('get_state');
    state.wsConnected = bgState.wsConnected  ?? false;
    state.userId      = bgState.userId       ?? null;
    state.hasToken    = bgState.hasToken     ?? false;
  } catch { /* worker not running yet — graceful degradation */ }

  if (state.serverUrl) {
    showView('main');
    await loadMainView();
  } else {
    showView('setup');
  }

  startStatusPolling();
}

// ---------------------------------------------------------------------------
// Static DOM listener bindings (run once)
// ---------------------------------------------------------------------------

function bindStaticListeners() {
  // Setup view
  byId('connect-btn').addEventListener('click', handleConnect);
  byId('server-url-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleConnect();
  });

  // Main view
  byId('link-new-btn').addEventListener('click', startLinkingFlow);
  byId('settings-btn').addEventListener('click', () => {
    // Go back to setup so user can change the server URL
    byId('server-url-input').value = state.serverUrl ?? '';
    showView('setup');
  });

  // Linking view
  byId('back-btn').addEventListener('click', handleLinkingBack);
  byId('cancel-link-btn').addEventListener('click', () => showView('main'));
  byId('confirm-link-btn').addEventListener('click', confirmLink);

  // ESC key to go back / cancel linking
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.view === 'linking') showView('main');
    if (state.view === 'setup' && state.serverUrl) showView('main');
  });
}

// ---------------------------------------------------------------------------
// View routing
// ---------------------------------------------------------------------------

function showView(name) {
  ['setup', 'main', 'linking'].forEach((v) => {
    byId(`${v}-view`).hidden = (v !== name);
  });
  state.view = name;

  // Auto-focus the primary input in each view
  const focusTargets = {
    setup:   'server-url-input',
    linking: null,
  };
  const target = focusTargets[name];
  if (target) setTimeout(() => byId(target)?.focus(), 60);
}

// ---------------------------------------------------------------------------
// Status polling
// ---------------------------------------------------------------------------

function startStatusPolling() {
  state.statusPollTimer = setInterval(async () => {
    try {
      const s = await msgBackground('get_state');
      const changed = (s.wsConnected !== state.wsConnected) || (s.hasToken !== state.hasToken);
      state.wsConnected = s.wsConnected ?? false;
      state.hasToken    = s.hasToken    ?? false;
      state.userId      = s.userId      ?? state.userId;
      if (changed && state.view === 'main') updateStatusBar();
    } catch { /* background asleep — ignore */ }
  }, 2_000);
}

function updateStatusBar() {
  const dot   = byId('ws-indicator');
  const label = byId('header-url');

  dot.className  = `status-dot ${state.wsConnected ? 'dot-online' : 'dot-offline'}`;
  dot.title      = state.wsConnected ? 'Connected to server' : 'Disconnected from server';
  label.textContent = state.serverUrl ? trimUrl(state.serverUrl) : '';

  byId('token-warning').hidden = state.hasToken;
}

// ---------------------------------------------------------------------------
// Setup flow
// ---------------------------------------------------------------------------

async function handleConnect() {
  const input = byId('server-url-input');
  const url   = input.value.trim();
  const errEl = byId('setup-error');
  const btn   = byId('connect-btn');

  errEl.hidden      = true;
  errEl.textContent = '';

  if (!url) {
    showFormError('Please enter the server URL');
    input.focus();
    return;
  }

  // Normalise: strip trailing slash
  let serverUrl;
  try {
    const parsed = new URL(url);
    serverUrl = parsed.origin; // strips path/search/hash
  } catch {
    showFormError('Invalid URL — include http:// or https://');
    input.focus();
    return;
  }

  setLoadingBtn(btn, true);

  try {
    const res = await fetchWithTimeout(`${serverUrl}/api/ping`, {}, 5_000);
    if (!res.ok) throw new Error(`Server responded with HTTP ${res.status}`);
    const body = await res.json();
    if (!body.ok) throw new Error('Unexpected server response');
  } catch (err) {
    showFormError(
      err.message.includes('fetch') || err.message.includes('network')
        ? 'Could not reach server — check the URL and your VPN'
        : err.message,
    );
    setLoadingBtn(btn, false);
    return;
  }

  // Save and connect
  state.serverUrl = serverUrl;
  await msgBackground('save_server_url', { serverUrl });

  setLoadingBtn(btn, false);
  showView('main');
  await loadMainView();
}

function showFormError(msg) {
  const el = byId('setup-error');
  el.textContent = msg;
  el.hidden = false;
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

async function loadMainView() {
  updateStatusBar();
  renderLinkedPlaylists();
}

function renderLinkedPlaylists() {
  const list = byId('linked-list');
  const entries = Object.entries(state.linkedMeta);

  if (entries.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎵</div>
        <p class="empty-title">No linked playlists</p>
        <p class="empty-sub">Tap <strong>Link</strong> to connect a Tidal playlist to a shared one.</p>
      </div>`;
    return;
  }

  list.innerHTML = entries.map(([sharedId, meta]) => `
    <div class="linked-card" data-id="${sharedId}">
      <div class="linked-card-body">
        <div class="linked-card-row tidal-row">
          <span class="label">Tidal</span>
          <span class="name" title="${esc(meta.tidalName)}">${esc(meta.tidalName)}</span>
        </div>
        <div class="linked-arrow">↕</div>
        <div class="linked-card-row shared-row">
          <span class="label">Shared</span>
          <span class="name" title="${esc(meta.sharedName)}">${esc(meta.sharedName)}</span>
        </div>
      </div>
      <button
        class="btn btn-danger btn-xs"
        data-unlink="${sharedId}"
        data-armed="false"
        aria-label="Unlink ${esc(meta.sharedName)}"
      >Unlink</button>
    </div>`).join('');

  // Attach unlink handlers
  list.querySelectorAll('[data-unlink]').forEach((btn) => {
    btn.addEventListener('click', () =>
      handleUnlink(btn.dataset.unlink, btn),
    );
  });
}

// ---------------------------------------------------------------------------
// Unlink  (two-click confirmation)
// ---------------------------------------------------------------------------

async function handleUnlink(sharedPlaylistId, btn) {
  if (btn.dataset.armed !== 'true') {
    btn.dataset.armed   = 'true';
    btn.textContent     = 'Confirm?';
    setTimeout(() => {
      if (btn.dataset.armed === 'true') {
        btn.dataset.armed = 'false';
        btn.textContent   = 'Unlink';
      }
    }, 3_000);
    return;
  }

  btn.disabled    = true;
  btn.textContent = '…';

  const meta = state.linkedMeta[sharedPlaylistId];
  const name = meta?.sharedName ?? `Playlist #${sharedPlaylistId}`;

  try {
    // Delete the server-side link record
    if (meta?.linkId && state.serverUrl) {
      const res = await fetch(`${state.serverUrl}/api/links/${meta.linkId}`, { method: 'DELETE' });
      // 404 is fine — link may have been deleted already
      if (!res.ok && res.status !== 404) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
    }

    // Remove from background worker Map
    await msgBackground('unlink_playlist', { sharedPlaylistId: Number(sharedPlaylistId) });

    // Remove from local metadata
    const updated = { ...state.linkedMeta };
    delete updated[sharedPlaylistId];
    state.linkedMeta = updated;
    await chrome.storage.local.set({ linkedPlaylistMeta: updated });

    toast(`"${name}" unlinked`, 'info');
    renderLinkedPlaylists();
  } catch (err) {
    toast(`Unlink failed: ${err.message}`, 'error');
    btn.disabled      = false;
    btn.textContent   = 'Unlink';
    btn.dataset.armed = 'false';
  }
}

// ---------------------------------------------------------------------------
// Linking flow — entry
// ---------------------------------------------------------------------------

async function startLinkingFlow() {
  if (!state.hasToken) {
    toast('Open listen.tidal.com first so the extension can read your token', 'error');
    return;
  }

  state.selectedUserPlaylist   = null;
  state.selectedSharedPlaylist = null;
  state.step = 1;

  showView('linking');
  setStepUI(1);
  await loadTidalPlaylists();
}

function setStepUI(step) {
  state.step = step;
  byId('step-1').hidden = (step !== 1);
  byId('step-2').hidden = (step !== 2);
  byId('linking-step-label').textContent = `Step ${step} of 2`;
  byId('back-btn').style.visibility = (step === 1) ? 'hidden' : 'visible';
}

function handleLinkingBack() {
  if (state.step === 2) {
    setStepUI(1);
  } else {
    showView('main');
  }
}

// ---------------------------------------------------------------------------
// Step 1: Tidal playlists
// ---------------------------------------------------------------------------

async function loadTidalPlaylists() {
  const container = byId('tidal-playlists-list');
  container.innerHTML = '<div class="loading-row"><div class="spinner"></div>Loading your Tidal playlists…</div>';

  let result;
  try {
    result = await msgBackground('get_user_playlists');
  } catch (err) {
    renderError(container, `Extension not responding: ${err.message}`);
    return;
  }

  if (result?.error) {
    renderError(container, result.error);
    return;
  }

  // Normalise Tidal's nested item format { created, item: { uuid, title, numberOfTracks } }
  state.userPlaylists = (result?.playlists ?? []).map((entry) => ({
    id:     entry?.item?.uuid    ?? entry?.uuid    ?? entry?.id    ?? null,
    title:  entry?.item?.title   ?? entry?.title   ?? 'Untitled',
    tracks: entry?.item?.numberOfTracks ?? entry?.numberOfTracks ?? 0,
  })).filter((p) => p.id);

  renderTidalPlaylists();
}

function renderTidalPlaylists() {
  const container = byId('tidal-playlists-list');

  if (state.userPlaylists.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p class="empty-title">No Tidal playlists found</p>
        <p class="empty-sub">Make sure you have user-created playlists in your Tidal library.</p>
      </div>`;
    return;
  }

  // Skip playlists that are already linked
  const linkedTidalIds = new Set(Object.values(state.linkedMeta).map((m) => m.tidalPlaylistId));
  const available = state.userPlaylists.filter((p) => !linkedTidalIds.has(p.id));

  if (available.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p class="empty-title">All playlists already linked</p>
        <p class="empty-sub">Unlink an existing playlist to link a different one.</p>
      </div>`;
    return;
  }

  container.innerHTML = available.map((pl) => `
    <div class="playlist-option" data-tidal-id="${pl.id}" data-tidal-title="${esc(pl.title)}" role="option" tabindex="0">
      <div class="playlist-option-body">
        <div class="playlist-option-name">${esc(pl.title)}</div>
        <div class="playlist-option-meta">${pl.tracks} track${pl.tracks !== 1 ? 's' : ''}</div>
      </div>
      <div class="playlist-option-check"></div>
    </div>`).join('');

  container.querySelectorAll('.playlist-option').forEach((el) => {
    el.addEventListener('click', () =>
      selectTidalPlaylist(el.dataset.tidalId, el.dataset.tidalTitle),
    );
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') selectTidalPlaylist(el.dataset.tidalId, el.dataset.tidalTitle);
    });
  });
}

async function selectTidalPlaylist(id, title) {
  state.selectedUserPlaylist = { id, title };
  setStepUI(2);

  byId('selected-tidal-name').textContent = title;
  byId('confirm-link-btn').disabled = true;
  state.selectedSharedPlaylist = null;

  await loadSharedPlaylists();
}

// ---------------------------------------------------------------------------
// Step 2: Shared playlists
// ---------------------------------------------------------------------------

async function loadSharedPlaylists() {
  const container = byId('shared-playlists-list');
  container.innerHTML = '<div class="loading-row"><div class="spinner"></div>Loading shared playlists…</div>';

  try {
    const res = await fetchWithTimeout(`${state.serverUrl}/api/shared-playlists`, {}, 5_000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.sharedPlaylists = await res.json();
  } catch (err) {
    renderError(container, `Could not load shared playlists: ${err.message}`);
    return;
  }

  // Hide playlists the user is already linked to
  const linkedSharedIds = new Set(Object.keys(state.linkedMeta).map(Number));
  const available = state.sharedPlaylists.filter((p) => !linkedSharedIds.has(p.id));

  renderSharedPlaylists(container, available);
}

function renderSharedPlaylists(container, playlists) {
  if (playlists.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p class="empty-title">No shared playlists available</p>
        <p class="empty-sub">Ask your admin to create one in the web panel.</p>
      </div>`;
    return;
  }

  container.innerHTML = playlists.map((pl) => {
    const meta = [
      `${pl.user_count} user${pl.user_count !== 1 ? 's' : ''}`,
      `${pl.track_count} track${pl.track_count !== 1 ? 's' : ''}`,
    ].join(' · ');
    return `
      <div class="playlist-option" data-shared-id="${pl.id}" data-shared-name="${esc(pl.name)}" role="option" tabindex="0">
        <div class="playlist-option-body">
          <div class="playlist-option-name">${esc(pl.name)}</div>
          <div class="playlist-option-meta">${meta}${pl.description ? ' · ' + esc(pl.description.slice(0, 40)) : ''}</div>
        </div>
        <div class="playlist-option-check"></div>
      </div>`;
  }).join('');

  container.querySelectorAll('.playlist-option').forEach((el) => {
    el.addEventListener('click', () =>
      selectSharedPlaylist(Number(el.dataset.sharedId), el.dataset.sharedName, el),
    );
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ')
        selectSharedPlaylist(Number(el.dataset.sharedId), el.dataset.sharedName, el);
    });
  });
}

function selectSharedPlaylist(id, name, clickedEl) {
  // Deselect previous
  byId('shared-playlists-list')
    .querySelectorAll('.playlist-option.selected')
    .forEach((el) => el.classList.remove('selected'));

  clickedEl.classList.add('selected');
  state.selectedSharedPlaylist = { id, name };
  byId('confirm-link-btn').disabled = false;
}

// ---------------------------------------------------------------------------
// Confirm link  (step 2 → done)
// ---------------------------------------------------------------------------

async function confirmLink() {
  const { id: tidalPlaylistId, title: tidalName }    = state.selectedUserPlaylist;
  const { id: sharedPlaylistId, name: sharedName }   = state.selectedSharedPlaylist;
  const btn = byId('confirm-link-btn');

  if (!state.userId) {
    toast('Cannot link: user ID not captured yet — interact with the Tidal tab', 'error');
    return;
  }

  setLoadingBtn(btn, true);

  try {
    // 1. Create the server-side link record
    const res = await fetch(`${state.serverUrl}/api/links`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        sharedPlaylistId,
        userId:          state.userId,
        tidalPlaylistId,
      }),
    });

    const data = await res.json();

    // 409 = already linked on the server (e.g. from another device)
    if (res.status === 409) {
      // Proceed — just store the link locally if we don't have it
    } else if (!res.ok) {
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }

    const linkId      = data.link?.id ?? null;
    const serverTracks = data.tracks  ?? [];

    // 2. Tell the background worker to store the ID mapping
    await msgBackground('link_playlist', {
      sharedPlaylistId,
      tidalPlaylistId,
    });

    // 3. Persist display metadata locally
    const updatedMeta = {
      ...state.linkedMeta,
      [sharedPlaylistId]: { tidalPlaylistId, tidalName, sharedName, linkId },
    };
    state.linkedMeta = updatedMeta;
    await chrome.storage.local.set({ linkedPlaylistMeta: updatedMeta });

    // 4. Initial sync (non-fatal — sync may fail if Tidal token expired)
    if (serverTracks.length > 0) {
      try {
        await msgBackground('initial_sync', { sharedPlaylistId, serverTracks });
      } catch (err) {
        console.warn('[popup] initial_sync failed:', err.message);
        toast('Linked! Initial sync may be incomplete — tracks will sync on next change.', 'info');
      }
    }

    toast(`"${tidalName}" linked to "${sharedName}"`, 'success');
    showView('main');
    renderLinkedPlaylists();
    updateStatusBar();
  } catch (err) {
    toast(`Link failed: ${err.message}`, 'error');
    setLoadingBtn(btn, false);
  }
}

// ---------------------------------------------------------------------------
// Background worker messaging
// ---------------------------------------------------------------------------

/**
 * Send a typed message to the background service worker.
 * Wraps chrome.runtime.sendMessage with a friendly error on failure.
 */
async function msgBackground(type, payload = {}) {
  try {
    const response = await chrome.runtime.sendMessage({ type, ...payload });
    return response;
  } catch (err) {
    // "Could not establish connection" → worker was sleeping; wake it and retry once
    if (err.message?.includes('Could not establish connection')) {
      await new Promise((r) => setTimeout(r, 300));
      try {
        return await chrome.runtime.sendMessage({ type, ...payload });
      } catch (retryErr) {
        throw new Error('Extension not responding — try reloading');
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Toast notifications
// ---------------------------------------------------------------------------

function toast(message, type = 'info') {
  const container = byId('toast-container');
  const el        = document.createElement('div');
  el.className    = `toast toast-${type}`;
  el.innerHTML    = `<span>${esc(message)}</span>
    <button class="toast-dismiss" aria-label="Dismiss">&times;</button>`;

  el.querySelector('.toast-dismiss').addEventListener('click', () => el.remove());
  container.prepend(el); // newest on top

  setTimeout(() => el.classList.add('toast-fade'), 3_000);
  setTimeout(() => el.remove(), 3_400);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * fetch() with a hard timeout.
 */
function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

/** Toggle button loading state — shows spinner, hides label, disables button */
function setLoadingBtn(btn, loading) {
  const label   = btn.querySelector('.btn-label');
  const spinner = btn.querySelector('.btn-spinner');
  btn.disabled  = loading;
  if (label)   label.hidden   =  loading;
  if (spinner) spinner.hidden = !loading;
}

/** Render an inline error message into a container element */
function renderError(container, message) {
  container.innerHTML = `
    <div class="empty-state">
      <p class="empty-title" style="color:var(--danger)">Error</p>
      <p class="empty-sub">${esc(message)}</p>
    </div>`;
}

/** Escape HTML to prevent XSS */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Strip protocol for compact display */
function trimUrl(url) {
  return url.replace(/^https?:\/\//, '');
}

/** document.getElementById shorthand */
function byId(id) { return document.getElementById(id); }
