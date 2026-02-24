'use strict';

const db                     = require('./db');
const { encrypt, decrypt }   = require('./crypto');
const {
  refreshTokens,
  tidalGetPlaylistTrackIds,
  tidalGetTrackInfo,
  tidalAddTrack,
  tidalRemoveTrack,
} = require('./tidal');

// ---------------------------------------------------------------------------
// Known track state — in-memory, reset on server start.
// Map<tidalPlaylistId, Set<trackId>>
// ---------------------------------------------------------------------------
const knownTracks = new Map();

let pollInProgress = false;

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

async function pollAll(broadcastFn) {
  if (pollInProgress) {
    console.log('[poller] already in progress — skipping');
    return;
  }
  pollInProgress = true;

  try {
    const users = db.getAllUsersWithLinks();
    if (users.length === 0) return;

    console.log(`[poller] polling ${users.length} user(s) with linked playlists`);

    for (const user of users) {
      await pollUser(user, broadcastFn);
    }
  } catch (err) {
    console.error('[poller] unexpected error:', err.message);
  } finally {
    pollInProgress = false;
  }
}

async function pollUser(user, broadcastFn) {
  let accessToken;

  try {
    // Refresh token if within 5 minutes of expiry
    if (user.token_expires_at - Date.now() < 5 * 60 * 1000) {
      if (!user.refresh_token_enc) throw new Error('TIDAL_SESSION_DEAD');
      console.log(`[poller] refreshing token for user ${user.user_id}`);
      const refreshToken = decrypt(user.refresh_token_enc);
      const tokens       = await refreshTokens(refreshToken);
      db.upsertUser(
        user.user_id,
        user.display_name,
        encrypt(tokens.accessToken),
        encrypt(tokens.refreshToken),
        tokens.expiresAt,
      );
      accessToken = tokens.accessToken;
    } else {
      accessToken = decrypt(user.access_token_enc);
    }
  } catch (err) {
    if (err.message === 'TIDAL_SESSION_DEAD') {
      console.warn(`[poller] session dead for user ${user.user_id} — removing user`);
      db.deleteUser(user.user_id);
    } else {
      console.error(`[poller] token error for user ${user.user_id}: ${err.message}`);
    }
    return;
  }

  const links = db.getUserLinks(user.user_id);

  for (let i = 0; i < links.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 500));
    try {
      await pollPlaylist(links[i], user.user_id, accessToken, broadcastFn);
    } catch (err) {
      console.error(
        `[poller] poll failed for user=${user.user_id} tidalPlaylist=${links[i].tidal_playlist_id}: ${err.message}`,
      );
    }
  }
}

/**
 * Get a valid access token for any user, refreshing if needed.
 */
async function getAccessTokenForUser(user) {
  if (user.token_expires_at - Date.now() < 5 * 60 * 1000) {
    if (!user.refresh_token_enc) throw new Error('TIDAL_SESSION_DEAD');
    const tokens = await refreshTokens(decrypt(user.refresh_token_enc));
    db.upsertUser(
      user.user_id, user.display_name,
      encrypt(tokens.accessToken), encrypt(tokens.refreshToken), tokens.expiresAt,
    );
    return tokens.accessToken;
  }
  if (!user.access_token_enc) throw new Error('TIDAL_SESSION_DEAD');
  return decrypt(user.access_token_enc);
}

/**
 * Propagate a track add or remove to all other users linked to the same shared playlist.
 * Updates knownTracks for each target playlist so the next poll doesn't re-detect the change.
 */
async function propagateToOtherUsers(sharedPlaylistId, excludeUserId, trackId, action) {
  const links = db.getPlaylistLinks(sharedPlaylistId);
  for (const link of links) {
    if (link.user_id === excludeUserId) continue;
    try {
      const user = db.getUser(link.user_id);
      if (!user) continue;
      const token = await getAccessTokenForUser(user);

      if (action === 'add') {
        await tidalAddTrack(link.tidal_playlist_id, trackId, token);
        console.log(`[poller] propagated add ${trackId} → user=${link.user_id} playlist=${link.tidal_playlist_id}`);
      } else {
        await tidalRemoveTrack(link.tidal_playlist_id, trackId, token);
        console.log(`[poller] propagated remove ${trackId} → user=${link.user_id} playlist=${link.tidal_playlist_id}`);
      }

      // Update knownTracks so the next poll doesn't re-detect this as a change
      const known = knownTracks.get(link.tidal_playlist_id);
      if (known) {
        if (action === 'add') known.add(String(trackId));
        else known.delete(String(trackId));
      }
    } catch (err) {
      console.error(`[poller] propagate ${action} to user=${link.user_id}: ${err.message}`);
    }
  }
}

