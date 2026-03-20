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

  // Migrations: add new columns if they don't exist (safe to run multiple times)
  try {
    db.exec('ALTER TABLE playlist_links ADD COLUMN tidal_playlist_name TEXT');
  } catch { /* column already exists */ }
  try {
    db.exec('ALTER TABLE tracks ADD COLUMN track_title TEXT');
  } catch { /* column already exists */ }
  try {
    db.exec('ALTER TABLE tracks ADD COLUMN track_artist TEXT');
  } catch { /* column already exists */ }
  try {
    db.exec('ALTER TABLE shared_playlists ADD COLUMN created_by TEXT');
  } catch { /* column already exists */ }
  try {
    db.exec('ALTER TABLE shared_playlists ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0');
  } catch { /* column already exists */ }
  try {
    db.exec('ALTER TABLE users ADD COLUMN token_dead INTEGER NOT NULL DEFAULT 0');
  } catch { /* column already exists */ }
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS playlist_invites (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      shared_playlist_id INTEGER NOT NULL REFERENCES shared_playlists(id) ON DELETE CASCADE,
      code               TEXT    NOT NULL UNIQUE,
      created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
      revoked_at         INTEGER
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_invites_playlist ON playlist_invites(shared_playlist_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_invites_code ON playlist_invites(code)');
  } catch { /* already exists */ }

  // Backfill created_by for legacy playlists (pre-dating the column)
  try {
    db.exec(`
      UPDATE shared_playlists
      SET created_by = (
        SELECT user_id FROM playlist_links
        WHERE shared_playlist_id = shared_playlists.id
        ORDER BY created_at ASC
        LIMIT 1
      )
      WHERE created_by IS NULL
        AND id IN (SELECT DISTINCT shared_playlist_id FROM playlist_links)
    `);
  } catch { /* ignore */ }

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

function getSharedPlaylists(userId = null) {
  if (!userId) {
    // Admin call — return all
    return db.prepare(`
      SELECT sp.*,
        COUNT(DISTINCT pl.user_id)                                     AS user_count,
        COUNT(DISTINCT CASE WHEN t.removed_at IS NULL THEN t.id END)  AS track_count
      FROM shared_playlists sp
      LEFT JOIN playlist_links pl ON pl.shared_playlist_id = sp.id
      LEFT JOIN tracks         t  ON t.shared_playlist_id  = sp.id
      GROUP BY sp.id ORDER BY sp.created_at DESC
    `).all();
  }
  // User call — return only playlists they created or are linked to
  return db.prepare(`
    SELECT sp.*,
      COUNT(DISTINCT pl.user_id)                                     AS user_count,
      COUNT(DISTINCT CASE WHEN t.removed_at IS NULL THEN t.id END)  AS track_count
    FROM shared_playlists sp
    LEFT JOIN playlist_links pl ON pl.shared_playlist_id = sp.id
    LEFT JOIN tracks         t  ON t.shared_playlist_id  = sp.id
    WHERE sp.created_by = ?
       OR sp.id IN (SELECT shared_playlist_id FROM playlist_links WHERE user_id = ?)
    GROUP BY sp.id ORDER BY sp.created_at DESC
  `).all(userId, userId);
}

function getPublicPlaylists(userId) {
  return db.prepare(`
    SELECT sp.*,
      COUNT(DISTINCT pl.user_id)                                     AS user_count,
      COUNT(DISTINCT CASE WHEN t.removed_at IS NULL THEN t.id END)  AS track_count
    FROM shared_playlists sp
    LEFT JOIN playlist_links pl ON pl.shared_playlist_id = sp.id
    LEFT JOIN tracks         t  ON t.shared_playlist_id  = sp.id
    WHERE sp.is_public = 1
      AND (sp.created_by IS NULL OR sp.created_by != ?)
      AND sp.id NOT IN (SELECT shared_playlist_id FROM playlist_links WHERE user_id = ?)
    GROUP BY sp.id ORDER BY sp.created_at DESC
  `).all(userId, userId);
}

function createSharedPlaylist(name, description = null, createdBy = null, isPublic = 0) {
  const info = db.prepare(
    'INSERT INTO shared_playlists (name, description, created_by, is_public) VALUES (?, ?, ?, ?)',
  ).run(name, description, createdBy, isPublic ? 1 : 0);
  return db.prepare('SELECT * FROM shared_playlists WHERE id = ?').get(info.lastInsertRowid);
}

function updateSharedPlaylist(id, { isPublic }) {
  return db.prepare(
    'UPDATE shared_playlists SET is_public = ? WHERE id = ?',
  ).run(isPublic ? 1 : 0, id);
}

function deleteSharedPlaylist(id) {
  return db.prepare('DELETE FROM shared_playlists WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// playlist_links
// ---------------------------------------------------------------------------

function getUserLinks(userId) {
  return db.prepare(`
    SELECT pl.*, sp.name AS shared_playlist_name,
           sp.created_by AS playlist_created_by,
           sp.is_public  AS playlist_is_public
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

function createLink(sharedPlaylistId, userId, tidalPlaylistId, tidalPlaylistName = null) {
  const info = db.prepare(`
    INSERT INTO playlist_links (shared_playlist_id, user_id, tidal_playlist_id, tidal_playlist_name)
    VALUES (?, ?, ?, ?)
  `).run(sharedPlaylistId, userId, tidalPlaylistId, tidalPlaylistName);
  return db.prepare('SELECT * FROM playlist_links WHERE id = ?').get(info.lastInsertRowid);
}

function deleteLink(id) {
  return db.prepare('DELETE FROM playlist_links WHERE id = ?').run(id);
}

function getLinkById(id) {
  return db.prepare('SELECT * FROM playlist_links WHERE id = ?').get(id);
}

function checkLinkExists(sharedPlaylistId, userId) {
  return db.prepare(`
    SELECT id FROM playlist_links
    WHERE shared_playlist_id = ? AND user_id = ?
  `).get(sharedPlaylistId, userId);
}

function getLinkedUsers(sharedPlaylistId) {
  return db.prepare(`
    SELECT pl.user_id,
           COALESCE(u.display_name, pl.user_id) AS display_name,
           pl.tidal_playlist_name, pl.tidal_playlist_id, pl.created_at
    FROM playlist_links pl
    LEFT JOIN users u ON u.user_id = pl.user_id
    WHERE pl.shared_playlist_id = ?
    ORDER BY pl.created_at ASC
  `).all(sharedPlaylistId);
}

// ---------------------------------------------------------------------------
// tracks
// ---------------------------------------------------------------------------

function getPlaylistTracks(sharedPlaylistId) {
  return db.prepare(`
    SELECT t.*, COALESCE(u.display_name, t.added_by) AS added_by_name
    FROM tracks t
    LEFT JOIN users u ON u.user_id = t.added_by
    WHERE t.shared_playlist_id = ? AND t.removed_at IS NULL
    ORDER BY t.position ASC
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
function addTrack(sharedPlaylistId, tidalTrackId, addedBy, position, trackTitle = null, trackArtist = null) {
  const existing = db.prepare(`
    SELECT id FROM tracks
    WHERE shared_playlist_id = ? AND tidal_track_id = ? AND removed_at IS NULL
  `).get(sharedPlaylistId, tidalTrackId);

  if (existing) return null;

  const info = db.prepare(`
    INSERT INTO tracks (shared_playlist_id, tidal_track_id, added_by, position, track_title, track_artist)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sharedPlaylistId, tidalTrackId, addedBy, position, trackTitle, trackArtist);

  return db.prepare('SELECT * FROM tracks WHERE id = ?').get(info.lastInsertRowid);
}

/**
 * All active tracks with no title (need metadata backfill).
 */
function getTracksWithNullMetadata() {
  return db.prepare(`
    SELECT DISTINCT tidal_track_id FROM tracks
    WHERE removed_at IS NULL AND track_title IS NULL
  `).all();
}

/**
 * Set title/artist on all rows matching a track ID that still have null titles.
 */
function updateTrackMetadata(tidalTrackId, title, artist) {
  db.prepare(`
    UPDATE tracks SET track_title = ?, track_artist = ?
    WHERE tidal_track_id = ? AND track_title IS NULL
  `).run(title, artist, String(tidalTrackId));
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
// playlist_invites
// ---------------------------------------------------------------------------

function createInvite(sharedPlaylistId, code) {
  const info = db.prepare(
    'INSERT INTO playlist_invites (shared_playlist_id, code) VALUES (?, ?)',
  ).run(sharedPlaylistId, code);
  return db.prepare('SELECT * FROM playlist_invites WHERE id = ?').get(info.lastInsertRowid);
}

function getInvitesByPlaylist(sharedPlaylistId) {
  return db.prepare(
    'SELECT * FROM playlist_invites WHERE shared_playlist_id = ? AND revoked_at IS NULL ORDER BY created_at DESC',
  ).all(sharedPlaylistId);
}

function getInviteByCode(code) {
  return db.prepare(
    'SELECT * FROM playlist_invites WHERE code = ? AND revoked_at IS NULL',
  ).get(code);
}

function revokeInvite(id) {
  return db.prepare(
    'UPDATE playlist_invites SET revoked_at = unixepoch() WHERE id = ? AND revoked_at IS NULL',
  ).run(id);
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

function getSetting(key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

function setSetting(key, value) {
  return db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

function upsertUser(userId, displayName, accessTokenEnc, refreshTokenEnc, tokenExpiresAt) {
  return db.prepare(`
    INSERT INTO users (user_id, display_name, access_token_enc, refresh_token_enc, token_expires_at, token_dead)
    VALUES (?, ?, ?, ?, ?, 0)
    ON CONFLICT(user_id) DO UPDATE SET
      display_name      = excluded.display_name,
      access_token_enc  = excluded.access_token_enc,
      refresh_token_enc = excluded.refresh_token_enc,
      token_expires_at  = excluded.token_expires_at,
      token_dead        = 0
  `).run(userId, displayName, accessTokenEnc, refreshTokenEnc, tokenExpiresAt);
}

function markUserTokenDead(userId) {
  return db.prepare('UPDATE users SET token_dead = 1 WHERE user_id = ?').run(userId);
}

function getUser(userId) {
  return db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
}

function deleteUser(userId) {
  db.prepare('DELETE FROM playlist_links WHERE user_id = ?').run(userId);
  return db.prepare('DELETE FROM users WHERE user_id = ?').run(userId);
}

/**
 * Returns all users that have at least one playlist link (i.e., need polling).
 */
function getAllUsersWithLinks() {
  return db.prepare(`
    SELECT DISTINCT u.*
    FROM users u
    INNER JOIN playlist_links pl ON pl.user_id = u.user_id
    WHERE u.token_dead = 0
  `).all();
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
      COALESCE(u.display_name, au.user_id) AS display_name,
      au.shared_playlist_id,
      sp.name AS shared_playlist_name,
      au.last_seen
    FROM active_users au
    JOIN shared_playlists sp ON sp.id = au.shared_playlist_id
    LEFT JOIN users u ON u.user_id = au.user_id
    ORDER BY au.last_seen DESC
  `).all();
}

function getAllUsersWithPresence() {
  return db.prepare(`
    SELECT u.user_id,
           u.display_name,
           u.created_at,
           COUNT(DISTINCT pl.id) AS linked_count,
           MAX(au.last_seen)     AS last_seen
    FROM users u
    LEFT JOIN playlist_links pl ON pl.user_id = u.user_id
    LEFT JOIN active_users   au ON au.user_id = u.user_id
    GROUP BY u.user_id
    ORDER BY last_seen DESC, u.display_name ASC
  `).all();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  init,
  close,
  // settings
  getSetting,
  setSetting,
  // users
  upsertUser,
  markUserTokenDead,
  getUser,
  deleteUser,
  getAllUsersWithLinks,
  // shared_playlists
  getSharedPlaylists,
  getPublicPlaylists,
  createSharedPlaylist,
  updateSharedPlaylist,
  deleteSharedPlaylist,
  // playlist_links
  getUserLinks,
  getPlaylistLinks,
  createLink,
  deleteLink,
  getLinkById,
  checkLinkExists,
  getLinkedUsers,
  // tracks
  getPlaylistTracks,
  addTrack,
  removeTrack,
  getTracksWithNullMetadata,
  updateTrackMetadata,
  updateTrackPositions,
  getMaxPosition,
  // active_users
  updateUserLastSeen,
  getActiveUsers,
  getAllUsersWithPresence,
  // playlist_invites
  createInvite,
  getInvitesByPlaylist,
  getInviteByCode,
  revokeInvite,
};
