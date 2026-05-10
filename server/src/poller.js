'use strict';

const db                     = require('./db');
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

// Tracks must exist in DB for at least this long before Tidal-side removal detection
// is applied, preventing false positives while propagation is still in-flight.
const REMOVAL_GRACE_PERIOD_SEC = 120;

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
 * Add a track to all OTHER users' Tidal playlists linked to this shared playlist.
 * Called after a new track is detected and added to the DB.
 */
async function propagateAddToOtherUsers(sharedPlaylistId, excludeUserId, trackId, trackTitle, trackArtist) {
  const links = db.getPlaylistLinks(sharedPlaylistId);
  for (const link of links) {
    if (link.user_id === excludeUserId) continue;
    const user = db.getUser(link.user_id);
    if (!user || user.sync_status === 'token_revoked') continue;
    try {
      const token = await getAccessTokenForUser(user);
      await tidalAddTrack(link.tidal_playlist_id, trackId, token);
      db.logTrackEvent(sharedPlaylistId, trackId, 'added', null, 'propagation', link.user_id, trackTitle, trackArtist);
      console.log(`[poller] propagated +${trackId} → "${user.display_name || link.user_id}"`);
    } catch (err) {
      console.error(`[poller] propagate add failed for "${link.user_id}": ${err.message}`);
    }
  }
}

/**
 * Remove a track from ALL users' Tidal playlists linked to this shared playlist.
 * On success, clears the user's removal queue entry — the poller will retry
 * any remaining entries on the next cycle for users whose tokens are expired.
 */
async function propagateRemoveToAllUsers(sharedPlaylistId, trackId) {
  const links = db.getPlaylistLinks(sharedPlaylistId);
  for (const link of links) {
    const user = db.getUser(link.user_id);
    if (!user || user.sync_status === 'token_revoked') continue;
    try {
      const token = await getAccessTokenForUser(user);
      await tidalRemoveTrack(link.tidal_playlist_id, trackId, token);
      db.markRemovalComplete(sharedPlaylistId, trackId, link.user_id);
      db.logTrackEvent(sharedPlaylistId, trackId, 'removed', null, 'propagation', link.user_id, null, null);
      console.log(`[poller] propagated -${trackId} → "${user.display_name || link.user_id}"`);
    } catch (err) {
      console.error(`[poller] propagate remove failed for "${link.user_id}": ${err.message}`);
      // Queue entry stays — poller will retry on next cycle
    }
  }
}

// ---------------------------------------------------------------------------
// Poll a single playlist link
// ---------------------------------------------------------------------------

