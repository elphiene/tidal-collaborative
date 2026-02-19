'use strict';

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const db      = require('./db');
const config  = require('./config');
const api                  = require('./routes/api');
const { initWebSocket }    = require('./routes/ws');

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();

app.use(cors());
app.use(express.json());

// Serve web UI as static files
const webUiDir = path.join(__dirname, '../../web-ui');
app.use(express.static(webUiDir));

// REST API
app.use('/api', api);

// SPA fallback — serve index.html for any non-API route
app.get('*', (_req, res) => {
  res.sendFile(path.join(webUiDir, 'index.html'));
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

db.init();

const server = app.listen(config.PORT, '0.0.0.0', () => {
  console.log(
    `[server] listening on http://0.0.0.0:${config.PORT}  (${config.NODE_ENV})`,
  );
});

const wss = initWebSocket(server);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(signal) {
  console.log(`[server] ${signal} — shutting down…`);
  // Close WebSocket server first (stops accepting new connections)
  wss.close(() => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });

  // Force-exit if clients don't disconnect within 5 s
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = { app, server }; // exported for testing
