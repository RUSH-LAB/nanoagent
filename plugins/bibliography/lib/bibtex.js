/**
 * Reading BibTeX, and deciding what kind of thing an entry is.
 *
 * These lived in src/server/server-utils.js, the server's shared helpers, where
 * thirteen route modules destructured them out of ctx and not one of them
 * called them. The bibliography is their only caller and always was: a parser
 * for a citation format is not something a web server needs to know about.
 *
 * The regexes are module-scope and shared, and the two with /g are used only
 * through .replace(), which resets lastIndex, so one instance stays correct
 * across requests.
 */
// Regex literals used inside parseBibtex, hoisted to module scope. The
// character-scanning while loops below otherwise allocated a fresh RegExp for
// every character scanned. All four are non-global and used only via
// .split() / .match() / .test(), which never touch lastIndex, so one shared
// instance per pattern is byte-for-byte equivalent to the inline literals.
const BIBTEX_ENTRY_SPLIT_RE = /(?=@\s*[a-zA-Z]+\s*\{)/;
const BIBTEX_HEADER_RE = /^@\s*([a-zA-Z]+)\s*\{\s*([^,\s]+)\s*,/;
const BIBTEX_WS_OR_COMMA_RE = /[\s,]/;
const BIBTEX_WS_RE = /[\s]/;

// Author-parsing regexes, hoisted so parseBibtexAuthors / splitAuthorName build
// each once at module load instead of on every author. AUTHORS_AND_SPLIT_RE (i)
// and AUTHOR_NAME_WS_SPLIT_RE (no flags) are used via String.prototype.split,
// which never reads or writes lastIndex. AUTHOR_INITIAL_DOT_RE (g) is used only
// via String.prototype.replace(re, ''), which resets lastIndex to 0 before and
// after each call, so a shared instance carries no state between calls.
const AUTHORS_AND_SPLIT_RE = /\s+and\s+/i;
const AUTHOR_NAME_WS_SPLIT_RE = /\s+/;
const AUTHOR_INITIAL_DOT_RE = /\./g;

function parseBibtex(input) {
  const entries = [];
  const rawEntries = input.split(BIBTEX_ENTRY_SPLIT_RE);
  for (const raw of rawEntries) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('@')) continue;

    const headerMatch = trimmed.match(BIBTEX_HEADER_RE);
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
      while (i < bodyStr.length && BIBTEX_WS_OR_COMMA_RE.test(bodyStr[i])) i++;
      if (i >= bodyStr.length) break;

      const fieldStart = i;
      while (i < bodyStr.length && bodyStr[i] !== '=' && !BIBTEX_WS_RE.test(bodyStr[i])) i++;
      const fieldName = bodyStr.slice(fieldStart, i).trim().toLowerCase();
      if (!fieldName) { i++; continue; }

      while (i < bodyStr.length && BIBTEX_WS_RE.test(bodyStr[i])) i++;
      if (i >= bodyStr.length || bodyStr[i] !== '=') { i++; continue; }
      i++;
      while (i < bodyStr.length && BIBTEX_WS_RE.test(bodyStr[i])) i++;
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
        while (i < bodyStr.length && bodyStr[i] !== ',' && bodyStr[i] !== '}' && !BIBTEX_WS_RE.test(bodyStr[i])) i++;
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
  return authorStr.split(AUTHORS_AND_SPLIT_RE).map(a => {
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

// Field names that could pollute the output object's prototype; never copied into a
// merged metadata record. Shared module-scope set, matching the TEMPLATE_VAR_PROTO_KEYS
// and PROTO_KEYS precedent in server/routes/*.
const METADATA_FORBIDDEN_FIELDS = new Set(['__proto__', 'constructor', 'prototype']);

function splitAuthorName(name) {
  const tokens = String(name).trim().split(AUTHOR_NAME_WS_SPLIT_RE);
  const last = (tokens[tokens.length - 1] || '').toLowerCase();
  const first = tokens.length > 1 ? tokens[0].toLowerCase().replace(AUTHOR_INITIAL_DOT_RE, '') : '';
  return {first, last};
}

// Two author strings name the same person when their family names match and one
// given name is an initial-prefix of the other. So "J. Doe" matches "John Doe",
// while "Jane Doe" stays distinct from "John Doe". Known limits: a bare initial
// ("J. Doe") still collapses into any same-initial full name ("Jane Doe"), and a
// family-only name ("Doe") collapses into any name with the same family name.
//
// The second name arrives already split into its {first, last} pieces so a caller
// comparing one fixed name against many candidates parses that name once rather
// than on every probe. The existing (first-argument) side is split per call
// because it genuinely varies as the merged list grows.

// Two author strings name the same person when their family names match and one
// given name is an initial-prefix of the other. So "J. Doe" matches "John Doe",
// while "Jane Doe" stays distinct from "John Doe". Known limits: a bare initial
// ("J. Doe") still collapses into any same-initial full name ("Jane Doe"), and a
// family-only name ("Doe") collapses into any name with the same family name.
//
// The second name arrives already split into its {first, last} pieces so a caller
// comparing one fixed name against many candidates parses that name once rather
// than on every probe. The existing (first-argument) side is split per call
// because it genuinely varies as the merged list grows.
function sameAuthorParsed(existing, pName) {
  const pa = splitAuthorName(existing);
  if (!pa.last || !pName.last || pa.last !== pName.last) return false;
  if (!pa.first || !pName.first) return true;
  return pa.first === pName.first || pa.first.startsWith(pName.first) || pName.first.startsWith(pa.first);
}

// Longer given name means a more complete spelling; used to pick the winner when
// two formats of the same author collapse.

// Longer given name means a more complete spelling; used to pick the winner when
// two formats of the same author collapse.
function authorFirstNameLength(name) {
  return splitAuthorName(name).first.length;
}

// Merge author lists from several sources (already in precedence order),
// preserving first-seen order and keeping the most complete spelling per person.

// Merge author lists from several sources (already in precedence order),
// preserving first-seen order and keeping the most complete spelling per person.
function mergeAuthorLists(sourceList) {
  const merged = [];
  for (const src of sourceList) {
    const list = Array.isArray(src.authors) ? src.authors : [];
    for (const raw of list) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const name = raw.trim();
      // Parse this incoming name once; the findIndex scan below would otherwise
      // re-split this fixed name on every already-merged probe (O(N^2) parses).
      const pName = splitAuthorName(name);
      const idx = merged.findIndex(existing => sameAuthorParsed(existing, pName));
      if (idx === -1) merged.push(name);
      else if (pName.first.length > authorFirstNameLength(merged[idx])) merged[idx] = name;
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
  splitAuthorName, sameAuthorParsed, authorFirstNameLength, mergeAuthorLists, mergeMetadataSources,
  parseBibtex, parseBibtexAuthors, mapBibtexEntryType,
  BIBTEX_ENTRY_SPLIT_RE, BIBTEX_HEADER_RE, BIBTEX_WS_OR_COMMA_RE, BIBTEX_WS_RE,
  AUTHORS_AND_SPLIT_RE, AUTHOR_NAME_WS_SPLIT_RE, AUTHOR_INITIAL_DOT_RE,
};