async function pollPlaylist(link, accessToken, broadcastFn) {
  const tidalPlaylistId  = link.tidal_playlist_id;
  const sharedPlaylistId = link.shared_playlist_id;
  const userId           = link.user_id;
  const displayName      = link.tidal_playlist_name || tidalPlaylistId;

  const pollCounts = { newTracks: 0, removedTracks: 0, queuedRemovals: 0 };

  const { ids: tidalIds, truncated, nextCursor } =
    await tidalGetPlaylistTrackIds(tidalPlaylistId, accessToken, link.scan_cursor ?? null);

  const activeIds       = db.getActiveTrackIds(sharedPlaylistId);
  const pendingRemovals = db.getPendingRemovalsForUser(sharedPlaylistId, userId);

  // --- 1. Process pending removals ---
  // These are tracks deleted while this user's token was expired (or propagation failed).
  for (const trackId of pendingRemovals) {
    if (tidalIds.has(trackId)) {
      try {
        await tidalRemoveTrack(tidalPlaylistId, trackId, accessToken);
        db.markRemovalComplete(sharedPlaylistId, trackId, userId);
        db.logTrackEvent(sharedPlaylistId, trackId, 'removed', null, 'removal_queue', userId, null, null, 'processed from queue');
        pollCounts.queuedRemovals++;
        console.log(`[poller] removal queue: removed ${trackId} from "${displayName}"`);
      } catch (err) {
        // Leave queue entry in place — will retry next poll
        console.error(`[poller] removal queue: could not remove ${trackId} from "${displayName}": ${err.message}`);
      }
    } else {
      // Already gone from this user's Tidal — just confirm and clean up
      db.markRemovalComplete(sharedPlaylistId, trackId, userId);
      db.logTrackEvent(sharedPlaylistId, trackId, 'removed', null, 'removal_queue', userId, null, null, 'confirmed gone from Tidal');
      pollCounts.queuedRemovals++;
    }
  }

  // --- 2. Detect new tracks ---
  // A track is "new" if: not currently active AND not pending removal for this user.
  // Pending-removal tracks are excluded so a deleted track that's still in Tidal
  // (pending the retry above) cannot sneak back in as a new addition.
  const newTrackIds = [...tidalIds].filter(id => !activeIds.has(id) && !pendingRemovals.has(id));

  if (newTrackIds.length > 0) {
    console.log(`[poller] "${displayName}": ${newTrackIds.length} new track(s) detected`);
  }

  for (const trackId of newTrackIds) {
    const { title, artist } = await tidalGetTrackInfo(trackId, accessToken);
    const maxPos = db.getMaxPosition(sharedPlaylistId);
    const track  = db.addTrack(sharedPlaylistId, trackId, userId, maxPos + 1, title, artist);

    if (track) {
      // Clear any stale removal queue entries — track is being re-added intentionally
      db.clearRemovalQueue(sharedPlaylistId, trackId);

      db.logTrackEvent(sharedPlaylistId, trackId, 'added', userId, 'tidal_poll', null, title, artist);
      pollCounts.newTracks++;
      broadcastFn(sharedPlaylistId, {
        type:               'track_added',
        shared_playlist_id: sharedPlaylistId,
        tidal_track_id:     trackId,
        track_title:        title,
        track_artist:       artist,
        added_by:           userId,
        position:           track.position,
        timestamp:          Date.now(),
      });
      await propagateAddToOtherUsers(sharedPlaylistId, userId, trackId, title, artist);
    }
  }

  // --- 3. Tidal-side removal detection (full scans only) ---
  // If a track is active in DB but missing from this user's Tidal, and it was
  // added long enough ago that propagation should have settled, treat it as an
  // intentional removal by the user and propagate it to everyone else.
  if (!truncated) {
    const candidates = db.getTracksForRemovalDetection(sharedPlaylistId, link.id, REMOVAL_GRACE_PERIOD_SEC);
    for (const track of candidates) {
      const trackId = String(track.tidal_track_id);
      if (!tidalIds.has(trackId)) {
        console.log(`[poller] "${displayName}": Tidal-side removal detected for ${trackId}`);
        await handleTidalRemoval(sharedPlaylistId, trackId, userId, broadcastFn, track);
        pollCounts.removedTracks++;
      }
    }
  }

  // --- 4. Update pagination cursor and write poll log ---
  if (truncated && nextCursor) {
    db.setLinkCursor(link.id, nextCursor);
    console.log(`[poller] "${displayName}": paginated — cursor saved for next tick`);
    db.writePollLog(sharedPlaylistId, userId, tidalPlaylistId, 'paginated', pollCounts);
  } else {
    db.clearLinkCursor(link.id);
    db.writePollLog(sharedPlaylistId, userId, tidalPlaylistId, 'ok', pollCounts);
  }
}

/**
 * Handle a track that the user has removed from their Tidal playlist directly.
 * Soft-deletes the track in DB, writes removal queue entries for all other linked
 * users, broadcasts the removal, and attempts immediate propagation.
 */
