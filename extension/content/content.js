/**
 * Tidal Collaborative — Content Script
 * Injected into: https://listen.tidal.com/*
 *
 * What this script does:
 *  1. Intercepts network requests to capture the Tidal Bearer token
 *  2. Monitors SPA navigation to detect when the user enters / leaves a playlist
 *  3. Takes a snapshot of playlist tracks on arrival, then watches for mutations
 *  4. Sends add/remove events to the background service worker
 *
 * ─── SELECTOR GUIDE ────────────────────────────────────────────────────────
 *  Tidal's web player is a React SPA with CSS-module class names that change
 *  between deploys.  We prefer:
 *    1. data-test attributes  (most stable — intentionally added for testing)
 *    2. ARIA roles            (semantically stable)
 *    3. CSS class keywords    (fragile — use as last resort)
 *
 *  To update selectors: open DevTools on listen.tidal.com, navigate to a
 *  playlist, right-click a track row → Inspect.  Look for data-test="..."
 *  attributes or stable ARIA roles on the row and the container.
 *  Then update SELECTORS below.
 * ───────────────────────────────────────────────────────────────────────────
 */

// ---------------------------------------------------------------------------
// Selectors  ← UPDATE THESE after inspecting Tidal's actual DOM
// ---------------------------------------------------------------------------

const SELECTORS = {
  /**
   * The scrollable container that holds all track rows in a playlist.
   * Try each selector in order; the first one that matches wins.
   *
   * TODO: Open DevTools → navigate to playlist → inspect the list wrapper.
   *       Look for data-test="tracklist" or role="list" / role="grid".
   */
  trackListContainer: [
    '[data-test="tracklist"]',          // data-test (preferred)
    '[data-test="virtual-list"]',       // virtualised list wrapper
    '[class*="trackList_"]',            // CSS module (fragile)
    '[class*="PlayQueue"]',
    'main [role="list"]',               // ARIA role (fallback)
    'main [role="grid"]',
  ],

  /**
   * Individual track rows inside the container.
   *
   * TODO: Inspect a single track row.
   *       Look for data-test="tracklist-row" or role="row".
   */
  trackRow: [
    '[data-test="tracklist-row"]',
    '[data-test="track-row"]',
    '[class*="tableRow_"]',
    '[class*="trackItem_"]',
    '[role="row"]',
    'li[class*="track"]',
  ],

  /**
   * Element inside a track row that carries the track ID.
   * Tidal often stores IDs in href="/track/{id}" links, data-* attributes,
   * or embeds them in a React prop that we can read via the fibre tree.
   *
   * TODO: Inside a row element, look for:
   *   - <a href="/track/12345678"> links
   *   - data-track-id="12345678" attributes
   *   - data-id="12345678"
   */
  trackIdCarrier: [
    '[data-track-id]',
    '[data-id]',
    'a[href*="/track/"]',
  ],
};

// ---------------------------------------------------------------------------
// URL / token patterns
// ---------------------------------------------------------------------------

/** Matches /playlist/{uuid} — UUID is exactly 36 hex-and-dash chars */
const PLAYLIST_URL_RE  = /\/playlist\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** Extracts the numeric track ID from an href like "/track/12345678" */
const TRACK_HREF_RE    = /\/track\/(\d+)/i;

/** LocalStorage keys Tidal has used for auth data (check all of them) */
const LS_AUTH_KEYS     = [
  'authentication',
  'tidal.auth',
  'tidal_web_player_auth',
  'token',
];

const LOG_PREFIX       = '[Tidal Collab]';
const DEBOUNCE_MS      = 500;   // wait this long after last mutation before processing
const INIT_SETTLE_MS   = 1200;  // wait after URL change before starting observer
const POLL_INTERVAL_MS = 300;   // container polling interval
const POLL_TIMEOUT_MS  = 8000;  // give up looking for container after this long

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let lastToken       = null;   // last captured Bearer token (string | null)
let lastUserId      = null;   // last captured Tidal user ID (string | null)

let currentPlaylistId  = null;         // UUID of the currently viewed playlist
let trackSnapshot      = new Set();    // track IDs present when observation started
let observer           = null;         // active MutationObserver
let debounceTimer      = null;
let observerSetupTimer = null;         // setTimeout for INIT_SETTLE_MS delay

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

function init() {
  log(`initialising on ${window.location.href}`);

  interceptXHR();
  interceptFetch();
  tryExtractTokenFromStorage();

  monitorNavigation();
  handleUrlChange(window.location.href);
}

// ---------------------------------------------------------------------------
// Token capture
// ---------------------------------------------------------------------------

/**
 * Process a captured Bearer token (and optionally a user ID).
 * Only sends a message to the background if the token has actually changed
 * to avoid unnecessary churn.
 */
