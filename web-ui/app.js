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
  // Auth
  userId:       null,
  displayName:  null,
  signedIn:     false,

  // Current view: 'signed-out' | 'my-playlists' | 'discover' | 'users' | 'admin'
  view: 'signed-out',

  // Admin data
  playlists: [],
  users:     [],

  // Users view data
  allUsers:      [],
  usersViewTimer: null,

  // My playlists (split by ownership)
  ownedLinks:  [],
  joinedLinks: [],

  // Discover
  discoverPlaylists: [],

  // Create modal
  createStep:          1,
  createVisibility:    'private',
  createSelectedTidal: null,  // { id, name }

  // Join modal (Discover tab)
  joinTargetPlaylist: null,  // { id, name }
  joinSelectedTidal:  null,  // { id, name }

  // Invite link modal (join via ?invite= param)
  resolvedInvite:   null,    // { sharedPlaylistId, sharedPlaylistName }
  linkSelectedTidal: null,   // { id, name }

  // Invites management modal
  currentInvitesPlaylistId: null,

  // WS
  ws:                 null,
  wsConnected:        false,
  wsDisconnectTimer:  null,
  pollTimer:          null,
  sessionCheckTimer:  null,
};

// ---------------------------------------------------------------------------
// API fetch wrapper
// ---------------------------------------------------------------------------

async function apiFetch(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 401 && state.signedIn) {
    state.userId      = null;
    state.displayName = null;
    state.signedIn    = false;
    if (state.ws) {
      state.ws.onclose = null;
      state.ws.close();
      state.ws = null;
    }
    clearInterval(state.pollTimer);
    clearInterval(state.sessionCheckTimer);
    clearInterval(state.usersViewTimer);
    state.usersViewTimer = null;
    showSignedOut();
    toast('Your session has expired — please sign in again.', 'error');
  }
  return res;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  // Check for invite code BEFORE auth redirect cleanup
  const params = new URLSearchParams(window.location.search);
  const inviteCode = params.get('invite');
  if (inviteCode) {
    sessionStorage.setItem('pending_invite', inviteCode.toUpperCase());
    history.replaceState({}, '', window.location.pathname);
  }

  // Handle OAuth redirect query params
  if (params.has('auth')) {
    const result = params.get('auth');
    if (result === 'ok') {
      toast('Signed in successfully!', 'success');
    } else if (result === 'error') {
      const reason = params.get('reason') ?? 'Unknown error';
      toast(`Sign-in failed: ${reason}`, 'error');
    }
    history.replaceState({}, '', '/');
  }

  // Wire up static event listeners
  document.getElementById('signin-btn').addEventListener('click', handleSignIn);
  document.getElementById('signout-btn').addEventListener('click', handleSignOut);
  document.getElementById('open-create-btn').addEventListener('click', openCreateModal);
  document.getElementById('refresh-btn').addEventListener('click', () => {
    refreshAdmin();
    toast('Refreshed', 'info');
  });
  document.getElementById('refresh-discover-btn').addEventListener('click', fetchDiscover);

  // Navigation tabs
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // PIN inputs (modal)
  initPinInputs();

  // Create modal controls
  document.getElementById('create-name').addEventListener('input', () => {
    document.getElementById('create-next-btn').disabled =
      !document.getElementById('create-name').value.trim();
  });
  document.querySelectorAll('input[name="create-visibility"]').forEach((radio) => {
    radio.addEventListener('change', (e) => { state.createVisibility = e.target.value; });
  });
  document.getElementById('create-next-btn').addEventListener('click', handleCreateNext);
  document.getElementById('create-back-btn').addEventListener('click', handleCreateBack);

  // Join modal (Discover)
  document.getElementById('join-confirm-btn').addEventListener('click', handleJoinConfirm);

  // Invite link modal (join via invite code)
  document.getElementById('link-confirm-btn').addEventListener('click', handleLinkConfirm);

  // Invites management modal
  document.getElementById('generate-invite-btn').addEventListener('click', handleGenerateInvite);

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

  // Show server version in header
  apiFetch(`${BASE_URL}/api/ping`).then((r) => r.json()).then((d) => {
    if (d.version) document.getElementById('app-version').textContent = `v${d.version}`;
  }).catch(() => {});

  // Run setup wizard check — calls checkAuth() when complete
  await initSetupWizard();
});

// ---------------------------------------------------------------------------
// Setup Wizard
// ---------------------------------------------------------------------------

async function initSetupWizard() {
  const overlay = document.getElementById('setup-overlay');

  document.getElementById('setup-next-btn').addEventListener('click', handleSetupNext);
  document.getElementById('setup-copy-uri').addEventListener('click', handleSetupCopy);
  initSetupPinInputs();
  goToSetupStep(1);

  let status;
  try {
    const res = await apiFetch(`${BASE_URL}/api/setup/status`);
    status = await res.json();
  } catch {
    status = { complete: false, clientIdSet: false, adminPinSet: false };
  }

  if (status.complete) {
    overlay.remove();
    await checkAuth();
    return;
  }

  const statusEl = document.getElementById('setup-step-1-status');
  if (statusEl) statusEl.innerHTML = '<div class="setup-check">✓</div>';

  setTimeout(() => {
    if (status.clientIdSet && !status.adminPinSet) {
      goToSetupStep(3);
    } else {
      goToSetupStep(2);
      loadSetupRedirectUri();
    }
  }, 800);
}

function goToSetupStep(n) {
  for (let i = 1; i <= 4; i++) {
    const el = document.getElementById(`setup-step-${i}`);
    if (el) el.hidden = (i !== n);
  }

  document.querySelectorAll('.setup-dot').forEach((dot) => {
    const dotStep = parseInt(dot.dataset.step, 10);
    dot.classList.toggle('active', dotStep <= Math.max(n - 1, 1));
  });

  const nextBtn = document.getElementById('setup-next-btn');

  if (n === 1) {
    nextBtn.hidden   = true;
    nextBtn.disabled = true;
  } else if (n === 2) {
    nextBtn.hidden   = false;
    nextBtn.disabled = true;
    nextBtn.textContent = 'Continue';
    const clientInput = document.getElementById('setup-client-id');
    clientInput.addEventListener('input', () => {
      nextBtn.disabled = !clientInput.value.trim();
    });
    setTimeout(() => clientInput.focus(), 60);
  } else if (n === 3) {
    nextBtn.hidden   = false;
    nextBtn.disabled = true;
    nextBtn.textContent = 'Continue';
    setTimeout(() => document.querySelector('.setup-pin-digit')?.focus(), 60);
  } else if (n === 4) {
    nextBtn.hidden   = false;
    nextBtn.disabled = false;
    nextBtn.textContent = 'Get started';
  }
}

