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
async function propagateAddToOtherUsers(sharedPlaylistId, excludeUserId, trackId) {
  const links = db.getPlaylistLinks(sharedPlaylistId);
  for (const link of links) {
    if (link.user_id === excludeUserId) continue;
    // Abort if the track was deleted while we were iterating — prevents a Tidal
    // add completing *after* propagateRemoveToAllUsers, which would leave a
    // phantom duplicate in the target Tidal playlist.
    if (!db.getActiveTrackIds(sharedPlaylistId).has(trackId)) {
      console.log(`[poller] abort propagate +${trackId} — track deleted mid-propagation`);
      return;
    }
    const user = db.getUser(link.user_id);
    if (!user || user.sync_status === 'token_revoked') continue;
    try {
      const token = await getAccessTokenForUser(user);
      await tidalAddTrack(link.tidal_playlist_id, trackId, token);
      console.log(`[poller] propagated +${trackId} → "${user.display_name || link.user_id}"`);
    } catch (err) {
      console.error(`[poller] propagate add failed for "${link.user_id}": ${err.message}`);
    }
  }
}

/**
 * Remove a track from ALL users' Tidal playlists linked to this shared playlist.
 * Called when a track is deleted via the webapp.
 */
async function propagateRemoveToAllUsers(sharedPlaylistId, trackId) {
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
}

// ---------------------------------------------------------------------------
// Poll a single playlist link
// ---------------------------------------------------------------------------

async function pollPlaylist(link, accessToken, broadcastFn) {
  const tidalPlaylistId  = link.tidal_playlist_id;
  const sharedPlaylistId = link.shared_playlist_id;
  const userId           = link.user_id;
  const displayName      = link.tidal_playlist_name || tidalPlaylistId;

  // Resume from persisted cursor (null = start from beginning)
  const { ids: tidalIds, truncated, nextCursor } =
    await tidalGetPlaylistTrackIds(tidalPlaylistId, accessToken, link.scan_cursor ?? null);

  // Exclude active tracks (already synced) and tracks deleted within the last
  // 10 minutes (grace period covers the async Tidal propagation window while
  // still allowing a genuinely re-added track to come back after that time).
  const activeIds  = db.getActiveTrackIds(sharedPlaylistId);
  const deletedIds = db.getRecentlyDeletedTrackIds(sharedPlaylistId);
  const newTrackIds = [...tidalIds].filter(id => !activeIds.has(id) && !deletedIds.has(id));

  if (newTrackIds.length > 0) {
    console.log(`[poller] "${displayName}": ${newTrackIds.length} new track(s) detected`);
  }

  for (const trackId of newTrackIds) {
    const { title, artist } = await tidalGetTrackInfo(trackId, accessToken);
    const maxPos = db.getMaxPosition(sharedPlaylistId);
    // INSERT OR IGNORE — unique partial index makes this atomic; returns null if already active
    const track = db.addTrack(sharedPlaylistId, trackId, userId, maxPos + 1, title, artist);

    if (track) {
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
      await propagateAddToOtherUsers(sharedPlaylistId, userId, trackId);
    }
  }

  // Persist cursor or mark scan complete
  if (truncated && nextCursor) {
    db.setLinkCursor(link.id, nextCursor);
    console.log(`[poller] "${displayName}": paginated — cursor saved for next tick`);
  } else {
    db.clearLinkCursor(link.id);
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
    for (const track of existingTracks) {
      const id = String(track.tidal_track_id);
      if (!currentTidalIds.has(id)) {
        try {
          await tidalAddTrack(tidalPlaylistId, id, accessToken);
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
        await propagateAddToOtherUsers(sharedPlaylistId, userId, id);
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
