'use strict';

const { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } = require('crypto');

const ALGO = 'aes-256-gcm';

function getKey() {
  const k = process.env.ENCRYPTION_KEY;
  if (!k || k.length !== 64) throw new Error('ENCRYPTION_KEY must be 64 hex chars');
  return Buffer.from(k, 'hex');
}

/**
 * Encrypt a plaintext string.
 * Returns "<iv_hex>:<ciphertext_hex>:<authtag_hex>"
 */
function encrypt(plaintext) {
  const iv     = randomBytes(12);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${enc.toString('hex')}:${cipher.getAuthTag().toString('hex')}`;
}

/**
 * Decrypt a stored string produced by encrypt().
 */
function decrypt(stored) {
  const [ivHex, encHex, tagHex] = stored.split(':');
  const d = createDecipheriv(ALGO, getKey(), Buffer.from(ivHex, 'hex'));
  d.setAuthTag(Buffer.from(tagHex, 'hex'));
  return d.update(Buffer.from(encHex, 'hex')).toString('utf8') + d.final('utf8');
}

/**
 * Hash a short secret (e.g. the admin PIN) for storage.
 * Returns "<salt_hex>:<hash_hex>".
 */
function hashPin(pin) {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/**
 * Verify a secret against a hashPin() output. Timing-safe.
 */
function verifyPinHash(pin, stored) {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt     = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual   = scryptSync(pin, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

module.exports = { encrypt, decrypt, hashPin, verifyPinHash };
