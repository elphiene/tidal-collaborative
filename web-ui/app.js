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

  // Current view: 'signed-out' | 'my-playlists' | 'admin'
  view: 'signed-out',

  // Admin data
  playlists: [],
  users:     [],

  // My links
  myLinks: [],

  // Link modal state
  selectedTidalPlaylist: null, // { id, name }
  selectedSharedPlaylist: null, // { id, name }

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

/**
 * Wrapper around fetch for all /api/* calls.
 * If the server returns 401 while the user is signed in, tears down the
 * session locally and shows the sign-in screen (token expired / revoked).
 */
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
    showSignedOut();
    toast('Your session has expired — please sign in again.', 'error');
  }
  return res;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  // Handle OAuth redirect query params
  const params = new URLSearchParams(window.location.search);
  if (params.has('auth')) {
    const result = params.get('auth');
    if (result === 'ok') {
      toast('Signed in successfully!', 'success');
    } else if (result === 'error') {
      const reason = params.get('reason') ?? 'Unknown error';
      toast(`Sign-in failed: ${reason}`, 'error');
    }
    // Clean up URL
    history.replaceState({}, '', '/');
  }

  // Wire up static event listeners
  document.getElementById('signin-btn').addEventListener('click', handleSignIn);
  document.getElementById('signout-btn').addEventListener('click', handleSignOut);
  document.getElementById('open-link-btn').addEventListener('click', openLinkModal);
  document.getElementById('open-create-btn').addEventListener('click', () => openModal('create-modal'));
  document.getElementById('refresh-btn').addEventListener('click', () => {
    refreshAdmin();
    toast('Refreshed', 'info');
  });

  // Navigation tabs
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // PIN inputs (modal)
  initPinInputs();

  // Link modal controls
  document.getElementById('link-next-btn').addEventListener('click', handleLinkNext);
  document.getElementById('link-back-btn').addEventListener('click', handleLinkBack);

  // Create form
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

  // Run setup wizard check — calls checkAuth() when complete
  await initSetupWizard();
});

// ---------------------------------------------------------------------------
// Setup Wizard
// ---------------------------------------------------------------------------

async function initSetupWizard() {
  const overlay = document.getElementById('setup-overlay');

  // Wire up controls and show step 1 spinner BEFORE the fetch so the
  // overlay is covering the page from the very first paint.
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
    // Already set up — remove overlay immediately and run normal app init.
    overlay.remove();
    await checkAuth();
    return;
  }

  // Show step 1 success state briefly, then advance to the right step.
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
  // Show/hide steps
  for (let i = 1; i <= 4; i++) {
    const el = document.getElementById(`setup-step-${i}`);
    if (el) el.hidden = (i !== n);
  }

  // Update progress dots (fill up to step n-1 since step 1 is auto)
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
    // Focus the input
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

  // Determine current step from which step is visible
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
    // Remove overlay and start normal app
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
  showSignedOut();
}

// ---------------------------------------------------------------------------
// View management
// ---------------------------------------------------------------------------

function showSignedOut() {
  document.getElementById('signed-out-view').hidden   = false;
  document.getElementById('my-playlists-view').hidden = true;
  document.getElementById('admin-view').hidden        = true;
  document.getElementById('nav-tabs').hidden          = true;
  document.getElementById('user-display').hidden      = true;
  document.getElementById('signout-btn').hidden       = true;
  setWsStatus(false);
}

function showSignedIn() {
  document.getElementById('signed-out-view').hidden = true;
  document.getElementById('nav-tabs').hidden        = false;
  const userDisplay = document.getElementById('user-display');
  userDisplay.textContent = state.displayName ?? state.userId;
  userDisplay.hidden      = false;
  document.getElementById('signout-btn').hidden = false;

  switchView('my-playlists');
  connectWebSocket();
  state.pollTimer        = setInterval(refreshAdmin, POLL_MS);
  state.sessionCheckTimer = setInterval(() => apiFetch(`${BASE_URL}/api/me`), 2 * 60 * 1000);
}

