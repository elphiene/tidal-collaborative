'use strict';

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const session = require('express-session');

const db     = require('./db');
const config = require('./config');
const api                        = require('./routes/api');
const { initWebSocket, broadcast } = require('./routes/ws');
const { startPoller }            = require('./poller');

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();

// Session middleware — must come before routes
const sessionParser = session({
  secret:            config.SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge:   30 * 24 * 60 * 60 * 1000, // 30 days
    // sameSite: 'lax' is the default; set secure: true if using HTTPS
  },
});

app.use(sessionParser);
app.use(cors());
app.use(express.json());

// REST API (must come before static files so /api routes are not shadowed)
app.use('/api', api);

// Serve web UI as static files
const webUiDir = path.join(__dirname, '../../web-ui');
app.use(express.static(webUiDir));

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

// Wire session to WebSocket upgrade so req.session is available on WS connections
const wss = initWebSocket(server, sessionParser);

// Start server-side Tidal polling (replaces extension alarms)
if (config.ENCRYPTION_KEY) {
  startPoller(broadcast);
} else {
  console.warn('[server] ENCRYPTION_KEY not set — poller disabled (tokens cannot be decrypted)');
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(signal) {
  console.log(`[server] ${signal} — shutting down…`);
  wss.close(() => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });

  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = { app, server }; // exported for testing
