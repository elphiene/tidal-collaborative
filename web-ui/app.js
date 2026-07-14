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

  // Current view: 'signed-out' | 'playlists' | 'discover' | 'users' | 'activity' | 'admin'
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

  // Sync health (userId → { status, sync_error_msg, sync_retry_after })
  syncStatuses:  new Map(),
  adminSettings: { poll_interval_ms: 30000 },

  // Journal
  journalEntries:   [],
  journalOffset:    0,
  journalHasMore:   false,
  journalStats:     null,
  journalStatMode:  0,  // 0=all-time 1=7d 2=24h

  // Mobile nav
  navOpen: false,
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
  document.getElementById('open-discover-btn').addEventListener('click', () => switchView('discover'));
  document.getElementById('discover-back-btn').addEventListener('click', () => switchView('playlists'));
  document.getElementById('reconnect-btn').addEventListener('click', handleSignIn);
  // Admin sub-tabs
  document.querySelectorAll('#admin-subtabs .subtab').forEach((btn) => {
    btn.addEventListener('click', () => switchAdminTab(btn.dataset.atab));
  });
  document.getElementById('admin-activity-link').addEventListener('click', (e) => {
    e.preventDefault(); switchAdminTab('activity');
  });
  document.getElementById('hiw-dismiss').addEventListener('click', () => {
    localStorage.setItem('hiw_dismissed', '1');
    document.getElementById('hiw-strip').hidden = true;
  });
  // Activity filters (user-facing journal)
  document.getElementById('activity-filter-action').addEventListener('change', fetchUserActivity);
  document.getElementById('activity-filter-playlist').addEventListener('change', fetchUserActivity);
  document.getElementById('user-activity-more-btn').addEventListener('click', () => fetchUserActivity(true));

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
  document.querySelectorAll('input[name="create-source"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      state.createSource = e.target.value;
      // "fresh" creates straight from step 1; "existing" goes to the picker step.
      if (state.createStep === 1) {
        document.getElementById('create-next-btn').textContent = e.target.value === 'fresh' ? 'Create' : 'Next';
      }
    });
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

  // Hamburger (mobile nav toggle)
  document.getElementById('hamburger-btn').addEventListener('click', toggleMobileNav);

  // Sync banner dismiss
  document.getElementById('sync-banner-dismiss').addEventListener('click', hideSyncBanner);

  // Admin settings buttons (always in DOM, wired once)
  document.getElementById('poll-interval-save-btn').addEventListener('click', handlePollIntervalSave);
  document.getElementById('force-poll-btn').addEventListener('click', () => {
    handleForcePoll(document.getElementById('force-poll-btn'));
  });
  document.getElementById('api-key-generate-btn').addEventListener('click', handleGenerateApiKey);
  document.getElementById('api-key-copy-btn').addEventListener('click', handleCopyApiKey);

  // Journal controls (always in DOM)
  document.getElementById('journal-filter-action').addEventListener('change', () => {
    state.journalOffset = 0; state.journalEntries = []; fetchJournal();
  });
  document.getElementById('journal-filter-playlist').addEventListener('change', () => {
    state.journalOffset = 0; state.journalEntries = []; fetchJournal();
  });
  document.getElementById('journal-refresh-btn').addEventListener('click', () => {
    state.journalOffset = 0; state.journalEntries = []; fetchJournal(); fetchJournalStats();
  });
  document.getElementById('journal-load-more-btn').addEventListener('click', () => {
    state.journalOffset += 50; fetchJournal(true);
  });
  document.getElementById('stat-journal-card').addEventListener('click', cycleJournalStatMode);

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
    state.myStatus    = data.syncStatus || 'ok';
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
  document.getElementById('signed-out-view').hidden = false;
  document.getElementById('playlists-view').hidden  = true;
  document.getElementById('discover-view').hidden   = true;
  document.getElementById('users-view').hidden      = true;
  document.getElementById('activity-view').hidden   = true;
  document.getElementById('admin-view').hidden      = true;
  document.getElementById('nav-tabs').hidden        = true;
  document.getElementById('user-display').hidden    = true;
  document.getElementById('signout-btn').hidden     = true;
  clearInterval(state.usersViewTimer);
  state.usersViewTimer = null;
  hideSyncBanner();
  closeMobileNav();
  setWsStatus(false);
}

function showSignedIn() {
  document.getElementById('signed-out-view').hidden = true;
  document.getElementById('nav-tabs').hidden        = false;
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

  switchView('playlists');
  connectWebSocket();
  state.pollTimer        = setInterval(refreshAdmin, POLL_MS);
  state.sessionCheckTimer = setInterval(() => apiFetch(`${BASE_URL}/api/me`), 2 * 60 * 1000);
}

