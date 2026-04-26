'use strict';

const { Router }           = require('express');
const nodeCrypto           = require('node:crypto');
const db                   = require('../db');
const { encrypt }          = require('../crypto');
const tidal                = require('../tidal');
const {
  pollNow,
  initNewLink,
  getAccessTokenForUser,
  syncPlaylistForLink,
  propagateRemoveToAllUsers,
} = require('../poller');

const router = Router();

function generateInviteCode() {
  return nodeCrypto.randomBytes(6).toString('base64url').toUpperCase().slice(0, 8);
}

// Lazily-imported to avoid circular dep; ws.js is loaded before routes in index.js
function getBroadcast() {
  return require('./ws').broadcast;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

const { version } = require('../../package.json');

router.get('/ping', (_req, res) => {
  res.json({ ok: true, ts: Date.now(), version });
});

// ---------------------------------------------------------------------------
// Auth — OAuth 2.1 PKCE, server-side
// ---------------------------------------------------------------------------

const pkceStore  = new Map();
const PKCE_TTL_MS = 5 * 60 * 1000;

router.get('/auth/start', (req, res) => {
  const codeVerifier  = tidal.generateCodeVerifier();
  const codeChallenge = tidal.generateCodeChallenge(codeVerifier);
  const state         = tidal.generateState();

  pkceStore.set(state, { codeVerifier, created: Date.now() });
  setTimeout(() => pkceStore.delete(state), PKCE_TTL_MS);

  const proto       = req.headers['x-forwarded-proto'] ?? req.protocol;
  const host        = req.headers['x-forwarded-host'] ?? req.headers.host;
  const redirectUri = `${proto}://${host}/api/auth/callback`;

  const authUrl = tidal.buildAuthUrl(redirectUri, codeChallenge, state);
  console.log(`[api] auth/start: state=${state.slice(0, 8)}… redirectUri=${redirectUri}`);
  res.json({ authUrl, redirectUri });
});

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

  pkceStore.delete(state);

  try {
    const proto       = req.headers['x-forwarded-proto'] ?? req.protocol;
    const host        = req.headers['x-forwarded-host'] ?? req.headers.host;
    const redirectUri = `${proto}://${host}/api/auth/callback`;

    const tokens  = await tidal.exchangeCode(code, entry.codeVerifier, redirectUri);
    const profile = await tidal.fetchUserProfile(tokens.accessToken);

    if (!profile.userId) throw new Error('Could not determine Tidal user ID');

    db.upsertUser(
      profile.userId, profile.displayName,
      encrypt(tokens.accessToken), encrypt(tokens.refreshToken), tokens.expiresAt,
    );

    req.session.userId = profile.userId;
    console.log(`[api] auth/callback: signed in as ${profile.displayName} (${profile.userId})`);
    req.session.save(() => res.redirect('/?auth=ok'));
  } catch (err) {
    console.error('[api] auth/callback failed:', err.message);
    res.redirect('/?auth=error&reason=' + encodeURIComponent(err.message.slice(0, 100)));
  }
});

router.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

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

router.get('/admin/status', (req, res) => {
  res.json({ pinSet: !!db.getSetting('admin_pin'), authed: !!req.session.adminAuthed });
});

router.post('/admin/setup', (req, res) => {
  if (db.getSetting('admin_pin')) return res.status(409).json({ error: 'PIN already set' });
  const pin = String(req.body?.pin ?? '').trim();
  if (pin.length !== 4) return res.status(400).json({ error: 'PIN must be 4 digits' });
  db.setSetting('admin_pin', pin);
  req.session.adminAuthed = true;
  req.session.save(() => res.json({ ok: true }));
});

router.post('/admin/auth', (req, res) => {
  const stored = db.getSetting('admin_pin');
  if (!stored) return res.status(400).json({ error: 'No PIN set yet' });
  const pin = String(req.body?.pin ?? '').trim();
  if (pin !== stored) return res.status(401).json({ error: 'Incorrect PIN' });
  req.session.adminAuthed = true;
  req.session.save(() => res.json({ ok: true }));
});

// ---------------------------------------------------------------------------
// Admin — settings (poll interval etc.)
// ---------------------------------------------------------------------------

