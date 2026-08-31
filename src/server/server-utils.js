'use strict';

const path = require('path');
const crypto = require('crypto');

const ALLOWED_EXTS = ['.md', '.mdx'];
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'];
const MAX_BODY_SIZE = 10 * 1024 * 1024;
const MAX_TEXT_LENGTH = 10000;
const MAX_PRESENCE_FILES = 500;
const MAX_PRESENCE_USERS_PER_FILE = 50;

function isValidFilePath(filePath) {
  if (!filePath) return false;
  if (filePath.length > 500) return false;
  const normalized = path.normalize(filePath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return false;
  if (!normalized.startsWith('content/') && !normalized.startsWith('content' + path.sep)) return false;
  if (!ALLOWED_EXTS.some(ext => normalized.endsWith(ext))) return false;
  const filename = path.basename(normalized);
  if (filename.length > 200) return false;
  return true;
}

function isValidDir(dirPath) {
  if (!dirPath) return false;
  const normalized = path.normalize(dirPath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return false;
  return normalized === 'content' || normalized.startsWith('content/') || normalized.startsWith('content' + path.sep);
}

function sanitizeText(str) {
  if (typeof str !== 'string') return '';
  return str.slice(0, MAX_TEXT_LENGTH);
}

// Parse a numeric query parameter, clamping to `max` and falling back to `def`
// when the value is absent or non-numeric. Without the fallback a stray
// `?limit=abc` parses to NaN, which silently breaks the downstream slicing,
// ranking, and date math in the route handlers that call this (collapsing a
// page to empty, returning an unbounded list, or throwing on an Invalid Date).
// Absent and valid numeric values keep their previous behavior.
function numericParam(raw, def, max) {
  const n = parseInt(raw, 10);
  return Math.min(Number.isNaN(n) ? def : n, max);
}

function makeRateLimiter() {
  const rateLimits = {};
  function rateLimit(key, maxPerMinute) {
    const now = Date.now();
    if (!rateLimits[key]) rateLimits[key] = [];
    rateLimits[key] = rateLimits[key].filter(t => now - t < 60000);
    if (rateLimits[key].length >= maxPerMinute) return false;
    rateLimits[key].push(now);
    return true;
  }
  rateLimit._store = rateLimits;
  return rateLimit;
}

function makeCache() {
  const store = {};
  function cached(key, ttlMs, fn) {
    const entry = store[key];
    if (entry && Date.now() - entry.time < ttlMs) return entry.data;
    const data = fn();
    store[key] = {data, time: Date.now()};
    return data;
  }
  function invalidateCache(pattern) {
    for (const key of Object.keys(store)) {
      if (!pattern || key.includes(pattern)) delete store[key];
    }
  }
  cached.invalidate = invalidateCache;
  cached._store = store;
  return cached;
}

function makePresenceStore() {
  const presenceStore = {};

  function cleanStalePresence() {
    const now = Date.now();
    const STALE_MS = 30000;
    for (const filePath of Object.keys(presenceStore)) {
      const users = presenceStore[filePath];
      for (const userId of Object.keys(users)) {
        if (now - users[userId].lastSeen > STALE_MS) {
          delete users[userId];
        }
      }
      if (Object.keys(users).length === 0) {
        delete presenceStore[filePath];
      }
    }
    const fileKeys = Object.keys(presenceStore);
    if (fileKeys.length > MAX_PRESENCE_FILES) {
      fileKeys.slice(MAX_PRESENCE_FILES).forEach(k => delete presenceStore[k]);
    }
  }

  return {store: presenceStore, clean: cleanStalePresence};
}

module.exports = {
  ALLOWED_EXTS,
  IMAGE_EXTS,
  MAX_BODY_SIZE,
  MAX_TEXT_LENGTH,
  MAX_PRESENCE_FILES,
  MAX_PRESENCE_USERS_PER_FILE,
  isValidFilePath,
  isValidDir,
  sanitizeText,
  numericParam,
  makeRateLimiter,
  makeCache,
  makePresenceStore,
};
