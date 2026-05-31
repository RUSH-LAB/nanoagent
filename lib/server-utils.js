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
      for (const userId of Object.keys(presenceStore[filePath])) {
        if (now - presenceStore[filePath][userId].lastSeen > STALE_MS) {
          delete presenceStore[filePath][userId];
        }
      }
      if (Object.keys(presenceStore[filePath]).length === 0) {
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

function parseBibtex(input) {
  const entries = [];
  const rawEntries = input.split(/(?=@\s*[a-zA-Z]+\s*\{)/);
  for (const raw of rawEntries) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('@')) continue;

    const headerMatch = trimmed.match(/^@\s*([a-zA-Z]+)\s*\{\s*([^,\s]+)\s*,/);
    if (!headerMatch) continue;
    const entryType = headerMatch[1].toLowerCase();
    const citationKey = headerMatch[2];

    const openBrace = trimmed.indexOf('{');
    let depth = 1;
    let pos = openBrace + 1;
    let bodyEnd = -1;
    while (pos < trimmed.length && depth > 0) {
      if (trimmed[pos] === '{') depth++;
      else if (trimmed[pos] === '}') depth--;
      if (depth === 0) { bodyEnd = pos; break; }
      pos++;
    }
    if (bodyEnd === -1) bodyEnd = trimmed.length;

    const headerEnd = trimmed.indexOf(',', openBrace);
    if (headerEnd === -1) continue;
    const bodyStr = trimmed.slice(headerEnd + 1, bodyEnd);

    const fields = {};
    let i = 0;
    while (i < bodyStr.length) {
      while (i < bodyStr.length && /[\s,]/.test(bodyStr[i])) i++;
      if (i >= bodyStr.length) break;

      const fieldStart = i;
      while (i < bodyStr.length && bodyStr[i] !== '=' && !/[\s]/.test(bodyStr[i])) i++;
      const fieldName = bodyStr.slice(fieldStart, i).trim().toLowerCase();
      if (!fieldName) { i++; continue; }

      while (i < bodyStr.length && /[\s]/.test(bodyStr[i])) i++;
      if (i >= bodyStr.length || bodyStr[i] !== '=') { i++; continue; }
      i++;
      while (i < bodyStr.length && /[\s]/.test(bodyStr[i])) i++;
      if (i >= bodyStr.length) break;

      let value = '';
      if (bodyStr[i] === '{') {
        let braceDepth = 1;
        i++;
        const valStart = i;
        while (i < bodyStr.length && braceDepth > 0) {
          if (bodyStr[i] === '{') braceDepth++;
          else if (bodyStr[i] === '}') braceDepth--;
          if (braceDepth > 0) i++;
        }
        value = bodyStr.slice(valStart, i);
        if (i < bodyStr.length) i++;
      } else if (bodyStr[i] === '"') {
        i++;
        const valStart = i;
        while (i < bodyStr.length && bodyStr[i] !== '"') i++;
        value = bodyStr.slice(valStart, i);
        if (i < bodyStr.length) i++;
      } else {
        const valStart = i;
        while (i < bodyStr.length && bodyStr[i] !== ',' && bodyStr[i] !== '}' && !/[\s]/.test(bodyStr[i])) i++;
        value = bodyStr.slice(valStart, i);
      }

      if (fieldName) {
        fields[fieldName] = value.trim();
      }
    }

    entries.push({entryType, citationKey, fields});
  }
  return entries;
}

function parseBibtexAuthors(authorStr) {
  if (!authorStr) return [];
  return authorStr.split(/\s+and\s+/i).map(a => {
    a = a.trim();
    if (!a) return null;
    if (a.includes(',')) {
      const parts = a.split(',').map(p => p.trim());
      const lastName = parts[0];
      const firstName = parts.slice(1).join(' ').trim();
      return firstName ? `${firstName} ${lastName}` : lastName;
    }
    return a;
  }).filter(Boolean);
}

function mapBibtexEntryType(bibtexType) {
  const typeMap = {
    article: 'article',
    inproceedings: 'inproceedings',
    conference: 'inproceedings',
    book: 'book',
    incollection: 'incollection',
    phdthesis: 'phdthesis',
    mastersthesis: 'mastersthesis',
    techreport: 'techreport',
    misc: 'misc',
    unpublished: 'unpublished',
    inbook: 'inbook',
    proceedings: 'proceedings',
  };
  return typeMap[bibtexType] || 'misc';
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
  makeRateLimiter,
  makeCache,
  makePresenceStore,
  parseBibtex,
  parseBibtexAuthors,
  mapBibtexEntryType,
};
