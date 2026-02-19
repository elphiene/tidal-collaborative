'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const config   = require('./config');

/** @type {import('better-sqlite3').Database} */
let db;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function init() {
  const dir = path.dirname(config.DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(config.DB_PATH);

  // Apply schema (idempotent — uses CREATE IF NOT EXISTS throughout)
  const schema = fs.readFileSync(
    path.join(__dirname, '../db/init.sql'),
    'utf8',
  );
  db.exec(schema);

  console.log(`[db] opened ${config.DB_PATH}`);
  return db;
}

function close() {
  if (db) {
    db.close();
    console.log('[db] closed');
  }
}

// ---------------------------------------------------------------------------
// shared_playlists
// ---------------------------------------------------------------------------

function getSharedPlaylists() {
  return db.prepare(`
    SELECT
      sp.id,
      sp.name,
      sp.description,
      sp.created_at,
      COUNT(DISTINCT pl.user_id)                                         AS user_count,
      COUNT(DISTINCT CASE WHEN t.removed_at IS NULL THEN t.id END)      AS track_count
    FROM shared_playlists sp
    LEFT JOIN playlist_links pl ON pl.shared_playlist_id = sp.id
    LEFT JOIN tracks         t  ON t.shared_playlist_id  = sp.id
    GROUP BY sp.id
    ORDER BY sp.created_at DESC
  `).all();
}

function createSharedPlaylist(name, description = null) {
  const info = db.prepare(
    'INSERT INTO shared_playlists (name, description) VALUES (?, ?)',
  ).run(name, description);
  return db.prepare('SELECT * FROM shared_playlists WHERE id = ?').get(info.lastInsertRowid);
}

function deleteSharedPlaylist(id) {
  return db.prepare('DELETE FROM shared_playlists WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// playlist_links
// ---------------------------------------------------------------------------

function getUserLinks(userId) {
  return db.prepare(`
    SELECT pl.*, sp.name AS shared_playlist_name
    FROM playlist_links pl
    JOIN shared_playlists sp ON sp.id = pl.shared_playlist_id
    WHERE pl.user_id = ?
    ORDER BY pl.created_at DESC
  `).all(userId);
}

function getPlaylistLinks(sharedPlaylistId) {
  return db.prepare(
    'SELECT * FROM playlist_links WHERE shared_playlist_id = ?',
  ).all(sharedPlaylistId);
}

function createLink(sharedPlaylistId, userId, tidalPlaylistId) {
  const info = db.prepare(`
    INSERT INTO playlist_links (shared_playlist_id, user_id, tidal_playlist_id)
    VALUES (?, ?, ?)
  `).run(sharedPlaylistId, userId, tidalPlaylistId);
  return db.prepare('SELECT * FROM playlist_links WHERE id = ?').get(info.lastInsertRowid);
}

function deleteLink(id) {
  return db.prepare('DELETE FROM playlist_links WHERE id = ?').run(id);
}

function checkLinkExists(sharedPlaylistId, userId) {
  return db.prepare(`
    SELECT id FROM playlist_links
    WHERE shared_playlist_id = ? AND user_id = ?
  `).get(sharedPlaylistId, userId);
}

// ---------------------------------------------------------------------------
// tracks
// ---------------------------------------------------------------------------

function getPlaylistTracks(sharedPlaylistId) {
  return db.prepare(`
    SELECT * FROM tracks
    WHERE shared_playlist_id = ? AND removed_at IS NULL
    ORDER BY position ASC
  `).all(sharedPlaylistId);
}

function getMaxPosition(sharedPlaylistId) {
  const row = db.prepare(`
    SELECT MAX(position) AS max_pos FROM tracks
    WHERE shared_playlist_id = ? AND removed_at IS NULL
  `).get(sharedPlaylistId);
  return row?.max_pos ?? -1;
}

/**
 * Add a track. Returns the inserted row, or null if the track is already active.
 */
function addTrack(sharedPlaylistId, tidalTrackId, addedBy, position) {
  const existing = db.prepare(`
    SELECT id FROM tracks
    WHERE shared_playlist_id = ? AND tidal_track_id = ? AND removed_at IS NULL
  `).get(sharedPlaylistId, tidalTrackId);

  if (existing) return null;

  const info = db.prepare(`
    INSERT INTO tracks (shared_playlist_id, tidal_track_id, added_by, position)
    VALUES (?, ?, ?, ?)
  `).run(sharedPlaylistId, tidalTrackId, addedBy, position);

  return db.prepare('SELECT * FROM tracks WHERE id = ?').get(info.lastInsertRowid);
}

/**
 * Soft-delete a track (sets removed_at). Returns the run result.
 */
function removeTrack(sharedPlaylistId, tidalTrackId) {
  return db.prepare(`
    UPDATE tracks
    SET removed_at = unixepoch()
    WHERE shared_playlist_id = ? AND tidal_track_id = ? AND removed_at IS NULL
  `).run(sharedPlaylistId, tidalTrackId);
}

/**
 * Bulk-update track positions.
 * @param {number} sharedPlaylistId
 * @param {Array<{ tidalTrackId: string, position: number }>} positions
 */
function updateTrackPositions(sharedPlaylistId, positions) {
  const stmt = db.prepare(`
    UPDATE tracks SET position = ?
    WHERE shared_playlist_id = ? AND tidal_track_id = ? AND removed_at IS NULL
  `);
  const runAll = db.transaction((items) => {
    for (const { tidalTrackId, position } of items) {
      stmt.run(position, sharedPlaylistId, tidalTrackId);
    }
  });
  runAll(positions);
}

// ---------------------------------------------------------------------------
// active_users
// ---------------------------------------------------------------------------

function updateUserLastSeen(userId, sharedPlaylistId) {
  return db.prepare(`
    INSERT INTO active_users (user_id, shared_playlist_id, last_seen)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(user_id, shared_playlist_id)
    DO UPDATE SET last_seen = unixepoch()
  `).run(userId, sharedPlaylistId);
}

function getActiveUsers() {
  return db.prepare(`
    SELECT
      au.user_id,
      au.shared_playlist_id,
      sp.name AS shared_playlist_name,
      au.last_seen
    FROM active_users au
    JOIN shared_playlists sp ON sp.id = au.shared_playlist_id
    ORDER BY au.last_seen DESC
  `).all();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  init,
  close,
  // shared_playlists
  getSharedPlaylists,
  createSharedPlaylist,
  deleteSharedPlaylist,
  // playlist_links
  getUserLinks,
  getPlaylistLinks,
  createLink,
  deleteLink,
  checkLinkExists,
  // tracks
  getPlaylistTracks,
  addTrack,
  removeTrack,
  updateTrackPositions,
  getMaxPosition,
  // active_users
  updateUserLastSeen,
  getActiveUsers,
};