async function loadSetupRedirectUri() {
  try {
    const res  = await apiFetch(`${BASE_URL}/api/setup/redirect-uri`);
    const data = await res.json();
    document.getElementById('setup-redirect-uri').textContent = data.redirectUri ?? '';
  } catch {
    document.getElementById('setup-redirect-uri').textContent = `${window.location.origin}/api/auth/callback`;
  }
}

function handleSetupCopy() {
  const uri = document.getElementById('setup-redirect-uri').textContent;
  if (!uri || uri === 'Loading…') return;
  navigator.clipboard.writeText(uri).then(() => {
    const btn = document.getElementById('setup-copy-uri');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
  }).catch(() => {});
}

async function handleSetupNext() {
  const nextBtn = document.getElementById('setup-next-btn');

  let currentStep = 2;
  for (let i = 2; i <= 4; i++) {
    const el = document.getElementById(`setup-step-${i}`);
    if (el && !el.hidden) { currentStep = i; break; }
  }

  if (currentStep === 2) {
    const clientId = document.getElementById('setup-client-id').value.trim();
    const errEl    = document.getElementById('setup-client-error');
    if (!clientId) return;

    nextBtn.disabled    = true;
    nextBtn.textContent = 'Saving…';
    errEl.textContent   = '';

    try {
      const res = await apiFetch(`${BASE_URL}/api/setup/tidal-client-id`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ clientId }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      goToSetupStep(3);
    } catch (err) {
      errEl.textContent   = err.message;
      nextBtn.disabled    = false;
      nextBtn.textContent = 'Continue';
    }

  } else if (currentStep === 3) {
    const pin   = getSetupPinValue();
    const errEl = document.getElementById('setup-pin-error');
    if (pin.length !== 4) return;

    nextBtn.disabled    = true;
    nextBtn.textContent = 'Saving…';
    errEl.textContent   = '';

    try {
      const res = await apiFetch(`${BASE_URL}/api/admin/setup`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ pin }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      goToSetupStep(4);
    } catch (err) {
      errEl.textContent   = err.message;
      nextBtn.disabled    = false;
      nextBtn.textContent = 'Continue';
    }

  } else if (currentStep === 4) {
    document.getElementById('setup-overlay').remove();
    await checkAuth();
  }
}

function getSetupPinValue() {
  return [...document.querySelectorAll('.setup-pin-digit')].map((el) => el.value).join('');
}

function initSetupPinInputs() {
  const digits  = [...document.querySelectorAll('.setup-pin-digit')];
  const nextBtn = document.getElementById('setup-next-btn');

  digits.forEach((input, i) => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(-1);
      if (input.value && i < digits.length - 1) digits[i + 1].focus();
      nextBtn.disabled = getSetupPinValue().length !== 4;
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value && i > 0) {
        digits[i - 1].focus();
      }
      if (e.key === 'Enter' && !nextBtn.disabled) nextBtn.click();
    });

    input.addEventListener('focus', () => input.select());
  });
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function checkAuth() {
  try {
    const res = await apiFetch(`${BASE_URL}/api/me`);
    if (res.status === 401) {
      showSignedOut();
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.userId      = data.userId;
    state.displayName = data.displayName;
    state.signedIn    = true;
    showSignedIn();
  } catch (err) {
    console.error('[app] checkAuth:', err.message);
    showSignedOut();
  }
}

async function handleSignIn() {
  const btn = document.getElementById('signin-btn');
  btn.disabled = true;
  btn.textContent = 'Redirecting…';

  try {
    const res  = await apiFetch(`${BASE_URL}/api/auth/start`);
    const data = await res.json();
    if (!data.authUrl) throw new Error('No auth URL returned');
    window.location.href = data.authUrl;
  } catch (err) {
    console.error('[app] handleSignIn:', err.message);
    const errEl = document.getElementById('auth-error');
    errEl.textContent = `Could not start sign-in: ${err.message}`;
    errEl.hidden = false;
    btn.disabled = false;
    btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/></svg> Sign in with Tidal`;
  }
}

async function handleSignOut() {
  try {
    await apiFetch(`${BASE_URL}/api/auth/logout`, { method: 'POST' });
  } catch { /* ignore */ }
  state.userId      = null;
  state.displayName = null;
  state.signedIn    = false;
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
    state.ws = null;
  }
  clearInterval(state.pollTimer);
  clearInterval(state.sessionCheckTimer);
  clearInterval(state.usersViewTimer);
  state.usersViewTimer = null;
  showSignedOut();
}

// ---------------------------------------------------------------------------
// View management
// ---------------------------------------------------------------------------

function showSignedOut() {
  document.getElementById('signed-out-view').hidden   = false;
  document.getElementById('my-playlists-view').hidden = true;
  document.getElementById('discover-view').hidden     = true;
  document.getElementById('users-view').hidden        = true;
  document.getElementById('admin-view').hidden        = true;
  document.getElementById('nav-tabs').hidden          = true;
  document.getElementById('tab-discover').hidden      = true;
  document.getElementById('user-display').hidden      = true;
  document.getElementById('signout-btn').hidden       = true;
  clearInterval(state.usersViewTimer);
  state.usersViewTimer = null;
  setWsStatus(false);
}

function showSignedIn() {
  document.getElementById('signed-out-view').hidden = true;
  document.getElementById('nav-tabs').hidden        = false;
  document.getElementById('tab-discover').hidden    = false;
  const userDisplay = document.getElementById('user-display');
  userDisplay.textContent = state.displayName ?? state.userId;
  userDisplay.hidden      = false;
  document.getElementById('signout-btn').hidden = false;

  // Check for pending invite from ?invite= URL param (survived OAuth redirect)
  const pendingInvite = sessionStorage.getItem('pending_invite');
  if (pendingInvite) {
    sessionStorage.removeItem('pending_invite');
    setTimeout(() => openInviteLinkModal(pendingInvite), 400);
  }

  switchView('my-playlists');
  connectWebSocket();
  state.pollTimer        = setInterval(refreshAdmin, POLL_MS);
  state.sessionCheckTimer = setInterval(() => apiFetch(`${BASE_URL}/api/me`), 2 * 60 * 1000);
}

async function switchView(viewName) {
  if (viewName === 'admin') {
    const ok = await ensureAdminAuthed();
    if (!ok) return;
  }

  if (state.view === 'users' && viewName !== 'users') {
    clearInterval(state.usersViewTimer);
    state.usersViewTimer = null;
  }

  state.view = viewName;

  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.classList.toggle('nav-tab-active', btn.dataset.view === viewName);
  });

  document.getElementById('my-playlists-view').hidden = viewName !== 'my-playlists';
  document.getElementById('discover-view').hidden     = viewName !== 'discover';
  document.getElementById('users-view').hidden        = viewName !== 'users';
  document.getElementById('admin-view').hidden        = viewName !== 'admin';

  if (viewName === 'my-playlists') {
    fetchMyPlaylists();
  } else if (viewName === 'discover') {
    fetchDiscover();
  } else if (viewName === 'users') {
    fetchAllUsers();
    state.usersViewTimer = setInterval(fetchAllUsers, 30_000);
  } else if (viewName === 'admin') {
    refreshAdmin();
  }
}

// ---------------------------------------------------------------------------
// Admin PIN
// ---------------------------------------------------------------------------

async function ensureAdminAuthed() {
  try {
    const res  = await apiFetch(`${BASE_URL}/api/admin/status`);
    const data = await res.json();
    if (data.authed) return true;
    openPinModal(data.pinSet);
    return false;
  } catch {
    return false;
  }
}

function openPinModal(pinSet) {
  const desc    = document.getElementById('pin-modal-desc');
  const title   = document.getElementById('pin-modal-title');
  const submitBtn = document.getElementById('pin-submit-btn');
  const errEl   = document.getElementById('pin-error');

  if (pinSet) {
    title.textContent = 'Admin Access';
    desc.textContent  = 'Enter the 4-digit admin PIN';
    submitBtn.querySelector('.btn-label').textContent = 'Unlock';
  } else {
    title.textContent = 'Set Admin PIN';
    desc.textContent  = 'Choose a 4-digit PIN to protect the admin panel';
    submitBtn.querySelector('.btn-label').textContent = 'Set PIN';
  }

  errEl.hidden      = true;
  errEl.textContent = '';
  submitBtn.disabled = true;
  submitBtn.dataset.pinSet = pinSet ? '1' : '0';

  document.querySelectorAll('#pin-inputs .pin-digit').forEach((el) => { el.value = ''; });

  openModal('pin-modal');
  setTimeout(() => document.querySelector('#pin-inputs .pin-digit')?.focus(), 60);
}

function getPinValue() {
  return [...document.querySelectorAll('#pin-inputs .pin-digit')].map((el) => el.value).join('');
}

function initPinInputs() {
  const digits  = [...document.querySelectorAll('#pin-inputs .pin-digit')];
  const submitBtn = document.getElementById('pin-submit-btn');

  digits.forEach((input, i) => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(-1);
      if (input.value && i < digits.length - 1) digits[i + 1].focus();
      submitBtn.disabled = getPinValue().length !== 4;
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value && i > 0) {
        digits[i - 1].focus();
      }
      if (e.key === 'Enter' && !submitBtn.disabled) submitBtn.click();
    });

    input.addEventListener('focus', () => input.select());
  });

  submitBtn.addEventListener('click', handlePinSubmit);
}

async function handlePinSubmit() {
  const pin     = getPinValue();
  const errEl   = document.getElementById('pin-error');
  const submitBtn = document.getElementById('pin-submit-btn');
  const pinSet  = submitBtn.dataset.pinSet === '1';
  const endpoint = pinSet ? '/api/admin/auth' : '/api/admin/setup';

  errEl.hidden = true;
  setLoadingBtn(submitBtn, true);

  try {
    const res  = await apiFetch(`${BASE_URL}${endpoint}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ pin }),
    });
    const data = await res.json();

    if (!res.ok) {
      errEl.textContent = data.error ?? 'Incorrect PIN';
      errEl.hidden      = false;
      document.querySelectorAll('#pin-inputs .pin-digit').forEach((el) => { el.value = ''; });
      submitBtn.disabled = true;
      document.querySelector('#pin-inputs .pin-digit')?.focus();
      return;
    }

    closeModal('pin-modal');
    clearInterval(state.usersViewTimer);
    state.usersViewTimer = null;
    state.view = 'admin';
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.classList.toggle('nav-tab-active', btn.dataset.view === 'admin');
    });
    document.getElementById('my-playlists-view').hidden = true;
    document.getElementById('discover-view').hidden     = true;
    document.getElementById('users-view').hidden        = true;
    document.getElementById('admin-view').hidden        = false;
    refreshAdmin();
  } catch (err) {
    errEl.textContent = 'Network error — try again';
    errEl.hidden      = false;
  } finally {
    setLoadingBtn(submitBtn, false);
  }
}

