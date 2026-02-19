# Architecture

## Overview

```
 Chrome Extension                    Self-hosted Server (Docker)
 ┌────────────────────┐              ┌──────────────────────────┐
 │ Content Script      │              │  Node.js + Express       │
 │ ├─ intercept token  │              │                          │
 │ ├─ observe DOM      │──WebSocket──►│  WebSocket handler       │
 │ └─ detect changes   │◄─────────────│  ├─ auth (user_id only)  │
 │                     │              │  ├─ broadcast changes     │
 │ Service Worker      │              │  └─ track add/remove     │
 │ ├─ WS connection    │              │                          │
 │ ├─ Tidal API calls  │              │  REST API (/api/*)       │
 │ └─ state management │              │  ├─ shared playlists     │
 │                     │              │  ├─ playlist links        │
 │ Popup UI            │              │  └─ active users          │
 │ ├─ server setup     │              │                          │
 │ ├─ playlist linking │  REST API   │  SQLite (WAL mode)       │
 │ └─ status display   │────────────►│  └─ 4 tables             │
 └────────────────────┘              │                          │
                                     │  Static file server      │
 Browser (admin)                     │  └─ web-ui/ (admin panel)│
 ┌────────────────────┐              │                          │
 │ Web UI (vanilla JS) │──REST/WS───►│                          │
 └────────────────────┘              └──────────────────────────┘
```

## Data flow: track sync

1. User adds a track in Tidal web player
2. Content script's MutationObserver detects the DOM change
3. Content script extracts the track ID (5-strategy fallback chain)
4. Content script sends `track_added_in_tidal` to the service worker
5. Service worker sends `track_added` over WebSocket to the server
6. Server writes to SQLite, broadcasts to all other linked users
7. Each recipient's service worker receives the broadcast
8. Service worker calls the Tidal API to add the track to the recipient's linked playlist
9. Toast notification: "Track added by alice"

## Auth model

**The server never sees Tidal tokens.** Auth is minimal:

- Extension captures the Tidal Bearer token by intercepting XHR/fetch requests on `listen.tidal.com`
- Token is stored in `chrome.storage.local` and used only for direct Tidal API calls from the extension
- Server auth is a plain `user_id` string (Tidal numeric ID) sent over WebSocket — no JWT, no session cookies
- The server identifies users solely by this ID for broadcasting and presence tracking

## Database schema

4 tables in SQLite (WAL mode, foreign keys ON):

| Table | Purpose |
|-------|---------|
| `shared_playlists` | Admin-created playlists that users sync to |
| `playlist_links` | Maps user + their Tidal playlist UUID to a shared playlist |
| `tracks` | Track membership with soft-delete (`removed_at` column) |
| `active_users` | WebSocket presence tracking (upsert on auth) |

## Extension components

| Component | File | Role |
|-----------|------|------|
| Service worker | `background/worker.js` | WebSocket connection, Tidal API calls, state management, keepalive alarm |
| Content script | `content/content.js` | Token capture (XHR/fetch intercept), DOM observation, track ID extraction |
| Popup | `popup/popup.html` + `.js` + `.css` | Server setup, playlist linking, status display |

### Track ID extraction (5-strategy fallback)

The content script tries these in order on each track row element:

1. `data-track-id` / `data-id` attributes on the row
2. Child element `data-*` attributes and `href` containing `/track/`
3. Any `a[href*="/track/"]` descendant
4. React fiber walk (up 20 levels looking for `trackId` / `item.id` / `track.id`)
5. Aria-label regex for numeric IDs (`\b\d{6,}\b`)

### MV3 service worker lifecycle

Chrome kills idle service workers. Mitigations:

- `chrome.alarms` fires every ~24s to keep the worker alive
- `storageReady` promise pattern — state restored from `chrome.storage.local` before handling any message
- WebSocket reconnects with exponential backoff: `min(1000 * 2^attempt, 30000)`, max 5 attempts

## Tidal API usage

The extension calls Tidal's web API directly (same endpoints the web player uses):

- Base URL: `https://listen.tidal.com/v1`
- Auth: `Authorization: Bearer <captured-token>`
- Add track: `POST /playlists/{id}/items` (requires ETag)
- Remove track: `DELETE /playlists/{id}/items/{index}` (requires ETag)
- List tracks: `GET /playlists/{id}/items`
- ETag fetched before every write operation (optimistic concurrency)

## Conflict resolution

- **Last-write-wins** — no CRDT or OT
- **Set-difference diffing** — changes detected by comparing track ID sets (ignores reorder noise)
- **Idempotent adds** — `addTrack()` returns null if track already active (no duplicate broadcast)
- **Toast notifications** — users see who made each change
