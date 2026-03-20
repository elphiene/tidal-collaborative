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
// Known track state — in-memory, reset on server start.
// Map<tidalPlaylistId, Set<trackId>>
// ---------------------------------------------------------------------------
const knownTracks  = new Map();
// Progressive scan cursors for large playlists.
// Map<tidalPlaylistId, nextCursor> — null / absent means start from beginning.
const scanOffsets  = new Map();
// Playlists currently being seeded by initNewLink — poller skips these.
const initializingPlaylists = new Set();

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
  const userName = user.display_name || user.user_id;
  console.log(`[poller] pollUser start: user="${userName}" tokenExpiresIn=${Math.round((user.token_expires_at - Date.now()) / 1000)}s`);

  try {
    // Refresh token if within 5 minutes of expiry
    if (user.token_expires_at - Date.now() < 5 * 60 * 1000) {
      if (!user.refresh_token_enc) throw new Error('TIDAL_SESSION_DEAD');
      console.log(`[poller] refreshing token for "${userName}"`);
      const refreshToken = decrypt(user.refresh_token_enc);
      const tokens       = await refreshTokens(refreshToken);
      db.upsertUser(
        user.user_id,
        user.display_name,
        encrypt(tokens.accessToken),
        tokens.refreshToken ? encrypt(tokens.refreshToken) : user.refresh_token_enc,
        tokens.expiresAt,
      );
      accessToken = tokens.accessToken;
    } else {
      accessToken = decrypt(user.access_token_enc);
    }
  } catch (err) {
    console.warn(`[poller] token unusable for "${userName}" (${err.message}) — marking dead, keeping data`);
    db.markUserTokenDead(user.user_id);
    return;
  }

  const links = db.getUserLinks(user.user_id);
  console.log(`[poller] user="${userName}": polling ${links.length} playlist(s)`);

  for (let i = 0; i < links.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 500));
    const plName = links[i].tidal_playlist_name || links[i].tidal_playlist_id;
    if (initializingPlaylists.has(links[i].tidal_playlist_id)) {
      console.log(`[poller] user="${userName}": skipping "${plName}" — initNewLink in progress`);
      continue;
    }
    console.log(`[poller] user="${userName}": starting playlist "${plName}"`);
    try {
      await pollPlaylist(links[i], user.user_id, accessToken, broadcastFn);
      console.log(`[poller] user="${userName}": finished playlist "${plName}"`);
    } catch (err) {
      console.error(
        `[poller] poll failed for user="${userName}" tidalPlaylist="${plName}": ${err.message}`,
      );
    }
  }

  // Backfill missing track metadata (fires once per server run; retries if incomplete)
  if (!_backfillDone) {
    _backfillDone = true;
    backfillTrackMetadata(accessToken).catch((err) =>
      console.warn('[poller] backfill error:', err.message)
    );
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
      encrypt(tokens.accessToken),
      tokens.refreshToken ? encrypt(tokens.refreshToken) : user.refresh_token_enc,
      tokens.expiresAt,
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

      const linkUserName = user.display_name || link.user_id;
      const linkPlName   = link.tidal_playlist_name || link.tidal_playlist_id;
      if (action === 'add') {
        const known = knownTracks.get(link.tidal_playlist_id);
        if (known?.has(String(trackId))) {
          console.log(`[poller] skipping duplicate add ${trackId} → user="${linkUserName}" (already in playlist)`);
          continue;
        }
        await tidalAddTrack(link.tidal_playlist_id, trackId, token);
        console.log(`[poller] propagated add ${trackId} → user="${linkUserName}" playlist="${linkPlName}"`);
        if (known) known.add(String(trackId));
      } else {
        await tidalRemoveTrack(link.tidal_playlist_id, trackId, token);
        console.log(`[poller] propagated remove ${trackId} → user="${linkUserName}" playlist="${linkPlName}"`);
        const known = knownTracks.get(link.tidal_playlist_id);
        if (known) known.delete(String(trackId));
      }
    } catch (err) {
      console.error(`[poller] propagate ${action} to user="${link.user_id}": ${err.message}`);
    }
  }
}