// ---------------------------------------------------------------------------
// My Playlists view
// ---------------------------------------------------------------------------

async function fetchMyPlaylists() {
  try {
    const [linksRes, playlistsRes] = await Promise.all([
      apiFetch(`${BASE_URL}/api/links`),
      apiFetch(`${BASE_URL}/api/shared-playlists`),
    ]);

    if (!linksRes.ok) throw new Error(`HTTP ${linksRes.status}`);
    if (!playlistsRes.ok) throw new Error(`HTTP ${playlistsRes.status}`);

    const links     = await linksRes.json();
    const playlists = await playlistsRes.json();

    state.ownedLinks  = links.filter((l) => l.playlist_created_by === state.userId);
    state.joinedLinks = links.filter((l) => l.playlist_created_by !== state.userId);

    // Owned playlists with no link yet (edge case)
    const linkedSharedIds = new Set(links.map((l) => l.shared_playlist_id));
    const unlinkedOwned   = playlists.filter(
      (p) => p.created_by === state.userId && !linkedSharedIds.has(p.id),
    );

    renderOwnedPlaylists(state.ownedLinks, unlinkedOwned);
    renderJoinedPlaylists(state.joinedLinks);
  } catch (err) {
    console.error('[app] fetchMyPlaylists:', err.message);
    const errHtml = `<div class="empty-state"><p class="empty-title">Failed to load playlists</p><p class="empty-sub">${escHtml(err.message)}</p></div>`;
    document.getElementById('owned-playlists-list').innerHTML  = errHtml;
    document.getElementById('joined-playlists-list').innerHTML = errHtml;
  }
}