router.get('/admin/settings', (req, res) => {
  if (!req.session.adminAuthed) return res.status(403).json({ error: 'Admin auth required' });
  res.json({
    poll_interval_ms: db.getPollInterval(),
  });
});

router.patch('/admin/settings', (req, res) => {
  if (!req.session.adminAuthed) return res.status(403).json({ error: 'Admin auth required' });
  try {
    if (req.body?.poll_interval_ms !== undefined) {
      const ms = parseInt(req.body.poll_interval_ms, 10);
      if (isNaN(ms)) return res.status(400).json({ error: 'poll_interval_ms must be a number' });
      db.setPollInterval(ms);
      getBroadcast()(null, { type: 'settings_updated', key: 'poll_interval_ms', value: db.getPollInterval() });
      console.log(`[api] poll interval updated to ${db.getPollInterval()}ms`);
    }
    res.json({ ok: true, poll_interval_ms: db.getPollInterval() });
  } catch (err) {
    console.error('[api] PATCH /admin/settings', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/force-poll — trigger an immediate poll cycle for all users
router.post('/admin/force-poll', (req, res) => {
  if (!req.session.adminAuthed) return res.status(403).json({ error: 'Admin auth required' });
  pollNow();
  res.json({ ok: true });
});

// POST /api/admin/users/:id/reset-sync — clear error/revoked status so user is polled again
router.post('/admin/users/:id/reset-sync', (req, res) => {
  if (!req.session.adminAuthed) return res.status(403).json({ error: 'Admin auth required' });
  const userId = req.params.id;
  const user   = db.getUser(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  try {
    db.resetUserSyncStatus(userId);
    getBroadcast()(null, { type: 'sync_status', user_id: userId, status: 'ok', message: null });
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] POST /admin/users/:id/reset-sync', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/sync/status — per-user sync health (usable by signed-in users)
router.get('/sync/status', (req, res) => {
  if (!req.session.userId && !req.session.adminAuthed) {
    return res.status(401).json({ error: 'Not signed in' });
  }
  try {
    res.json(db.getUserSyncStatuses());
  } catch (err) {
    console.error('[api] GET /sync/status', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Tidal pass-through
// ---------------------------------------------------------------------------

router.get('/tidal/playlists', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not signed in' });

  try {
    const user = db.getUser(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not signed in' });

    const accessToken = await getAccessTokenForUser(user);
    const playlists   = await tidal.tidalGetUserPlaylists(user.user_id, accessToken);
    res.json(playlists);
  } catch (err) {
    console.error('[api] GET /tidal/playlists:', err.message);
    if (err.message === 'TIDAL_SESSION_DEAD') {
      return res.status(401).json({ error: 'Tidal session expired — please sign out and sign in again' });
    }
    res.status(500).json({ error: 'Failed to fetch playlists from Tidal' });
  }
});

// ---------------------------------------------------------------------------
// Shared playlists
// ---------------------------------------------------------------------------

router.get('/shared-playlists', (req, res) => {
  try {
    const userId = req.session.adminAuthed ? null : (req.session.userId ?? null);
    res.json(db.getSharedPlaylists(userId));
  } catch (err) {
    console.error('[api] GET /shared-playlists', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/shared-playlists/discover', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not signed in' });
  try {
    res.json(db.getPublicPlaylists(req.session.userId));
  } catch (err) {
    console.error('[api] GET /shared-playlists/discover', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/shared-playlists', (req, res) => {
  if (!req.session.userId && !req.session.adminAuthed) {
    return res.status(401).json({ error: 'Not signed in' });
  }

  const name              = req.body?.name?.trim();
  const description       = req.body?.description?.trim() || null;
  const isPublic          = !!req.body?.isPublic;
  const tidalPlaylistId   = req.body?.tidalPlaylistId?.trim() || null;
  const tidalPlaylistName = req.body?.tidalPlaylistName?.trim() || null;

  if (!name) return res.status(400).json({ error: '"name" is required' });

  try {
    const playlist = db.createSharedPlaylist(name, description, req.session.userId ?? null, isPublic);

    let link = null;
    if (tidalPlaylistId && req.session.userId) {
      link = db.createLink(playlist.id, req.session.userId, tidalPlaylistId, tidalPlaylistName);
      // initNewLink handles the pollNow internally
      initNewLink(link).catch(err => console.error('[api] initNewLink:', err.message));
    }

    res.status(201).json({ playlist, link });
  } catch (err) {
    console.error('[api] POST /shared-playlists', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/shared-playlists/:id', (req, res) => {
  const isAdmin = !!req.session.adminAuthed;
  if (!req.session.userId && !isAdmin) return res.status(401).json({ error: 'Not signed in' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  if (typeof req.body?.isPublic !== 'boolean') {
    return res.status(400).json({ error: '"isPublic" (boolean) is required' });
  }

  try {
    const playlists = db.getSharedPlaylists();
    const pl = playlists.find(p => p.id === id);
    if (!pl) return res.status(404).json({ error: 'Playlist not found' });
    if (pl.created_by !== req.session.userId && !isAdmin) return res.status(403).json({ error: 'Forbidden' });

    db.updateSharedPlaylist(id, { isPublic: req.body.isPublic });
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] PATCH /shared-playlists/:id', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/shared-playlists/:id', (req, res) => {
  const isAdmin = !!req.session.adminAuthed;
  if (!req.session.userId && !isAdmin) return res.status(401).json({ error: 'Not signed in' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const playlists = db.getSharedPlaylists();
    const pl = playlists.find(p => p.id === id);
    if (!pl) return res.status(404).json({ error: 'Playlist not found' });
    if (pl.created_by !== req.session.userId && !isAdmin) return res.status(403).json({ error: 'Forbidden' });

    db.deleteSharedPlaylist(id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] DELETE /shared-playlists/:id', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/shared-playlists/:id/tracks', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    res.json(db.getPlaylistTracks(id));
  } catch (err) {
    console.error('[api] GET /shared-playlists/:id/tracks', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/shared-playlists/:id/tracks/:trackId
// Removes a track from the shared playlist AND from all members' Tidal playlists.
router.delete('/shared-playlists/:id/tracks/:trackId', async (req, res) => {
  if (!req.session.userId && !req.session.adminAuthed) {
    return res.status(401).json({ error: 'Not signed in' });
  }

  const spId    = parseInt(req.params.id, 10);
  const trackId = String(req.params.trackId).trim();
  if (isNaN(spId) || !trackId) return res.status(400).json({ error: 'Invalid parameters' });

  try {
    const result = db.removeTrack(spId, trackId);
    if (result.changes === 0) return res.status(404).json({ error: 'Track not found or already removed' });

    const removedBy = req.session.userId ?? 'admin';
    getBroadcast()(spId, {
      type:               'track_removed',
      shared_playlist_id: spId,
      tidal_track_id:     trackId,
      removed_by:         removedBy,
      timestamp:          Date.now(),
    });

    // Propagate removal to all linked Tidal playlists (fire-and-forget, non-blocking)
    propagateRemoveToAllUsers(spId, trackId)
      .catch(err => console.error('[api] propagate remove failed:', err.message));

    res.json({ ok: true });
  } catch (err) {
    console.error('[api] DELETE /shared-playlists/:id/tracks/:trackId', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/shared-playlists/:id/tracks/reorder
router.post('/shared-playlists/:id/tracks/reorder', (req, res) => {
  if (!req.session.userId && !req.session.adminAuthed) {
    return res.status(401).json({ error: 'Not signed in' });
  }

  const spId      = parseInt(req.params.id, 10);
  const positions = req.body?.positions;
  if (isNaN(spId)) return res.status(400).json({ error: 'Invalid id' });
  if (!Array.isArray(positions) || positions.length === 0) {
    return res.status(400).json({ error: '"positions" array is required' });
  }

  const normalised = [];
  for (const entry of positions) {
    if (!entry.tidal_track_id || typeof entry.position !== 'number' || !Number.isInteger(entry.position)) {
      return res.status(400).json({ error: 'Each entry needs tidal_track_id (string) and position (integer)' });
    }
    normalised.push({ tidalTrackId: String(entry.tidal_track_id), position: entry.position });
  }

  try {
    db.updateTrackPositions(spId, normalised);

    getBroadcast()(spId, {
      type:               'tracks_reordered',
      shared_playlist_id: spId,
      positions,
      reordered_by:       req.session.userId ?? 'admin',
      timestamp:          Date.now(),
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[api] POST /shared-playlists/:id/tracks/reorder', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Invite codes
// ---------------------------------------------------------------------------

router.post('/shared-playlists/:id/invites', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not signed in' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const playlists = db.getSharedPlaylists();
    const pl = playlists.find(p => p.id === id);
    if (!pl) return res.status(404).json({ error: 'Playlist not found' });
    if (pl.created_by !== req.session.userId && !req.session.adminAuthed) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    let invite = null, attempts = 0;
    do {
      try { invite = db.createInvite(id, generateInviteCode()); }
      catch { if (++attempts > 5) throw new Error('Could not generate unique code'); invite = null; }
    } while (!invite);

    res.status(201).json(invite);
  } catch (err) {
    console.error('[api] POST /shared-playlists/:id/invites', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/shared-playlists/:id/invites', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not signed in' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const playlists = db.getSharedPlaylists();
    const pl = playlists.find(p => p.id === id);
    if (!pl) return res.status(404).json({ error: 'Playlist not found' });
    if (pl.created_by !== req.session.userId && !req.session.adminAuthed) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.json(db.getInvitesByPlaylist(id));
  } catch (err) {
    console.error('[api] GET /shared-playlists/:id/invites', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/invites/:id', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not signed in' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const result = db.revokeInvite(id);
    if (result.changes === 0) return res.status(404).json({ error: 'Invite not found or already revoked' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] DELETE /invites/:id', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/invites/:code', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not signed in' });
  const code = req.params.code.trim().toUpperCase();
  try {
    const invite = db.getInviteByCode(code);
    if (!invite) return res.status(404).json({ error: 'Invalid or expired invite code' });
    const playlists = db.getSharedPlaylists();
    const pl = playlists.find(p => p.id === invite.shared_playlist_id);
    if (!pl) return res.status(404).json({ error: 'Playlist no longer exists' });
    res.json({ sharedPlaylistId: pl.id, sharedPlaylistName: pl.name });
  } catch (err) {
    console.error('[api] GET /invites/:code', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Playlist links
// ---------------------------------------------------------------------------

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

router.get('/links', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not signed in' });
  try {
    res.json(db.getUserLinks(req.session.userId));
  } catch (err) {
    console.error('[api] GET /links', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/links', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not signed in' });
  const userId = req.session.userId;
  const { inviteCode, sharedPlaylistId, tidalPlaylistId, tidalPlaylistName } = req.body ?? {};

  if (!tidalPlaylistId) return res.status(400).json({ error: '"tidalPlaylistId" is required' });
  if (!inviteCode && !sharedPlaylistId) {
    return res.status(400).json({ error: 'Either "inviteCode" or "sharedPlaylistId" is required' });
  }

  try {
    let spId;
    if (inviteCode) {
      const invite = db.getInviteByCode(String(inviteCode).trim().toUpperCase());
      if (!invite) return res.status(403).json({ error: 'Invalid or expired invite code' });
      spId = invite.shared_playlist_id;
    } else {
      spId = parseInt(sharedPlaylistId, 10);
      if (isNaN(spId)) return res.status(400).json({ error: 'Invalid sharedPlaylistId' });
      const playlists = db.getSharedPlaylists();
      const pl = playlists.find(p => p.id === spId);
      if (!pl) return res.status(404).json({ error: 'Playlist not found' });
      if (!pl.is_public) {
        return res.status(403).json({ error: 'This playlist is private — an invite link is required' });
      }
    }

    const existing = db.checkLinkExists(spId, userId);
    if (existing) return res.status(409).json({ error: 'Already linked', linkId: existing.id });

    const link   = db.createLink(spId, userId, tidalPlaylistId.trim(), tidalPlaylistName || null);
    const tracks = db.getPlaylistTracks(spId);

    initNewLink(link).catch(err => console.error('[api] initNewLink:', err.message));

    res.status(201).json({ link, tracks });
  } catch (err) {
    console.error('[api] POST /links', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/links/:id', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not signed in' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const link = db.getLinkById(id);
    if (!link) return res.status(404).json({ error: 'Link not found' });
    if (link.user_id !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });
    db.deleteLink(id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] DELETE /links/:id', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/links/:id/sync — full bidirectional sync for a specific link
router.post('/links/:id/sync', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not signed in' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const link = db.getLinkById(id);
    if (!link) return res.status(404).json({ error: 'Link not found' });
    if (link.user_id !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });

    const user = db.getUser(req.session.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });

    let accessToken;
    try {
      accessToken = await getAccessTokenForUser(user);
    } catch {
      return res.status(502).json({ error: 'Tidal session expired — please sign out and back in' });
    }

    const result = await syncPlaylistForLink(link, accessToken);
    res.json(result);
  } catch (err) {
    console.error('[api] POST /links/:id/sync', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/shared-playlists/:id/linked-users', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    res.json(db.getLinkedUsers(id));
  } catch (err) {
    console.error('[api] GET /shared-playlists/:id/linked-users', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Setup wizard
// ---------------------------------------------------------------------------

router.get('/setup/status', (_req, res) => {
  const clientIdSet = !!(process.env.TIDAL_CLIENT_ID || db.getSetting('tidal_client_id'));
  const adminPinSet = !!db.getSetting('admin_pin');
  res.json({ complete: clientIdSet && adminPinSet, clientIdSet, adminPinSet });
});

router.post('/setup/tidal-client-id', (req, res) => {
  const clientId = String(req.body?.clientId ?? '').trim();
  if (!clientId) return res.status(400).json({ error: 'clientId is required' });
  db.setSetting('tidal_client_id', clientId);
  console.log('[api] Tidal Client ID saved via setup wizard');
  res.json({ ok: true });
});

router.get('/setup/redirect-uri', (req, res) => {
  const proto       = req.headers['x-forwarded-proto'] ?? req.protocol;
  const host        = req.headers['x-forwarded-host'] ?? req.headers.host;
  const redirectUri = `${proto}://${host}/api/auth/callback`;
  res.json({ redirectUri });
});

// ---------------------------------------------------------------------------
// Users (presence)
// ---------------------------------------------------------------------------

router.get('/users', (_req, res) => {
  try {
    res.json(db.getActiveUsers());
  } catch (err) {
    console.error('[api] GET /users', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/users/all', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not signed in' });
  try {
    res.json(db.getAllUsersWithPresence());
  } catch (err) {
    console.error('[api] GET /users/all', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Admin — dedup Tidal playlists
// ---------------------------------------------------------------------------

router.post('/admin/dedup-playlists', async (req, res) => {
  if (!req.session.adminAuthed) return res.status(403).json({ error: 'Admin auth required' });

  const report = [];
  const users  = db.getAllUsersWithLinks();

  for (const user of users) {
    let accessToken;
    try {
      accessToken = await getAccessTokenForUser(user);
    } catch {
      console.warn(`[dedup] skipping user ${user.user_id} — token unavailable`);
      continue;
    }

    const links = db.getUserLinks(user.user_id);
    for (const link of links) {
      let rawIds;
      try {
        rawIds = await tidal.tidalGetPlaylistTrackList(link.tidal_playlist_id, accessToken);
      } catch (err) {
        console.error(`[dedup] could not fetch ${link.tidal_playlist_id}: ${err.message}`);
        continue;
      }

      const counts = new Map();
      for (const id of rawIds) counts.set(id, (counts.get(id) ?? 0) + 1);

      const fixed = [];
      for (const [id, count] of counts) {
        if (count <= 1) continue;
        try {
          await tidal.tidalRemoveTrack(link.tidal_playlist_id, id, accessToken);
          await new Promise(r => setTimeout(r, 300));
          await tidal.tidalAddTrack(link.tidal_playlist_id, id, accessToken);
          fixed.push({ id, removedCount: count - 1 });
        } catch (err) {
          console.error(`[dedup] playlist=${link.tidal_playlist_id} track=${id}: ${err.message}`);
        }
        await new Promise(r => setTimeout(r, 300));
      }

      if (fixed.length > 0) {
        report.push({ userId: user.user_id, playlistId: link.tidal_playlist_id, fixed });
      }
    }
  }

  res.json({ ok: true, report });
});

module.exports = router;