async function switchView(viewName) {
  closeMobileNav();

  if (viewName === 'admin') {
    const ok = await ensureAdminAuthed();
    if (!ok) return;
  }

  if (state.view === 'users' && viewName !== 'users') {
    clearInterval(state.usersViewTimer);
    state.usersViewTimer = null;
  }

  state.view = viewName;

  // Discover is a sub-page of Playlists — keep the Playlists tab lit there.
  const activeTab = viewName === 'discover' ? 'playlists' : viewName;
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.classList.toggle('nav-tab-active', btn.dataset.view === activeTab);
  });

  document.getElementById('playlists-view').hidden = viewName !== 'playlists';
  document.getElementById('discover-view').hidden  = viewName !== 'discover';
  document.getElementById('users-view').hidden     = viewName !== 'users';
  document.getElementById('activity-view').hidden  = viewName !== 'activity';
  document.getElementById('admin-view').hidden     = viewName !== 'admin';

  if (viewName === 'playlists') {
    fetchMyPlaylists();
  } else if (viewName === 'discover') {
    fetchDiscover();
  } else if (viewName === 'users') {
    fetchAllUsers();
    state.usersViewTimer = setInterval(fetchAllUsers, 30_000);
  } else if (viewName === 'activity') {
    fetchUserActivity();
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
    document.getElementById('playlists-view').hidden = true;
    document.getElementById('discover-view').hidden  = true;
    document.getElementById('users-view').hidden     = true;
    document.getElementById('activity-view').hidden  = true;
    document.getElementById('admin-view').hidden     = false;
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
  const hub = document.getElementById('playlists-hub');
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

    // Counts (tracks / members) come from the shared-playlists payload.
    const counts = {};
    playlists.forEach((p) => { counts[p.id] = p; });

    // Owned playlists with no Tidal link yet (edge case)
    const linkedSharedIds = new Set(links.map((l) => l.shared_playlist_id));
    const unlinkedOwned   = playlists.filter(
      (p) => p.created_by === state.userId && !linkedSharedIds.has(p.id),
    );

    renderPlaylistsHub(state.ownedLinks, state.joinedLinks, unlinkedOwned, counts);
  } catch (err) {
    console.error('[app] fetchMyPlaylists:', err.message);
    hub.innerHTML = `<div class="empty-state"><p class="empty-title">Failed to load playlists</p><p class="empty-sub">${escHtml(err.message)}</p></div>`;
  }
}

// A teal "Synced" pill, or an amber warning derived from the user's own sync state.
function syncPillHTML() {
  const s = state.myStatus || 'ok';
  if (s === 'ok') return '<span class="pl-sync"><span class="dot"></span>Synced</span>';
  const label = s === 'rate_limited' ? 'Rate-limited'
    : s === 'token_revoked' ? 'Reconnect needed'
    : 'Sync error';
  return `<span class="pl-sync warn"><span class="dot"></span>${label}</span>`;
}

function plCardHTML(o) {
  // o: { role, spId, name, isPublic, linkId, tracks, members, unlinked }
  const roleLabel = `${o.role} · ${o.isPublic ? 'Public' : 'Private'}`;
  const stats = `
    <div class="pl-stats">
      <div class="pl-stat"><div class="n">${o.unlinked ? '—' : o.tracks}</div><div class="l">tracks</div></div>
      <div class="pl-stat"><div class="n">${o.members}</div><div class="l">member${o.members === 1 ? '' : 's'}</div></div>
    </div>`;

  const actions = [];
  actions.push(`<button class="btn btn-ghost btn-sm" data-view-tracks="${o.spId}">View tracks</button>`);
  if (o.role === 'Owner') {
    if (!o.isPublic) actions.push(`<button class="btn btn-ghost btn-sm" data-invites="${o.spId}" data-invites-name="${escHtml(o.name)}">Invite</button>`);
    if (o.linkId) actions.push(`<button class="btn btn-ghost btn-sm" data-sync="${o.linkId}">Sync now</button>`);
    actions.push(`<button class="btn btn-ghost btn-sm" data-toggle-vis="${o.spId}" data-is-public="${o.isPublic ? 1 : 0}">${o.isPublic ? 'Make Private' : 'Make Public'}</button>`);
    actions.push(`<button class="btn btn-danger btn-sm" data-delete-pl="${o.spId}" data-delete-pl-name="${escHtml(o.name)}" data-armed="false">Delete</button>`);
  } else {
    if (o.linkId) actions.push(`<button class="btn btn-ghost btn-sm" data-sync="${o.linkId}">Sync now</button>`);
    actions.push(`<button class="btn btn-danger btn-sm" data-unlink="${o.linkId}" data-armed="false">Leave</button>`);
  }

  const sub = o.unlinked ? '<div class="pl-activity">Not linked to a Tidal playlist yet</div>' : '';

  return `
    <div class="pl-card">
      <div class="pl-card-top">
        <div><div class="pl-name">${escHtml(o.name)}</div><div class="pl-role">${roleLabel}</div></div>
        ${o.unlinked ? '' : syncPillHTML()}
      </div>
      ${stats}
      ${sub}
      <div class="pl-foot">${actions.join('')}</div>
    </div>`;
}