function renderOwnedPlaylists(links, unlinked) {
  const el = document.getElementById('owned-playlists-list');

  if (links.length === 0 && unlinked.length === 0) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎵</div>
        <p class="empty-title">No playlists yet</p>
        <p class="empty-sub">Click <strong>New Playlist</strong> to create your first one.</p>
      </div>`;
    return;
  }

  const linkedCards = links.map((link) => {
    const isPrivate = !link.playlist_is_public;
    const visBadge  = isPrivate
      ? '<span class="badge-private">🔒 Private</span>'
      : '<span class="badge-public">🌍 Public</span>';
    const visBtn = isPrivate
      ? `<button class="btn btn-ghost btn-sm btn-xs" data-toggle-vis="${link.shared_playlist_id}" data-is-public="0">Make Public</button>`
      : `<button class="btn btn-ghost btn-sm btn-xs" data-toggle-vis="${link.shared_playlist_id}" data-is-public="1">Make Private</button>`;
    const inviteBtn = isPrivate
      ? `<button class="btn btn-ghost btn-sm btn-xs" data-invites="${link.shared_playlist_id}" data-invites-name="${escHtml(link.shared_playlist_name)}">Invite Link</button>`
      : '';

    return `
      <div class="link-card">
        <div class="link-card-body">
          <div class="link-arrow">
            <span class="link-name shared-name">${escHtml(link.shared_playlist_name)}</span>
            ${visBadge}
          </div>
          <div class="link-arrow">
            <span class="link-name tidal-name">${escHtml(link.tidal_playlist_name || link.tidal_playlist_id)}</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            <span class="link-name" style="color:var(--text-muted)">syncing</span>
          </div>
          <p class="link-meta">Linked ${formatDate(link.created_at)}</p>
        </div>
        <div class="link-card-actions" style="flex-wrap:wrap;gap:0.35rem">
          <button class="btn btn-secondary btn-sm btn-xs" data-sync="${link.id}">Sync</button>
          ${inviteBtn}
          ${visBtn}
          <button class="btn btn-danger btn-sm btn-xs" data-delete-pl="${link.shared_playlist_id}" data-delete-pl-name="${escHtml(link.shared_playlist_name)}" data-armed="false">Delete</button>
        </div>
      </div>`;
  });

  const unlinkedCards = unlinked.map((pl) => {
    const isPrivate = !pl.is_public;
    const visBadge  = isPrivate
      ? '<span class="badge-private">🔒 Private</span>'
      : '<span class="badge-public">🌍 Public</span>';
    const visBtn = isPrivate
      ? `<button class="btn btn-ghost btn-sm btn-xs" data-toggle-vis="${pl.id}" data-is-public="0">Make Public</button>`
      : `<button class="btn btn-ghost btn-sm btn-xs" data-toggle-vis="${pl.id}" data-is-public="1">Make Private</button>`;
    const inviteBtn = isPrivate
      ? `<button class="btn btn-ghost btn-sm btn-xs" data-invites="${pl.id}" data-invites-name="${escHtml(pl.name)}">Invite Link</button>`
      : '';
    return `
      <div class="link-card">
        <div class="link-card-body">
          <div class="link-arrow">
            <span class="link-name shared-name">${escHtml(pl.name)}</span>
            ${visBadge}
          </div>
          <p class="link-meta">Not linked to a Tidal playlist · Created ${formatDate(pl.created_at)}</p>
        </div>
        <div class="link-card-actions" style="flex-wrap:wrap;gap:0.35rem">
          ${inviteBtn}
          ${visBtn}
          <button class="btn btn-danger btn-sm btn-xs" data-delete-pl="${pl.id}" data-delete-pl-name="${escHtml(pl.name)}" data-armed="false">Delete</button>
        </div>
      </div>`;
  });

  el.innerHTML = [...linkedCards, ...unlinkedCards].join('');

  el.querySelectorAll('[data-sync]').forEach((btn) => {
    btn.addEventListener('click', () => handleSync(parseInt(btn.dataset.sync, 10), btn));
  });
  el.querySelectorAll('[data-invites]').forEach((btn) => {
    btn.addEventListener('click', () =>
      openInvitesModal(parseInt(btn.dataset.invites, 10), btn.dataset.invitesName));
  });
  el.querySelectorAll('[data-toggle-vis]').forEach((btn) => {
    btn.addEventListener('click', () =>
      handleToggleVisibility(parseInt(btn.dataset.toggleVis, 10), btn.dataset.isPublic === '1', btn));
  });
  el.querySelectorAll('[data-delete-pl]').forEach((btn) => {
    btn.addEventListener('click', () =>
      handleDeletePlaylist(parseInt(btn.dataset.deletePl, 10), btn.dataset.deletePlName, btn));
  });
}

function renderJoinedPlaylists(links) {
  const el = document.getElementById('joined-playlists-list');

  if (links.length === 0) {
    el.innerHTML = `
      <div class="empty-state">
        <p class="empty-title">No joined playlists</p>
        <p class="empty-sub">Browse the <strong>Discover</strong> tab or use an invite link to join a playlist.</p>
      </div>`;
    return;
  }

  el.innerHTML = links.map((link) => `
    <div class="link-card">
      <div class="link-card-body">
        <div class="link-arrow">
          <span class="link-name tidal-name">${escHtml(link.tidal_playlist_name || link.tidal_playlist_id)}</span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M5 12h14M12 5l7 7-7 7"/>
          </svg>
          <span class="link-name shared-name">${escHtml(link.shared_playlist_name)}</span>
        </div>
        <p class="link-meta">Linked ${formatDate(link.created_at)}</p>
      </div>
      <div class="link-card-actions">
        <button class="btn btn-secondary btn-sm" data-sync="${link.id}">Sync</button>
        <button class="btn btn-danger btn-sm" data-unlink="${link.id}" data-armed="false">Unlink</button>
      </div>
    </div>`).join('');

  el.querySelectorAll('[data-sync]').forEach((btn) => {
    btn.addEventListener('click', () => handleSync(parseInt(btn.dataset.sync, 10), btn));
  });
  el.querySelectorAll('[data-unlink]').forEach((btn) => {
    btn.addEventListener('click', () => handleUnlink(parseInt(btn.dataset.unlink, 10), btn));
  });
}

async function handleUnlink(linkId, btn) {
  if (btn.dataset.armed !== 'true') {
    btn.dataset.armed = 'true';
    btn.textContent   = 'Confirm?';
    setTimeout(() => {
      if (btn.dataset.armed === 'true') {
        btn.dataset.armed = 'false';
        btn.textContent   = 'Unlink';
      }
    }, 3000);
    return;
  }

  btn.disabled    = true;
  btn.textContent = 'Unlinking…';

  try {
    const res = await apiFetch(`${BASE_URL}/api/links/${linkId}`, { method: 'DELETE' });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error ?? `HTTP ${res.status}`);
    }
    toast('Playlist unlinked', 'info');
    await fetchMyPlaylists();
  } catch (err) {
    toast(`Unlink failed: ${err.message}`, 'error');
    btn.disabled      = false;
    btn.textContent   = 'Unlink';
    btn.dataset.armed = 'false';
  }
}

async function handleSync(linkId, btn) {
  btn.disabled    = true;
  btn.textContent = 'Syncing…';

  try {
    const res = await apiFetch(`${BASE_URL}/api/links/${linkId}/sync`, { method: 'POST' });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error ?? `HTTP ${res.status}`);
    }
    const { added, merged, duplicatesFixed } = await res.json();

    if (added === 0 && merged === 0 && duplicatesFixed === 0) {
      toast('Already in sync', 'info');
    } else {
      const parts = [];
      if (added > 0)           parts.push(`+${added} added to playlist`);
      if (merged > 0)          parts.push(`+${merged} merged to server`);
      if (duplicatesFixed > 0) parts.push(`${duplicatesFixed} dupes fixed`);
      toast(`Synced: ${parts.join(', ')}`, 'success');
    }
  } catch (err) {
    toast(`Sync failed: ${err.message}`, 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Sync';
  }
}

async function handleDeletePlaylist(id, name, btn) {
  if (btn.dataset.armed !== 'true') {
    btn.dataset.armed = 'true';
    btn.textContent   = 'Confirm?';
    setTimeout(() => {
      if (btn.dataset.armed === 'true') {
        btn.dataset.armed = 'false';
        btn.textContent   = 'Delete';
      }
    }, 3000);
    return;
  }

  btn.disabled    = true;
  btn.textContent = 'Deleting…';

  try {
    const res = await apiFetch(`${BASE_URL}/api/shared-playlists/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error ?? `HTTP ${res.status}`);
    }
    toast(`"${name}" deleted`, 'info');
    await fetchMyPlaylists();
  } catch (err) {
    toast(`Delete failed: ${err.message}`, 'error');
    btn.disabled      = false;
    btn.textContent   = 'Delete';
    btn.dataset.armed = 'false';
  }
}

