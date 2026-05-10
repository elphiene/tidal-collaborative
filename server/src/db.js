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

  const schema = fs.readFileSync(path.join(__dirname, '../db/init.sql'), 'utf8');
  db.exec(schema);

  runMigrations();

  console.log(`[db] opened ${config.DB_PATH}`);
  return db;
}

function runMigrations() {
  // Column additions — safe to run multiple times; error = already exists
  const columnMigrations = [
    'ALTER TABLE playlist_links ADD COLUMN tidal_playlist_name TEXT',
    'ALTER TABLE tracks ADD COLUMN track_title TEXT',
    'ALTER TABLE tracks ADD COLUMN track_artist TEXT',
    'ALTER TABLE shared_playlists ADD COLUMN created_by TEXT',
    'ALTER TABLE shared_playlists ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN token_dead INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE users ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'ok'",
    'ALTER TABLE users ADD COLUMN sync_error_msg TEXT',
    'ALTER TABLE users ADD COLUMN sync_retry_after INTEGER',
    'ALTER TABLE playlist_links ADD COLUMN scan_cursor TEXT',
    'ALTER TABLE playlist_links ADD COLUMN last_polled_at INTEGER',
  ];
  for (const sql of columnMigrations) {
    try { db.exec(sql); } catch { /* already exists */ }
  }

  // Ensure playlist_invites table exists (predates init.sql entry)
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

  // Backfill created_by for legacy playlists
  try {
    db.exec(`
      UPDATE shared_playlists
      SET created_by = (
        SELECT user_id FROM playlist_links
        WHERE shared_playlist_id = shared_playlists.id
        ORDER BY created_at ASC LIMIT 1
      )
      WHERE created_by IS NULL
        AND id IN (SELECT DISTINCT shared_playlist_id FROM playlist_links)
    `);
  } catch { /* ignore */ }

  // Migrate old token_dead flag into sync_status
  try {
    db.exec(`UPDATE users SET sync_status = 'token_revoked' WHERE token_dead = 1 AND sync_status = 'ok'`);
  } catch { /* ignore */ }

  // Deduplicate active tracks, then enforce uniqueness via partial index.
  // Keep the earliest insertion (MIN id) for each active (playlist, track) pair.
  try {
    db.exec(`
      DELETE FROM tracks
      WHERE removed_at IS NULL
        AND id NOT IN (
          SELECT MIN(id) FROM tracks
          WHERE removed_at IS NULL
          GROUP BY shared_playlist_id, tidal_track_id
        )
    `);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_active_unique
      ON tracks(shared_playlist_id, tidal_track_id)
      WHERE removed_at IS NULL
    `);
  } catch (e) {
    console.warn('[db] unique index migration warning:', e.message);
  }

  // Default settings
  try {
    db.exec(`INSERT OR IGNORE INTO settings(key, value) VALUES('poll_interval_ms', '30000')`);
  } catch { /* ignore */ }

  // track_removal_queue and track_events tables (created idempotently via init.sql,
  // but also ensure they exist for deployments that already ran init.sql before these were added)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS track_removal_queue (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      shared_playlist_id INTEGER NOT NULL,
      tidal_track_id     TEXT    NOT NULL,
      user_id            TEXT    NOT NULL,
      deleted_by         TEXT    NOT NULL,
      created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(shared_playlist_id, tidal_track_id, user_id)
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_removal_queue_user  ON track_removal_queue(shared_playlist_id, user_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_removal_queue_track ON track_removal_queue(shared_playlist_id, tidal_track_id)`);
  } catch { /* already exists */ }

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS track_events (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      shared_playlist_id INTEGER NOT NULL,
      tidal_track_id     TEXT    NOT NULL,
      event_type         TEXT    NOT NULL,
      actor_user_id      TEXT,
      source             TEXT    NOT NULL,
      target_user_id     TEXT,
      track_title        TEXT,
      track_artist       TEXT,
      timestamp          INTEGER NOT NULL DEFAULT (unixepoch()),
      notes              TEXT
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_track_events_pl ON track_events(shared_playlist_id, timestamp DESC)`);
  } catch { /* already exists */ }

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS poll_log (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      shared_playlist_id INTEGER NOT NULL,
      user_id            TEXT    NOT NULL,
      tidal_playlist_id  TEXT    NOT NULL,
      status             TEXT    NOT NULL,
      new_tracks         INTEGER NOT NULL DEFAULT 0,
      removed_tracks     INTEGER NOT NULL DEFAULT 0,
      queued_removals    INTEGER NOT NULL DEFAULT 0,
      error_msg          TEXT,
      timestamp          INTEGER NOT NULL DEFAULT (unixepoch())
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_poll_log_pl ON poll_log(shared_playlist_id, timestamp DESC)`);
  } catch { /* already exists */ }
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

