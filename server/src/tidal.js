'use strict';

// ---------------------------------------------------------------------------
// Tidal Official API (openapi.tidal.com/v2)
// Ported from extension/background/worker.js — pure Node fetch (Node 18+)
// ---------------------------------------------------------------------------

const TIDAL_API_BASE   = 'https://openapi.tidal.com/v2';
const TIDAL_AUTH_TOKEN = 'https://auth.tidal.com/v1/oauth2/token';

const db = require('./db');

function getClientId() {
  const id = process.env.TIDAL_CLIENT_ID || db.getSetting('tidal_client_id');
  if (!id) throw new Error('Tidal Client ID not configured — complete setup wizard at http://localhost:3000');
  return id;
}

// ---------------------------------------------------------------------------
// Core fetch wrapper
// ---------------------------------------------------------------------------

/**
 * Make an authenticated request to the Tidal v2 API.
 * Returns parsed JSON, or null for 204/202.
 * Throws on error (including 401 — caller must handle token refresh).
 */
async function tidalFetch(path, accessToken, options = {}) {
  const url     = `${TIDAL_API_BASE}${path}`;
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type':  'application/vnd.api+json',
    'Accept':        'application/vnd.api+json',
    ...(options.headers ?? {}),
  };

  async function attempt() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      return await fetch(url, { ...options, headers, signal: controller.signal });
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(`Tidal request timed out: ${path}`);
      throw new Error(`Tidal network error: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  let res = await attempt();

  if (res.status === 401) throw new Error('TIDAL_401');

  if (res.status === 429) {
    const wait = parseInt(res.headers.get('Retry-After') ?? '5', 10);
    console.warn(`[tidal] rate limited on ${path} — waiting ${wait}s then retrying`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    res = await attempt();
    if (res.status === 429) {
      throw new Error(`Tidal rate limit — still limited after retry`);
    }
  }

  if (res.status === 204 || res.status === 202 || res.status === 201) return null;

  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch { /* ignore */ }
    throw new Error(`Tidal ${res.status}: ${body.slice(0, 200)}`);
  }

  // Guard against empty bodies on any other 2xx (some Tidal endpoints omit Content-Type)
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) return null;

  return res.json();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Exchange an auth code (PKCE) for tokens.
 * Returns { accessToken, refreshToken, expiresAt }
 */
async function exchangeCode(code, codeVerifier, redirectUri) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let res;
  try {
    res = await fetch(TIDAL_AUTH_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     getClientId(),
        code,
        redirect_uri:  redirectUri,
        code_verifier: codeVerifier,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Token exchange timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Token exchange failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  return _tokenResponse(data);
}

/**
 * Refresh tokens using a refresh token.
 * Returns { accessToken, refreshToken, expiresAt }
 * Throws on 400/401 (session dead — user must re-authenticate).
 */
async function refreshTokens(refreshToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let res;
  try {
    res = await fetch(TIDAL_AUTH_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        client_id:     getClientId(),
        refresh_token: refreshToken,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Token refresh timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 400 || res.status === 401) {
      throw new Error('TIDAL_SESSION_DEAD');
    }
    throw new Error(`Token refresh failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  return _tokenResponse(data);
}

