'use strict';

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const session = require('express-session');
const crypto  = require('crypto');

const db     = require('./db');
const config = require('./config');

// ---------------------------------------------------------------------------
// Startup — DB must init first so we can load/generate secrets
// ---------------------------------------------------------------------------

db.init();

// ENCRYPTION_KEY: env var → DB → generate new
let encKey = process.env.ENCRYPTION_KEY || db.getSetting('encryption_key');
if (!encKey) {
  encKey = crypto.randomBytes(32).toString('hex');
  db.setSetting('encryption_key', encKey);
  console.log('[server] Generated new ENCRYPTION_KEY (stored in DB)');
}
process.env.ENCRYPTION_KEY = encKey; // crypto.js reads from process.env

// SESSION_SECRET: env var → DB → generate new
let sessSecret = process.env.SESSION_SECRET || db.getSetting('session_secret');
if (!sessSecret || sessSecret === 'dev-secret-change-in-production') {
  sessSecret = crypto.randomBytes(32).toString('hex');
  db.setSetting('session_secret', sessSecret);
  console.log('[server] Generated new SESSION_SECRET (stored in DB)');
}

// Routes are loaded after secrets are set so any module-level logic
// that depends on process.env runs with the correct values.
const api                          = require('./routes/api');
const { initWebSocket, broadcast } = require('./routes/ws');
const { startPoller }              = require('./poller');

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();

// Session middleware — must come before routes
const sessionParser = session({
  secret:            sessSecret,
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

const server = app.listen(config.PORT, '0.0.0.0', () => {
  console.log(
    `[server] listening on http://0.0.0.0:${config.PORT}  (${config.NODE_ENV})`,
  );
});

// Wire session to WebSocket upgrade so req.session is available on WS connections
const wss = initWebSocket(server, sessionParser);

// Start server-side Tidal polling — encryption key is always set at this point
startPoller(broadcast);

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