async function pollPlaylist(link, userId, accessToken, broadcastFn) {
  const tidalPlaylistId  = link.tidal_playlist_id;
  const sharedPlaylistId = link.shared_playlist_id;

  const currentIds = await tidalGetPlaylistTrackIds(tidalPlaylistId, accessToken);
  const known      = knownTracks.get(tidalPlaylistId) ?? new Set();

  const added   = [...currentIds].filter((id) => !known.has(id));
  const removed = [...known].filter((id) => !currentIds.has(id));

  if (added.length > 0 || removed.length > 0) {
    console.log(
      `[poller] ${tidalPlaylistId}: +${added.length} -${removed.length} tracks (user=${userId})`,
    );
  }

  for (const trackId of added) {
    // Fetch track metadata (title, artist) — fails gracefully with nulls
    const { title, artist } = await tidalGetTrackInfo(trackId, accessToken);

    const maxPos = db.getMaxPosition(sharedPlaylistId);
    const track  = db.addTrack(sharedPlaylistId, trackId, userId, maxPos + 1, title, artist);
    if (track) {
      // Only broadcast + propagate if addTrack actually inserted (not already active)
      broadcastFn(sharedPlaylistId, {
        type:               'track_added',
        shared_playlist_id: sharedPlaylistId,
        tidal_track_id:     trackId,
        track_title:        title,
        track_artist:       artist,
        added_by:           userId,
        position:           track.position,
        timestamp:          Date.now(),
      }, userId);

      await propagateToOtherUsers(sharedPlaylistId, userId, trackId, 'add');
    }
  }

  for (const trackId of removed) {
    const result = db.removeTrack(sharedPlaylistId, trackId);
    if (result.changes > 0) {
      broadcastFn(sharedPlaylistId, {
        type:               'track_removed',
        shared_playlist_id: sharedPlaylistId,
        tidal_track_id:     trackId,
        removed_by:         userId,
        timestamp:          Date.now(),
      }, userId);

      await propagateToOtherUsers(sharedPlaylistId, userId, trackId, 'remove');
    }
  }

  knownTracks.set(tidalPlaylistId, currentIds);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/**
 * Start the polling interval.
 * @param {Function} broadcastFn  (sharedPlaylistId, message, excludeUserId) => void
 * @param {number}   intervalMs   default 60 seconds
 */
let _broadcastFn = null;

function startPoller(broadcastFn, intervalMs = 60_000) {
  _broadcastFn = broadcastFn;
  console.log(`[poller] starting — interval ${intervalMs / 1000}s`);
  // Initial poll shortly after startup to seed known state
  setTimeout(() => pollAll(broadcastFn).catch((err) => console.error('[poller]', err.message)), 5_000);
  setInterval(() => {
    pollAll(broadcastFn).catch((err) => console.error('[poller]', err.message));
  }, intervalMs);
}

/** Trigger an immediate poll (e.g. after a new playlist link is created). */
function pollNow() {
  if (_broadcastFn) {
    pollAll(_broadcastFn).catch((err) => console.error('[poller] pollNow:', err.message));
  }
}

/**
 * Called when a new playlist link is created.
 * Pushes all existing shared playlist tracks to the user's Tidal playlist,
 * then seeds knownTracks so the first poll doesn't re-detect them as new.
 * After seeding, triggers a normal poll to pick up any tracks the user already
 * had in their Tidal playlist (those get merged into the shared playlist).
 */
async function initNewLink(link) {
  const { tidal_playlist_id: tidalPlaylistId, shared_playlist_id: sharedPlaylistId, user_id: userId } = link;

  const user = db.getUser(userId);
  if (!user) return;

  let accessToken;
  try {
    accessToken = await getAccessTokenForUser(user);
  } catch (err) {
    console.error(`[poller] initNewLink: token error for user ${userId}: ${err.message}`);
    return;
  }

  const existingTracks = db.getPlaylistTracks(sharedPlaylistId);

  if (existingTracks.length === 0) {
    // Nothing to seed — let the normal poll handle it
    knownTracks.set(tidalPlaylistId, new Set());
    return;
  }

  console.log(`[poller] initNewLink: pushing ${existingTracks.length} existing tracks to ${tidalPlaylistId} (user=${userId})`);

  const seededIds = new Set();
  for (const track of existingTracks) {
    try {
      await tidalAddTrack(tidalPlaylistId, track.tidal_track_id, accessToken);
    } catch (err) {
      // Track may already be in the playlist — not fatal
      console.warn(`[poller] initNewLink: could not add ${track.tidal_track_id}: ${err.message}`);
    }
    // Always seed the ID so the next poll doesn't re-detect it as a new addition
    seededIds.add(String(track.tidal_track_id));
  }

  knownTracks.set(tidalPlaylistId, seededIds);
  console.log(`[poller] initNewLink: seeded knownTracks[${tidalPlaylistId}] with ${seededIds.size} IDs`);
}

module.exports = { startPoller, pollNow, initNewLink };
