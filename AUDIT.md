# Repository Audit — tidal-collaborative

**Date:** 2026-07-06 · **Scope:** full codebase (server, web-ui, docker, schema) · **Version audited:** 1.0.0

Overall: the codebase is clean, well-commented, and the journal-based sync design is sound. The findings below are ordered by severity. The Critical/High items are worth fixing before adding more users; several can silently destroy playlist data or let one user affect another's Tidal library.

---

## Critical

### C1 — Truncated/resumed playlist scans cause mass false removals — **FIXED** (`2c6de80`)
`poller.js stepDetect()` (lines ~143–183) diffs the fetched Tidal track IDs against **all** of the user's active tracks, but `tidalGetPlaylistTrackIds()` can return a *partial* set in two cases: (a) the scan hit `MAX_PAGES` (50 pages ≈ 5,000 tracks) and was truncated, and (b) the scan **resumed from a saved `scan_cursor`**, in which case it only contains the tail of the playlist. In both cases every active track outside the fetched window lands in `removedIds`, gets journaled as `removed`, soft-deleted from the shared playlist, and propagated as a removal to every collaborator's Tidal playlist.

**Fix:** skip the removal diff entirely whenever `truncated` is true **or** the scan started from a non-null cursor; only run removal detection on a complete from-the-start scan. (Add detection is safe either way.)

### C2 — Re-linking a playlist can wipe the shared playlist — **FIXED** (`ecedb49`)
`DELETE /api/links/:id` (`api.js`) and `db.deleteUser()` remove the link but leave the user's `user_actions` rows behind. If the user later re-links (possibly to a different or empty Tidal playlist), `initNewLink()`'s seed upsert is a no-op (rows already exist with `tidal_applied=1`), and the next `stepDetect` compares the *new* playlist against the *old* rows — everything missing is detected as removed and propagated to all collaborators.

**Fix:** delete `user_actions` rows for `(user_id, shared_playlist_id)` when a link is deleted (and when a user is deleted).

---

## High

### H1 — Missing authorization on destructive playlist endpoints
`DELETE /api/shared-playlists/:id/tracks/:trackId` and `POST /api/shared-playlists/:id/tracks/reorder` (`api.js` ~340–410) only check that the caller is signed in. **Any** authenticated user can delete any track from any shared playlist — including private ones they are not a member of — and the deletion propagates to every member's real Tidal playlist. Similarly, `DELETE /api/invites/:id` lets any signed-in user revoke any invite.

**Fix:** require the caller to be linked to the playlist (`db.checkLinkExists`) or its creator/admin.

