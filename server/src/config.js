'use strict';

const path = require('path');

module.exports = {
  PORT:           parseInt(process.env.PORT, 10) || 3000,
  NODE_ENV:       process.env.NODE_ENV || 'development',
  // Default puts data/ at the repo root regardless of CWD
  DB_PATH:        process.env.DB_PATH || path.join(__dirname, '../../data/db.sqlite'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || null,
  SESSION_SECRET: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
};