function _tokenResponse(data) {
  const accessToken  = data.access_token;
  const refreshToken = data.refresh_token;
  const expiresIn    = data.expires_in ?? 3600;
  if (!accessToken) throw new Error('No access_token in token response');
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

// ---------------------------------------------------------------------------
// User profile
// ---------------------------------------------------------------------------

/**
 * Fetch the current user's profile.
 * Returns { userId: string, displayName: string|null }
 */
async function fetchUserProfile(accessToken) {
  const data = await tidalFetch('/users/me', accessToken, { method: 'GET' });
  // JSON:API: { data: { id: "...", attributes: { username, firstName, ... } } }
  const userId      = data?.data?.id ?? data?.id ?? null;
  const displayName = data?.data?.attributes?.username
    ?? data?.data?.attributes?.firstName
    ?? data?.username
    ?? null;
  return { userId: userId ? String(userId) : null, displayName };
}

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

/**
 * Get all playlists owned by a user.
 * Returns the JSON:API data array.
 */
async function tidalGetUserPlaylists(userId, accessToken) {
  const params = new URLSearchParams({ 'filter[owners.id]': userId });
  const data   = await tidalFetch(`/playlists?${params}`, accessToken, { method: 'GET' });
  return data?.data ?? [];
}

/**
 * Get track IDs from a playlist starting at startOffset.
 * Returns { ids: Set<string>, truncated: boolean, nextOffset: number }.
 * Stops after MAX_PAGES pages — caller should resume from nextOffset next cycle.
 */
const MAX_PAGES = 50; // ~1 000 tracks at Tidal's ~20/page page size

async function tidalGetPlaylistTrackIds(playlistId, accessToken, startOffset = 0) {
  const ids    = new Set();
  let   offset = startOffset;
  const limit  = 100;
  let   pages  = 0;

  while (true) {
    const data = await tidalFetch(
      `/playlists/${playlistId}/relationships/items?limit=${limit}&offset=${offset}`,
      accessToken,
      { method: 'GET' },
    );

    const items = data?.data ?? [];
    if (items.length === 0) return { ids, truncated: false, nextOffset: 0 };

    for (const item of items) {
      if (item.id) ids.add(String(item.id));
    }

    pages++;
    offset += items.length;

    if (pages >= MAX_PAGES) {
      console.log(`[tidal] ${playlistId}: pausing scan at offset ${offset} (${ids.size} IDs this chunk) — will continue next cycle`);
      return { ids, truncated: true, nextOffset: offset };
    }

    // Brief pause between pages to avoid bursting into Tidal's rate limit
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * Add a track to a playlist.
 */
async function tidalAddTrack(playlistId, trackId, accessToken) {
  await tidalFetch(`/playlists/${playlistId}/relationships/items`, accessToken, {
    method: 'POST',
    body:   JSON.stringify({ data: [{ id: String(trackId), type: 'tracks' }] }),
  });
}

/**
 * Remove a track from a playlist.
 */
async function tidalRemoveTrack(playlistId, trackId, accessToken) {
  await tidalFetch(`/playlists/${playlistId}/relationships/items`, accessToken, {
    method: 'DELETE',
    body:   JSON.stringify({ data: [{ id: String(trackId), type: 'tracks' }] }),
  });
}

/**
 * Fetch title and primary artist name for a single track.
 * Returns { title: string|null, artist: string|null }
 * Never throws — returns nulls on any error.
 */
async function tidalGetTrackInfo(trackId, accessToken) {
  try {
    const data  = await tidalFetch(`/tracks/${trackId}`, accessToken, { method: 'GET' });
    const track = data?.data;
    if (!track) return { title: null, artist: null };

    const title     = track.attributes?.title ?? null;
    let   artist    = null;

    // Artist may be inlined in `included` (if the server happens to include it)
    const artistRel = track.relationships?.artists?.data;
    if (Array.isArray(artistRel) && artistRel.length > 0 && Array.isArray(data.included)) {
      const found = data.included.find(
        (r) => r.type === 'artists' && r.id === artistRel[0].id,
      );
      artist = found?.attributes?.name ?? null;
    }

    return { title, artist };
  } catch (err) {
    console.warn(`[tidal] Could not fetch track info for ${trackId}: ${err.message}`);
    return { title: null, artist: null };
  }
}

// ---------------------------------------------------------------------------
// PKCE helpers (server-side — uses Node crypto)
// ---------------------------------------------------------------------------

const { randomBytes, createHash } = require('crypto');

function generateCodeVerifier() {
  return randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

function generateState() {
  return randomBytes(16).toString('base64url');
}

// Build a Tidal authorize URL
function buildAuthUrl(redirectUri, codeChallenge, state, scopes = 'user.read playlists.read playlists.write') {
  const params = new URLSearchParams({
    response_type:         'code',
    client_id:             getClientId(),
    redirect_uri:          redirectUri,
    scope:                 scopes,
    code_challenge:        codeChallenge,
    code_challenge_method: 'S256',
    state,
  });
  return `https://login.tidal.com/authorize?${params}`;
}

module.exports = {
  tidalFetch,
  exchangeCode,
  refreshTokens,
  fetchUserProfile,
  tidalGetUserPlaylists,
  tidalGetPlaylistTrackIds,
  tidalAddTrack,
  tidalRemoveTrack,
  tidalGetTrackInfo,
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  buildAuthUrl,
};
