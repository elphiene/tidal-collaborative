# Read-only API (for external apps)

tidal-collaborative exposes a **read-only HTTP API** so external clients (e.g. a
custom car/mobile app) can fetch the collaborative playlist data without a
browser session. It's authenticated with a single static API key.

## Getting a key

Admin panel → **Settings → API key → Generate**. The key is shown **once** —
copy it immediately. It's stored only as a hash, so a lost key is rotated, not
recovered. Generating again rotates it (the old key stops working at once).

Alternatively, pin a key at deploy time with the `API_KEY` env var. When that's
set it takes precedence and the UI button is disabled (rotate it in your env /
compose file instead).

## Authenticating

Send the key as a bearer token on every request:

```
Authorization: Bearer <your-key>
```

Rules:
- The key grants **GET only**. Any `POST`/`PATCH`/`DELETE` with a key → `403`.
- A missing/invalid key on a keyed request → `401`.
- Base URL is wherever the server is reachable, e.g. `http://<host>:3000`.

## Endpoints

The key can read every *global* endpoint (the same data an admin sees).
Endpoints that answer "*my* …" for a signed-in user (`/me`, `/links`,
`/tidal/playlists`, `/users/all`) are **not** available to a key — it isn't
anyone's session — and return `401`.

| Method & path | Returns |
|---|---|
| `GET /api/shared-playlists` | All shared playlists with `user_count` / `track_count` |
| `GET /api/shared-playlists/:id/tracks` | Tracks in one playlist (the main one) |
| `GET /api/shared-playlists/:id/linked-users` | Users linked to a playlist |
| `GET /api/journal` | Activity log (`?playlist_id=`, `?action=added\|removed`, paginated) |
| `GET /api/journal/stats` | Aggregate journal counts |
| `GET /api/sync/status` | Per-user sync status |
| `GET /api/users` | Currently-active (present) users |

### The two you'll actually use

**List playlists** — pick an `id` from here:

```bash
curl -H "Authorization: Bearer $KEY" http://<host>:3000/api/shared-playlists
```

```json
[
  { "id": 1, "name": "Road Trip", "is_public": 1, "user_count": 3, "track_count": 42 }
]
```

**Get a playlist's tracks** — the list to feed into Tidal playback. Each row's
`tidal_track_id` is the ID to resolve/play via Tidal's own API:

```bash
curl -H "Authorization: Bearer $KEY" http://<host>:3000/api/shared-playlists/1/tracks
```

```json
[
  {
    "tidal_track_id": "12345678",
    "track_title": "Song Name",
    "track_artist": "Artist Name",
    "position": 0,
    "added_by_name": "Cherry"
  }
]
```

Tracks are ordered by `position`; removed tracks are already filtered out.

## Notes

- No CORS headers are sent. That's fine for a native app (CORS only applies to
  browser JS); a browser-based client on another origin won't be able to call it.
- The key exposes display names, playlist names, and sync status — no tokens or
  emails are ever returned. Still, treat the key as a shared secret.