function setLinkCursor(linkId, cursor) {
  return db.prepare('UPDATE playlist_links SET scan_cursor = ? WHERE id = ?').run(cursor, linkId);
}

function clearLinkCursor(linkId) {
  return db.prepare(
    'UPDATE playlist_links SET scan_cursor = NULL, last_polled_at = unixepoch() WHERE id = ?',
  ).run(linkId);
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
 * Returns a Set of active tidal_track_ids for a shared playlist.
 * Used by the poller to diff against current Tidal state.
 */
function getActiveTrackIds(sharedPlaylistId) {
  const rows = db.prepare(`
    SELECT tidal_track_id FROM tracks
    WHERE shared_playlist_id = ? AND removed_at IS NULL
  `).all(sharedPlaylistId);
  return new Set(rows.map(r => String(r.tidal_track_id)));
}

/**
 * Returns a Set of ALL tidal_track_ids ever seen for a shared playlist,
 * including soft-deleted ones. Used by the poller diff so that a webapp
 * deletion is not resurrected before the Tidal-side removal propagates.
 */
function getAllTrackIds(sharedPlaylistId) {
  const rows = db.prepare(`
    SELECT DISTINCT tidal_track_id FROM tracks
    WHERE shared_playlist_id = ?
  `).all(sharedPlaylistId);
  return new Set(rows.map(r => String(r.tidal_track_id)));
}

/**
 * Add a track using INSERT OR IGNORE — the partial unique index
 * (shared_playlist_id, tidal_track_id) WHERE removed_at IS NULL
 * guarantees atomicity. Returns the new row, or null if already active.
 */
function addTrack(sharedPlaylistId, tidalTrackId, addedBy, position, trackTitle = null, trackArtist = null) {
  const info = db.prepare(`
    INSERT OR IGNORE INTO tracks
      (shared_playlist_id, tidal_track_id, added_by, position, track_title, track_artist)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sharedPlaylistId, String(tidalTrackId), addedBy, position, trackTitle, trackArtist);

  if (info.changes === 0) return null;
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

function updateTrackMetadata(tidalTrackId, title, artist) {
  db.prepare(`
    UPDATE tracks SET track_title = ?, track_artist = ?
    WHERE tidal_track_id = ? AND track_title IS NULL
  `).run(title, artist, String(tidalTrackId));
}

/**
 * Soft-delete a track from a shared playlist. Returns the run result.
 */
function removeTrack(sharedPlaylistId, tidalTrackId) {
  return db.prepare(`
    UPDATE tracks
    SET removed_at = unixepoch()
    WHERE shared_playlist_id = ? AND tidal_track_id = ? AND removed_at IS NULL
  `).run(sharedPlaylistId, String(tidalTrackId));
}

/**
 * Bulk-update track positions within a transaction.
 */
function updateTrackPositions(sharedPlaylistId, positions) {
  const stmt = db.prepare(`
    UPDATE tracks SET position = ?
    WHERE shared_playlist_id = ? AND tidal_track_id = ? AND removed_at IS NULL
  `);
  db.transaction((items) => {
    for (const { tidalTrackId, position } of items) {
      stmt.run(position, sharedPlaylistId, tidalTrackId);
    }
  })(positions);
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

function getPollInterval() {
  const val = getSetting('poll_interval_ms');
  return val ? parseInt(val, 10) : 30000;
}

function setPollInterval(ms) {
  const clamped = Math.max(15000, Math.min(300000, Number(ms)));
  return setSetting('poll_interval_ms', String(clamped));
}

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

function upsertUser(userId, displayName, accessTokenEnc, refreshTokenEnc, tokenExpiresAt) {
  return db.prepare(`
    INSERT INTO users (user_id, display_name, access_token_enc, refresh_token_enc, token_expires_at, token_dead, sync_status)
    VALUES (?, ?, ?, ?, ?, 0, 'ok')
    ON CONFLICT(user_id) DO UPDATE SET
      display_name      = excluded.display_name,
      access_token_enc  = excluded.access_token_enc,
      refresh_token_enc = excluded.refresh_token_enc,
      token_expires_at  = excluded.token_expires_at,
      token_dead        = 0,
      sync_status       = 'ok',
      sync_error_msg    = NULL,
      sync_retry_after  = NULL
  `).run(userId, displayName, accessTokenEnc, refreshTokenEnc, tokenExpiresAt);
}

function setUserSyncStatus(userId, status, errorMsg = null, retryAfter = null) {
  return db.prepare(`
    UPDATE users SET sync_status = ?, sync_error_msg = ?, sync_retry_after = ?
    WHERE user_id = ?
  `).run(status, errorMsg, retryAfter, userId);
}

function getUserSyncStatuses() {
  return db.prepare(`
    SELECT user_id, display_name, sync_status, sync_error_msg, sync_retry_after
    FROM users
    ORDER BY display_name ASC
  `).all();
}

function markUserTokenDead(userId) {
  return db.prepare(`
    UPDATE users SET token_dead = 1, sync_status = 'token_revoked', sync_error_msg = 'Token revoked or expired'
    WHERE user_id = ?
  `).run(userId);
}

function resetUserSyncStatus(userId) {
  return db.prepare(`
    UPDATE users SET sync_status = 'ok', sync_error_msg = NULL, sync_retry_after = NULL, token_dead = 0
    WHERE user_id = ?
  `).run(userId);
}

function getUser(userId) {
  return db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
}

function deleteUser(userId) {
  db.prepare('DELETE FROM playlist_links WHERE user_id = ?').run(userId);
  return db.prepare('DELETE FROM users WHERE user_id = ?').run(userId);
}

/**
 * Returns all users with at least one playlist link, excluding those with revoked tokens.
 * Rate-limited users are included — the poller checks retry_after itself.
 */
function getAllUsersWithLinks() {
  return db.prepare(`
    SELECT DISTINCT u.*
    FROM users u
    INNER JOIN playlist_links pl ON pl.user_id = u.user_id
    WHERE u.sync_status != 'token_revoked'
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
           u.sync_status,
           u.sync_error_msg,
           u.sync_retry_after,
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
// track_removal_queue
// ---------------------------------------------------------------------------

/**
 * Write a removal queue entry for every linked user (except excludeUserId).
 * Called when a track is deleted so the poller can retry removal for users
 * whose tokens are currently expired.
 */
function addToRemovalQueueAllUsers(spId, trackId, deletedBy, excludeUserId = null) {
  const links = db.prepare('SELECT user_id FROM playlist_links WHERE shared_playlist_id = ?').all(spId);
  const stmt  = db.prepare(`
    INSERT OR IGNORE INTO track_removal_queue (shared_playlist_id, tidal_track_id, user_id, deleted_by)
    VALUES (?, ?, ?, ?)
  `);
  for (const link of links) {
    if (excludeUserId && link.user_id === excludeUserId) continue;
    stmt.run(spId, String(trackId), link.user_id, deletedBy);
  }
}

/** Remove a user's pending removal entry once confirmed gone from their Tidal. */
function markRemovalComplete(spId, trackId, userId) {
  return db.prepare(`
    DELETE FROM track_removal_queue
    WHERE shared_playlist_id = ? AND tidal_track_id = ? AND user_id = ?
  `).run(spId, String(trackId), userId);
}

/** Clear all pending removal entries for a track (called when someone re-adds it). */
function clearRemovalQueue(spId, trackId) {
  return db.prepare(`
    DELETE FROM track_removal_queue
    WHERE shared_playlist_id = ? AND tidal_track_id = ?
  `).run(spId, String(trackId));
}

/** Returns a Set of track IDs that are pending removal for this specific user. */
function getPendingRemovalsForUser(spId, userId) {
  const rows = db.prepare(`
    SELECT tidal_track_id FROM track_removal_queue
    WHERE shared_playlist_id = ? AND user_id = ?
  `).all(spId, userId);
  return new Set(rows.map(r => String(r.tidal_track_id)));
}

/**
 * Returns active tracks that meet all conditions for Tidal-side removal detection:
 * - Active in DB (removed_at IS NULL)
 * - Added at least gracePeriodSeconds ago (avoids false positives on fresh propagations)
 * - Link has been fully polled at least once since the track was added (last_polled_at > added_at)
 * - No pending removal queue entry exists for this user (not already being processed)
 */
function getTracksForRemovalDetection(spId, linkId, gracePeriodSeconds) {
  return db.prepare(`
    SELECT t.tidal_track_id, t.track_title, t.track_artist
    FROM tracks t
    JOIN playlist_links pl ON pl.id = ?
    WHERE t.shared_playlist_id = ?
      AND t.removed_at IS NULL
      AND t.added_at < (unixepoch() - ?)
      AND pl.last_polled_at IS NOT NULL
      AND pl.last_polled_at > t.added_at
      AND NOT EXISTS (
        SELECT 1 FROM track_removal_queue q
        WHERE q.shared_playlist_id = t.shared_playlist_id
          AND q.tidal_track_id = t.tidal_track_id
          AND q.user_id = pl.user_id
      )
  `).all(linkId, spId, gracePeriodSeconds);
}

// ---------------------------------------------------------------------------
// track_events (activity log)
// ---------------------------------------------------------------------------

function logTrackEvent(spId, trackId, eventType, actorUserId, source, targetUserId, trackTitle, trackArtist, notes = null) {
  try {
    db.prepare(`
      INSERT INTO track_events
        (shared_playlist_id, tidal_track_id, event_type, actor_user_id, source, target_user_id, track_title, track_artist, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      spId, String(trackId), eventType,
      actorUserId   ?? null, source,
      targetUserId  ?? null,
      trackTitle    ?? null,
      trackArtist   ?? null,
      notes         ?? null,
    );
  } catch (err) {
    console.warn('[db] logTrackEvent error:', err.message);
  }
}

/** Returns events for a playlist since sinceSeconds (unix epoch seconds), newest first. */
function getTrackEvents(spId, sinceSeconds, limit = 500) {
  return db.prepare(`
    SELECT te.*,
      COALESCE(ua.display_name, te.actor_user_id)   AS actor_display_name,
      COALESCE(ut.display_name, te.target_user_id)  AS target_display_name
    FROM track_events te
    LEFT JOIN users ua ON ua.user_id = te.actor_user_id
    LEFT JOIN users ut ON ut.user_id = te.target_user_id
    WHERE te.shared_playlist_id = ?
      AND te.timestamp >= ?
    ORDER BY te.timestamp DESC
    LIMIT ?
  `).all(spId, sinceSeconds, limit);
}

/** Delete events older than cutoffSeconds (called periodically to prevent unbounded growth). */
function pruneTrackEvents(cutoffSeconds) {
  db.prepare('DELETE FROM track_events WHERE timestamp < ?').run(cutoffSeconds);
  db.prepare('DELETE FROM poll_log WHERE timestamp < ?').run(cutoffSeconds);
}

// ---------------------------------------------------------------------------
// poll_log (sync timing)
// ---------------------------------------------------------------------------

function writePollLog(spId, userId, tidalPlaylistId, status, counts = {}, errorMsg = null) {
  try {
    db.prepare(`
      INSERT INTO poll_log (shared_playlist_id, user_id, tidal_playlist_id, status, new_tracks, removed_tracks, queued_removals, error_msg)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      spId, userId, tidalPlaylistId, status,
      counts.newTracks      ?? 0,
      counts.removedTracks  ?? 0,
      counts.queuedRemovals ?? 0,
      errorMsg ?? null,
    );
  } catch (err) {
    console.warn('[db] writePollLog error:', err.message);
  }
}

/** Returns poll log entries for a playlist since sinceSeconds, newest first. */
function getPollLog(spId, sinceSeconds, limit = 200) {
  return db.prepare(`
    SELECT pl.*,
      COALESCE(u.display_name, pl.user_id) AS user_display_name
    FROM poll_log pl
    LEFT JOIN users u ON u.user_id = pl.user_id
    WHERE pl.shared_playlist_id = ?
      AND pl.timestamp >= ?
    ORDER BY pl.timestamp DESC
    LIMIT ?
  `).all(spId, sinceSeconds, limit);
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
  getPollInterval,
  setPollInterval,
  // users
  upsertUser,
  markUserTokenDead,
  resetUserSyncStatus,
  setUserSyncStatus,
  getUserSyncStatuses,
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
  setLinkCursor,
  clearLinkCursor,
  // tracks
  getPlaylistTracks,
  getActiveTrackIds,
  getAllTrackIds,
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
  // track_removal_queue
  addToRemovalQueueAllUsers,
  markRemovalComplete,
  clearRemovalQueue,
  getPendingRemovalsForUser,
  getTracksForRemovalDetection,
  // track_events
  logTrackEvent,
  getTrackEvents,
  pruneTrackEvents,
  // poll_log
  writePollLog,
  getPollLog,
};
