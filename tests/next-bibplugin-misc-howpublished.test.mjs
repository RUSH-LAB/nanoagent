import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bibliographyPlugin = require('../plugins/docusaurus-plugin-bibliography');

// ===========================================================================
// Characterization test for the `misc` fallthrough of inferBibtexType and its
// howpublished emission in toBibtex (plugins/docusaurus-plugin-bibliography.js).
//
// When an entry's type is `misc` (or any unrecognized type) AND its venue is
// neither in the CONFERENCES set nor multi-word-conference-like, inferBibtexType
// returns `misc`; toBibtex then takes its final else arm and emits a
// `howpublished = {<venue>}` field under an `@misc{` header (never journal or
// booktitle). This drives the REAL exported loadContent(), exactly as
// tests/plugins/bibliography.test.mjs does, and asserts on content[key].bibtex.
//
// Discovery mirrors inferBibtexType faithfully (the CONFERENCES set and the
// conference regex are copied from the source) so it selects exactly the keys
// the plugin would infer as `misc`. The bibtex assertions then run
// independently, so any drift between this mirror and the source surfaces as a
// loud failure rather than a silent skip. Keys are discovered dynamically to
// stay robust across references.yaml edits.
// ===========================================================================

// Copied verbatim from plugins/docusaurus-plugin-bibliography.js (CONFERENCES).
const CONFERENCES = new Set([
  'NeurIPS', 'NIPS', 'ICML', 'ICLR',
  'CVPR', 'ICCV', 'ECCV', 'BMVC',
  'ACL', 'EMNLP', 'NAACL', 'EACL', 'COLING', 'CoNLL',
  'AAAI', 'IJCAI', 'UAI', 'AISTATS', 'COLT',
  'KDD', 'SIGIR', 'WWW', 'WSDM', 'CIKM', 'RecSys',
  'SIGMOD', 'VLDB', 'ICDE',
  'OSDI', 'SOSP', 'NSDI', 'ATC', 'EuroSys', 'SoCC', 'MLSys',
  'PLDI', 'POPL', 'OOPSLA', 'ICFP',
  'ICSE', 'FSE', 'ASE', 'ISSTA',
  'MICCAI',
  'RSS', 'ICRA', 'IROS', 'CoRL',
  'SIGGRAPH',
  'CHI', 'UIST', 'CSCW',
  'CCS', 'NDSS', 'AISec',
  'STOC', 'FOCS', 'SODA',
  'INTERSPEECH', 'ICASSP',
  'TREC',
  'EMNLP Findings', 'ACL Findings', 'NAACL Findings',
]);
const CONFERENCE_RE = /proceedings|conference|workshop|symposium|findings/i;
// Types that inferBibtexType resolves before the venue heuristics, so they never
// reach the `misc` fallthrough.
const KNOWN_NON_MISC = new Set([
  'book',
  'inproceedings',
  'phdthesis',
  'thesis',
  'techreport',
]);

// True when inferBibtexType(entry) would return `misc` AND a venue is present
// (so toBibtex reaches the howpublished else arm).
function infersMiscWithVenue(entry) {
  const t = (entry.type || 'misc').toLowerCase();
  if (KNOWN_NON_MISC.has(t)) return false;
  const venue = entry.venue || '';
  if (!venue) return false;
  if (CONFERENCES.has(venue)) return false;
  if (CONFERENCE_RE.test(venue)) return false;
  // `article` with a non-conference venue infers `article`, not `misc`.
  return t !== 'article';
}

describe('docusaurus-plugin-bibliography misc venue howpublished', () => {
  let content;
  let miscVenueKeys;

  before(async () => {
    content = await bibliographyPlugin().loadContent();
    miscVenueKeys = Object.keys(content).filter((key) =>
      infersMiscWithVenue(content[key]),
    );
  });

  it('discovers at least one misc/unknown-type entry carrying a non-conference venue', () => {
    assert.ok(
      content && typeof content === 'object' && Object.keys(content).length > 0,
      'loadContent() should return a populated references object',
    );
    assert.ok(
      miscVenueKeys.length > 0,
      'expected references.yaml to contain at least one misc (or unknown) type entry with a present, non-conference venue',
    );
  });

  it('emits @misc with a howpublished venue field and no journal/booktitle', () => {
    const key = miscVenueKeys[0];
    const bib = content[key].bibtex;
    const venue = content[key].venue;

    assert.ok(
      bib.startsWith('@misc{'),
      `expected @misc header for ${key}: ${bib.slice(0, 40)}`,
    );
    assert.ok(bib.includes(`{${key},`), `bibtex should contain {${key},`);
    assert.ok(
      bib.includes(`howpublished = {${venue}}`),
      `expected "howpublished = {${venue}}" in ${key} bibtex:\n${bib}`,
    );
    assert.ok(
      !bib.includes('journal ='),
      `@misc entry ${key} must not emit a journal field`,
    );
    assert.ok(
      !bib.includes('booktitle ='),
      `@misc entry ${key} must not emit a booktitle field`,
    );
  });

  it('routes the venue of every discovered misc entry through howpublished, never journal/booktitle', () => {
    for (const key of miscVenueKeys) {
      const bib = content[key].bibtex;
      const venue = content[key].venue;

      assert.ok(
        bib.startsWith('@misc{'),
        `expected @misc header for ${key}: ${bib.slice(0, 40)}`,
      );
      assert.ok(
        bib.includes(`howpublished = {${venue}}`),
        `expected "howpublished = {${venue}}" in ${key} bibtex:\n${bib}`,
      );
      assert.ok(
        !bib.includes('journal ='),
        `${key} must not emit a journal field`,
      );
      assert.ok(
        !bib.includes('booktitle ='),
        `${key} must not emit a booktitle field`,
      );
    }
  });

  // Drift guard: the discovery mirror (CONFERENCES set, conference regex, type
  // rules) must not miss any entry the real source actually routes to @misc with
  // a venue. Every key whose emitted bibtex is an @misc header AND carries a
  // venue must have been discovered. If the copied mirror ever falls out of sync
  // with plugins/docusaurus-plugin-bibliography.js, this fails loudly instead of
  // letting the characterization quietly stop covering some entries.
  it('discovers every @misc entry that carries a venue (mirror stays in sync with the source)', () => {
    const missed = Object.keys(content).filter((key) => {
      const bib = content[key].bibtex;
      const venue = content[key].venue || '';
      return bib.startsWith('@misc{') && venue && !miscVenueKeys.includes(key);
    });
    assert.deepStrictEqual(
      missed,
      [],
      `@misc entries carrying a venue were not discovered (CONFERENCES/regex mirror drift?): ${missed.join(', ')}`,
    );
  });
});
