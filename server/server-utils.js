'use strict';

const path = require('path');
const crypto = require('crypto');

const ALLOWED_EXTS = ['.md', '.mdx'];
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'];
const MAX_BODY_SIZE = 10 * 1024 * 1024;
const MAX_TEXT_LENGTH = 10000;
const MAX_PRESENCE_FILES = 500;
const MAX_PRESENCE_USERS_PER_FILE = 50;

// Field names that could pollute the output object's prototype; never copied into a
// merged metadata record. Shared module-scope set, matching the TEMPLATE_VAR_PROTO_KEYS
// and PROTO_KEYS precedent in server/routes/*.
const METADATA_FORBIDDEN_FIELDS = new Set(['__proto__', 'constructor', 'prototype']);

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

      fields[fieldName] = value.trim();
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

// ── Multi-source metadata merge ──
// Split a "First [Middle] Last" display name into the pieces used for dedup.
// Sources here always emit names in given-then-family order (Semantic Scholar
// returns `author.name`, CrossRef joins `given family`, DBLP returns full
// names), so the last whitespace token is the family name. Only the first and
// last tokens are considered; any middle names or initials are ignored.
function splitAuthorName(name) {
  const tokens = String(name).trim().split(/\s+/);
  const last = (tokens[tokens.length - 1] || '').toLowerCase();
  const first = tokens.length > 1 ? tokens[0].toLowerCase().replace(/\./g, '') : '';
  return {first, last};
}

// Two author strings name the same person when their family names match and one
// given name is an initial-prefix of the other. So "J. Doe" matches "John Doe",
// while "Jane Doe" stays distinct from "John Doe". Known limits: a bare initial
// ("J. Doe") still collapses into any same-initial full name ("Jane Doe"), and a
// family-only name ("Doe") collapses into any name with the same family name.
function sameAuthor(a, b) {
  const pa = splitAuthorName(a);
  const pb = splitAuthorName(b);
  if (!pa.last || !pb.last || pa.last !== pb.last) return false;
  if (!pa.first || !pb.first) return true;
  return pa.first === pb.first || pa.first.startsWith(pb.first) || pb.first.startsWith(pa.first);
}

// Longer given name means a more complete spelling; used to pick the winner when
// two formats of the same author collapse.
function authorFirstNameLength(name) {
  return splitAuthorName(name).first.length;
}

// Merge author lists from several sources (already in precedence order),
// preserving first-seen order and keeping the most complete spelling per person.
function mergeAuthorLists(sourceList) {
  const merged = [];
  for (const src of sourceList) {
    const list = Array.isArray(src.authors) ? src.authors : [];
    for (const raw of list) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const name = raw.trim();
      const idx = merged.findIndex(existing => sameAuthor(existing, name));
      if (idx === -1) merged.push(name);
      else if (authorFirstNameLength(name) > authorFirstNameLength(merged[idx])) merged[idx] = name;
    }
  }
  return merged;
}

// Merge the per-source enrichment objects (Semantic Scholar, CrossRef, DBLP)
// produced by GET /api/references/enrich into one best-value record. Pure and
// additive: the handler keeps returning the per-source `sources` map and now
// also a `merged` view built here.
//
// Field precedence, highest first:
//   • doi:   CrossRef, then DBLP, then Semantic Scholar (CrossRef registers DOIs)
//   • venue: DBLP, then CrossRef, then Semantic Scholar (DBLP venue names are cleanest)
//   • every other field: CrossRef, then DBLP, then Semantic Scholar
// Source-exclusive fields (arxivId, citationCount, referenceCount, tldr, issn,
// issue, publisher) simply fall through that order to whichever source has them,
// and any field missing from the preferred source is filled from the next.
// Authors are merged across sources and de-duplicated across name formats.
function mergeMetadataSources(sources) {
  if (!sources || typeof sources !== 'object') return {};

  const SOURCE_ORDER = ['crossref', 'dblp', 'semanticScholar'];
  const FIELD_ORDER = {
    doi: ['crossref', 'dblp', 'semanticScholar'],
    venue: ['dblp', 'crossref', 'semanticScholar'],
  };

  // Keep only sources actually supplied as objects.
  const present = {};
  for (const name of SOURCE_ORDER) {
    const src = sources[name];
    if (src && typeof src === 'object' && !Array.isArray(src)) present[name] = src;
  }

  const hasValue = (v) => {
    if (v === null || v === undefined) return false;
    if (typeof v === 'string') return v.trim() !== '';
    if (Array.isArray(v)) return v.length > 0;
    return true;
  };

  // Union of every non-author field across sources, in a stable order.
  const fieldNames = [];
  for (const name of SOURCE_ORDER) {
    if (!present[name]) continue;
    for (const field of Object.keys(present[name])) {
      if (field === 'authors' || METADATA_FORBIDDEN_FIELDS.has(field)) continue;
      if (!fieldNames.includes(field)) fieldNames.push(field);
    }
  }

  const merged = {};
  for (const field of fieldNames) {
    // hasOwnProperty guard: a field named like an Object.prototype member
    // (constructor, valueOf, ...) must not pick up an inherited non-array value.
    const order = Object.prototype.hasOwnProperty.call(FIELD_ORDER, field) ? FIELD_ORDER[field] : SOURCE_ORDER;
    for (const name of order) {
      const src = present[name];
      if (src && hasValue(src[field])) {
        merged[field] = src[field];
        break;
      }
    }
  }

  const authors = mergeAuthorLists(SOURCE_ORDER.map(n => present[n]).filter(Boolean));
  if (authors.length > 0) merged.authors = authors;

  return merged;
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
  mergeMetadataSources,
};