async function switchView(viewName) {
  if (viewName === 'admin') {
    const ok = await ensureAdminAuthed();
    if (!ok) return; // PIN modal shown; view switch happens after successful auth
  }

  state.view = viewName;

  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.classList.toggle('nav-tab-active', btn.dataset.view === viewName);
  });

  document.getElementById('my-playlists-view').hidden = viewName !== 'my-playlists';
  document.getElementById('admin-view').hidden        = viewName !== 'admin';

  if (viewName === 'my-playlists') {
    fetchMyLinks();
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

  // Clear inputs
  document.querySelectorAll('#pin-inputs .pin-digit').forEach((el) => { el.value = ''; });

  openModal('pin-modal');

  // Focus first digit after modal opens
  setTimeout(() => document.querySelector('.pin-digit')?.focus(), 60);
}

function getPinValue() {
  return [...document.querySelectorAll('#pin-inputs .pin-digit')].map((el) => el.value).join('');
}

// Wire up PIN digit inputs for the admin PIN modal (called once on DOMContentLoaded)
function initPinInputs() {
  const digits  = [...document.querySelectorAll('#pin-inputs .pin-digit')];
  const submitBtn = document.getElementById('pin-submit-btn');

  digits.forEach((input, i) => {
    input.addEventListener('input', () => {
      // Only allow single digit
      input.value = input.value.replace(/\D/g, '').slice(-1);
      // Auto-advance
      if (input.value && i < digits.length - 1) digits[i + 1].focus();
      submitBtn.disabled = getPinValue().length !== 4;
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value && i > 0) {
        digits[i - 1].focus();
      }
      if (e.key === 'Enter' && !submitBtn.disabled) submitBtn.click();
    });

    // Select on focus so typing replaces the digit
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
      // Clear inputs and refocus
      document.querySelectorAll('#pin-inputs .pin-digit').forEach((el) => { el.value = ''; });
      submitBtn.disabled = true;
      document.querySelector('#pin-inputs .pin-digit')?.focus();
      return;
    }

    closeModal('pin-modal');
    // Now actually switch to admin view
    state.view = 'admin';
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.classList.toggle('nav-tab-active', btn.dataset.view === 'admin');
    });
    document.getElementById('my-playlists-view').hidden = true;
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