async function handleToggleVisibility(id, currentlyPublic, btn) {
  const newIsPublic = !currentlyPublic;
  btn.disabled = true;

  try {
    const res = await apiFetch(`${BASE_URL}/api/shared-playlists/${id}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ isPublic: newIsPublic }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error ?? `HTTP ${res.status}`);
    }
    toast(newIsPublic ? 'Playlist is now public' : 'Playlist is now private', 'success');
    await fetchMyPlaylists();
  } catch (err) {
    toast(`Failed to update visibility: ${err.message}`, 'error');
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Discover view
// ---------------------------------------------------------------------------

async function fetchDiscover() {
  const list = document.getElementById('discover-list');
  list.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>Loading…</span></div>';

  try {
    const res = await apiFetch(`${BASE_URL}/api/shared-playlists/discover`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.discoverPlaylists = await res.json();
    renderDiscover();
  } catch (err) {
    list.innerHTML = `<div class="empty-state"><p class="empty-title">Failed to load</p><p class="empty-sub">${escHtml(err.message)}</p></div>`;
  }
}

function renderDiscover() {
  const list = document.getElementById('discover-list');

  if (state.discoverPlaylists.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🌍</div>
        <p class="empty-title">Nothing to discover yet</p>
        <p class="empty-sub">Public playlists from other users will appear here.</p>
      </div>`;
    return;
  }

  list.innerHTML = state.discoverPlaylists.map((pl) => `
    <div class="link-card">
      <div class="link-card-body">
        <div class="link-arrow">
          <span class="link-name shared-name">${escHtml(pl.name)}</span>
          <span class="badge-public">🌍 Public</span>
        </div>
        ${pl.description ? `<p class="link-meta">${escHtml(pl.description)}</p>` : ''}
        <p class="link-meta">${pl.track_count} track${pl.track_count !== 1 ? 's' : ''} · ${pl.user_count} user${pl.user_count !== 1 ? 's' : ''}</p>
      </div>
      <div class="link-card-actions">
        <button class="btn btn-primary btn-sm" data-join="${pl.id}" data-join-name="${escHtml(pl.name)}">Join</button>
      </div>
    </div>`).join('');

  list.querySelectorAll('[data-join]').forEach((btn) => {
    btn.addEventListener('click', () =>
      openJoinModal(parseInt(btn.dataset.join, 10), btn.dataset.joinName));
  });
}

// ---------------------------------------------------------------------------
// Create Playlist Modal (two-step)
// ---------------------------------------------------------------------------

function openCreateModal() {
  state.createStep          = 1;
  state.createVisibility    = 'private';
  state.createSelectedTidal = null;

  // Reset step 1
  document.getElementById('create-name').value = '';
  document.getElementById('create-desc').value = '';
  document.querySelector('input[name="create-visibility"][value="private"]').checked = true;
  document.getElementById('create-error').textContent = '';

  // Show step 1, hide step 2
  document.getElementById('create-step-1').hidden = false;
  document.getElementById('create-step-2').hidden = true;
  document.getElementById('create-back-btn').hidden = true;
  document.getElementById('create-next-btn').textContent = 'Next';
  document.getElementById('create-next-btn').disabled = true;

  openModal('create-modal');
  setTimeout(() => document.getElementById('create-name').focus(), 60);
}

async function handleCreateNext() {
  if (state.createStep === 1) {
    const name = document.getElementById('create-name').value.trim();
    if (!name) {
      document.getElementById('create-error').textContent = 'Name is required.';
      return;
    }
    document.getElementById('create-error').textContent = '';
    state.createStep = 2;

    document.getElementById('create-step-1').hidden = false; // keep visible briefly
    document.getElementById('create-step-1').hidden = true;
    document.getElementById('create-step-2').hidden = false;
    document.getElementById('create-back-btn').hidden = false;
    document.getElementById('create-next-btn').textContent = 'Create';
    document.getElementById('create-next-btn').disabled = true;
    state.createSelectedTidal = null;

    // Load Tidal playlists
    await loadTidalPlaylistsInto('create-tidal-list', (pl) => {
      state.createSelectedTidal = pl;
      document.getElementById('create-next-btn').disabled = false;
    });

  } else {
    // Step 2 — submit
    if (!state.createSelectedTidal) return;

    const btn  = document.getElementById('create-next-btn');
    const name = document.getElementById('create-name').value.trim();
    const desc = document.getElementById('create-desc').value.trim() || null;

    btn.disabled    = true;
    btn.textContent = 'Creating…';

    try {
      const res = await apiFetch(`${BASE_URL}/api/shared-playlists`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          name,
          description:       desc,
          isPublic:          state.createVisibility === 'public',
          tidalPlaylistId:   state.createSelectedTidal.id,
          tidalPlaylistName: state.createSelectedTidal.name,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

      closeModal('create-modal');
      toast(`"${name}" created`, 'success');
      await fetchMyPlaylists();
    } catch (err) {
      toast(`Create failed: ${err.message}`, 'error');
      btn.disabled    = false;
      btn.textContent = 'Create';
    }
  }
}

function handleCreateBack() {
  state.createStep = 1;
  document.getElementById('create-step-1').hidden = false;
  document.getElementById('create-step-2').hidden = true;
  document.getElementById('create-back-btn').hidden = true;
  document.getElementById('create-next-btn').textContent = 'Next';
  document.getElementById('create-next-btn').disabled =
    !document.getElementById('create-name').value.trim();
}

// ---------------------------------------------------------------------------
// Join Modal (Discover tab — join a public playlist)
// ---------------------------------------------------------------------------

async function openJoinModal(playlistId, playlistName) {
  state.joinTargetPlaylist = { id: playlistId, name: playlistName };
  state.joinSelectedTidal  = null;

  document.getElementById('join-modal-subtitle').textContent = playlistName;
  document.getElementById('join-confirm-btn').disabled = true;

  openModal('join-modal');

  await loadTidalPlaylistsInto('join-tidal-list', (pl) => {
    state.joinSelectedTidal = pl;
    document.getElementById('join-confirm-btn').disabled = false;
  });
}

async function handleJoinConfirm() {
  if (!state.joinTargetPlaylist || !state.joinSelectedTidal) return;

  const btn = document.getElementById('join-confirm-btn');
  btn.disabled    = true;
  btn.textContent = 'Joining…';

  try {
    const res = await apiFetch(`${BASE_URL}/api/links`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        sharedPlaylistId:  state.joinTargetPlaylist.id,
        tidalPlaylistId:   state.joinSelectedTidal.id,
        tidalPlaylistName: state.joinSelectedTidal.name,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

    closeModal('join-modal');
    toast(`Joined "${state.joinTargetPlaylist.name}"`, 'success');
    // Refresh both discover (to remove joined) and my playlists (to show new link)
    await Promise.allSettled([fetchDiscover(), fetchMyPlaylists()]);
  } catch (err) {
    toast(`Join failed: ${err.message}`, 'error');
    btn.disabled    = false;
    btn.textContent = 'Join';
  }
}

// ---------------------------------------------------------------------------
// Invite Link Modal (join via ?invite= URL or manually entered code)
// ---------------------------------------------------------------------------

async function openInviteLinkModal(code) {
  state.resolvedInvite   = null;
  state.linkSelectedTidal = null;

  document.getElementById('link-modal-title').textContent    = 'Join with Invite';
  document.getElementById('link-modal-subtitle').textContent = 'Validating invite code…';
  document.getElementById('link-confirm-btn').disabled       = true;
  document.getElementById('link-tidal-list').innerHTML =
    '<div class="loading-state"><div class="spinner"></div><span>Validating…</span></div>';

  openModal('link-modal');

  try {
    const res = await apiFetch(`${BASE_URL}/api/invites/${encodeURIComponent(code)}`);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      closeModal('link-modal');
      toast(`Invalid invite: ${d.error ?? 'Code not found'}`, 'error');
      return;
    }
    const { sharedPlaylistId, sharedPlaylistName } = await res.json();
    state.resolvedInvite = { sharedPlaylistId, sharedPlaylistName, code };

    document.getElementById('link-modal-subtitle').textContent = sharedPlaylistName;

    await loadTidalPlaylistsInto('link-tidal-list', (pl) => {
      state.linkSelectedTidal = pl;
      document.getElementById('link-confirm-btn').disabled = false;
    });
  } catch (err) {
    closeModal('link-modal');
    toast(`Failed to validate invite: ${err.message}`, 'error');
  }
}

async function handleLinkConfirm() {
  if (!state.resolvedInvite || !state.linkSelectedTidal) return;

  const btn = document.getElementById('link-confirm-btn');
  btn.disabled    = true;
  btn.textContent = 'Joining…';

  try {
    const res = await apiFetch(`${BASE_URL}/api/links`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        inviteCode:        state.resolvedInvite.code,
        tidalPlaylistId:   state.linkSelectedTidal.id,
        tidalPlaylistName: state.linkSelectedTidal.name,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

    closeModal('link-modal');
    toast(`Joined "${state.resolvedInvite.sharedPlaylistName}"`, 'success');
    await fetchMyPlaylists();
  } catch (err) {
    toast(`Join failed: ${err.message}`, 'error');
    btn.disabled    = false;
    btn.textContent = 'Join Playlist';
  }
}

// ---------------------------------------------------------------------------
// Invites Management Modal
// ---------------------------------------------------------------------------

async function openInvitesModal(playlistId, playlistName) {
  state.currentInvitesPlaylistId = playlistId;

  document.getElementById('invites-modal-subtitle').textContent = playlistName;
  document.getElementById('invites-modal-body').innerHTML =
    '<div class="loading-state"><div class="spinner"></div><span>Loading…</span></div>';

  openModal('invites-modal');
  await loadInvites(playlistId);
}

async function loadInvites(playlistId) {
  const body = document.getElementById('invites-modal-body');
  try {
    const res = await apiFetch(`${BASE_URL}/api/shared-playlists/${playlistId}/invites`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const invites = await res.json();
    renderInvites(invites);
  } catch (err) {
    body.innerHTML = `<div class="empty-state"><p class="empty-title">Failed to load invite links</p><p class="empty-sub">${escHtml(err.message)}</p></div>`;
  }
}

function renderInvites(invites) {
  const body = document.getElementById('invites-modal-body');

  if (invites.length === 0) {
    body.innerHTML = `
      <div class="empty-state">
        <p class="empty-title">No invite links yet</p>
        <p class="empty-sub">Click <strong>+ New Link</strong> to generate a shareable invite.</p>
      </div>`;
    return;
  }

  body.innerHTML = invites.map((inv) => {
    const url = `${BASE_URL}/?invite=${inv.code}`;
    return `
      <div class="invite-row">
        <span class="invite-code">${escHtml(inv.code)}</span>
        <span class="invite-url">${escHtml(url)}</span>
        <button class="btn btn-ghost btn-sm btn-xs" data-copy-url="${escHtml(url)}">Copy</button>
        <button class="btn btn-danger btn-sm btn-xs" data-revoke-invite="${inv.id}">Revoke</button>
      </div>`;
  }).join('');

  body.querySelectorAll('[data-copy-url]').forEach((btn) => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.copyUrl).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = orig; }, 2000);
      }).catch(() => toast('Could not copy to clipboard', 'error'));
    });
  });

  body.querySelectorAll('[data-revoke-invite]').forEach((btn) => {
    btn.addEventListener('click', () =>
      handleRevokeInvite(parseInt(btn.dataset.revokeInvite, 10), btn));
  });
}