function renderPlaylistsHub(ownedLinks, joinedLinks, unlinkedOwned, counts) {
  const hub = document.getElementById('playlists-hub');
  const sub = document.getElementById('playlists-sub');
  const hiw = document.getElementById('hiw-strip');
  const total = ownedLinks.length + joinedLinks.length + unlinkedOwned.length;

  // Reconnect banner — shown when the user's own Tidal token is dead.
  const rb = document.getElementById('reconnect-banner');
  if (rb) {
    const dead = state.myStatus === 'token_revoked' || state.myStatus === 'error';
    rb.hidden = !dead;
  }

  if (total === 0) {
    hiw.hidden = true;
    sub.textContent = 'Nothing here yet — create your first one below.';
    hub.classList.remove('pl-grid'); // welcome is a single centered card, not a grid item
    hub.innerHTML = welcomeHTML();
    document.getElementById('welcome-create')?.addEventListener('click', openCreateModal);
    document.getElementById('welcome-discover')?.addEventListener('click', () => switchView('discover'));
    return;
  }

  hub.classList.add('pl-grid');
  hiw.hidden = localStorage.getItem('hiw_dismissed') === '1';
  sub.textContent = `${total} playlist${total === 1 ? '' : 's'}`;

  const cards = [];
  ownedLinks.forEach((l) => cards.push(plCardHTML({
    role: 'Owner', spId: l.shared_playlist_id, name: l.shared_playlist_name,
    isPublic: !!l.playlist_is_public, linkId: l.id,
    tracks: counts[l.shared_playlist_id]?.track_count ?? 0,
    members: counts[l.shared_playlist_id]?.user_count ?? 1,
  })));
  unlinkedOwned.forEach((p) => cards.push(plCardHTML({
    role: 'Owner', spId: p.id, name: p.name, isPublic: !!p.is_public, linkId: null,
    tracks: p.track_count ?? 0, members: p.user_count ?? 1, unlinked: true,
  })));
  joinedLinks.forEach((l) => cards.push(plCardHTML({
    role: 'Joined', spId: l.shared_playlist_id, name: l.shared_playlist_name,
    isPublic: !!l.playlist_is_public, linkId: l.id,
    tracks: counts[l.shared_playlist_id]?.track_count ?? 0,
    members: counts[l.shared_playlist_id]?.user_count ?? 1,
  })));

  hub.innerHTML = cards.join('');

  hub.querySelectorAll('[data-view-tracks]').forEach((b) =>
    b.addEventListener('click', () => openViewModal(Number(b.dataset.viewTracks))));
  hub.querySelectorAll('[data-sync]').forEach((b) =>
    b.addEventListener('click', () => handleSync(parseInt(b.dataset.sync, 10), b)));
  hub.querySelectorAll('[data-invites]').forEach((b) =>
    b.addEventListener('click', () => openInvitesModal(parseInt(b.dataset.invites, 10), b.dataset.invitesName)));
  hub.querySelectorAll('[data-toggle-vis]').forEach((b) =>
    b.addEventListener('click', () => handleToggleVisibility(parseInt(b.dataset.toggleVis, 10), b.dataset.isPublic === '1', b)));
  hub.querySelectorAll('[data-delete-pl]').forEach((b) =>
    b.addEventListener('click', () => handleDeletePlaylist(parseInt(b.dataset.deletePl, 10), b.dataset.deletePlName, b)));
  hub.querySelectorAll('[data-unlink]').forEach((b) =>
    b.addEventListener('click', () => handleUnlink(parseInt(b.dataset.unlink, 10), b)));
}

function welcomeHTML() {
  return `
    <div class="welcome">
      <h2>Welcome to Tidal Collaborative 👋</h2>
      <p class="lead">Keep a playlist perfectly in sync with friends — every add and remove shows up for everyone, automatically.</p>
      <div class="steps">
        <div class="step"><div class="num">1</div><h3>Make a Tidal playlist</h3><p>Create it in Tidal — or let us make a fresh empty one for you when you create a playlist below.</p></div>
        <div class="step"><div class="num">2</div><h3>Create or join here</h3><p>Start a shared playlist, or join one a friend invited you to, then link your Tidal playlist to it.</p></div>
        <div class="step"><div class="num">3</div><h3>Just add music</h3><p>From then on, every add or remove syncs to everyone automatically.</p></div>
      </div>
      <div class="welcome-callout">
        <span class="wc-icon">🔀</span>
        <span><b>Linking merges the two playlists.</b> Any songs already in your Tidal playlist get added to the shared one and pushed to everyone — and the shared playlist's songs get added to yours. Start with an empty Tidal playlist for a clean join.</span>
      </div>
      <div class="welcome-cta">
        <button class="btn btn-primary" id="welcome-create">＋ Create your first playlist</button>
        <button class="btn btn-secondary" id="welcome-discover">Browse public playlists</button>
      </div>
    </div>`;
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
  state.createSource        = 'fresh';
  state.createSelectedTidal = null;

  // Reset step 1
  document.getElementById('create-name').value = '';
  document.getElementById('create-desc').value = '';
  document.querySelector('input[name="create-visibility"][value="private"]').checked = true;
  document.querySelector('input[name="create-source"][value="fresh"]').checked = true;
  document.getElementById('create-error').textContent = '';

  // Show step 1, hide step 2
  document.getElementById('create-step-1').hidden = false;
  document.getElementById('create-step-2').hidden = true;
  document.getElementById('create-back-btn').hidden = true;
  document.getElementById('create-next-btn').textContent = 'Create'; // fresh is default
  document.getElementById('create-next-btn').disabled = true;

  openModal('create-modal');
  setTimeout(() => document.getElementById('create-name').focus(), 60);
}

