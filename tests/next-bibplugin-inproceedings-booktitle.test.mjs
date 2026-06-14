import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Drive the REAL plugin module through its PUBLIC loadContent(), exactly as the
// sibling tests/plugins/bibliography.test.mjs does (one directory up from here).
// This is a characterization test, not a source-lift: it asserts on the bibtex
// that loadContent() actually produces.
const bibliographyPlugin = require('../plugins/docusaurus-plugin-bibliography');

const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');

// Resolve references.yaml relative to the plugin (cwd-independent), mirroring the
// sibling test, so the discovery below reads the same data loadContent() reads.
const pluginDir = path.dirname(
  require.resolve('../plugins/docusaurus-plugin-bibliography'),
);
const projectDir = path.resolve(pluginDir, '..');
const bibPath = path.join(projectDir, 'bibliography', 'references.yaml');
const rawBib = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};
const allKeys = Object.keys(rawBib);

// inferBibtexType early-returns on these types BEFORE the venue checks (source
// lines 32 to 35), so an entry must avoid them to reach the venue branches.
const EARLY_RETURN_TYPES = new Set([
  'book',
  'inproceedings',
  'phdthesis',
  'thesis',
  'techreport',
]);

// The venue regex evaluated at source line 39.
const VENUE_REGEX = /proceedings|conference|workshop|symposium|findings/i;

// The only multi-word members of the CONFERENCES set (source line 23). Skipping
// them guarantees the discovered pick reaches the REGEX branch (line 39) rather
// than the set-membership branch (line 38), which would also yield
// @inproceedings and so would not isolate the branch under test.
const MULTIWORD_CONFERENCE_NAMES = new Set([
  'EMNLP Findings',
  'ACL Findings',
  'NAACL Findings',
]);

// Discover, dynamically, an entry that exercises the venue-regex branch: a
// non-early-return type whose venue matches the regex and is multi-word (so it
// cannot be a bare single-word CONFERENCES name) and is not one of the multi-word
// set names. Ephemeral __test/__wf fixtures are excluded so the pick is a stable
// real reference. Discovering the key (rather than hardcoding it) keeps the test
// robust to references.yaml edits.
const regexVenueKey = allKeys.find((k) => {
  if (k.startsWith('__test') || k.startsWith('__wf')) return false;
  const entry = rawBib[k];
  const type = (entry.type || 'misc').toLowerCase();
  const venue = entry.venue || '';
  return (
    !EARLY_RETURN_TYPES.has(type) &&
    venue.includes(' ') &&
    VENUE_REGEX.test(venue) &&
    !MULTIWORD_CONFERENCE_NAMES.has(venue)
  );
});

describe('docusaurus-plugin-bibliography venue-regex inproceedings booktitle', () => {
  let content;

  before(async () => {
    content = await bibliographyPlugin().loadContent();
  });

  it('discovers a non-set venue-regex entry (test is not vacuous)', () => {
    assert.ok(
      regexVenueKey,
      'expected references.yaml to hold a non-early-return entry whose venue ' +
        'matches /proceedings|conference|workshop|symposium|findings/i, is ' +
        'multi-word, and is not a CONFERENCES set-name',
    );
  });

  it('the entry reaches the regex branch, not an early return or the set branch', () => {
    // These restate the discovery predicate as executable documentation of the
    // branch under test (the venue regex, source line 39): they record which
    // traits of the real entry route it there. The independent characterization
    // is the bibtex assertion below.
    assert.ok(regexVenueKey);
    const entry = rawBib[regexVenueKey];
    const type = (entry.type || 'misc').toLowerCase();
    assert.ok(
      !EARLY_RETURN_TYPES.has(type),
      `type "${type}" must not be an early-return type`,
    );
    assert.match(entry.venue, VENUE_REGEX);
    assert.ok(entry.venue.includes(' '), 'venue should be multi-word');
    assert.ok(
      !MULTIWORD_CONFERENCE_NAMES.has(entry.venue),
      'venue must not be a CONFERENCES set-name (that is the line 38 branch)',
    );
  });

  it('emits an @inproceedings header keyed by the entry id', () => {
    assert.ok(regexVenueKey);
    const bib = content[regexVenueKey].bibtex;
    assert.ok(
      bib.startsWith('@inproceedings{'),
      `expected an @inproceedings header: ${bib.slice(0, 40)}`,
    );
    assert.ok(
      bib.includes(`@inproceedings{${regexVenueKey},`),
      'the header should carry the entry key',
    );
  });

  it('maps the venue to a booktitle field, never a journal field', () => {
    assert.ok(regexVenueKey);
    const entry = rawBib[regexVenueKey];
    const bib = content[regexVenueKey].bibtex;
    // Pin the exact field line toBibtex emits at source line 58 (a newline plus a
    // two-space indent), so the golden is matched as a whole field rather than a
    // loose substring.
    assert.ok(
      bib.includes(`\n  booktitle = {${entry.venue}}`),
      `expected the exact booktitle field line carrying the venue: ${bib}`,
    );
    assert.ok(
      !bib.includes('journal ='),
      'an inproceedings entry must not emit a journal field',
    );
    // Pin the exact field mapping: not the book (publisher) or misc
    // (howpublished) venue branch either.
    assert.ok(
      !bib.includes('publisher ='),
      'venue should map to booktitle, not publisher',
    );
    assert.ok(
      !bib.includes('howpublished ='),
      'venue should map to booktitle, not howpublished',
    );
  });
});