function captureCredentials(token, userId = null) {
  let changed = false;

  if (token && token !== lastToken) {
    lastToken = token;
    changed   = true;
    log(`token captured (${token.slice(0, 12)}…)`);
  }

  if (userId && String(userId) !== lastUserId) {
    lastUserId = String(userId);
    changed    = true;
    log(`userId captured: ${lastUserId}`);
  }

  if (changed) {
    sendToBackground('tidal_token', {
      token:  lastToken,
      userId: lastUserId,
    });
  }
}

/**
 * Attempt to decode a JWT payload and extract the user ID.
 * Tidal JWTs carry "uid" or "sub" in the payload.
 * Returns null if the token is not a valid JWT or has no user field.
 */
function userIdFromJWT(token) {
  try {
    const payloadB64 = token.split('.')[1];
    if (!payloadB64) return null;
    const json = atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(json);
    return payload.uid ?? payload.userId ?? payload.sub ?? null;
  } catch {
    return null;
  }
}

/**
 * Scan well-known localStorage keys for an existing Tidal token.
 * Useful when the content script loads after the app has already
 * authenticated (most page loads).
 */
function tryExtractTokenFromStorage() {
  for (const key of LS_AUTH_KEYS) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;

      const data = JSON.parse(raw);

      // Different versions of Tidal's app use different field names
      const token  = data.access_token ?? data.accessToken ?? data.token ?? null;
      const userId = data.userId ?? data.user_id ?? data.sub
        ?? (token ? userIdFromJWT(token) : null);

      if (token) {
        log(`token found in localStorage["${key}"]`);
        captureCredentials(token, userId ? String(userId) : null);
        return;
      }
    } catch { /* malformed JSON — skip */ }
  }
  log('no token in localStorage — will capture from network requests');
}

// ---------------------------------------------------------------------------
// XHR interception
// ---------------------------------------------------------------------------

function interceptXHR() {
  // --- Capture token from outgoing Authorization headers ---
  const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
    if (header.toLowerCase() === 'authorization' && typeof value === 'string') {
      const match = value.match(/^Bearer (.+)$/i);
      if (match) captureCredentials(match[1], userIdFromJWT(match[1]));
    }
    return originalSetHeader.apply(this, arguments);
  };

  // --- Capture userId from API responses ---
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.addEventListener('load', function () {
      try {
        // Sessions endpoint and user-info endpoints carry the userId in the body
        if (/\/(sessions|users\/me)\b/.test(this.responseURL)) {
          const data = JSON.parse(this.responseText);
          const uid  = data.userId ?? data.id ?? null;
          if (uid) captureCredentials(lastToken, String(uid));
        }
      } catch { /* ignore parse errors */ }
    });
    return originalOpen.apply(this, arguments);
  };

  log('XHR intercepted');
}

// ---------------------------------------------------------------------------
// fetch() interception
// ---------------------------------------------------------------------------

function interceptFetch() {
  const originalFetch = window.fetch.bind(window);

  window.fetch = async function (input, init = {}) {
    // Extract Authorization header from the request before it leaves
    try {
      let authValue = null;

      if (input instanceof Request) {
        authValue = input.headers.get('authorization');
      } else if (init?.headers) {
        const h = init.headers;
        authValue = (h instanceof Headers)
          ? h.get('authorization')
          : (h['authorization'] ?? h['Authorization'] ?? null);
      }

      if (authValue) {
        const match = authValue.match(/^Bearer (.+)$/i);
        if (match) captureCredentials(match[1], userIdFromJWT(match[1]));
      }
    } catch { /* never let our code break the original fetch */ }

    const response = await originalFetch(input, init);

    // Peek at sessions / user-info responses to extract userId
    try {
      const url = typeof input === 'string' ? input : input?.url ?? '';
      if (/\/(sessions|users\/me)\b/.test(url)) {
        const clone = response.clone();
        clone.json().then((data) => {
          const uid = data.userId ?? data.id ?? null;
          if (uid) captureCredentials(lastToken, String(uid));
        }).catch(() => {});
      }
    } catch { /* ignore */ }

    return response;
  };

  log('fetch() intercepted');
}

// ---------------------------------------------------------------------------
// SPA navigation monitoring
// ---------------------------------------------------------------------------

function monitorNavigation() {
  // Wrap pushState / replaceState (React Router uses both)
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function (state, title, url) {
      const result = original.apply(this, arguments);
      if (url) handleUrlChange(String(url));
      return result;
    };
  }

  // Back / forward navigation
  window.addEventListener('popstate', () => handleUrlChange(window.location.href));

  log('navigation monitoring active');
}

// ---------------------------------------------------------------------------
// Playlist detection
// ---------------------------------------------------------------------------

