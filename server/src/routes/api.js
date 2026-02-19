'use strict';

const { Router } = require('express');
const db = require('../db');

const router = Router();

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

router.get('/ping', (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ---------------------------------------------------------------------------
// Shared playlists
// ---------------------------------------------------------------------------

// GET /api/shared-playlists
// Returns all shared playlists with aggregated user_count and track_count.
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

// POST /api/links
// Body: { sharedPlaylistId: number, userId: string, tidalPlaylistId: string }
// Returns: { link, tracks } — tracks used by the extension for initial sync.
router.post('/links', (req, res) => {
  const { sharedPlaylistId, userId, tidalPlaylistId } = req.body ?? {};

  if (!sharedPlaylistId || !userId || !tidalPlaylistId) {
    return res.status(400).json({
      error: '"sharedPlaylistId", "userId", and "tidalPlaylistId" are all required',
    });
  }

  const spId = parseInt(sharedPlaylistId, 10);
  if (isNaN(spId)) return res.status(400).json({ error: 'Invalid sharedPlaylistId' });

  if (typeof userId !== 'string' || !userId.trim()) {
    return res.status(400).json({ error: 'Invalid userId' });
  }
  if (typeof tidalPlaylistId !== 'string' || !tidalPlaylistId.trim()) {
    return res.status(400).json({ error: 'Invalid tidalPlaylistId' });
  }

  try {
    const existing = db.checkLinkExists(spId, userId.trim());
    if (existing) {
      return res.status(409).json({ error: 'Already linked', linkId: existing.id });
    }

    const link   = db.createLink(spId, userId.trim(), tidalPlaylistId.trim());
    const tracks = db.getPlaylistTracks(spId);
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

// ---------------------------------------------------------------------------
// Users (presence)
// ---------------------------------------------------------------------------

// GET /api/users
// Returns all rows from active_users joined with shared_playlist name.
// Used by the admin panel to show the "Recent Users" table.
router.get('/users', (_req, res) => {
  try {
    res.json(db.getActiveUsers());
  } catch (err) {
    console.error('[api] GET /users', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
