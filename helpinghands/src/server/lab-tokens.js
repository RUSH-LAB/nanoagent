'use strict';
const crypto = require('crypto');

/**
 * The download token in Mochi Lab's one-line install (routes/lab.js): which
 * member it is for and until when, signed with the server's session secret,
 * so the server keeps nothing. `<user id, base64url>.<expiry, unix seconds>.<HMAC-SHA256, base64url>`,
 * the HMAC's key derived from the secret for this use alone.
 */
const TOKEN_MS = 60 * 60_000;
const TOKEN = /^([A-Za-z0-9_-]+)\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

const mac = (secret, payload) => crypto.createHmac('sha256', crypto.createHmac('sha256', secret).update('mochi-lab-download').digest())
  .update(payload).digest();

/** A token for `userId`, good for an hour from `now`. */
function signDownloadToken(secret, userId, now = Date.now()) {
  const payload = `${Buffer.from(userId).toString('base64url')}.${Math.floor((now + TOKEN_MS) / 1000)}`;
  return `${payload}.${mac(secret, payload).toString('base64url')}`;
}

/** The member `token` is for, or null when it is malformed, forged or expired. */
function verifyDownloadToken(secret, token, now = Date.now()) {
  const match = TOKEN.exec(String(token ?? ''));
  if (!match) return null;
  const [, user, expiry, signature] = match;
  if (!crypto.timingSafeEqual(Buffer.from(mac(secret, `${user}.${expiry}`).toString('base64url')), Buffer.from(signature))) return null;
  if (Number(expiry) * 1000 <= now) return null;
  return Buffer.from(user, 'base64url').toString() || null;
}

module.exports = {signDownloadToken, verifyDownloadToken, TOKEN_MS};
