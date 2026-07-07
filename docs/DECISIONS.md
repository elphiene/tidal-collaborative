# tidal-collaborative — Decisions log

## D-001 · `better-sqlite3` (sync), not async sqlite3

**Decided:** Build time
**Context:** All DB access patterns are simple — write a journal entry, read a list.
**Decision:** `better-sqlite3` sync API.
**Why:** Synchronous code is easier to reason about for a small server. Performance is excellent for this workload. WAL mode keeps reads non-blocking even mid-write.
**Trade-off:** Native binding needs to build per Node major version. Acceptable — Node 20 LTS is locked in for now.

## D-002 · AES-256-GCM for at-rest Tidal token encryption

**Decided:** Build time
**Context:** User Tidal refresh tokens are valuable bearer secrets. SQLite is on disk.
**Decision:** Encrypt tokens with AES-256-GCM before insert. Key is a 32-byte secret generated at first run and stored in the SQLite file too (`secrets` table).
**Why:** Defence in depth. If the DB file leaks, raw tokens aren't immediately useful.
**Trade-off:** Encryption-at-rest where the key lives in the same file isn't crypto-rigorous — it's anti-casual-leak only. Acceptable for a self-hosted homelab app. Recommended: set `ENCRYPTION_KEY` explicitly via env/secret for any deployment that isn't a single-user homelab box (see `server/.env.example`, AUDIT.md M5).

## D-003 · 4-step journal-based sync engine

**Decided:** 2026, rewritten from a simpler version
**Context:** Original sync engine raced on rapid changes from multiple users.
**Decision:** Rewrote sync as a 4-step journal: poll Tidal for changes → write to `master_journal` → propagate per-user via `user_actions` → fire WebSocket notifications.
**Why:** Decouples Tidal API access from per-user propagation. The journal is the single source of truth — replayable, debuggable.
**Trade-off:** More moving parts than a "poll-and-push" loop. Worth it for correctness.

## D-004 · Native WebSockets via `ws`, not Socket.IO

**Decided:** Build time
**Context:** Need live updates to connected clients (track added, playlist renamed, etc.).
**Decision:** `ws` library, no Socket.IO.
**Why:** Don't need rooms, namespaces, or polyfills. Native WebSockets are universally supported by browsers we care about.
**Trade-off:** No fallback to long-polling if WebSockets are blocked. Acceptable — users are on home networks.

## D-005 · Vanilla HTML/CSS/JS frontend (no framework)

**Decided:** Build time
**Context:** Small client UI: login, playlist list, sync status, admin panel.
**Decision:** Vanilla JS. Plain `<script>` tags, no bundler.
**Why:** Consistent with the rest of El's web apps. Easy to read in browser devtools. No build step in dev.
**Trade-off:** UI complexity ceiling. If features grow, may need a framework. Not the case yet.

## D-006 · CasaOS-compatible Docker layout

**Decided:** Build time
**Context:** Deployment target is CasaOS (a self-hosted home server UI on top of Docker).
**Decision:** Volume mounts under `/DATA/AppData/` (CasaOS convention), `x-casaos:` block in `docker-compose.yml`.
**Why:** App can be installed via CasaOS UI by other homelab users, not just El's setup.
**Trade-off:** Convention-coupled to CasaOS. Users on other Docker setups need to change `volumes:` paths.

## D-007 · Compose-level healthcheck overrides the Dockerfile one

**Decided:** Build time (and re-fixed 2026-05-28)
**Context:** Container needs a healthcheck so Docker can detect process failure.
**Decision (original):** Both Dockerfile and compose define healthchecks. Compose-level uses `curl`.
**Decision (fix 2026-05-28):** curl isn't in the Alpine image. Also `localhost` resolves to `::1` first inside the container (server only listens IPv4). Fixed to use `wget` against `127.0.0.1` in compose.
**Why:** wget is in busybox by default; `127.0.0.1` is explicit IPv4.
**Trade-off:** Dockerfile + compose now have near-identical healthcheck definitions. If someone removes the compose-level one, the Dockerfile one takes over and continues to work.

## D-008 · Prometheus metrics via `prom-client`

**Decided:** 2026 (Phase 2 of monitoring)
**Context:** Want to track WebSocket connections, sync events, and poller activity over time.
**Decision:** Instrument with `prom-client`. Expose `/metrics` on the same port, no auth.
**Why:** Native Prometheus integration. The host's Grafana stack already scrapes blackbox HTTP; adding this is one config line.
**Trade-off:** `/metrics` is unauth'd. Acceptable — it's behind the same Cloudflare tunnel as everything else, and the metric values aren't sensitive.

## D-009 · No automated tests (yet)

**Decided:** Build time
**Context:** Test suite would add value but slows initial development.
**Decision:** Skip automated tests. Manual smoke-testing only.
**Why:** Time-to-ship trade-off. The sync engine is the part that most needs tests; everything else is straightforward.
**Trade-off:** Regression risk on the sync engine. If you touch `poller.js` or the journal logic, manually verify a real account before deploying.

## D-010 · v1.0.0 first release (2026-05-26)

**Decided:** 2026-05-26
**Context:** Hit the threshold of being usable for the original collaborators (Cherry, Eloise, Amelia).
**Decision:** Tag v1.0.0 as the first release.
**Why:** Locks in a known-good reference. From here, bumps are semver.
**Trade-off:** None — should have started tagging earlier, but better late than never.
