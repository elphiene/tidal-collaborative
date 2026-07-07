'use strict';

const db                     = require('./db');
const metrics                = require('./metrics');
const { encrypt, decrypt }   = require('./crypto');
const {
  refreshTokens,
  tidalGetPlaylistTrackIds,
  tidalGetPlaylistTrackList,
  tidalGetTrackInfo,
  tidalAddTrack,
  tidalRemoveTrack,
} = require('./tidal');

// ---------------------------------------------------------------------------
// Journal tag helper — human-readable label for a journal/action entry
// ---------------------------------------------------------------------------

function buildTag(displayName, action, trackArtist, trackTitle, playlistName) {
  const verb  = action === 'added' ? 'added'  : 'removed';
  const prep  = action === 'added' ? 'to'     : 'from';
  const track = [trackArtist, trackTitle].filter(Boolean).join(' – ') || '(unknown track)';
  return `${displayName || 'Unknown'} ${verb} ${track} ${prep} ${playlistName || 'playlist'}`;
}

// ---------------------------------------------------------------------------
// Per-user token refresh mutex (prevents concurrent refreshes for same user)
// Map<userId, Promise<string>>
// ---------------------------------------------------------------------------
const tokenRefreshLocks = new Map();

// Per-user poll lock (prevents overlapping polls for same user)
// Set<userId>
const pollingUsers = new Set();

let _broadcastFn       = null;
let _schedulerTimer    = null;
let _currentIntervalMs = 30_000;
let _backfillDone      = false;

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

async function getAccessTokenForUser(user) {
  // Wait if a refresh is already in flight for this user
  if (tokenRefreshLocks.has(user.user_id)) {
    await tokenRefreshLocks.get(user.user_id);
    const fresh = db.getUser(user.user_id);
    if (!fresh?.access_token_enc) throw new Error('TIDAL_SESSION_DEAD');
    return decrypt(fresh.access_token_enc);
  }

  if (user.token_expires_at - Date.now() >= 5 * 60 * 1000) {
    if (!user.access_token_enc) throw new Error('TIDAL_SESSION_DEAD');
    return decrypt(user.access_token_enc);
  }

  if (!user.refresh_token_enc) throw new Error('TIDAL_SESSION_DEAD');

  const p = (async () => {
    const tokens = await refreshTokens(decrypt(user.refresh_token_enc));
    db.upsertUser(
      user.user_id, user.display_name,
      encrypt(tokens.accessToken),
      tokens.refreshToken ? encrypt(tokens.refreshToken) : user.refresh_token_enc,
      tokens.expiresAt,
    );
    return tokens.accessToken;
  })();

  tokenRefreshLocks.set(
    user.user_id,
    p.catch(() => {}).finally(() => tokenRefreshLocks.delete(user.user_id)),
  );

  return p;
}

// ---------------------------------------------------------------------------
// Propagation helpers
// ---------------------------------------------------------------------------

/**
 * Write a removal event to the journal and queue it in every linked user's
 * user_actions table.  Called by the REST API when a track is deleted via
 * the web UI.  tidalAlreadyApplied=true means the caller has already
 * called tidalRemoveTrack for all users (propagateRemoveToAllUsers path).
 */
function journalizeRemoval(sharedPlaylistId, trackId, removedBy, { tidalAlreadyApplied = false } = {}) {
  const trackRow = db.getPlaylistTracks(sharedPlaylistId).find(t => String(t.tidal_track_id) === String(trackId));
  const title  = trackRow?.track_title  ?? null;
  const artist = trackRow?.track_artist ?? null;

  const entry = db.addJournalEntry('removed', removedBy, trackId, title, artist, sharedPlaylistId);

  const links = db.getPlaylistLinks(sharedPlaylistId);
  for (const link of links) {
    db.upsertUserAction(link.user_id, sharedPlaylistId, trackId, 'removed', title, artist, {
      tidalOrigin:  0,
      tidalApplied: tidalAlreadyApplied ? 1 : 0,
      journalId:    entry.id,
    });
  }
  return entry;
}

/**
 * Remove a track from ALL users' Tidal playlists linked to this shared playlist.
 * Called when a track is deleted via the webapp.
 * Also writes the removal to the journal for the audit log.
 */
