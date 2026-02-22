'use strict';

const { Router } = require('express');
const db         = require('../db');
const { encrypt, decrypt }  = require('../crypto');
const tidal      = require('../tidal');
const { pollNow, initNewLink } = require('../poller');

const router = Router();

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

router.get('/ping', (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ---------------------------------------------------------------------------
// Auth — OAuth 2.1 PKCE, server-side
// ---------------------------------------------------------------------------

// In-memory PKCE state store: state -> { codeVerifier, created }
const pkceStore = new Map();
const PKCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// GET /api/auth/start
// Generates PKCE params and returns the Tidal authorize URL.
router.get('/auth/start', (req, res) => {
  const codeVerifier  = tidal.generateCodeVerifier();
  const codeChallenge = tidal.generateCodeChallenge(codeVerifier);
  const state         = tidal.generateState();

  pkceStore.set(state, { codeVerifier, created: Date.now() });
  setTimeout(() => pkceStore.delete(state), PKCE_TTL_MS);

  // Build redirect URI from the incoming request so it works on any host
  const proto       = req.headers['x-forwarded-proto'] ?? req.protocol;
  const host        = req.headers['x-forwarded-host'] ?? req.headers.host;
  const redirectUri = `${proto}://${host}/api/auth/callback`;

  const authUrl = tidal.buildAuthUrl(redirectUri, codeChallenge, state);

  console.log(`[api] auth/start: state=${state.slice(0, 8)}… redirectUri=${redirectUri}`);
  res.json({ authUrl, redirectUri });
});

// GET /api/auth/callback  (Tidal redirects here after user logs in)
router.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error('[api] auth/callback error:', error);
    return res.redirect('/?auth=error&reason=' + encodeURIComponent(error));
  }

  const entry = pkceStore.get(state);
  if (!entry || !code) {
    console.error('[api] auth/callback: invalid state or missing code');
    return res.redirect('/?auth=error&reason=invalid_state');
  }

  pkceStore.delete(state); // one-time use

  try {
    const proto       = req.headers['x-forwarded-proto'] ?? req.protocol;
    const host        = req.headers['x-forwarded-host'] ?? req.headers.host;
    const redirectUri = `${proto}://${host}/api/auth/callback`;

    const tokens  = await tidal.exchangeCode(code, entry.codeVerifier, redirectUri);
    const profile = await tidal.fetchUserProfile(tokens.accessToken);

    if (!profile.userId) throw new Error('Could not determine Tidal user ID');

    db.upsertUser(
      profile.userId,
      profile.displayName,
      encrypt(tokens.accessToken),
      encrypt(tokens.refreshToken),
      tokens.expiresAt,
    );

    req.session.userId = profile.userId;
    console.log(`[api] auth/callback: signed in as ${profile.displayName} (${profile.userId})`);
    req.session.save(() => res.redirect('/?auth=ok'));
  } catch (err) {
    console.error('[api] auth/callback failed:', err.message);
    res.redirect('/?auth=error&reason=' + encodeURIComponent(err.message.slice(0, 100)));
  }
});

// POST /api/auth/logout
router.post('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// GET /api/me
router.get('/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not signed in' });
  const user = db.getUser(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Not signed in' });
  }
  res.json({ userId: user.user_id, displayName: user.display_name });
});

// ---------------------------------------------------------------------------
// Admin PIN auth
// ---------------------------------------------------------------------------

// GET /api/admin/status
router.get('/admin/status', (req, res) => {
  res.json({
    pinSet: !!db.getSetting('admin_pin'),
    authed: !!req.session.adminAuthed,
  });
});

// POST /api/admin/setup  — first-time PIN creation
router.post('/admin/setup', (req, res) => {
  if (db.getSetting('admin_pin')) return res.status(409).json({ error: 'PIN already set' });
  const pin = String(req.body?.pin ?? '').trim();
  if (pin.length !== 4) return res.status(400).json({ error: 'PIN must be 4 digits' });
  db.setSetting('admin_pin', pin);
  req.session.adminAuthed = true;
  req.session.save(() => res.json({ ok: true }));
});

// POST /api/admin/auth  — verify PIN
router.post('/admin/auth', (req, res) => {
  const stored = db.getSetting('admin_pin');
  if (!stored) return res.status(400).json({ error: 'No PIN set yet' });
  const pin = String(req.body?.pin ?? '').trim();
  if (pin !== stored) return res.status(401).json({ error: 'Incorrect PIN' });
  req.session.adminAuthed = true;
  req.session.save(() => res.json({ ok: true }));
});

// ---------------------------------------------------------------------------
// Tidal pass-through
// ---------------------------------------------------------------------------