/**
 * Called on every URL change.  Determines whether we entered or left a
 * playlist page and starts / stops the MutationObserver accordingly.
 */
function handleUrlChange(url) {
  const match    = url.match(PLAYLIST_URL_RE);
  const newId    = match ? match[1].toLowerCase() : null;

  if (newId === currentPlaylistId) return; // same page — nothing to do

  // ---- Leaving a playlist ----
  if (currentPlaylistId) {
    stopObserving();
    log(`left playlist ${currentPlaylistId}`);
  }

  currentPlaylistId = newId;

  // ---- Entering a playlist ----
  if (currentPlaylistId) {
    log(`detected playlist page: ${currentPlaylistId}`);

    // Give the React app time to render the track list before we attach
    clearTimeout(observerSetupTimer);
    observerSetupTimer = setTimeout(
      () => startObserving(currentPlaylistId),
      INIT_SETTLE_MS,
    );
  }
}

// ---------------------------------------------------------------------------
// MutationObserver lifecycle
// ---------------------------------------------------------------------------

async function startObserving(playlistId) {
  if (observer) stopObserving(); // defensive teardown

  log(`looking for track list container… (${playlistId})`);

  const container = await waitForElement(
    SELECTORS.trackListContainer,
    POLL_TIMEOUT_MS,
    POLL_INTERVAL_MS,
  );

  if (!container) {
    log('⚠  track list container not found — selectors may need updating');
    log('   Open DevTools on this playlist page to inspect and update SELECTORS');
    return;
  }

  // Snapshot the current tracks so we don't fire spurious events on load
  trackSnapshot = captureCurrentTrackIds(container);
  log(`observation started — snapshot: ${trackSnapshot.size} tracks`, [...trackSnapshot]);

  observer = new MutationObserver((mutations) => {
    // Ignore mutations that don't involve track rows being added or removed
    const relevant = mutations.some(
      (m) => m.type === 'childList' && (m.addedNodes.length > 0 || m.removedNodes.length > 0),
    );
    if (!relevant) return;

    // Debounce: process only after changes have settled
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => processTrackChanges(container), DEBOUNCE_MS);
  });

  observer.observe(container, {
    childList: true,
    subtree:   true,  // needed for virtualised lists that nest nodes
  });

  log(`MutationObserver attached to`, container);
}

function stopObserving() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  clearTimeout(debounceTimer);
  clearTimeout(observerSetupTimer);
  trackSnapshot = new Set();
  log('observer stopped');
}

// ---------------------------------------------------------------------------
// Track change processing
// ---------------------------------------------------------------------------

/**
 * Diff the current DOM state against the last snapshot and emit events
 * for tracks that were genuinely added or removed.
 *
 * Using a set-difference approach means:
 *  • Reordering shows up as both a remove and an add for the same ID → net 0 → ignored.
 *  • A genuine add has the ID only in the new set.
 *  • A genuine remove has the ID only in the old snapshot.
 */
function processTrackChanges(container) {
  const current = captureCurrentTrackIds(container);

  const added   = [...current].filter((id) => !trackSnapshot.has(id));
  const removed = [...trackSnapshot].filter((id) => !current.has(id));

  if (added.length === 0 && removed.length === 0) return;

  log(`change detected — added: [${added}]  removed: [${removed}]`);

  for (const trackId of added) {
    log(`→ track added: ${trackId}`);
    sendToBackground('track_added_in_tidal', {
      tidalPlaylistId: currentPlaylistId,
      tidalTrackId:    trackId,
    });
  }

  for (const trackId of removed) {
    log(`→ track removed: ${trackId}`);
    sendToBackground('track_removed_in_tidal', {
      tidalPlaylistId: currentPlaylistId,
      tidalTrackId:    trackId,
    });
  }

  // Update snapshot to the current state
  trackSnapshot = current;
}

// ---------------------------------------------------------------------------
// Track ID extraction
// ---------------------------------------------------------------------------

/**
 * Walk every track row currently in the container and collect track IDs.
 * Returns a Set<string> of numeric Tidal track IDs.
 */
function captureCurrentTrackIds(container) {
  const ids  = new Set();
  const rows = findTrackRows(container);

  for (const row of rows) {
    const id = extractTrackId(row);
    if (id) ids.add(id);
  }

  return ids;
}

/**
 * Find all track-row elements within a container using the selector list.
 * Returns an empty array if nothing matches (fails gracefully).
 */
function findTrackRows(container) {
  for (const selector of SELECTORS.trackRow) {
    const rows = container.querySelectorAll(selector);
    if (rows.length > 0) {
      log(`track rows found via selector "${selector}" (${rows.length} rows)`);
      return Array.from(rows);
    }
  }
  log('⚠  no track rows matched — update SELECTORS.trackRow');
  return [];
}