async function pollPlaylist(link, userId, accessToken, broadcastFn) {
  const tidalPlaylistId  = link.tidal_playlist_id;
  const sharedPlaylistId = link.shared_playlist_id;

  const startCursor   = scanOffsets.get(tidalPlaylistId) ?? null;
  const isPartialScan = startCursor !== null;

  const { ids: currentIds, truncated, nextCursor } =
    await tidalGetPlaylistTrackIds(tidalPlaylistId, accessToken, startCursor);

  const known = knownTracks.get(tidalPlaylistId) ?? new Set();

  const added = [...currentIds].filter((id) => !known.has(id));
  // Only detect removals on a complete scan from the very beginning
  const removed = (truncated || isPartialScan) ? [] : [...known].filter((id) => !currentIds.has(id));

  if (added.length > 0 || removed.length > 0) {
    console.log(
      `[poller] "${link.tidal_playlist_name || tidalPlaylistId}": +${added.length} -${removed.length} tracks`,
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

  // Always merge fetched IDs into known — only replace when we completed a full scan from offset 0
  if (!truncated && !isPartialScan) {
    knownTracks.set(tidalPlaylistId, currentIds);
  } else {
    const merged = knownTracks.get(tidalPlaylistId) ?? new Set();
    for (const id of currentIds) merged.add(id);
    knownTracks.set(tidalPlaylistId, merged);
  }

  // Advance (or reset) the scan position for next cycle
  if (truncated) {
    scanOffsets.set(tidalPlaylistId, nextCursor);
  } else {
    scanOffsets.delete(tidalPlaylistId);
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/**
 * Start the polling interval.
 * @param {Function} broadcastFn  (sharedPlaylistId, message, excludeUserId) => void
 * @param {number}   intervalMs   default 60 seconds
 */
let _broadcastFn  = null;
let _backfillDone = false;

/**
 * Fetch title/artist from Tidal for any tracks in the DB with null metadata.
 * Fires once per server run (or retries next cycle if some tracks failed).
 */
async function backfillTrackMetadata(accessToken) {
  const tracks = db.getTracksWithNullMetadata();
  if (tracks.length === 0) return;

  console.log(`[poller] backfilling metadata for ${tracks.length} track(s)…`);
  let filled = 0;
  for (const track of tracks) {
    const { title, artist } = await tidalGetTrackInfo(String(track.tidal_track_id), accessToken);
    if (title || artist) {
      db.updateTrackMetadata(track.tidal_track_id, title, artist);
      filled++;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`[poller] backfill complete: ${filled}/${tracks.length} tracks updated`);
  if (filled < tracks.length) _backfillDone = false; // retry next cycle if incomplete
}

function seedKnownTracksFromDB() {
  const users = db.getAllUsersWithLinks();
  for (const user of users) {
    const links = db.getUserLinks(user.user_id);
    for (const link of links) {
      const tracks = db.getPlaylistTracks(link.shared_playlist_id);
      const ids = new Set(tracks.map((t) => String(t.tidal_track_id)));
      knownTracks.set(link.tidal_playlist_id, ids);
    }
  }
  console.log(`[poller] seeded knownTracks for ${knownTracks.size} playlist(s) from DB`);
}

function startPoller(broadcastFn, intervalMs = 60_000) {
  _broadcastFn = broadcastFn;
  seedKnownTracksFromDB();
  console.log(`[poller] starting — interval ${intervalMs / 1000}s`);
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

  initializingPlaylists.add(tidalPlaylistId);

  let accessToken;
  try {
    accessToken = await getAccessTokenForUser(user);
  } catch (err) {
    console.error(`[poller] initNewLink: token error for "${user?.display_name || userId}": ${err.message}`);
    initializingPlaylists.delete(tidalPlaylistId);
    return;
  }

  const existingTracks = db.getPlaylistTracks(sharedPlaylistId);

  if (existingTracks.length === 0) {
    // Nothing to seed — let the normal poll handle it
    knownTracks.set(tidalPlaylistId, new Set());
    initializingPlaylists.delete(tidalPlaylistId);
    return;
  }

  console.log(`[poller] initNewLink: pushing ${existingTracks.length} existing tracks to "${link.tidal_playlist_name || tidalPlaylistId}" for "${user.display_name || userId}"`);

  const { ids: existingIds } = await tidalGetPlaylistTrackIds(tidalPlaylistId, accessToken);

  const seededIds = new Set();
  for (const track of existingTracks) {
    const id = String(track.tidal_track_id);
    if (!existingIds.has(id)) {
      try {
        await tidalAddTrack(tidalPlaylistId, id, accessToken);
      } catch (err) {
        console.warn(`[poller] initNewLink: could not add ${id}: ${err.message}`);
      }
    }
    seededIds.add(id);
  }

  knownTracks.set(tidalPlaylistId, seededIds);
  initializingPlaylists.delete(tidalPlaylistId);
  console.log(`[poller] initNewLink: seeded "${link.tidal_playlist_name || tidalPlaylistId}" with ${seededIds.size} IDs`);
}

/**
 * Force-sync a user's Tidal playlist using a bidirectional merge.
 * - Tidal-only tracks → merged into server DB + propagated to other users
 * - Server-only tracks → added to Tidal
 * - Duplicates in Tidal → excess copies removed
 * Updates knownTracks and clears scanOffsets so the next normal poll starts clean.
 *
 * @param {{ tidal_playlist_id: string, shared_playlist_id: number, user_id: number }} link
 * @param {string} accessToken
 * @returns {{ added: number, merged: number, duplicatesFixed: number }}
 */
async function syncPlaylistForLink(link, accessToken) {
  const { tidal_playlist_id: tidalPlaylistId, shared_playlist_id: sharedPlaylistId, user_id: userId } = link;

  // Fetch Tidal playlist as array (preserves duplicates)
  const tidalList = await tidalGetPlaylistTrackList(tidalPlaylistId, accessToken);

  // Count occurrences in Tidal
  const tidalCounts = new Map();
  for (const id of tidalList) tidalCounts.set(id, (tidalCounts.get(id) ?? 0) + 1);

  // Current server state (mutable — updated as we merge Tidal-only tracks in)
  const serverTracks = db.getPlaylistTracks(sharedPlaylistId);
  const serverIds    = new Set(serverTracks.map((t) => String(t.tidal_track_id)));

  let added = 0, merged = 0, duplicatesFixed = 0;

  // Pass 1: Walk Tidal tracks
  //   - Duplicates → remove excess copies
  //   - Tidal-only tracks → merge into server (same as what a normal poll does)
  for (const [id, tidalCount] of tidalCounts) {
    if (tidalCount > 1) {
      const excess = tidalCount - 1;
      for (let i = 0; i < excess; i++) {
        try {
          await tidalRemoveTrack(tidalPlaylistId, id, accessToken);
          duplicatesFixed++;
        } catch (err) {
          console.warn(`[sync] could not remove duplicate ${id}: ${err.message}`);
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    if (!serverIds.has(id)) {
      const { title, artist } = await tidalGetTrackInfo(id, accessToken);
      const maxPos = db.getMaxPosition(sharedPlaylistId);
      const track  = db.addTrack(sharedPlaylistId, id, userId, maxPos + 1, title, artist);
      if (track) {
        if (_broadcastFn) {
          _broadcastFn(sharedPlaylistId, {
            type:               'track_added',
            shared_playlist_id: sharedPlaylistId,
            tidal_track_id:     id,
            track_title:        title,
            track_artist:       artist,
            added_by:           userId,
            position:           track.position,
            timestamp:          Date.now(),
          }, userId);
        }
        await propagateToOtherUsers(sharedPlaylistId, userId, id, 'add');
        serverIds.add(id);
        merged++;
      }
    }
  }

  // Pass 2: Add to Tidal any server tracks not currently in Tidal
  for (const id of serverIds) {
    if (!tidalCounts.has(id)) {
      try {
        await tidalAddTrack(tidalPlaylistId, id, accessToken);
        added++;
      } catch (err) {
        console.warn(`[sync] could not add ${id}: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // Update knownTracks to mirror final merged state; clear progressive scan offset
  knownTracks.set(tidalPlaylistId, new Set(serverIds));
  scanOffsets.delete(tidalPlaylistId);

  console.log(`[sync] ${tidalPlaylistId}: +${added} to Tidal, +${merged} merged to server, ~${duplicatesFixed} dupes fixed`);
  return { added, merged, duplicatesFixed };
}

module.exports = { startPoller, pollNow, initNewLink, getAccessTokenForUser, syncPlaylistForLink };
