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

/**
 * Atomically create a shared playlist and, if a Tidal playlist ID is given,
 * its first link — so a failure creating the link doesn't leave an orphaned
 * playlist behind with no way for the client to retry cleanly (AUDIT.md L4).
 */
function createSharedPlaylistWithLink(name, description, createdBy, isPublic, tidalPlaylistId, tidalPlaylistName) {
  return db.transaction(() => {
    const playlist = createSharedPlaylist(name, description, createdBy, isPublic);
    let link = null;
    if (tidalPlaylistId && createdBy) {
      link = createLink(playlist.id, createdBy, tidalPlaylistId, tidalPlaylistName);
    }
    return { playlist, link };
  })();
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

/**
 * Deletes a link AND its user_actions rows for that (user, shared_playlist).
 * Leaving user_actions behind causes AUDIT.md C2: re-linking later compares
 * the new Tidal playlist against stale rows and everything missing gets
 * detected as removed and propagated to every other collaborator.
 */
function deleteLink(id) {
  const link = db.prepare('SELECT * FROM playlist_links WHERE id = ?').get(id);
  if (!link) return { changes: 0 };
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM user_actions WHERE user_id = ? AND shared_playlist_id = ?')
      .run(link.user_id, link.shared_playlist_id);
    db.prepare('DELETE FROM playlist_links WHERE id = ?').run(id);
  });
  tx();
  return { changes: 1 };
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
 * Returns a Set of tidal_track_ids soft-deleted within the last `windowMs` ms.
 * Used by the poller diff to block resurrection during the propagation window,
 * while still allowing genuine re-adds after propagation has had time to finish.
 */
function getRecentlyDeletedTrackIds(sharedPlaylistId, windowMs = 10 * 60 * 1000) {
  const cutoffSec = Math.floor((Date.now() - windowMs) / 1000);
  const rows = db.prepare(`
    SELECT DISTINCT tidal_track_id FROM tracks
    WHERE shared_playlist_id = ? AND removed_at IS NOT NULL AND removed_at > ?
  `).all(sharedPlaylistId, cutoffSec);
  return new Set(rows.map(r => String(r.tidal_track_id)));
}

/**
 * Add a track, returning the new row or null if already active.
 * Runs in a transaction: soft-deleted rows for the same track are purged first
 * so that INSERT OR IGNORE cannot create a duplicate active row alongside them
 * (the partial unique index only covers removed_at IS NULL, so without the
 * DELETE step the insert would silently succeed and produce two rows).
 */
function addTrack(sharedPlaylistId, tidalTrackId, addedBy, position, trackTitle = null, trackArtist = null) {
  const id = String(tidalTrackId);
  return db.transaction(() => {
    // Purge any leftover soft-deleted rows for this track before inserting.
    db.prepare(`
      DELETE FROM tracks
      WHERE shared_playlist_id = ? AND tidal_track_id = ? AND removed_at IS NOT NULL
    `).run(sharedPlaylistId, id);

    const info = db.prepare(`
      INSERT OR IGNORE INTO tracks
        (shared_playlist_id, tidal_track_id, added_by, position, track_title, track_artist)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sharedPlaylistId, id, addedBy, position, trackTitle, trackArtist);

    if (info.changes === 0) return null;
    return db.prepare('SELECT * FROM tracks WHERE id = ?').get(info.lastInsertRowid);
  })();
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
 * A track row regardless of removed_at state — unlike getPlaylistTracks(),
 * which only returns active rows. Used to look up title/artist metadata
 * for a track that has just been (or is being) soft-deleted.
 */
function getTrackRow(sharedPlaylistId, tidalTrackId) {
  return db.prepare(`
    SELECT * FROM tracks
    WHERE shared_playlist_id = ? AND tidal_track_id = ?
    ORDER BY id DESC LIMIT 1
  `).get(sharedPlaylistId, String(tidalTrackId));
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

function getInviteById(id) {
  return db.prepare('SELECT * FROM playlist_invites WHERE id = ?').get(id);
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
    INSERT INTO users (user_id, display_name, access_token_enc, refresh_token_enc, token_expires_at, sync_status)
    VALUES (?, ?, ?, ?, ?, 'ok')
    ON CONFLICT(user_id) DO UPDATE SET
      display_name      = excluded.display_name,
      access_token_enc  = excluded.access_token_enc,
      refresh_token_enc = excluded.refresh_token_enc,
      token_expires_at  = excluded.token_expires_at,
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
    UPDATE users SET sync_status = 'token_revoked', sync_error_msg = 'Token revoked or expired'
    WHERE user_id = ?
  `).run(userId);
}

function resetUserSyncStatus(userId) {
  return db.prepare(`
    UPDATE users SET sync_status = 'ok', sync_error_msg = NULL, sync_retry_after = NULL
    WHERE user_id = ?
  `).run(userId);
}

function getUser(userId) {
  return db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
}

function deleteUser(userId) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM user_actions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM playlist_links WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE user_id = ?').run(userId);
  });
  return tx();
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
// master_journal
// ---------------------------------------------------------------------------