/**
 * Extract the Tidal track ID from a single row element.
 * Tries multiple strategies in order of reliability.
 *
 * @param  {Element} row
 * @returns {string|null}  numeric track ID as a string, or null
 */
function extractTrackId(row) {
  // ── Strategy 1: data-track-id / data-id attributes directly on the row ──
  const directAttr = row.getAttribute('data-track-id')
    ?? row.getAttribute('data-id')
    ?? row.getAttribute('data-testid');

  if (directAttr && /^\d+$/.test(directAttr)) return directAttr;

  // ── Strategy 2: data-* attributes on a child element ──
  for (const selector of SELECTORS.trackIdCarrier) {
    const el = row.querySelector(selector);
    if (!el) continue;

    // data-track-id or data-id attribute
    const attr = el.getAttribute('data-track-id') ?? el.getAttribute('data-id');
    if (attr && /^\d+$/.test(attr)) return attr;

    // href="/track/12345678"
    const href = el.getAttribute('href') ?? '';
    const hrefMatch = href.match(TRACK_HREF_RE);
    if (hrefMatch) return hrefMatch[1];
  }

  // ── Strategy 3: any href="/track/{id}" anywhere inside the row ──
  const anyLink = row.querySelector('a[href*="/track/"]');
  if (anyLink) {
    const m = anyLink.getAttribute('href').match(TRACK_HREF_RE);
    if (m) return m[1];
  }

  // ── Strategy 4: React fibre props ──────────────────────────────────────
  // Tidal is a React app; track data lives in the component props.
  // Walk up the fibre tree from the row element looking for a prop that
  // carries the track ID.
  // NOTE: This relies on React internals and may break on major React upgrades.
  const reactId = extractFromReactFibre(row);
  if (reactId) return reactId;

  // ── Strategy 5: aria-label containing a track title / ID ──────────────
  // Some players encode the track ID in an aria-label like "Play track 12345678"
  const ariaLabel = row.getAttribute('aria-label') ?? '';
  const ariaMatch = ariaLabel.match(/\b(\d{6,})\b/);  // Tidal track IDs are ≥6 digits
  if (ariaMatch) return ariaMatch[1];

  return null;
}

/**
 * Walk the React fibre tree rooted at `element` looking for a memoized prop
 * that looks like a Tidal track ID.
 *
 * Tidal components typically carry the track as `{ id, title, ... }` or
 * as `{ trackId, ... }` in their props or context.
 *
 * @param  {Element} element
 * @returns {string|null}
 */
function extractFromReactFibre(element) {
  // Find the fibre key that React attaches to DOM nodes
  const fibreKey = Object.keys(element).find(
    (k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'),
  );
  if (!fibreKey) return null;

  let fibre = element[fibreKey];
  let depth = 0;

  while (fibre && depth < 20) {
    const props = fibre.memoizedProps ?? fibre.pendingProps ?? {};

    // Common prop shapes Tidal has used:
    //   { trackId: 12345678 }
    //   { item: { id: 12345678, type: 'track' } }
    //   { track: { id: 12345678 } }
    //   { id: 12345678, type: 'track' }

    if (props.trackId && /^\d+$/.test(String(props.trackId))) {
      return String(props.trackId);
    }
    if (props.item?.id && props.item?.type === 'track') {
      return String(props.item.id);
    }
    if (props.track?.id) {
      return String(props.track.id);
    }
    if (props.id && typeof props.id === 'number') {
      return String(props.id);
    }

    fibre = fibre.return;
    depth++;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Communication with background service worker
// ---------------------------------------------------------------------------

/**
 * Send a typed message to the background service worker.
 * Silently swallows errors — the background may not be alive yet.
 */
function sendToBackground(type, payload) {
  log(`→ background: type=${type}`, payload);
  chrome.runtime.sendMessage({ type, ...payload }).catch((err) => {
    log(`⚠  sendMessage failed (type=${type}): ${err.message}`);
  });
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Poll for an element matching any selector in the provided list.
 * Resolves with the first match, or null after timeoutMs.
 *
 * @param {string[]} selectors
 * @param {number}   timeoutMs
 * @param {number}   intervalMs
 * @returns {Promise<Element|null>}
 */
function waitForElement(selectors, timeoutMs, intervalMs) {
  return new Promise((resolve) => {
    const start = Date.now();

    const check = () => {
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el) {
          log(`element found via "${selector}" after ${Date.now() - start}ms`);
          return resolve(el);
        }
      }
      if (Date.now() - start >= timeoutMs) {
        return resolve(null);
      }
      setTimeout(check, intervalMs);
    };

    check();
  });
}

/**
 * Structured console.log with prefix and timestamp.
 */
function log(...args) {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  console.log(`${LOG_PREFIX} [${ts}]`, ...args);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

init();
