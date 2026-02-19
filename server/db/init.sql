-- Tidal Collaborative — SQLite schema
-- Managed via better-sqlite3; run once at server startup.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

-- Admin-created playlists that collaborators sync to
CREATE TABLE IF NOT EXISTS shared_playlists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  description TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Each user's local Tidal playlist linked to a shared playlist
CREATE TABLE IF NOT EXISTS playlist_links (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  shared_playlist_id INTEGER NOT NULL REFERENCES shared_playlists(id) ON DELETE CASCADE,
  user_id            TEXT    NOT NULL,  -- Tidal user ID
  tidal_playlist_id  TEXT    NOT NULL,  -- local Tidal playlist UUID
  created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(shared_playlist_id, user_id)
);

-- Track membership in shared playlists (soft-delete for removal history)
CREATE TABLE IF NOT EXISTS tracks (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  shared_playlist_id INTEGER NOT NULL REFERENCES shared_playlists(id) ON DELETE CASCADE,
  tidal_track_id     TEXT    NOT NULL,
  added_by           TEXT    NOT NULL,  -- Tidal user ID
  position           INTEGER NOT NULL DEFAULT 0,
  added_at           INTEGER NOT NULL DEFAULT (unixepoch()),
  removed_at         INTEGER             -- NULL = active; set = removed
);

-- WebSocket presence tracking (upserted by WS handler)
CREATE TABLE IF NOT EXISTS active_users (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            TEXT    NOT NULL,
  shared_playlist_id INTEGER NOT NULL REFERENCES shared_playlists(id) ON DELETE CASCADE,
  last_seen          INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, shared_playlist_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_tracks_playlist  ON tracks(shared_playlist_id);
CREATE INDEX IF NOT EXISTS idx_tracks_position  ON tracks(shared_playlist_id, position);
CREATE INDEX IF NOT EXISTS idx_links_user       ON playlist_links(user_id);
CREATE INDEX IF NOT EXISTS idx_links_playlist   ON playlist_links(shared_playlist_id);
CREATE INDEX IF NOT EXISTS idx_users_user       ON active_users(user_id);
CREATE INDEX IF NOT EXISTS idx_users_playlist   ON active_users(shared_playlist_id);