async function handleCreateNext() {
  const name = document.getElementById('create-name').value.trim();

  if (state.createStep === 1) {
    if (!name) {
      document.getElementById('create-error').textContent = 'Name is required.';
      return;
    }
    document.getElementById('create-error').textContent = '';

    // "fresh" — no picker needed; create an empty Tidal playlist and link it.
    if (state.createSource === 'fresh') {
      await submitCreate(name, null);
      return;
    }

    // "existing" — advance to the Tidal playlist picker.
    state.createStep = 2;
    document.getElementById('create-step-1').hidden = true;
    document.getElementById('create-step-2').hidden = false;
    document.getElementById('create-back-btn').hidden = false;
    document.getElementById('create-next-btn').textContent = 'Create';
    document.getElementById('create-next-btn').disabled = true;
    state.createSelectedTidal = null;

    await loadTidalPlaylistsInto('create-tidal-list', (pl) => {
      state.createSelectedTidal = pl;
      document.getElementById('create-next-btn').disabled = false;
    });

  } else {
    // Step 2 — an existing Tidal playlist was chosen.
    if (!state.createSelectedTidal) return;
    await submitCreate(name, state.createSelectedTidal);
  }
}

// Shared create submit. tidalPl null → create a fresh empty Tidal playlist first.
async function submitCreate(name, tidalPl) {
  const btn  = document.getElementById('create-next-btn');
  const desc = document.getElementById('create-desc').value.trim() || null;

  btn.disabled    = true;
  btn.textContent = tidalPl ? 'Creating…' : 'Creating playlist…';

  try {
    let tidalId = tidalPl?.id;
    let tidalName = tidalPl?.name;

    if (!tidalPl) {
      const cr = await apiFetch(`${BASE_URL}/api/tidal/playlists`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name, description: desc || '' }),
      });
      const cd = await cr.json();
      if (!cr.ok) throw new Error(cd.error ?? `HTTP ${cr.status}`);
      tidalId   = cd.id;
      tidalName = cd.name;
    }

    const res = await apiFetch(`${BASE_URL}/api/shared-playlists`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        name,
        description:       desc,
        isPublic:          state.createVisibility === 'public',
        tidalPlaylistId:   tidalId,
        tidalPlaylistName: tidalName,
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
    btn.textContent = state.createStep === 2 ? 'Create' : (state.createSource === 'fresh' ? 'Create' : 'Next');
  }
}

function handleCreateBack() {
  state.createStep = 1;
  document.getElementById('create-step-1').hidden = false;
  document.getElementById('create-step-2').hidden = true;
  document.getElementById('create-back-btn').hidden = true;
  document.getElementById('create-next-btn').textContent =
    state.createSource === 'fresh' ? 'Create' : 'Next';
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
  await Promise.allSettled([
    fetchPlaylists(), fetchUsers(), fetchAdminSettings(),
    fetchJournalStats(),
  ]);
  // Journal loads after playlists so the filter dropdown is populated
  state.journalOffset = 0;
  state.journalEntries = [];
  await fetchJournal();
  renderAdminOverview();
}

// Admin sub-tab switcher — panels are #admin-panel-<name>, all in the DOM.
function switchAdminTab(name) {
  state.adminTab = name;
  document.querySelectorAll('#admin-subtabs .subtab').forEach((b) =>
    b.classList.toggle('active', b.dataset.atab === name));
  ['overview', 'playlists', 'users', 'activity', 'settings'].forEach((n) => {
    const p = document.getElementById(`admin-panel-${n}`);
    if (p) p.hidden = n !== name;
  });
  if (name === 'overview') renderAdminOverview();
}