async function propagateRemoveToAllUsers(sharedPlaylistId, trackId, removedBy = null) {
  const links = db.getPlaylistLinks(sharedPlaylistId);
  for (const link of links) {
    const user = db.getUser(link.user_id);
    if (!user || user.sync_status === 'token_revoked') continue;
    try {
      const token = await getAccessTokenForUser(user);
      await tidalRemoveTrack(link.tidal_playlist_id, trackId, token);
      console.log(`[poller] propagated -${trackId} → "${user.display_name || link.user_id}"`);
    } catch (err) {
      console.error(`[poller] propagate remove failed for "${link.user_id}": ${err.message}`);
    }
  }
  // Journal the removal so it appears in the audit log (tidalAlreadyApplied=true)
  try {
    journalizeRemoval(sharedPlaylistId, trackId, removedBy ?? 'admin', { tidalAlreadyApplied: true });
  } catch (err) {
    console.warn('[poller] journalizeRemoval failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Journal sync — four steps per link
// ---------------------------------------------------------------------------

/**
 * Step 1 — Detect changes in the user's Tidal playlist and record them in
 * user_actions.  tidal_origin=1 means the change came from the Tidal app
 * (already applied to Tidal); journal_id=NULL means it hasn't been flushed.
 */
async function stepDetect(link, accessToken) {
  const { tidal_playlist_id: tidalPlaylistId, shared_playlist_id: spId, user_id: userId } = link;
  const displayName = link.tidal_playlist_name || tidalPlaylistId;
  const startedFromCursor = link.scan_cursor != null;

  const { ids: tidalIds, truncated, nextCursor } =
    await tidalGetPlaylistTrackIds(tidalPlaylistId, accessToken, link.scan_cursor ?? null);

  // Persist cursor or clear on completion
  if (truncated && nextCursor) {
    db.setLinkCursor(link.id, nextCursor);
    console.log(`[poller] "${displayName}": paginated — cursor saved`);
  } else {
    db.clearLinkCursor(link.id);
  }

  const knownIds  = db.getUserAllKnownTrackIds(userId, spId);  // all rows, any state
  const activeIds = db.getUserActiveTrackIds(userId, spId);    // current_action='added'

  // Tracks in Tidal not known at all → newly added in Tidal app. Safe even on a
  // partial fetch — presence in a partial window still proves the track exists.
  const newIds = [...tidalIds].filter(id => !knownIds.has(id));

  // Tracks we thought were active but gone from Tidal → removed in Tidal app.
  // Only trustworthy on a COMPLETE from-the-start scan: if this fetch was
  // truncated (hit MAX_PAGES) or resumed from a saved cursor, tidalIds is only
  // a partial window of the playlist, and every active track outside that
  // window would incorrectly look "removed" (AUDIT.md C1).
  const completeScan = !startedFromCursor && !truncated;
  const removedIds = completeScan
    ? [...activeIds].filter(id => !tidalIds.has(id))
    : [];
  if (!completeScan && activeIds.size > 0) {
    console.log(`[poller] "${displayName}": partial scan (cursor=${startedFromCursor}, truncated=${truncated}) — skipping removal detection`);
  }

  for (const trackId of newIds) {
    const { title, artist } = await tidalGetTrackInfo(trackId, accessToken);
    db.upsertUserAction(userId, spId, trackId, 'added', title, artist,
      { tidalOrigin: 1, tidalApplied: 1, journalId: null });
    console.log(`[poller] "${displayName}": detected +${trackId} (${title || '?'})`);
  }

  for (const trackId of removedIds) {
    const existing = db.getPendingTidalActions(userId, spId).find(r => String(r.tidal_track_id) === trackId);
    const title  = existing?.track_title  ?? null;
    const artist = existing?.track_artist ?? null;
    db.upsertUserAction(userId, spId, trackId, 'removed', title, artist,
      { tidalOrigin: 1, tidalApplied: 1, journalId: null });
    console.log(`[poller] "${displayName}": detected -${trackId}`);
  }

  return { newCount: newIds.length, removedCount: removedIds.length };
}

/**
 * Step 2 — Flush unflushed user_actions to master_journal.
 * Also updates the shared tracks table and broadcasts WS events.
 */
function stepFlush(link, broadcastFn) {
  const { shared_playlist_id: spId, user_id: userId } = link;
  const user     = db.getUser(userId);
  const displayName = user?.display_name || userId;

  const unflushed = db.getUnflushedUserActions(userId, spId);
  if (unflushed.length === 0) return;

  const sp = db.getSharedPlaylists().find(p => p.id === spId);

  for (const row of unflushed) {
    const entry = db.addJournalEntry(
      row.current_action, userId,
      row.tidal_track_id, row.track_title, row.track_artist, spId,
    );
    db.setUserActionJournalId(row.id, entry.id);

    const tag = buildTag(displayName, row.current_action, row.track_artist, row.track_title, sp?.name);
    console.log(`[journal] ${tag}`);

    if (row.current_action === 'added') {
      const maxPos = db.getMaxPosition(spId);
      const track  = db.addTrack(spId, row.tidal_track_id, userId, maxPos + 1, row.track_title, row.track_artist);
      if (track) {
        metrics.tracksAddedTotal.inc();
        broadcastFn(spId, {
          type: 'track_added', shared_playlist_id: spId,
          tidal_track_id: row.tidal_track_id,
          track_title: row.track_title, track_artist: row.track_artist,
          added_by: userId, position: track.position, timestamp: Date.now(),
        });
      }
    } else {
      db.removeTrack(spId, row.tidal_track_id);
      broadcastFn(spId, {
        type: 'track_removed', shared_playlist_id: spId,
        tidal_track_id: row.tidal_track_id,
        removed_by: userId, timestamp: Date.now(),
      });
    }
  }
}

/**
 * Step 3 — Pull new journal entries into every OTHER user's user_actions table.
 * Pure DB work — no Tidal calls.
 */
function stepPull(link) {
  const { shared_playlist_id: spId, user_id: originUserId } = link;
  const allLinks = db.getPlaylistLinks(spId);

  for (const other of allLinks) {
    if (other.user_id === originUserId) continue;
    const maxJid  = db.getUserMaxJournalId(other.user_id, spId);
    const entries = db.getJournalEntriesAfter(spId, maxJid);
    if (entries.length === 0) continue;

    for (const entry of entries) {
      db.upsertUserAction(
        other.user_id, spId, entry.tidal_track_id,
        entry.action, entry.track_title, entry.track_artist,
        { tidalOrigin: 0, tidalApplied: 0, journalId: entry.id },
      );
    }
    console.log(`[journal] pulled ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} → "${other.user_id}"`);
  }
}

/**
 * Step 4 — Apply pending user_actions to the user's Tidal playlist.
 */
async function stepApply(link, accessToken) {
  const { tidal_playlist_id: tidalPlaylistId, shared_playlist_id: spId, user_id: userId } = link;
  const pending = db.getPendingTidalActions(userId, spId);
  if (pending.length === 0) return;

  for (const row of pending) {
    try {
      if (row.current_action === 'added') {
        await tidalAddTrack(tidalPlaylistId, row.tidal_track_id, accessToken);
        metrics.propagationsTotal.inc();
      } else {
        await tidalRemoveTrack(tidalPlaylistId, row.tidal_track_id, accessToken);
      }
      db.markTidalApplied(row.id);
      console.log(`[poller] applied ${row.current_action === 'added' ? '+' : '-'}${row.tidal_track_id} → "${userId}"`);
    } catch (err) {
      // On 404/not-found the desired state is already achieved — mark applied
      if (/404|not.?found/i.test(err.message)) {
        db.markTidalApplied(row.id);
        console.warn(`[poller] ${row.tidal_track_id} not in Tidal — marking applied`);
      } else {
        throw err; // let pollUser handle 429 etc.
      }
    }
  }
}

/**
 * Run all four journal sync steps for a single playlist link.
 * Replaces the old pollPlaylist + propagateAddToOtherUsers flow.
 */
async function pollPlaylist(link, accessToken, broadcastFn) {
  await stepDetect(link, accessToken);
  stepFlush(link, broadcastFn);
  stepPull(link);
  await stepApply(link, accessToken);
}

// ---------------------------------------------------------------------------
// Poll all playlists for a single user
// ---------------------------------------------------------------------------

async function pollUser(userId, broadcastFn) {
  const user = db.getUser(userId);
  if (!user) return;

  const name = user.display_name || userId;

  // Respect rate-limit backoff
  if (user.sync_status === 'rate_limited' && user.sync_retry_after > Date.now()) {
    console.log(`[poller] "${name}" rate-limited — skipping (retry at ${new Date(user.sync_retry_after).toISOString()})`);
    return;
  }

  let accessToken;
  try {
    accessToken = await getAccessTokenForUser(user);
  } catch (err) {
    console.warn(`[poller] token unusable for "${name}" — marking revoked`);
    db.markUserTokenDead(userId);
    broadcastFn(null, {
      type:    'sync_status',
      user_id: userId,
      status:  'token_revoked',
      message: 'Tidal session expired — user must re-authenticate',
    });
    return;
  }

  const links = db.getUserLinks(userId);
  console.log(`[poller] "${name}": checking ${links.length} playlist(s)`);

  let hadError = false;
  for (const link of links) {
    try {
      await pollPlaylist(link, accessToken, broadcastFn);
    } catch (err) {
      const is429 = /429|rate.?limit/i.test(err.message);
      if (is429) {
        const retryAfter = Date.now() + 60_000;
        db.setUserSyncStatus(userId, 'rate_limited', 'Tidal rate limit reached', retryAfter);
        broadcastFn(null, {
          type:        'sync_status',
          user_id:     userId,
          status:      'rate_limited',
          message:     'Tidal rate limit — sync paused for 60 seconds',
          retry_after: retryAfter,
        });
        console.warn(`[poller] "${name}" rate limited — pausing sync`);
        return;
      }
      console.error(`[poller] poll failed for "${name}" / "${link.tidal_playlist_name || link.tidal_playlist_id}": ${err.message}`);
      db.setUserSyncStatus(userId, 'error', err.message);
      hadError = true;
    }
  }

  if (!hadError && user.sync_status !== 'ok') {
    db.setUserSyncStatus(userId, 'ok');
    broadcastFn(null, { type: 'sync_status', user_id: userId, status: 'ok', message: null });
  }

  // Backfill missing track metadata once per server run using the first available token
  if (!_backfillDone) {
    _backfillDone = true;
    backfillTrackMetadata(accessToken).catch(err =>
      console.warn('[poller] backfill error:', err.message),
    );
  }
}

// ---------------------------------------------------------------------------
// Scheduler — stagger users evenly across the poll interval
// ---------------------------------------------------------------------------

function schedulePollCycle(broadcastFn) {
  const users = db.getAllUsersWithLinks();
  if (users.length === 0) return;
  metrics.pollCyclesTotal.inc();

  const gap = Math.max(1_000, Math.floor(_currentIntervalMs / users.length));
  users.forEach((user, i) => {
    setTimeout(() => {
      if (pollingUsers.has(user.user_id)) return;
      pollingUsers.add(user.user_id);
      pollUser(user.user_id, broadcastFn)
        .catch(err => console.error(`[poller] uncaught error for "${user.user_id}":`, err.message))
        .finally(() => pollingUsers.delete(user.user_id));
    }, i * gap);
  });
}

// ---------------------------------------------------------------------------
// Metadata backfill
// ---------------------------------------------------------------------------

async function backfillTrackMetadata(accessToken) {
  const tracks = db.getTracksWithNullMetadata();
  if (tracks.length === 0) return;
  console.log(`[poller] backfilling metadata for ${tracks.length} track(s)…`);
  let filled = 0;
  for (const t of tracks) {
    const { title, artist } = await tidalGetTrackInfo(String(t.tidal_track_id), accessToken);
    if (title || artist) { db.updateTrackMetadata(t.tidal_track_id, title, artist); filled++; }
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(`[poller] backfill complete: ${filled}/${tracks.length}`);
  if (filled < tracks.length) _backfillDone = false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function startPoller(broadcastFn) {
  _broadcastFn       = broadcastFn;
  _currentIntervalMs = db.getPollInterval();
  console.log(`[poller] starting — interval ${_currentIntervalMs / 1000}s, staggered per user`);

  const run = () => {
    schedulePollCycle(broadcastFn);
    const newMs = db.getPollInterval();
    if (newMs !== _currentIntervalMs) {
      _currentIntervalMs = newMs;
      clearInterval(_schedulerTimer);
      _schedulerTimer = setInterval(run, newMs);
      console.log(`[poller] interval updated to ${newMs / 1000}s`);
    }
  };

  setTimeout(() => schedulePollCycle(broadcastFn), 5_000);
  _schedulerTimer = setInterval(run, _currentIntervalMs);
}

/** Trigger an immediate poll for a specific user or all users. */
function pollNow(userId = null) {
  if (!_broadcastFn) return;
  if (userId) {
    if (!pollingUsers.has(userId)) {
      pollingUsers.add(userId);
      pollUser(userId, _broadcastFn)
        .catch(err => console.error('[poller] pollNow error:', err.message))
        .finally(() => pollingUsers.delete(userId));
    }
  } else {
    schedulePollCycle(_broadcastFn);
  }
}

/**
 * Called after a new playlist link is created.
 * Seeds user_actions with all existing shared playlist tracks (pending Tidal apply),
 * then triggers a normal poll which will apply them and detect any existing Tidal tracks.
 */
async function initNewLink(link) {
  const { shared_playlist_id: sharedPlaylistId, user_id: userId } = link;
  const user = db.getUser(userId);
  if (!user) return;

  const existingTracks = db.getPlaylistTracks(sharedPlaylistId);
  const displayName    = link.tidal_playlist_name || link.tidal_playlist_id;

  if (existingTracks.length > 0) {
    console.log(`[poller] initNewLink: seeding ${existingTracks.length} track(s) for "${displayName}"`);
    for (const track of existingTracks) {
      db.upsertUserAction(
        userId, sharedPlaylistId, String(track.tidal_track_id),
        'added', track.track_title, track.track_artist,
        { tidalOrigin: 0, tidalApplied: 0, journalId: null },
      );
    }
  }

  db.clearLinkCursor(link.id);
  // pollNow runs stepDetect (finds any tracks the user already had in Tidal)
  // and stepApply (pushes seeded tracks above to their Tidal playlist)
  pollNow(userId);
}

/**
 * Full bidirectional sync for a link (used by admin force-sync endpoint).
 * - Tidal-only tracks → merged into server DB + propagated to other users
 * - Server-only tracks → added to Tidal
 * - Tidal duplicates → excess copies removed
 */
async function syncPlaylistForLink(link, accessToken) {
  const { tidal_playlist_id: tidalPlaylistId, shared_playlist_id: sharedPlaylistId, user_id: userId } = link;

  const tidalList   = await tidalGetPlaylistTrackList(tidalPlaylistId, accessToken);
  const tidalCounts = new Map();
  for (const id of tidalList) tidalCounts.set(id, (tidalCounts.get(id) ?? 0) + 1);

  const serverIds  = db.getActiveTrackIds(sharedPlaylistId);
  const deletedIds = db.getRecentlyDeletedTrackIds(sharedPlaylistId);
  let added = 0, merged = 0, duplicatesFixed = 0;

  for (const [id, count] of tidalCounts) {
    if (count > 1) {
      for (let i = 0; i < count - 1; i++) {
        try { await tidalRemoveTrack(tidalPlaylistId, id, accessToken); duplicatesFixed++; }
        catch (err) { console.warn(`[sync] could not remove Tidal duplicate ${id}: ${err.message}`); }
        await new Promise(r => setTimeout(r, 300));
      }
    }

    if (!serverIds.has(id) && !deletedIds.has(id)) {
      const { title, artist } = await tidalGetTrackInfo(id, accessToken);
      const maxPos = db.getMaxPosition(sharedPlaylistId);
      const track  = db.addTrack(sharedPlaylistId, id, userId, maxPos + 1, title, artist);
      if (track) {
        if (_broadcastFn) {
          _broadcastFn(sharedPlaylistId, {
            type: 'track_added', shared_playlist_id: sharedPlaylistId,
            tidal_track_id: id, track_title: title, track_artist: artist,
            added_by: userId, position: track.position, timestamp: Date.now(),
          });
        }
        // Journal the merge so stepPull propagates it to other users on their next poll
        const entry = db.addJournalEntry('added', userId, id, title, artist, sharedPlaylistId);
        // Seed origin user's user_action so stepDetect doesn't re-detect this as new
        db.upsertUserAction(userId, sharedPlaylistId, id, 'added', title, artist,
          { tidalOrigin: 1, tidalApplied: 1, journalId: entry.id });
        serverIds.add(id);
        merged++;
      }
    }
  }

  for (const id of serverIds) {
    if (!tidalCounts.has(id)) {
      try { await tidalAddTrack(tidalPlaylistId, id, accessToken); added++; }
      catch (err) { console.warn(`[sync] could not add ${id} to Tidal: ${err.message}`); }
      await new Promise(r => setTimeout(r, 300));
    }
  }

  db.clearLinkCursor(link.id);
  console.log(`[sync] "${tidalPlaylistId}": +${added} to Tidal, +${merged} merged to DB, ${duplicatesFixed} dupes fixed`);
  return { added, merged, duplicatesFixed };
}

module.exports = {
  startPoller,
  pollNow,
  initNewLink,
  getAccessTokenForUser,
  syncPlaylistForLink,
  propagateRemoveToAllUsers,
  journalizeRemoval,
  buildTag,
};
