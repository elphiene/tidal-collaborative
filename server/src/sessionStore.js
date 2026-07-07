'use strict';

const { Store } = require('express-session');
const db = require('./db');

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // matches the cookie maxAge in index.js

/**
 * express-session Store backed by better-sqlite3 (AUDIT.md M4). Replaces the
 * default MemoryStore, which drops every session on restart/redeploy and
 * leaks memory by design. No new dependency — reuses the DB already open.
 */
class SqliteSessionStore extends Store {
  get(sid, callback) {
    try {
      const row = db.getSession(sid);
      if (!row || row.expires_at < Date.now()) return callback(null, null);
      callback(null, JSON.parse(row.data));
    } catch (err) {
      callback(err);
    }
  }

  set(sid, session, callback) {
    try {
      const maxAge = session.cookie?.maxAge ?? DEFAULT_TTL_MS;
      db.upsertSession(sid, JSON.stringify(session), Date.now() + maxAge);
      callback?.(null);
    } catch (err) {
      callback?.(err);
    }
  }

  touch(sid, session, callback) {
    this.set(sid, session, callback);
  }

  destroy(sid, callback) {
    try {
      db.deleteSession(sid);
      callback?.(null);
    } catch (err) {
      callback?.(err);
    }
  }
}

module.exports = SqliteSessionStore;