function addJournalEntry(action, userId, tidalTrackId, trackTitle, trackArtist, sharedPlaylistId) {
  const info = db.prepare(`
    INSERT INTO master_journal (action, user_id, tidal_track_id, track_title, track_artist, shared_playlist_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(action, userId, String(tidalTrackId), trackTitle ?? null, trackArtist ?? null, sharedPlaylistId);
  return db.prepare('SELECT * FROM master_journal WHERE id = ?').get(info.lastInsertRowid);
}

/**
 * Fetch journal entries for a shared playlist with id > afterId, oldest-first.
 * Used by the poller to pull new events for other users.
 */
function getJournalEntriesAfter(sharedPlaylistId, afterId) {
  return db.prepare(`
    SELECT mj.*, COALESCE(u.display_name, mj.user_id) AS display_name,
           sp.name AS playlist_name
    FROM master_journal mj
    LEFT JOIN users u ON u.user_id = mj.user_id
    LEFT JOIN shared_playlists sp ON sp.id = mj.shared_playlist_id
    WHERE mj.shared_playlist_id = ? AND mj.id > ?
    ORDER BY mj.id ASC
  `).all(sharedPlaylistId, afterId ?? 0);
}

/**
 * Paginated journal query for the admin UI.
 * Returns entries newest-first with display_name and playlist_name joined.
 */
function getJournalPage({ sharedPlaylistId = null, action = null, limit = 50, offset = 0 } = {}) {
  const where = [];
  const args  = [];
  if (sharedPlaylistId) { where.push('mj.shared_playlist_id = ?'); args.push(sharedPlaylistId); }
  if (action)           { where.push('mj.action = ?');             args.push(action); }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  args.push(Math.min(limit, 200), offset);
  return db.prepare(`
    SELECT mj.*,
           COALESCE(u.display_name, mj.user_id) AS display_name,
           sp.name AS playlist_name
    FROM master_journal mj
    LEFT JOIN users u ON u.user_id = mj.user_id
    LEFT JOIN shared_playlists sp ON sp.id = mj.shared_playlist_id
    ${whereClause}
    ORDER BY mj.id DESC
    LIMIT ? OFFSET ?
  `).all(...args);
}

function getJournalStats() {
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(`
    SELECT
      COUNT(*)                                               AS total,
      COUNT(CASE WHEN created_at > ? THEN 1 END)            AS last_7d,
      COUNT(CASE WHEN created_at > ? THEN 1 END)            AS last_24h
    FROM master_journal
  `).get(now - 7 * 86400, now - 86400);
}

// ---------------------------------------------------------------------------
// user_actions
// ---------------------------------------------------------------------------

/**
 * Upsert a track's current state for a user.
 * Only updates if the state actually changes (prevents spurious Tidal calls).
 */
function upsertUserAction(userId, sharedPlaylistId, tidalTrackId, action, trackTitle, trackArtist,
  { tidalOrigin = 0, tidalApplied = 0, journalId = null } = {}) {
  return db.prepare(`
    INSERT INTO user_actions
      (user_id, shared_playlist_id, tidal_track_id, track_title, track_artist,
       current_action, journal_id, tidal_applied, tidal_origin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, shared_playlist_id, tidal_track_id) DO UPDATE SET
      current_action = excluded.current_action,
      track_title    = COALESCE(excluded.track_title, track_title),
      track_artist   = COALESCE(excluded.track_artist, track_artist),
      journal_id     = CASE
        WHEN current_action != excluded.current_action THEN NULL
        WHEN excluded.journal_id IS NOT NULL
         AND (journal_id IS NULL OR excluded.journal_id > journal_id)
        THEN excluded.journal_id
        ELSE journal_id
      END,
      tidal_applied  = CASE
        WHEN current_action != excluded.current_action THEN 0
        WHEN excluded.tidal_applied = 1               THEN 1
        ELSE tidal_applied
      END,
      updated_at     = unixepoch()
    WHERE current_action != excluded.current_action
       OR (excluded.tidal_applied = 1 AND tidal_applied = 0)
       OR (excluded.journal_id IS NOT NULL
           AND (journal_id IS NULL OR excluded.journal_id > journal_id))
  `).run(
    userId, sharedPlaylistId, String(tidalTrackId),
    trackTitle ?? null, trackArtist ?? null,
    action, journalId, tidalApplied ? 1 : 0, tidalOrigin ? 1 : 0,
  );
}

/**
 * Track IDs the server believes are currently 'added' in a user's Tidal playlist.
 */
/**
 * Returns track IDs confirmed present in the user's Tidal playlist (tidal_applied=1).
 * Excludes pending adds (tidal_applied=0) — those haven't been pushed to Tidal yet,
 * so stepDetect must not treat their absence as a removal.
 */
function getUserActiveTrackIds(userId, sharedPlaylistId) {
  const rows = db.prepare(`
    SELECT tidal_track_id FROM user_actions
    WHERE user_id = ? AND shared_playlist_id = ? AND current_action = 'added' AND tidal_applied = 1
  `).all(userId, sharedPlaylistId);
  return new Set(rows.map(r => String(r.tidal_track_id)));
}

/**
 * All track IDs the server has any record of for this user+playlist (regardless of state).
 * Used to avoid re-detecting removed tracks as new.
 */
function getUserAllKnownTrackIds(userId, sharedPlaylistId) {
  const rows = db.prepare(`
    SELECT tidal_track_id FROM user_actions
    WHERE user_id = ? AND shared_playlist_id = ?
  `).all(userId, sharedPlaylistId);
  return new Set(rows.map(r => String(r.tidal_track_id)));
}

/**
 * Track IDs whose removal for this user is CONFIRMED against Tidal
 * (current_action='removed' AND tidal_applied=1) — i.e. the row can only be
 * in this state after the track was actually absent from the user's real
 * Tidal playlist at some point. If one of these reappears in a later scan,
 * it's unambiguously a genuine re-add, not a removal still propagating
 * (a pulled-but-not-yet-applied removal is tidal_applied=0, so it's excluded
 * here — no race with in-flight propagation).
 */
function getUserConfirmedRemovedTrackIds(userId, sharedPlaylistId) {
  const rows = db.prepare(`
    SELECT tidal_track_id FROM user_actions
    WHERE user_id = ? AND shared_playlist_id = ? AND current_action = 'removed' AND tidal_applied = 1
  `).all(userId, sharedPlaylistId);
  return new Set(rows.map(r => String(r.tidal_track_id)));
}

/**
 * user_action rows not yet flushed to master_journal (journal_id IS NULL).
 */
function getUnflushedUserActions(userId, sharedPlaylistId) {
  return db.prepare(`
    SELECT * FROM user_actions
    WHERE user_id = ? AND shared_playlist_id = ? AND journal_id IS NULL
    ORDER BY id ASC
  `).all(userId, sharedPlaylistId);
}

/**
 * Stamp a user_action row with its master_journal entry id.
 */
function setUserActionJournalId(id, journalId) {
  return db.prepare('UPDATE user_actions SET journal_id = ? WHERE id = ?').run(journalId, id);
}

/**
 * Highest journal_id a user has seen for a playlist (used to detect new entries to pull).
 */
function getUserMaxJournalId(userId, sharedPlaylistId) {
  const row = db.prepare(`
    SELECT MAX(journal_id) AS max_jid FROM user_actions
    WHERE user_id = ? AND shared_playlist_id = ?
  `).get(userId, sharedPlaylistId);
  return row?.max_jid ?? 0;
}

/**
 * A single user_action row regardless of current_action/tidal_applied state.
 * Unlike getPendingTidalActions(), which only returns tidal_applied=0 rows.
 */
function getUserActionRow(userId, sharedPlaylistId, tidalTrackId) {
  return db.prepare(`
    SELECT * FROM user_actions
    WHERE user_id = ? AND shared_playlist_id = ? AND tidal_track_id = ?
  `).get(userId, sharedPlaylistId, String(tidalTrackId));
}

/**
 * user_action rows pending Tidal application (tidal_applied = 0), oldest-first.
 */
function getPendingTidalActions(userId, sharedPlaylistId) {
  return db.prepare(`
    SELECT * FROM user_actions
    WHERE user_id = ? AND shared_playlist_id = ? AND tidal_applied = 0
    ORDER BY id ASC
  `).all(userId, sharedPlaylistId);
}

function markTidalApplied(id) {
  return db.prepare('UPDATE user_actions SET tidal_applied = 1 WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// sessions (backs the custom express-session Store — AUDIT.md M4)
// ---------------------------------------------------------------------------

function getSession(sid) {
  return db.prepare('SELECT * FROM sessions WHERE sid = ?').get(sid);
}

function upsertSession(sid, data, expiresAt) {
  return db.prepare(`
    INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at
  `).run(sid, data, expiresAt);
}

function deleteSession(sid) {
  return db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
}

/**
 * Remove expired sessions. There's no background job in this single-process
 * app, so this only runs at startup — expired rows can accumulate for the
 * lifetime of a run, which is an acceptable trade-off (same class as other
 * homelab-scale trade-offs already documented in docs/DECISIONS.md).
 */
function pruneExpiredSessions() {
  return db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
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
  createSharedPlaylistWithLink,
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
  getTrackRow,
  getActiveTrackIds,
  getRecentlyDeletedTrackIds,
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
  getInviteById,
  getInviteByCode,
  revokeInvite,
  // master_journal
  addJournalEntry,
  getJournalEntriesAfter,
  getJournalPage,
  getJournalStats,
  // user_actions
  upsertUserAction,
  getUserActiveTrackIds,
  getUserAllKnownTrackIds,
  getUserConfirmedRemovedTrackIds,
  getUnflushedUserActions,
  setUserActionJournalId,
  getUserMaxJournalId,
  getUserActionRow,
  getPendingTidalActions,
  markTidalApplied,
  // sessions
  getSession,
  upsertSession,
  deleteSession,
  pruneExpiredSessions,
};