function renderAdminOverview() {
  // Attention banner — surfaces users whose sync is broken.
  const att = document.getElementById('admin-attention');
  if (att) {
    const broken = (state.users || []).filter(
      (u) => u.sync_status === 'token_revoked' || u.sync_status === 'error');
    if (broken.length === 0) {
      att.hidden = true;
    } else {
      const names = broken.map((u) => escHtml(u.display_name || u.user_id)).join(', ');
      att.hidden = false;
      att.innerHTML = `<span aria-hidden="true">⚠️</span><span><b>${broken.length} user${broken.length === 1 ? '' : 's'} need${broken.length === 1 ? 's' : ''} attention</b> — ${names} can't sync until ${broken.length === 1 ? 'they reconnect' : 'they reconnect'} their Tidal account. <a href="#" id="admin-attention-link" style="color:inherit;text-decoration:underline">See in Users &rarr;</a></span>`;
      document.getElementById('admin-attention-link')?.addEventListener('click', (e) => {
        e.preventDefault(); switchAdminTab('users');
      });
    }
  }

  // Recent activity snapshot — top 5 journal entries.
  const ra = document.getElementById('admin-recent-activity');
  if (ra) {
    const recent = (state.journalEntries || []).slice(0, 5);
    ra.innerHTML = recent.length
      ? recent.map(journalEntryHTML).join('')
      : '<div class="empty-state"><p class="empty-sub">No activity yet.</p></div>';
  }

  // System health.
  const health = document.getElementById('admin-health');
  if (health) {
    const pollSec   = Math.round((state.adminSettings.poll_interval_ms || 30000) / 1000);
    const errCount  = (state.users || []).filter(
      (u) => u.sync_status === 'token_revoked' || u.sync_status === 'error').length;
    const rateCount = (state.users || []).filter((u) => u.sync_status === 'rate_limited').length;
    const rows = [
      ['Poll interval', `${pollSec}s`],
      ['Linked users', String((state.users || []).length)],
      ['Sync errors', errCount ? `<span style="color:#ffb454">${errCount}</span>` : '0'],
      ['Rate-limited', rateCount ? `<span style="color:#ffb454">${rateCount}</span>` : '0'],
    ];
    health.innerHTML = rows.map(([k, v]) =>
      `<div class="health-row"><span class="health-name">${k}</span><span>${v}</span></div>`).join('');
  }
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
// Journal
// ---------------------------------------------------------------------------

async function fetchJournalStats() {
  try {
    const res = await apiFetch(`${BASE_URL}/api/journal/stats`);
    if (!res.ok) return;
    state.journalStats = await res.json();
    renderJournalStat();
  } catch { /* non-fatal */ }
}

const JOURNAL_STAT_MODES = [
  { key: 'total',    label: 'Journal Events'    },
  { key: 'last_7d',  label: 'Events (7 days)'   },
  { key: 'last_24h', label: 'Events (24 hours)'  },
];

function renderJournalStat() {
  if (!state.journalStats) return;
  const mode = JOURNAL_STAT_MODES[state.journalStatMode];
  setElText('stat-journal',       state.journalStats[mode.key] ?? '—');
  setElText('stat-journal-label', mode.label);
}

function cycleJournalStatMode() {
  state.journalStatMode = (state.journalStatMode + 1) % JOURNAL_STAT_MODES.length;
  renderJournalStat();
}

async function fetchJournal(append = false) {
  const action     = document.getElementById('journal-filter-action')?.value    || '';
  const playlistId = document.getElementById('journal-filter-playlist')?.value  || '';

  const params = new URLSearchParams({ limit: 50, offset: state.journalOffset });
  if (action)     params.set('action',      action);
  if (playlistId) params.set('playlist_id', playlistId);

  try {
    const res = await apiFetch(`${BASE_URL}/api/journal?${params}`);
    if (!res.ok) { renderJournal(); return; }
    const entries = await res.json();

    if (append) {
      state.journalEntries.push(...entries);
    } else {
      state.journalEntries = entries;
      populateJournalPlaylistFilter();
    }
    state.journalHasMore = entries.length === 50;
    renderJournal();
  } catch (err) {
    console.error('[app] fetchJournal:', err.message);
    renderJournal();
  }
}

function populateJournalPlaylistFilter() {
  const sel = document.getElementById('journal-filter-playlist');
  if (!sel) return;
  const current = sel.value;
  // Build unique playlist list from loaded playlists
  const opts = [{ id: '', name: 'All Playlists' }];
  for (const pl of state.playlists) opts.push({ id: pl.id, name: pl.name });
  sel.innerHTML = opts.map(o =>
    `<option value="${o.id}"${String(o.id) === current ? ' selected' : ''}>${escHtml(o.name)}</option>`
  ).join('');
}

function renderJournal() {
  const list     = document.getElementById('journal-list');
  const moreWrap = document.getElementById('journal-load-more');
  if (!list) return;

  if (state.journalEntries.length === 0) {
    list.innerHTML = `<div class="empty-state"><p class="empty-title">No journal entries yet</p></div>`;
    if (moreWrap) moreWrap.hidden = true;
    return;
  }

  list.innerHTML = state.journalEntries.map(e => {
    const actionClass = e.action === 'added' ? 'journal-action-added' : 'journal-action-removed';
    const verb        = e.action === 'added' ? 'added'   : 'removed';
    const prep        = e.action === 'added' ? 'to'      : 'from';
    const track       = [e.track_artist, e.track_title].filter(Boolean).join(' – ') || '(unknown track)';
    const playlist    = e.playlist_name ? escHtml(e.playlist_name) : '';
    const who         = escHtml(e.display_name || e.user_id);
    const when        = timeAgo(e.created_at);
    return `
      <div class="journal-entry">
        <span class="journal-sentence"><span class="journal-who">${who}</span> <span class="journal-verb ${actionClass}">${verb}</span> <span class="journal-track">${escHtml(track)}</span> ${prep} <span class="journal-playlist">${playlist}</span></span>
        <span class="journal-time">${when}</span>
      </div>`;
  }).join('');

  if (moreWrap) moreWrap.hidden = !state.journalHasMore;
}

// ---------------------------------------------------------------------------
// User-facing Activity page (journal grouped by day)
// ---------------------------------------------------------------------------

function journalEntryHTML(e) {
  const actionClass = e.action === 'added' ? 'journal-action-added' : 'journal-action-removed';
  const verb        = e.action === 'added' ? 'added' : 'removed';
  const prep        = e.action === 'added' ? 'to'    : 'from';
  const track       = [e.track_artist, e.track_title].filter(Boolean).join(' – ') || '(unknown track)';
  const playlist    = e.playlist_name ? escHtml(e.playlist_name) : '';
  const who         = escHtml(e.display_name || e.user_id);
  return `
    <div class="journal-entry">
      <span class="journal-sentence"><span class="journal-who">${who}</span> <span class="journal-verb ${actionClass}">${verb}</span> <span class="journal-track">${escHtml(track)}</span> ${prep} <span class="journal-playlist">${playlist}</span></span>
      <span class="journal-time">${timeAgo(e.created_at)}</span>
    </div>`;
}

function activityDayLabel(unixSec) {
  const d   = new Date(unixSec * 1000);
  const now = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function populateActivityPlaylistFilter() {
  const sel = document.getElementById('activity-filter-playlist');
  if (!sel) return;
  const current = sel.value;
  const seen = new Set();
  const opts = [{ id: '', name: 'All playlists' }];
  [...(state.ownedLinks || []), ...(state.joinedLinks || [])].forEach((l) => {
    if (!seen.has(l.shared_playlist_id)) {
      seen.add(l.shared_playlist_id);
      opts.push({ id: l.shared_playlist_id, name: l.shared_playlist_name });
    }
  });
  sel.innerHTML = opts.map((o) =>
    `<option value="${o.id}"${String(o.id) === current ? ' selected' : ''}>${escHtml(o.name)}</option>`
  ).join('');
}

async function fetchUserActivity(append = false) {
  const list     = document.getElementById('user-activity-list');
  const moreWrap = document.getElementById('user-activity-more');
  const action     = document.getElementById('activity-filter-action')?.value   || '';
  const playlistId = document.getElementById('activity-filter-playlist')?.value  || '';

  if (!append) { state.userActivityOffset = 0; state.userActivity = []; }

  const params = new URLSearchParams({ limit: 50, offset: state.userActivityOffset });
  if (action)     params.set('action',      action);
  if (playlistId) params.set('playlist_id', playlistId);

  try {
    const res = await apiFetch(`${BASE_URL}/api/journal?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const entries = await res.json();

    if (append) state.userActivity.push(...entries);
    else { state.userActivity = entries; populateActivityPlaylistFilter(); }

    state.userActivityHasMore = entries.length === 50;
    state.userActivityOffset  = state.userActivity.length;
    renderUserActivity();
  } catch (err) {
    console.error('[app] fetchUserActivity:', err.message);
    list.innerHTML = `<div class="empty-state"><p class="empty-title">Failed to load activity</p><p class="empty-sub">${escHtml(err.message)}</p></div>`;
    if (moreWrap) moreWrap.hidden = true;
  }
}

function renderUserActivity() {
  const list     = document.getElementById('user-activity-list');
  const moreWrap = document.getElementById('user-activity-more');
  if (!list) return;

  if (state.userActivity.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎶</div>
        <p class="empty-title">No activity yet</p>
        <p class="empty-sub">Track changes across your playlists will show up here.</p>
      </div>`;
    if (moreWrap) moreWrap.hidden = true;
    return;
  }

  let html = '';
  let currentLabel = null;
  let open = false;
  state.userActivity.forEach((e) => {
    const label = activityDayLabel(e.created_at);
    if (label !== currentLabel) {
      if (open) html += '</div></div>';
      currentLabel = label;
      html += `<div class="day-label">${label}</div><div class="activity-card"><div class="journal-list">`;
      open = true;
    }
    html += journalEntryHTML(e);
  });
  if (open) html += '</div></div>';

  list.innerHTML = html;
  if (moreWrap) moreWrap.hidden = !state.userActivityHasMore;
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

    let syncBadge;
    const syncStatus = u.sync_status ?? 'ok';
    if (syncStatus === 'rate_limited') {
      syncBadge = '<span class="status-badge badge-rate-limited" title="Rate limited by Tidal">Rate limited</span>';
    } else if (syncStatus === 'token_revoked') {
      syncBadge = '<span class="status-badge badge-token-revoked" title="Token revoked — user must re-authenticate">Revoked</span>';
    } else if (syncStatus === 'error') {
      const msg = escHtml(u.sync_error_msg ?? 'Error');
      syncBadge = `<span class="status-badge badge-offline" title="${msg}">Error</span>`;
    } else {
      syncBadge = '<span class="status-badge badge-online">OK</span>';
    }

    const resetBtn = syncStatus !== 'ok'
      ? `<button class="btn btn-ghost btn-sm btn-xs" data-reset-sync="${escHtml(u.user_id ?? u.display_name)}">Reset</button>`
      : '';

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
        <td style="white-space:nowrap">${syncBadge} ${resetBtn}</td>
      </tr>`;
  }).join('');

  list.innerHTML = `
    <table class="users-table">
      <thead>
        <tr>
          <th>User</th>
          <th>Playlist</th>
          <th>Last Seen</th>
          <th>Presence</th>
          <th>Sync</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  list.querySelectorAll('[data-reset-sync]').forEach((btn) => {
    btn.addEventListener('click', () => handleAdminResetSync(btn.dataset.resetSync, btn));
  });
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
  const tabEl = document.getElementById('tab-tracks');
  if (!tabEl) return;

  if (tracks.length === 0) {
    tabEl.innerHTML = `
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
      <td>
        <button class="btn btn-danger btn-sm btn-xs"
                data-delete-track="${escHtml(String(t.tidal_track_id))}"
                data-playlist-id="${pl.id}"
                data-armed="false">Remove</button>
      </td>
    </tr>`;
  }).join('');

  tabEl.innerHTML = `
    <table class="tracks-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Track</th>
          <th>Added By</th>
          <th>Added At</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  tabEl.querySelectorAll('[data-delete-track]').forEach((btn) => {
    btn.addEventListener('click', () =>
      handleDeleteTrack(parseInt(btn.dataset.playlistId, 10), btn.dataset.deleteTrack, btn));
  });
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
        else if (state.view === 'playlists') fetchMyPlaylists();
        else if (state.view === 'activity') fetchUserActivity();
        showSyncNotification(msg);
      } else if (msg.type === 'sync_status') {
        handleSyncStatus(msg);
      } else if (msg.type === 'settings_updated') {
        if (msg.key === 'poll_interval_ms') {
          state.adminSettings.poll_interval_ms = Number(msg.value);
          renderAdminSettings();
        }
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

// ---------------------------------------------------------------------------
// Mobile nav
// ---------------------------------------------------------------------------

function toggleMobileNav() {
  state.navOpen = !state.navOpen;
  document.body.classList.toggle('nav-open', state.navOpen);
  document.getElementById('hamburger-btn').setAttribute('aria-expanded', String(state.navOpen));
}

function closeMobileNav() {
  if (!state.navOpen) return;
  state.navOpen = false;
  document.body.classList.remove('nav-open');
  const btn = document.getElementById('hamburger-btn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

// ---------------------------------------------------------------------------
// Sync status
// ---------------------------------------------------------------------------

function handleSyncStatus(msg) {
  if (msg.user_id) {
    state.syncStatuses.set(String(msg.user_id), {
      status:           msg.status,
      sync_error_msg:   msg.message,
      sync_retry_after: msg.retry_after,
    });
    // If it's our own status, refresh the sync pills on the hub.
    if (String(msg.user_id) === String(state.userId)) {
      state.myStatus = msg.status;
      if (state.view === 'playlists') fetchMyPlaylists();
    }
  }

  const hasIssue = msg.status === 'rate_limited' || msg.status === 'token_revoked' || msg.status === 'error';

  if (hasIssue) {
    showSyncBanner(msg);
  } else {
    const anyIssue = [...state.syncStatuses.values()].some(
      (s) => s.status === 'rate_limited' || s.status === 'token_revoked' || s.status === 'error',
    );
    if (!anyIssue) hideSyncBanner();
  }

  if (state.view === 'admin') fetchUsers();
}

function showSyncBanner(msg) {
  const banner = document.getElementById('sync-banner');
  const text   = document.getElementById('sync-banner-text');
  if (!banner || !text) return;

  if (msg.status === 'rate_limited') {
    text.textContent = 'Sync is rate-limited by Tidal. Polling is paused temporarily.';
  } else if (msg.status === 'token_revoked') {
    text.textContent = 'A user token was revoked — that user must re-authenticate.';
  } else {
    text.textContent = msg.message ?? 'Sync error — check the admin panel.';
  }

  banner.hidden = false;
}

function hideSyncBanner() {
  const banner = document.getElementById('sync-banner');
  if (banner) banner.hidden = true;
}

// ---------------------------------------------------------------------------
// Admin settings
// ---------------------------------------------------------------------------

async function fetchAdminSettings() {
  try {
    const res = await apiFetch(`${BASE_URL}/api/admin/settings`);
    if (!res.ok) return;
    const data = await res.json();
    state.adminSettings = { ...state.adminSettings, ...data };
    renderAdminSettings();
    fetchApiKeyStatus();
  } catch { /* silent — not admin-authed */ }
}

async function fetchApiKeyStatus() {
  const statusEl = document.getElementById('api-key-status');
  const btn      = document.getElementById('api-key-generate-btn');
  try {
    const res = await apiFetch(`${BASE_URL}/api/admin/api-key`);
    if (!res.ok) return;
    const { set, source } = await res.json();
    if (source === 'env') {
      statusEl.textContent = 'Set via API_KEY env var — rotate it there, not here';
      btn.disabled = true;
    } else if (set) {
      statusEl.textContent = 'A key is set. Generating again rotates it (old key stops working).';
      btn.textContent = 'Rotate';
    } else {
      statusEl.textContent = 'Read-only key for external apps to fetch playlist data';
      btn.textContent = 'Generate';
    }
  } catch { /* silent — not admin-authed */ }
}

async function handleGenerateApiKey() {
  const btn = document.getElementById('api-key-generate-btn');
  const rotating = btn.textContent === 'Rotate';
  if (rotating && !confirm('Rotate the API key? The current key will stop working immediately.')) return;
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Working…';
  try {
    const res = await apiFetch(`${BASE_URL}/api/admin/api-key`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    document.getElementById('api-key-value').value = data.key;
    document.getElementById('api-key-reveal-row').hidden = false;
    toast('API key generated — copy it now', 'success');
    fetchApiKeyStatus();
  } catch (err) {
    toast(`Failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = prev;   // fetchApiKeyStatus() corrects the label to Generate/Rotate
  }
}

async function handleCopyApiKey() {
  const input = document.getElementById('api-key-value');
  try {
    await navigator.clipboard.writeText(input.value);
    toast('Copied to clipboard', 'success');
  } catch {
    input.select();
    document.execCommand('copy');
    toast('Copied', 'success');
  }
}

function renderAdminSettings() {
  const msEl = document.getElementById('poll-interval-input');
  if (msEl) msEl.value = Math.round(state.adminSettings.poll_interval_ms / 1000);
}

async function handleForcePoll(btn) {
  btn.disabled    = true;
  btn.textContent = 'Polling…';
  try {
    const res = await apiFetch(`${BASE_URL}/api/admin/force-poll`, { method: 'POST' });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error ?? `HTTP ${res.status}`);
    }
    toast('Force poll triggered', 'success');
  } catch (err) {
    toast(`Force poll failed: ${err.message}`, 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Force Poll Now';
  }
}

