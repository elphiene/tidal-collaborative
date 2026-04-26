-- Tidal Collaborative — SQLite schema
-- Managed via better-sqlite3; run once at server startup.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

-- Playlists that collaborators sync to
CREATE TABLE IF NOT EXISTS shared_playlists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  description TEXT,
  created_by  TEXT,           -- user_id of creator; NULL = legacy admin-created
  is_public   INTEGER NOT NULL DEFAULT 0,  -- 1 = public, 0 = private
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Invite codes for private playlists
CREATE TABLE IF NOT EXISTS playlist_invites (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  shared_playlist_id INTEGER NOT NULL REFERENCES shared_playlists(id) ON DELETE CASCADE,
  code               TEXT    NOT NULL UNIQUE,
  created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  revoked_at         INTEGER
);

-- Each user's local Tidal playlist linked to a shared playlist
CREATE TABLE IF NOT EXISTS playlist_links (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  shared_playlist_id  INTEGER NOT NULL REFERENCES shared_playlists(id) ON DELETE CASCADE,
  user_id             TEXT    NOT NULL,
  tidal_playlist_id   TEXT    NOT NULL,
  tidal_playlist_name TEXT,
  scan_cursor         TEXT,             -- persisted pagination cursor; NULL = start from beginning
  last_polled_at      INTEGER,          -- epoch seconds of last completed poll
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(shared_playlist_id, user_id)
);

-- Track membership in shared playlists (soft-delete preserves history)
CREATE TABLE IF NOT EXISTS tracks (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  shared_playlist_id INTEGER NOT NULL REFERENCES shared_playlists(id) ON DELETE CASCADE,
  tidal_track_id     TEXT    NOT NULL,
  added_by           TEXT    NOT NULL,
  position           INTEGER NOT NULL DEFAULT 0,
  added_at           INTEGER NOT NULL DEFAULT (unixepoch()),
  removed_at         INTEGER,           -- NULL = active; epoch seconds = removed
  track_title        TEXT,
  track_artist       TEXT
);

-- WebSocket presence tracking (upserted by WS handler)
CREATE TABLE IF NOT EXISTS active_users (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            TEXT    NOT NULL,
  shared_playlist_id INTEGER NOT NULL REFERENCES shared_playlists(id) ON DELETE CASCADE,
  last_seen          INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, shared_playlist_id)
);

-- Key/value store for server configuration
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Authenticated users (tokens stored encrypted)
CREATE TABLE IF NOT EXISTS users (
  user_id           TEXT    PRIMARY KEY,
  display_name      TEXT,
  access_token_enc  TEXT    NOT NULL,
  refresh_token_enc TEXT    NOT NULL,
  token_expires_at  INTEGER NOT NULL,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  token_dead        INTEGER NOT NULL DEFAULT 0,
  sync_status       TEXT    NOT NULL DEFAULT 'ok', -- ok | rate_limited | token_revoked | error
  sync_error_msg    TEXT,
  sync_retry_after  INTEGER   -- epoch ms; relevant when sync_status = 'rate_limited'
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_tracks_playlist  ON tracks(shared_playlist_id);
CREATE INDEX IF NOT EXISTS idx_tracks_position  ON tracks(shared_playlist_id, position);
CREATE INDEX IF NOT EXISTS idx_links_user       ON playlist_links(user_id);
CREATE INDEX IF NOT EXISTS idx_links_playlist   ON playlist_links(shared_playlist_id);
CREATE INDEX IF NOT EXISTS idx_users_user       ON active_users(user_id);
CREATE INDEX IF NOT EXISTS idx_users_playlist   ON active_users(shared_playlist_id);
CREATE INDEX IF NOT EXISTS idx_invites_playlist ON playlist_invites(shared_playlist_id);
CREATE INDEX IF NOT EXISTS idx_invites_code     ON playlist_invites(code);

-- NOTE: The partial unique index on tracks is created in db.js migrations
-- (after deduplication of any existing data) rather than here.
-- idx_tracks_active_unique ON tracks(shared_playlist_id, tidal_track_id) WHERE removed_at IS NULL
