'use strict';

const path = require('path');
const crypto = require('crypto');
// The content-path to site-URL rule, shared with the browser. It lives in
// src/utils because both halves need it and it belongs to neither; re-exported
// from here so route modules keep taking their helpers from ctx rather than
// growing an import into the client tree.
const {contentPathToUrl} = require('../utils/paths');

const ALLOWED_EXTS = ['.md', '.mdx'];
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'];
const MAX_BODY_SIZE = 10 * 1024 * 1024;
const MAX_TEXT_LENGTH = 10000;
const MAX_PRESENCE_FILES = 500;
const MAX_PRESENCE_USERS_PER_FILE = 50;

/**
 * Resolve `relative` inside `root`, or throw.
 *
 * The guard is on the resolved path rather than on the string, because
 * '../../etc/passwd' and 'a/../../../etc/passwd' are both fine as strings and
 * neither is inside the directory once resolved.
 */
function within(root, relative, what) {
  const resolved = path.resolve(root, String(relative ?? ''));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`${what} is outside the directory this plugin may use: ${relative}`);
  }
  return resolved;
}

/**
 * Whether `filePath` names a content file the caller may address.
 *
 * The path is relative to the caller's own workspace: `handbook/intro.md`,
 * not `content/acme/handbook/intro.md`. Which workspace that is comes from
 * the verified session and is prepended by the server, so there is no field in
 * any request where a caller could name another organization's file. Chat has
 * worked this way since it was written; this is the same rule for content.
 *
 * This check is about the shape of the name. Containment is decided separately,
 * by resolveContentPath below, against the resolved path rather than the
 * string, because `a/../../x` is a fine-looking string that is not inside
 * anything. Both run on every file request: this one rejects what is obviously
 * not a page, that one rejects what escapes.
 */
function isValidFilePath(filePath) {
  if (!filePath) return false;
  if (filePath.length > 500) return false;
  const normalized = path.normalize(filePath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return false;
  if (!ALLOWED_EXTS.some(ext => normalized.endsWith(ext))) return false;
  const filename = path.basename(normalized);
  if (filename.length > 200) return false;
  return true;
}

/** The same, for a directory, which has no extension to check. */
function isValidDir(dirPath) {
  if (dirPath === '' || dirPath === '.') return true;
  if (!dirPath) return false;
  if (dirPath.length > 500) return false;
  const normalized = path.normalize(dirPath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return false;
  return true;
}

/**
 * `relative` resolved inside `orgRoot`, or null when it escapes.
 *
 * The one place a request's path becomes a real location on disk, and therefore
 * the boundary between two organizations. It defers to plugin-api's `within`,
 * which already compares resolved paths rather than strings and is the only
 * copy of this that was ever written correctly; the difference is that a plugin
 * reaching out of bounds is a bug worth throwing on, while a request doing it is
 * an ordinary 400, so this returns null instead.
 */
function resolveContentPath(orgRoot, relative) {
  try {
    return within(orgRoot, relative, 'path');
  } catch {
    return null;
  }
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

module.exports = {
  ALLOWED_EXTS,
  IMAGE_EXTS,
  MAX_BODY_SIZE,
  MAX_TEXT_LENGTH,
  MAX_PRESENCE_FILES,
  MAX_PRESENCE_USERS_PER_FILE,
  within,
  isValidFilePath,
  isValidDir,
  resolveContentPath,
  contentPathToUrl,
  sanitizeText,
  numericParam,
};
