'use strict';

const client = require('prom-client');

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const wsActiveConnections = new client.Gauge({
  name:      'tidal_ws_active_connections',
  help:      'Authenticated WebSocket clients currently connected',
  registers: [register],
});

const tracksAddedTotal = new client.Counter({
  name:      'tidal_sync_tracks_added_total',
  help:      'Tracks added to a shared playlist by the poller',
  registers: [register],
});

const propagationsTotal = new client.Counter({
  name:      'tidal_sync_propagations_total',
  help:      'Track propagations pushed to other users Tidal playlists',
  registers: [register],
});

const pollCyclesTotal = new client.Counter({
  name:      'tidal_poll_cycles_total',
  help:      'Completed poller scheduler runs',
  registers: [register],
});

module.exports = { register, wsActiveConnections, tracksAddedTotal, propagationsTotal, pollCyclesTotal };
