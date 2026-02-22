'use strict';

const { createCipheriv, createDecipheriv, randomBytes } = require('crypto');

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

module.exports = { encrypt, decrypt };