async function fetchMyLinks() {
  try {
    const res = await apiFetch(`${BASE_URL}/api/links`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.myLinks = await res.json();
    renderMyLinks();
  } catch (err) {
    console.error('[app] fetchMyLinks:', err.message);
    document.getElementById('my-links-list').innerHTML = `
      <div class="empty-state">
        <p class="empty-title">Failed to load links</p>
        <p class="empty-sub">${escHtml(err.message)}</p>
      </div>`;
  }
}

function renderMyLinks() {
  const el = document.getElementById('my-links-list');

  if (state.myLinks.length === 0) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔗</div>
        <p class="empty-title">No playlists linked yet</p>
        <p class="empty-sub">Click <strong>Link Playlist</strong> to connect one of your Tidal playlists to a shared playlist.</p>
      </div>`;
    return;
  }

  el.innerHTML = state.myLinks.map((link) => `
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
        <button class="btn btn-danger btn-sm" data-unlink="${link.id}" data-armed="false">Unlink</button>
      </div>
    </div>`).join('');

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
    await fetchMyLinks();
  } catch (err) {
    toast(`Unlink failed: ${err.message}`, 'error');
    btn.disabled      = false;
    btn.textContent   = 'Unlink';
    btn.dataset.armed = 'false';
  }
}

// ---------------------------------------------------------------------------
// Link Playlist Modal
// ---------------------------------------------------------------------------

async function openLinkModal() {
  state.selectedTidalPlaylist  = null;
  state.selectedSharedPlaylist = null;

  // Reset to step 1
  document.getElementById('link-step-1').hidden = false;
  document.getElementById('link-step-2').hidden = true;
  document.getElementById('link-next-btn').disabled = true;
  document.getElementById('link-next-btn').textContent = 'Next';
  document.getElementById('link-back-btn').hidden = true;

  openModal('link-modal');

  // Load Tidal playlists
  const listEl = document.getElementById('tidal-playlists-list');
  listEl.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>Loading your Tidal playlists…</span></div>';

  try {
    const res = await apiFetch(`${BASE_URL}/api/tidal/playlists`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    const data = await res.json(); // JSON:API data array

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
        state.selectedTidalPlaylist = { id: btn.dataset.id, name: btn.dataset.name };
        document.getElementById('link-next-btn').disabled = false;
      });
    });
  } catch (err) {
    listEl.innerHTML = `<div class="empty-state"><p class="empty-title">Failed to load Tidal playlists</p><p class="empty-sub">${escHtml(err.message)}</p></div>`;
  }
}

async function handleLinkNext() {
  const step1 = document.getElementById('link-step-1');
  const step2 = document.getElementById('link-step-2');
  const nextBtn = document.getElementById('link-next-btn');
  const backBtn = document.getElementById('link-back-btn');

  if (!step2.hidden) {
    // We're on step 2 — confirm the link
    if (!state.selectedTidalPlaylist || !state.selectedSharedPlaylist) return;

    nextBtn.disabled    = true;
    nextBtn.textContent = 'Linking…';

    try {
      const res = await apiFetch(`${BASE_URL}/api/links`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          sharedPlaylistId: state.selectedSharedPlaylist.id,
          tidalPlaylistId:  state.selectedTidalPlaylist.id,
          tidalPlaylistName: state.selectedTidalPlaylist.name,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

      closeModal('link-modal');
      toast(`Linked "${state.selectedTidalPlaylist.name}" → "${state.selectedSharedPlaylist.name}"`, 'success');
      await fetchMyLinks();
    } catch (err) {
      toast(`Link failed: ${err.message}`, 'error');
      nextBtn.disabled    = false;
      nextBtn.textContent = 'Link Playlists';
    }
    return;
  }

  // Move from step 1 → step 2
  step1.hidden = true;
  step2.hidden = false;
  backBtn.hidden = false;
  nextBtn.disabled = true;
  nextBtn.textContent = 'Link Playlists';

  const listEl = document.getElementById('shared-playlists-select-list');
  listEl.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>Loading shared playlists…</span></div>';

  try {
    const res = await apiFetch(`${BASE_URL}/api/shared-playlists`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const playlists = await res.json();

    if (playlists.length === 0) {
      listEl.innerHTML = '<div class="empty-state"><p class="empty-title">No shared playlists yet</p><p class="empty-sub">Ask an admin to create one first.</p></div>';
      return;
    }

    listEl.innerHTML = playlists.map((pl) => `
      <button class="select-item" data-id="${pl.id}" data-name="${escHtml(pl.name)}">
        <span class="select-item-name">${escHtml(pl.name)}</span>
        <span class="select-item-meta">${pl.track_count} tracks · ${pl.user_count} users</span>
      </button>`).join('');

    listEl.querySelectorAll('.select-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        listEl.querySelectorAll('.select-item').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        state.selectedSharedPlaylist = { id: parseInt(btn.dataset.id, 10), name: btn.dataset.name };
        document.getElementById('link-next-btn').disabled = false;
      });
    });
  } catch (err) {
    listEl.innerHTML = `<div class="empty-state"><p class="empty-title">Failed to load playlists</p><p class="empty-sub">${escHtml(err.message)}</p></div>`;
  }
}

function handleLinkBack() {
  document.getElementById('link-step-1').hidden = false;
  document.getElementById('link-step-2').hidden = true;
  document.getElementById('link-back-btn').hidden = true;
  document.getElementById('link-next-btn').textContent = 'Next';
  document.getElementById('link-next-btn').disabled = !state.selectedTidalPlaylist;
  state.selectedSharedPlaylist = null;
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
// Render: Playlists
// ---------------------------------------------------------------------------

function renderPlaylists() {
  const grid = document.getElementById('playlists-grid');

  if (state.playlists.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <div class="empty-icon">🎵</div>
        <p class="empty-title">No shared playlists yet</p>
        <p class="empty-sub">Click <strong>New Playlist</strong> to create one.</p>
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
// Create Playlist
// ---------------------------------------------------------------------------

async function handleCreateSubmit(e) {
  e.preventDefault();

  const name  = document.getElementById('pl-name').value.trim();
  const desc  = document.getElementById('pl-desc').value.trim();
  const errEl = document.getElementById('create-error');
  const btn   = document.getElementById('create-submit-btn');

  errEl.textContent = '';

  if (!name) {
    errEl.textContent = 'Playlist name is required.';
    document.getElementById('pl-name').focus();
    return;
  }

  setLoadingBtn(btn, true);

  try {
    const res = await apiFetch(`${BASE_URL}/api/shared-playlists`, {
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
// View Playlist Modal
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
    // Clear any pending disconnect notification and immediately show connected
    clearTimeout(state.wsDisconnectTimer);
    state.wsDisconnectTimer = null;
    _applyWsStatus(true);
  } else {
    // Debounce: only show Disconnected after 1.5s to absorb brief mobile hiccups
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