async function handlePollIntervalSave() {
  const msEl = document.getElementById('poll-interval-input');
  if (!msEl) return;
  const secs = parseInt(msEl.value, 10);
  if (isNaN(secs) || secs < 15 || secs > 300) {
    toast('Poll interval must be between 15 and 300 seconds', 'error');
    return;
  }
  const btn = document.getElementById('poll-interval-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const res = await apiFetch(`${BASE_URL}/api/admin/settings`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ poll_interval_ms: secs * 1000 }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error ?? `HTTP ${res.status}`);
    }
    state.adminSettings.poll_interval_ms = secs * 1000;
    toast(`Poll interval set to ${secs}s`, 'success');
  } catch (err) {
    toast(`Failed to update: ${err.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  }
}

// ---------------------------------------------------------------------------
// Track delete (admin view modal)
// ---------------------------------------------------------------------------

async function handleDeleteTrack(playlistId, trackId, btn) {
  if (btn.dataset.armed !== 'true') {
    btn.dataset.armed = 'true';
    btn.textContent   = 'Confirm?';
    setTimeout(() => {
      if (btn.dataset.armed === 'true') {
        btn.dataset.armed = 'false';
        btn.textContent   = 'Remove';
      }
    }, 3000);
    return;
  }

  btn.disabled    = true;
  btn.textContent = '…';

  try {
    const res = await apiFetch(
      `${BASE_URL}/api/shared-playlists/${playlistId}/tracks/${encodeURIComponent(trackId)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error ?? `HTTP ${res.status}`);
    }
    btn.closest('tr').remove();
    toast('Track removed from all linked playlists', 'info');
    if (state.view === 'admin') fetchPlaylists();
  } catch (err) {
    toast(`Remove failed: ${err.message}`, 'error');
    btn.disabled      = false;
    btn.textContent   = 'Remove';
    btn.dataset.armed = 'false';
  }
}

// ---------------------------------------------------------------------------
// Admin: reset user sync status
// ---------------------------------------------------------------------------

async function handleAdminResetSync(userId, btn) {
  btn.disabled    = true;
  btn.textContent = '…';
  try {
    const res = await apiFetch(
      `${BASE_URL}/api/admin/users/${encodeURIComponent(userId)}/reset-sync`,
      { method: 'POST' },
    );
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error ?? `HTTP ${res.status}`);
    }
    toast('Sync status reset for user', 'success');
    state.syncStatuses.delete(String(userId));
    await fetchUsers();
  } catch (err) {
    toast(`Reset failed: ${err.message}`, 'error');
    btn.disabled    = false;
    btn.textContent = 'Reset';
  }
}