### H2 — Unauthenticated read endpoints leak private data
These routes have no auth at all: `GET /api/shared-playlists/:id/tracks` (full track list of private playlists), `GET /api/shared-playlists/:id/linked-users` (user IDs, display names, Tidal playlist IDs), `GET /api/links/:userId` (enumerate any user's links; the authenticated `GET /api/links` makes this one redundant), and `GET /api/users` (presence). `/metrics` is also open despite the "local port only" comment — the server binds `0.0.0.0` and compose publishes the port.

**Fix:** require a session on all of these; delete `GET /api/links/:userId`.

### H3 — WebSocket `auth` message allows impersonation
`ws.js handleAuth()` accepts any client-supplied `payload.user_id` with no verification, overriding the session-based auth done at upgrade. An unauthenticated WS client can claim any user ID, receive that user's playlist events and sync-status messages, kick the real user's connection (one socket per user ID), and forge presence rows.

**Fix:** remove the `auth` message path entirely — session auth at upgrade already works — or at minimum require `payload.user_id === req.session.userId`.

### H4 — `POST /api/setup/tidal-client-id` is permanently unauthenticated
The setup endpoint works even after setup completes, so anyone who can reach the server can overwrite the Tidal Client ID at any time (breaking sign-in, or pointing the OAuth flow at their own Tidal app).

**Fix:** reject if a client ID is already set unless `req.session.adminAuthed`.

### H5 — Admin PIN is brute-forceable and stored in plaintext
A 4-digit PIN (10,000 combinations), no rate limiting or lockout on `POST /api/admin/auth`, stored in plaintext in `settings`, compared with `!==`. A trivial script gains admin in seconds; admin can force-poll, change settings, and read the full journal. First-run is also a race: whoever reaches a fresh install first sets the PIN.

**Fix:** add per-IP/global attempt throttling with backoff, hash the PIN (scrypt from Node's built-in crypto keeps the no-new-deps constraint), and consider a longer secret.

### H6 — Web-UI track removals are marked "applied" even when the Tidal call failed — **FIXED** (`8e3329c`)
`propagateRemoveToAllUsers()` (`poller.js` ~113–132) catches and logs per-user Tidal failures, then `journalizeRemoval(..., { tidalAlreadyApplied: true })` stamps `tidal_applied=1` for **all** users. A user whose removal failed keeps the track in their Tidal playlist forever: it's `known` (state `removed`) so `stepDetect` never re-detects it, and it's never retried. Silent permanent divergence.

**Fix:** track per-user success and set `tidalApplied` accordingly (failures stay 0 and are retried by `stepApply`).

---

## Medium

### M1 — Tracks re-added from the Tidal app are never detected
`stepDetect` computes `newIds` against `getUserAllKnownTrackIds()` (rows in *any* state). A track the user removed and later re-adds in the Tidal app is already "known" (state `removed`), so the re-add is silently ignored forever — contradicting the intent of `getRecentlyDeletedTrackIds()`'s propagation window (which is only used by manual force-sync). **Fix:** treat tracks present in Tidal whose `current_action='removed'` (and outside the recent-deletion window) as adds.

### M2 — `tidalRemoveTrack` fetches the entire playlist per removal
Every removal calls `tidalGetPlaylistItemMap()`, which paginates the whole playlist (150 ms per page). `propagateRemoveToAllUsers` does this once per user; the dedup endpoint does it per duplicate. On large playlists this is an O(N) API storm per removal and a likely 429 source. **Fix:** cache the item map per (playlist, poll cycle), or batch removals.

### M3 — Journal entries for web-UI removals lose title/artist
In the DELETE track route, `db.removeTrack()` soft-deletes the row *before* `journalizeRemoval()` looks it up via `getPlaylistTracks()` (active rows only), so metadata is always null. Same class of bug in `stepDetect`'s removal path, which looks up metadata in `getPendingTidalActions()` (`tidal_applied=0`) although the removed row has `tidal_applied=1`. **Fix:** query the row regardless of `removed_at`/applied state.

### M4 — Session store is in-memory
`express-session` default MemoryStore: all sessions drop on every restart/redeploy (users and admin get logged out), and it leaks memory by design. With better-sqlite3 already present, a tiny SQLite-backed store keeps the minimal-deps constraint. Also set `cookie.secure` (behind HTTPS) and `app.set('trust proxy', 1)` if a reverse proxy is used — the code reads `x-forwarded-*` headers but never configures trust-proxy, so those headers are client-spoofable.

### M5 — Encryption key stored alongside the encrypted data
When `ENCRYPTION_KEY` isn't provided via env, it's generated and stored in the same `db.sqlite` as the encrypted Tidal tokens — anyone who obtains the DB file gets the key too. The compose file ships without the env var, so this is the default deployment. Document the tradeoff and recommend setting `ENCRYPTION_KEY` via env/secret in production deployments.

### M6 — CORS wide open + no CSRF tokens
`app.use(cors())` sets `Access-Control-Allow-Origin: *`. Cookies aren't sent cross-origin with `*` and `sameSite: lax` (default) blocks cross-site POSTs, so the practical risk is low today — but the config invites regressions (e.g., switching to `credentials: true`). Since the UI is same-origin, `cors` can likely be removed entirely (also satisfies the minimal-deps constraint).

### M7 — Dockerfile healthcheck still uses `localhost`
The compose healthcheck was fixed to `127.0.0.1` (per CLAUDE.md), but the Dockerfile `HEALTHCHECK` — explicitly kept as the fallback — still uses `http://localhost:3000`, which resolves to `::1` first in Alpine while the server listens on IPv4 only. The fallback will report unhealthy exactly when it's needed. One-word fix.

### M8 — Container runs as root
No `USER` directive in the Dockerfile. Add `USER node` (and `chown` `/app/data`) to limit blast radius.

---

## Low

- **L1** — `build.sh` pushes to Docker Hub despite being documented (CLAUDE.md, header comment) as local build+tag only; `publish.sh` exists for pushing. Surprising side effect — remove the push from `build.sh`.
- **L2** — `master_journal` is documented as append-only/never-deleted, but its FK is `ON DELETE CASCADE` on `shared_playlists` — deleting a playlist erases its history. Same for `addTrack()` hard-deleting soft-deleted rows despite the "soft-delete preserves history" schema comment. Align code or docs.
- **L3** — Unknown `/api/*` paths fall through to the SPA catch-all and return `index.html` with HTTP 200. Add an `/api` 404 handler before the static/SPA fallback.
- **L4** — `POST /api/shared-playlists`: if `createLink()` throws after the playlist insert, the client gets a 500 but the playlist exists (no transaction). Wrap in `db.transaction`.
- **L5** — `journalizeRemoval` is imported in `api.js` but never used there. `engines` says `>=18` while docs standardize on Node 20.
- **L6** — Invite codes: `base64url → toUpperCase()` collapses case, cutting entropy to ~41 bits over an ambiguous alphabet (`-`, `_` look odd uppercased). Fine for invites, but a hex or A–Z0–9 alphabet would be cleaner. There's also no rate limit on `GET /api/invites/:code` probing.
- **L7** — `server/.env` contains a real `ENCRYPTION_KEY`/`SESSION_SECRET`, and `data/db.sqlite` + `docker/data/db.sqlite` (real user tokens) sit in the working tree. All are gitignored — verify with `git ls-files` that none were ever committed, and rotate the keys if they were. Treat these files as secrets when sharing the folder.
- **L8** — `compose pull_policy: always` on the `latest` tag means silent unattended upgrades for CasaOS users; consider versioned tags.
- **L9** — No test suite (documented constraint). The poller's diff logic (C1, M1) is exactly the kind of pure-ish logic that would be cheap to unit-test with a mocked `tidal.js`.

---

## What looks good

Parameterized SQL throughout (no injection found); AES-256-GCM with random 12-byte IVs and auth tags; PKCE handled server-side with state + TTL and tokens never exposed to the browser; consistent `escHtml()` escaping in the web UI (no XSS found); refresh-token mutex and per-user poll locks; idempotent migrations; sensible 429/backoff handling; partial unique index guarding duplicate active tracks; graceful shutdown with a hard-exit timer.

## Suggested fix order

1. C1 + C2 (data-destroying sync bugs), H6 (silent divergence)
2. H1–H4 (authz/authn holes), H5 (PIN brute force)
3. M1–M3 (sync correctness/perf), M7 (one-liner)
4. M4–M6, M8, then Low items opportunistically