// GET /api/tidal/playlists
router.get('/tidal/playlists', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not signed in' });

  try {
    const user        = db.getUser(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not signed in' });

    let accessToken = decrypt(user.access_token_enc);

    // Refresh if close to expiry
    if (user.token_expires_at - Date.now() < 5 * 60 * 1000) {
      const tokens = await tidal.refreshTokens(decrypt(user.refresh_token_enc));
      db.upsertUser(user.user_id, user.display_name,
        encrypt(tokens.accessToken), encrypt(tokens.refreshToken), tokens.expiresAt);
      accessToken = tokens.accessToken;
    }

    const playlists = await tidal.tidalGetUserPlaylists(user.user_id, accessToken);
    res.json(playlists);
  } catch (err) {
    console.error('[api] GET /tidal/playlists:', err.message);
    res.status(500).json({ error: 'Failed to fetch playlists from Tidal' });
  }
});

// ---------------------------------------------------------------------------
// Shared playlists
// ---------------------------------------------------------------------------

// GET /api/shared-playlists
router.get('/shared-playlists', (_req, res) => {
  try {
    res.json(db.getSharedPlaylists());
  } catch (err) {
    console.error('[api] GET /shared-playlists', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/shared-playlists
// Body: { name: string, description?: string }
router.post('/shared-playlists', (req, res) => {
  const name        = req.body?.name?.trim();
  const description = req.body?.description?.trim() || null;

  if (!name) {
    return res.status(400).json({ error: '"name" is required' });
  }

  try {
    const playlist = db.createSharedPlaylist(name, description);
    res.status(201).json(playlist);
  } catch (err) {
    console.error('[api] POST /shared-playlists', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/shared-playlists/:id
router.delete('/shared-playlists/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const result = db.deleteSharedPlaylist(id);
    if (result.changes === 0) return res.status(404).json({ error: 'Playlist not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] DELETE /shared-playlists/:id', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/shared-playlists/:id/tracks
router.get('/shared-playlists/:id/tracks', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const tracks = db.getPlaylistTracks(id);
    res.json(tracks);
  } catch (err) {
    console.error('[api] GET /shared-playlists/:id/tracks', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Playlist links
// ---------------------------------------------------------------------------

// GET /api/links/:userId
router.get('/links/:userId', (req, res) => {
  const { userId } = req.params;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  try {
    res.json(db.getUserLinks(userId));
  } catch (err) {
    console.error('[api] GET /links/:userId', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/links  (session-based — returns links for the signed-in user)
router.get('/links', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not signed in' });
  try {
    res.json(db.getUserLinks(req.session.userId));
  } catch (err) {
    console.error('[api] GET /links', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/links
// Body: { sharedPlaylistId: number, tidalPlaylistId: string, tidalPlaylistName?: string }
// userId comes from session; body.userId accepted as fallback for compatibility.
router.post('/links', (req, res) => {
  const userId = req.session.userId ?? req.body?.userId;
  const { sharedPlaylistId, tidalPlaylistId, tidalPlaylistName } = req.body ?? {};

  if (!sharedPlaylistId || !userId || !tidalPlaylistId) {
    return res.status(400).json({
      error: '"sharedPlaylistId" and "tidalPlaylistId" are required (userId from session)',
    });
  }

  const spId = parseInt(sharedPlaylistId, 10);
  if (isNaN(spId)) return res.status(400).json({ error: 'Invalid sharedPlaylistId' });

  if (typeof tidalPlaylistId !== 'string' || !tidalPlaylistId.trim()) {
    return res.status(400).json({ error: 'Invalid tidalPlaylistId' });
  }

  try {
    const existing = db.checkLinkExists(spId, userId.trim());
    if (existing) {
      return res.status(409).json({ error: 'Already linked', linkId: existing.id });
    }

    const link   = db.createLink(spId, userId.trim(), tidalPlaylistId.trim(), tidalPlaylistName || null);
    const tracks = db.getPlaylistTracks(spId);

    // Seed the new user's Tidal playlist with existing shared tracks, then poll
    // for any tracks they already had (those get merged into the shared playlist).
    // Run in background — don't block the response.
    initNewLink(link)
      .then(() => pollNow())
      .catch((err) => console.error('[api] initNewLink:', err.message));

    res.status(201).json({ link, tracks });
  } catch (err) {
    console.error('[api] POST /links', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/links/:id
router.delete('/links/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const result = db.deleteLink(id);
    if (result.changes === 0) return res.status(404).json({ error: 'Link not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] DELETE /links/:id', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/shared-playlists/:id/linked-users
router.get('/shared-playlists/:id/linked-users', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const users = db.getLinkedUsers(id);
    res.json(users);
  } catch (err) {
    console.error('[api] GET /shared-playlists/:id/linked-users', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Users (presence)
// ---------------------------------------------------------------------------

// GET /api/users
router.get('/users', (_req, res) => {
  try {
    res.json(db.getActiveUsers());
  } catch (err) {
    console.error('[api] GET /users', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
