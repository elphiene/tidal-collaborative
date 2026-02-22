# Architecture

## Overview

```
Any browser (phone, desktop, tablet)
  └── Web UI  at http://your-server:3000
        ├── Sign in with Tidal (OAuth 2.1 PKCE — server-side)
        ├── View / manage linked playlists
        └── WebSocket connection for real-time notifications

Server
  ├── REST API         /api/*
  ├── WebSocket        /ws
  ├── Poller           setInterval 60s  ← detects changes, writes DB, propagates
  ├── Tidal v2 client  openapi.tidal.com/v2
  └── SQLite           data/db.sqlite

Tidal API (openapi.tidal.com/v2)
  └── Server calls on behalf of each user using stored, encrypted tokens
```

---

## Data flow: track sync

### When a user adds a track in Tidal

1. User adds a track to their Tidal playlist in the Tidal app / web player
2. Server's polling loop runs (every 60 s) and fetches that playlist's current track IDs
3. Set-difference against `knownTracks` (in-memory Map) reveals the new track ID
4. `db.addTrack()` writes the track to the shared playlist in SQLite (idempotent)
5. Server fetches track title + artist from the Tidal API
6. Server calls the Tidal API to add the track to every other user's linked playlist (`propagateToOtherUsers`)
7. `knownTracks` is updated for all affected playlists so next poll doesn't re-detect the change
8. `track_added` is broadcast over WebSocket to all open browser tabs
9. Each browser tab shows a toast notification and refreshes its track list

### When a new user links their playlist

1. `POST /api/links` creates the link record
2. `initNewLink()` runs in the background:
   - Fetches all existing tracks from the shared playlist (SQLite)
   - Pushes each track to the new user's Tidal playlist via the API
   - Seeds `knownTracks` with those IDs so they aren't re-detected as new
3. `pollNow()` runs after seeding to pick up any tracks the user already had (those are merged into the shared playlist)

---

## Auth model

### User authentication (OAuth 2.1 PKCE)

- Server generates `code_verifier` / `code_challenge` and stores the verifier in memory (5-minute TTL)
- Browser is redirected to `https://login.tidal.com/authorize`
- Tidal redirects back to `/api/auth/callback` with the auth code
- Server exchanges the code for tokens, fetches the user profile, encrypts tokens with AES-256-GCM, and stores them in the `users` table
- `req.session.userId` is set — the session cookie is the only credential the browser holds

### Token storage

- Algorithm: AES-256-GCM (Node built-in `crypto`, no extra dependencies)
- Key: `ENCRYPTION_KEY` env var — 64 hex chars (32 bytes)
- Per-token format: `<iv_hex>:<ciphertext_hex>:<authtag_hex>`
- Protects against a stolen `db.sqlite` file

### Admin panel

- 4-digit PIN stored in the `settings` table
- First user to open the admin panel sets the PIN; subsequent access requires it
- PIN session flag (`req.session.adminAuthed`) gates admin endpoints

### WebSocket authentication

- Session cookie is automatically sent with the WebSocket upgrade request
- Server runs `sessionParser` middleware on the upgrade, then reads `req.session.userId`
- No auth message required from the client

---

## Polling loop

`poller.js` runs on a 60-second interval:

```
pollAll()
  └── for each user with at least one playlist link:
        1. Refresh token if within 5 minutes of expiry
        2. for each of the user's linked playlists:
              a. tidalGetPlaylistTrackIds()  — full paginated fetch
              b. diff against knownTracks[tidalPlaylistId]
              c. for each added track:
                   - tidalGetTrackInfo()    — title + artist
                   - db.addTrack()          — idempotent
                   - broadcast track_added
                   - propagateToOtherUsers() — tidalAddTrack for every other linked user
              d. for each removed track:
                   - db.removeTrack()       — soft-delete
                   - broadcast track_removed
                   - propagateToOtherUsers() — tidalRemoveTrack for every other linked user
              e. knownTracks.set(tidalPlaylistId, currentIds)
```

`pollNow()` triggers an immediate cycle (called after a new link is created).

`initNewLink()` seeds the new user's Tidal playlist and `knownTracks` before the first poll.

---

## Database schema

6 tables in SQLite (WAL mode, foreign keys ON):

| Table | Purpose |
|-------|---------|
| `users` | Tidal user records with AES-256-GCM encrypted tokens |
| `settings` | Key/value store — currently holds `admin_pin` |
| `shared_playlists` | Admin-created playlists that collaborators sync to |
| `playlist_links` | Maps each user + their Tidal playlist UUID to a shared playlist |
| `tracks` | Track membership with soft-delete (`removed_at` column) and title/artist metadata |
| `active_users` | WebSocket presence tracking (upserted on connection) |

Schema is idempotent (`CREATE TABLE IF NOT EXISTS`). New columns are added via runtime `ALTER TABLE` migrations in `db.init()`.

---

## WebSocket messages

All messages are JSON. The server pushes; clients do not need to send anything after connecting (authentication is via the session cookie on the HTTP upgrade).

| Direction | Type | Key fields |
|-----------|------|-----------|
| Server → Client | `auth_ok` | `user_id` |
| Server → Client | `track_added` | `shared_playlist_id`, `tidal_track_id`, `track_title`, `track_artist`, `added_by`, `position`, `timestamp` |
| Server → Client | `track_removed` | `shared_playlist_id`, `tidal_track_id`, `removed_by`, `timestamp` |
| Server → Client | `tracks_reordered` | `shared_playlist_id`, `positions[]` |

---

## Tidal API usage

All calls go through the official Tidal Open API v2 (`openapi.tidal.com/v2`), JSON:API format:

| Operation | Endpoint |
|-----------|---------|
| Fetch user profile | `GET /users/me` |
| List user playlists | `GET /playlists?filter[owners.id]={userId}` |
| List playlist tracks | `GET /playlists/{id}/relationships/items` (paginated, 100/page) |
| Add track | `POST /playlists/{id}/relationships/items` |
| Remove track | `DELETE /playlists/{id}/relationships/items` |
| Fetch track info | `GET /tracks/{id}` |
| Exchange auth code | `POST https://auth.tidal.com/v1/oauth2/token` |
| Refresh token | `POST https://auth.tidal.com/v1/oauth2/token` |

---

## Conflict resolution

- **Last-write-wins** — no CRDT or OT
- **Set-difference diffing** — changes detected by comparing ID sets; reorder noise ignored
- **Idempotent adds** — `addTrack()` returns null if the track is already active (no duplicate broadcast or propagation)
- **Token refresh** — inline, within 5 minutes of expiry, per user per poll cycle
- **Dead sessions** — if a refresh token returns 400/401, the user record is deleted from the DB