async function handleGenerateInvite() {
  const id  = state.currentInvitesPlaylistId;
  if (!id) return;

  const btn = document.getElementById('generate-invite-btn');
  btn.disabled    = true;
  btn.textContent = 'Generating…';

  try {
    const res = await apiFetch(`${BASE_URL}/api/shared-playlists/${id}/invites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error ?? `HTTP ${res.status}`);
    }
    toast('New invite link created', 'success');
    await loadInvites(id);
  } catch (err) {
    toast(`Failed to create invite: ${err.message}`, 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = '+ New Link';
  }
}

async function handleRevokeInvite(inviteId, btn) {
  btn.disabled    = true;
  btn.textContent = '…';

  try {
    const res = await apiFetch(`${BASE_URL}/api/invites/${inviteId}`, { method: 'DELETE' });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error ?? `HTTP ${res.status}`);
    }
    toast('Invite link revoked', 'info');
    await loadInvites(state.currentInvitesPlaylistId);
  } catch (err) {
    toast(`Failed to revoke: ${err.message}`, 'error');
    btn.disabled    = false;
    btn.textContent = 'Revoke';
  }
}

// ---------------------------------------------------------------------------
// Tidal playlist loader (shared helper)
// ---------------------------------------------------------------------------

async function loadTidalPlaylistsInto(listElId, onSelect) {
  const listEl = document.getElementById(listElId);
  listEl.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>Loading your Tidal playlists…</span></div>';

  try {
    const res = await apiFetch(`${BASE_URL}/api/tidal/playlists`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    const data = await res.json();

    if (data.length === 0) {
      listEl.innerHTML = '<div class="empty-state"><p class="empty-title">No Tidal playlists found</p><p class="empty-sub">Create a playlist in Tidal first.</p></div>';
      return;
    }

    listEl.innerHTML = data.map((pl) => {
      const name  = pl.attributes?.name ?? pl.attributes?.title ?? pl.id;
      const count = pl.attributes?.numberOfItems ?? pl.attributes?.numberOfTracks ?? '';
      return `
        <button class="select-item" data-id="${escHtml(pl.id)}" data-name="${escHtml(name)}">
          <span class="select-item-name">${escHtml(name)}</span>
          ${count !== '' ? `<span class="select-item-meta">${count} tracks</span>` : ''}
        </button>`;
    }).join('');

    listEl.querySelectorAll('.select-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        listEl.querySelectorAll('.select-item').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        onSelect({ id: btn.dataset.id, name: btn.dataset.name });
      });
    });
  } catch (err) {
    listEl.innerHTML = `<div class="empty-state"><p class="empty-title">Failed to load Tidal playlists</p><p class="empty-sub">${escHtml(err.message)}</p></div>`;
  }
}

// ---------------------------------------------------------------------------
// Admin view
// ---------------------------------------------------------------------------

async function refreshAdmin() {
  await Promise.allSettled([fetchPlaylists(), fetchUsers()]);
}

async function fetchPlaylists() {
  try {
    const res = await apiFetch(`${BASE_URL}/api/shared-playlists`);
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
    const res = await apiFetch(`${BASE_URL}/api/users`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.users = await res.json();
    renderUsers();
    renderStats();
  } catch (err) {
    console.error('[app] fetchUsers:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Users view
// ---------------------------------------------------------------------------

async function fetchAllUsers() {
  try {
    const res = await apiFetch(`${BASE_URL}/api/users/all`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.allUsers = await res.json();
    renderAllUsers();
  } catch (err) {
    console.error('[app] fetchAllUsers:', err.message);
  }
}

function renderAllUsers() {
  const el  = document.getElementById('all-users-list');
  if (!el) return;

  if (state.allUsers.length === 0) {
    el.innerHTML = `<div class="empty-state"><p class="empty-title">No users have signed in yet</p></div>`;
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const rows = state.allUsers.map((u) => {
    let badgeClass, badgeLabel;
    if (u.last_seen == null) {
      badgeClass = 'badge-offline'; badgeLabel = 'Offline';
    } else if (now - u.last_seen < 300) {
      badgeClass = 'badge-online';  badgeLabel = 'Online';
    } else if (now - u.last_seen < 1800) {
      badgeClass = 'badge-away';    badgeLabel = 'Away';
    } else {
      badgeClass = 'badge-offline'; badgeLabel = 'Offline';
    }
    const lastSeenText = u.last_seen != null ? timeAgo(u.last_seen) : 'Never';
    const linkedText   = u.linked_count > 0 ? `${u.linked_count} linked` : 'None';
    return `
      <tr>
        <td>${escHtml(u.display_name || u.user_id)}</td>
        <td class="text-muted">${linkedText}</td>
        <td class="text-muted">${lastSeenText}</td>
        <td><span class="status-badge ${badgeClass}">${badgeLabel}</span></td>
      </tr>`;
  }).join('');

  el.innerHTML = `
    <table class="users-table">
      <thead>
        <tr>
          <th>User</th>
          <th>Playlists</th>
          <th>Last Seen</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

async function fetchTracks(playlistId) {
  const res = await apiFetch(`${BASE_URL}/api/shared-playlists/${playlistId}/tracks`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchLinkedUsers(playlistId) {
  const res = await apiFetch(`${BASE_URL}/api/shared-playlists/${playlistId}/linked-users`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Render: Stats
// ---------------------------------------------------------------------------

function renderStats() {
  const totalPlaylists = state.playlists.length;
  const totalTracks    = state.playlists.reduce((s, p) => s + (p.track_count ?? 0), 0);
  const linkedUsers    = new Set(state.users.map((u) => u.user_id)).size;
  const fiveMinsAgo   = Math.floor(Date.now() / 1000) - 300;
  const onlineCount   = state.users.filter((u) => u.last_seen >= fiveMinsAgo).length;

  setElText('stat-playlists', totalPlaylists);
  setElText('stat-tracks',    totalTracks);
  setElText('stat-users',     linkedUsers);
  setElText('stat-online',    onlineCount);
}

// ---------------------------------------------------------------------------
// Render: Playlists (admin grid)
// ---------------------------------------------------------------------------

function renderPlaylists() {
  const grid = document.getElementById('playlists-grid');

  if (state.playlists.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <div class="empty-icon">🎵</div>
        <p class="empty-title">No shared playlists yet</p>
        <p class="empty-sub">Users can create playlists from the <strong>My Playlists</strong> tab.</p>
      </div>`;
    return;
  }

  grid.innerHTML = state.playlists.map(playlistCardHTML).join('');

  grid.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => openViewModal(Number(btn.dataset.view)));
  });

  grid.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', () => handleAdminDelete(Number(btn.dataset.delete), btn));
  });
}

function playlistCardHTML(pl) {
  const descHTML = pl.description
    ? `<p class="card-desc">${escHtml(pl.description)}</p>`
    : '';
  const visBadge = pl.is_public
    ? '<span class="badge-public" style="font-size:0.7rem">🌍 Public</span>'
    : '<span class="badge-private" style="font-size:0.7rem">🔒 Private</span>';

  return `
    <div class="playlist-card" data-id="${pl.id}">
      <div class="card-body">
        <div class="card-icon">🎵</div>
        <h3 class="card-title">${escHtml(pl.name)} ${visBadge}</h3>
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
// Render: Users (admin)
// ---------------------------------------------------------------------------

function renderUsers() {
  const list = document.getElementById('users-list');

  if (state.users.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <p class="empty-title">No users have connected yet</p>
        <p class="empty-sub">Users appear here after they sign in and link a playlist.</p>
      </div>`;
    return;
  }

  const rows = state.users.map((u) => {
    const fiveMinsAgo = Math.floor(Date.now() / 1000) - 300;
    const isOnline    = u.last_seen >= fiveMinsAgo;
    return `
      <tr>
        <td>${escHtml(u.display_name)}</td>
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
          <th>User</th>
          <th>Playlist</th>
          <th>Last Seen</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ---------------------------------------------------------------------------
// Admin: Delete Playlist (two-click)
// ---------------------------------------------------------------------------

async function handleAdminDelete(id, btn) {
  const pl   = state.playlists.find((p) => p.id === id);
  const name = pl?.name ?? `Playlist #${id}`;

  if (btn.dataset.armed !== 'true') {
    btn.dataset.armed = 'true';
    btn.textContent   = 'Confirm?';
    setTimeout(() => {
      if (btn.dataset.armed === 'true') {
        btn.dataset.armed = 'false';
        btn.textContent   = 'Delete';
      }
    }, 3000);
    return;
  }

  btn.disabled    = true;
  btn.textContent = 'Deleting…';

  try {
    const res = await apiFetch(`${BASE_URL}/api/shared-playlists/${id}`, { method: 'DELETE' });
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
// View Playlist Modal (admin)
// ---------------------------------------------------------------------------

async function openViewModal(id) {
  const pl = state.playlists.find((p) => p.id === id);
  if (!pl) return;

  document.getElementById('view-modal-title').textContent    = pl.name;
  document.getElementById('view-modal-subtitle').textContent =
    `${pl.track_count} track${pl.track_count !== 1 ? 's' : ''} · ${pl.user_count} user${pl.user_count !== 1 ? 's' : ''}`;

  document.getElementById('view-modal-body').innerHTML = `
    <div class="view-modal-tabs">
      <button class="tab-button tab-active" data-tab="tracks">Tracks</button>
      <button class="tab-button" data-tab="users">Linked Users</button>
    </div>
    <div id="tab-tracks" class="tab-content">
      <div class="loading-state"><div class="spinner"></div><span>Loading tracks…</span></div>
    </div>
    <div id="tab-users" class="tab-content" style="display:none">
      <div class="loading-state"><div class="spinner"></div><span>Loading users…</span></div>
    </div>`;

  openModal('view-modal');

  document.querySelectorAll('.tab-button').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab, id));
  });

  try {
    const tracks = await fetchTracks(id);
    renderTracksInModal(tracks, pl);
  } catch (err) {
    document.getElementById('tab-tracks').innerHTML = `
      <div class="empty-state">
        <p class="empty-title">Failed to load tracks</p>
        <p class="empty-sub">${escHtml(err.message)}</p>
      </div>`;
  }
}

function switchTab(tabName, playlistId) {
  document.querySelectorAll('.tab-button').forEach((btn) => {
    btn.classList.toggle('tab-active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-content').forEach((el) => {
    el.style.display = 'none';
  });
  document.getElementById(`tab-${tabName}`).style.display = 'block';

  if (tabName === 'users') loadLinkedUsersTab(playlistId);
}

async function loadLinkedUsersTab(playlistId) {
  const el = document.getElementById('tab-users');
  try {
    const users = await fetchLinkedUsers(playlistId);
    renderLinkedUsersInModal(users);
  } catch (err) {
    el.innerHTML = `
      <div class="empty-state">
        <p class="empty-title">Failed to load linked users</p>
        <p class="empty-sub">${escHtml(err.message)}</p>
      </div>`;
  }
}

function renderLinkedUsersInModal(users) {
  const el = document.getElementById('tab-users');

  if (users.length === 0) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">👥</div>
        <p class="empty-title">No users linked yet</p>
        <p class="empty-sub">Users will appear here once they link this playlist.</p>
      </div>`;
    return;
  }

  const rows = users.map((u) => `
    <tr>
      <td>${escHtml(u.display_name)}</td>
      <td>${escHtml(u.tidal_playlist_name || '—')}</td>
      <td class="text-muted">${formatDate(u.created_at)}</td>
    </tr>`).join('');

  el.innerHTML = `
    <table class="users-table">
      <thead>
        <tr>
          <th>User</th>
          <th>Tidal Playlist Name</th>
          <th>Linked At</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderTracksInModal(tracks, pl) {
  const body = document.getElementById('view-modal-body');

  if (tracks.length === 0) {
    body.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎵</div>
        <p class="empty-title">No tracks yet</p>
        <p class="empty-sub">
          Users linked to <strong>${escHtml(pl.name)}</strong> will sync tracks here automatically.
        </p>
      </div>`;
    return;
  }

  const rows = tracks.map((t, i) => {
    let trackDisplay;
    if (t.track_title) {
      trackDisplay = escHtml(t.track_title);
      if (t.track_artist) trackDisplay += ` <span class="track-artist">· ${escHtml(t.track_artist)}</span>`;
    } else {
      trackDisplay = `<span class="text-muted">${escHtml(t.tidal_track_id)}</span>`;
    }
    return `
    <tr>
      <td class="track-pos text-muted">${i + 1}</td>
      <td class="track-name">${trackDisplay}</td>
      <td>${escHtml(t.added_by_name)}</td>
      <td class="text-muted">${formatDate(t.added_at)}</td>
    </tr>`;
  }).join('');

  body.innerHTML = `
    <table class="tracks-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Track</th>
          <th>Added By</th>
          <th>Added At</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

function connectWebSocket() {
  if (state.ws) {
    state.ws.onclose = null;
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

  ws.onopen = () => {
    setWsStatus(true);
  };

  ws.onmessage = ({ data }) => {
    try {
      const msg = JSON.parse(data);
      if (['track_added', 'track_removed', 'tracks_reordered'].includes(msg.type)) {
        if (state.view === 'admin') fetchPlaylists();
        showSyncNotification(msg);
      }
    } catch { /* ignore malformed messages */ }
  };

  ws.onclose = () => {
    setWsStatus(false);
    setTimeout(connectWebSocket, 3_000);
  };

  ws.onerror = () => {
    ws.close();
  };
}

function setWsStatus(online) {
  if (online) {
    clearTimeout(state.wsDisconnectTimer);
    state.wsDisconnectTimer = null;
    _applyWsStatus(true);
  } else {
    if (!state.wsDisconnectTimer) {
      state.wsDisconnectTimer = setTimeout(() => {
        state.wsDisconnectTimer = null;
        _applyWsStatus(false);
      }, 1500);
    }
  }
}

function _applyWsStatus(online) {
  state.wsConnected = online;
  const el    = document.getElementById('ws-status');
  const label = el.querySelector('.ws-label');
  el.className      = `ws-status ${online ? 'ws-connected' : 'ws-disconnected'}`;
  label.textContent = online ? 'Connected' : 'Disconnected';
}

function showSyncNotification(msg) {
  const trackLabel = msg.track_title
    ? `"${msg.track_title}"`
    : `track ${msg.tidal_track_id ?? ''}`;
  const map = {
    track_added:      `${trackLabel} added`,
    track_removed:    `${trackLabel} removed`,
    tracks_reordered: `Playlist reordered`,
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

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(unixSecs) {
  return new Date(unixSecs * 1000).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function timeAgo(unixSecs) {
  const diff = Math.floor(Date.now() / 1000) - unixSecs;
  if (diff < 10)    return 'just now';
  if (diff < 60)    return `${diff}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