async function handleTidalRemoval(sharedPlaylistId, trackId, detectedByUserId, broadcastFn, trackMeta) {
  db.removeTrack(sharedPlaylistId, trackId);
  // Queue entries for all OTHER users (current user's Tidal already confirmed empty)
  db.addToRemovalQueueAllUsers(sharedPlaylistId, trackId, detectedByUserId, detectedByUserId);

  db.logTrackEvent(
    sharedPlaylistId, trackId, 'removed', detectedByUserId, 'tidal_removal_detected',
    null, trackMeta.track_title, trackMeta.track_artist, 'detected missing from Tidal',
  );

  broadcastFn(sharedPlaylistId, {
    type:               'track_removed',
    shared_playlist_id: sharedPlaylistId,
    tidal_track_id:     trackId,
    removed_by:         detectedByUserId,
    timestamp:          Date.now(),
  });

  // Propagate immediately (best-effort; queue handles any failures)
  const links = db.getPlaylistLinks(sharedPlaylistId);
  for (const link of links) {
    if (link.user_id === detectedByUserId) continue;
    const user = db.getUser(link.user_id);
    if (!user || user.sync_status === 'token_revoked') continue;
    try {
      const token = await getAccessTokenForUser(user);
      await tidalRemoveTrack(link.tidal_playlist_id, trackId, token);
      db.markRemovalComplete(sharedPlaylistId, trackId, link.user_id);
      db.logTrackEvent(sharedPlaylistId, trackId, 'removed', null, 'propagation', link.user_id, trackMeta.track_title, trackMeta.track_artist);
      console.log(`[poller] tidal-removal propagated -${trackId} → "${user.display_name || link.user_id}"`);
    } catch (err) {
      console.error(`[poller] tidal-removal propagation failed for "${link.user_id}": ${err.message}`);
    }
  }
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
      db.writePollLog(link.shared_playlist_id, userId, link.tidal_playlist_id, 'error', {}, err.message.slice(0, 200));
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

  // Prune activity log entries older than 7 days, run every 6 hours
  const pruneEvents = () => {
    const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
    const result = db.pruneTrackEvents(cutoff);
    if (result.changes > 0) console.log(`[poller] pruned ${result.changes} old track event(s)`);
  };
  setTimeout(pruneEvents, 60_000); // first run after 1 minute
  setInterval(pruneEvents, 6 * 60 * 60 * 1000);
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
 * Pushes all existing shared playlist tracks into the user's Tidal playlist,
 * then triggers a normal poll to pick up any Tidal-only tracks they already have.
 */
async function initNewLink(link) {
  const { tidal_playlist_id: tidalPlaylistId, shared_playlist_id: sharedPlaylistId, user_id: userId } = link;
  const user = db.getUser(userId);
  if (!user) return;

  let accessToken;
  try {
    accessToken = await getAccessTokenForUser(user);
  } catch (err) {
    console.error(`[poller] initNewLink token error for "${user.display_name || userId}": ${err.message}`);
    return;
  }

  const existingTracks = db.getPlaylistTracks(sharedPlaylistId);
  const displayName    = link.tidal_playlist_name || tidalPlaylistId;

  if (existingTracks.length > 0) {
    console.log(`[poller] initNewLink: pushing ${existingTracks.length} track(s) → "${displayName}"`);
    const { ids: currentTidalIds } = await tidalGetPlaylistTrackIds(tidalPlaylistId, accessToken);
    // Don't push tracks that are pending removal for this user
    const pendingRemovals = db.getPendingRemovalsForUser(link.shared_playlist_id, userId);
    for (const track of existingTracks) {
      const id = String(track.tidal_track_id);
      if (pendingRemovals.has(id)) continue;
      if (!currentTidalIds.has(id)) {
        try {
          await tidalAddTrack(tidalPlaylistId, id, accessToken);
          db.logTrackEvent(link.shared_playlist_id, id, 'added', null, 'init_link', userId, track.track_title, track.track_artist);
        } catch (err) {
          console.warn(`[poller] initNewLink: could not add ${id}: ${err.message}`);
        }
        await new Promise(r => setTimeout(r, 300));
      }
    }
    console.log(`[poller] initNewLink: done for "${displayName}"`);
  }

  // Clear any stale cursor so the next poll starts fresh
  db.clearLinkCursor(link.id);
  // Poll immediately to merge any tracks the user already had in their Tidal
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

  const serverIds = db.getActiveTrackIds(sharedPlaylistId);
  let added = 0, merged = 0, duplicatesFixed = 0;

  for (const [id, count] of tidalCounts) {
    if (count > 1) {
      for (let i = 0; i < count - 1; i++) {
        try { await tidalRemoveTrack(tidalPlaylistId, id, accessToken); duplicatesFixed++; }
        catch (err) { console.warn(`[sync] could not remove Tidal duplicate ${id}: ${err.message}`); }
        await new Promise(r => setTimeout(r, 300));
      }
    }

    if (!serverIds.has(id)) {
      const { title, artist } = await tidalGetTrackInfo(id, accessToken);
      const maxPos = db.getMaxPosition(sharedPlaylistId);
      const track  = db.addTrack(sharedPlaylistId, id, userId, maxPos + 1, title, artist);
      if (track) {
        db.clearRemovalQueue(sharedPlaylistId, id);
        db.logTrackEvent(sharedPlaylistId, id, 'added', userId, 'force_sync', null, title, artist);
        if (_broadcastFn) {
          _broadcastFn(sharedPlaylistId, {
            type: 'track_added', shared_playlist_id: sharedPlaylistId,
            tidal_track_id: id, track_title: title, track_artist: artist,
            added_by: userId, position: track.position, timestamp: Date.now(),
          });
        }
        await propagateAddToOtherUsers(sharedPlaylistId, userId, id, title, artist);
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
};
