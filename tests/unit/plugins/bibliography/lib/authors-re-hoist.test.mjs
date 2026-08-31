import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// The BibTeX author parsing and the multi-source metadata merge that shares its
// name-splitting regexes both live in the bibliography plugin, the only caller
// either ever had, so both halves of this file now reach for one module. The
// BIBTEX_-prefixed aliases date from when the two halves came from separate
// modules; they are kept because they name which half each assertion belongs to.
const {
  mergeMetadataSources,
  parseBibtexAuthors,
  AUTHORS_AND_SPLIT_RE,
  AUTHOR_NAME_WS_SPLIT_RE: BIBTEX_AUTHOR_NAME_WS_SPLIT_RE,
  AUTHOR_INITIAL_DOT_RE: BIBTEX_AUTHOR_INITIAL_DOT_RE,
} = require('../../../../../plugins/bibliography/lib/bibtex.js');

describe('bibliography lib author regex hoist', () => {
  it('exports each author regex as a module-scope RegExp with the expected source and flags', () => {
    assert.ok(AUTHORS_AND_SPLIT_RE instanceof RegExp);
    assert.equal(AUTHORS_AND_SPLIT_RE.source, '\\s+and\\s+');
    assert.equal(AUTHORS_AND_SPLIT_RE.flags, 'i');

    assert.ok(BIBTEX_AUTHOR_NAME_WS_SPLIT_RE instanceof RegExp);
    assert.equal(BIBTEX_AUTHOR_NAME_WS_SPLIT_RE.source, '\\s+');
    assert.equal(BIBTEX_AUTHOR_NAME_WS_SPLIT_RE.flags, '');

    assert.ok(BIBTEX_AUTHOR_INITIAL_DOT_RE instanceof RegExp);
    assert.equal(BIBTEX_AUTHOR_INITIAL_DOT_RE.source, '\\.');
    assert.equal(BIBTEX_AUTHOR_INITIAL_DOT_RE.flags, 'g');
  });

  it('parseBibtexAuthors returns a byte-identical array across repeated calls', () => {
    // One input that exercises all three behaviors at once: the case-insensitive
    // `and` split (lowercase `and` plus uppercase `AND`), the `Last, First`
    // reorder, and a bare initial (`D.`).
    const input = 'Doe, Jane and John Smith AND Knuth, D.';
    const expected = ['Jane Doe', 'John Smith', 'D. Knuth'];

    const first = parseBibtexAuthors(input);
    assert.deepEqual(first, expected);

    // Calling again must yield the same result: the shared regex instances carry
    // no leftover state between parses.
    const second = parseBibtexAuthors(input);
    assert.deepEqual(second, first);
  });

  it('AUTHOR_INITIAL_DOT_RE (the only /g instance) carries no lastIndex state across replace calls', () => {
    // splitAuthorName strips initial dots via String.prototype.replace, which
    // resets lastIndex; a shared /g instance must therefore strip identically on
    // every call. parseBibtexAuthors never reaches this regex, so exercise it
    // directly through the exported constant.
    assert.equal('J.R.R.'.replace(BIBTEX_AUTHOR_INITIAL_DOT_RE, ''), 'JRR');
    assert.equal('J.R.R.'.replace(BIBTEX_AUTHOR_INITIAL_DOT_RE, ''), 'JRR');
    assert.equal(BIBTEX_AUTHOR_INITIAL_DOT_RE.lastIndex, 0);
  });
});

// splitAuthorName, which serves the mergeMetadataSources author dedup, shares
// the two name-splitting regexes with the BibTeX parser above. This half pins
// the pattern and flags against the source text, and pins the behavior through
// mergeMetadataSources, the entry point the plugin's endpoints reach them by.
describe('metadata merge author regex hoist', () => {
  const src = readFileSync(new URL('../../../../../plugins/bibliography/lib/bibtex.js', import.meta.url), 'utf8');
  // Core kept a duplicate of this merge until the bibliography plugin became its
  // only caller. Read core too, so the assertion below still guards core against
  // a copy coming back.
  const coreSrc = readFileSync(new URL('../../../../../src/server/server-utils.js', import.meta.url), 'utf8');

  it('declares each name-splitting regex once at module scope with the expected literal', () => {
    assert.ok(
      src.includes('const AUTHOR_NAME_WS_SPLIT_RE = /\\s+/;'),
      'expected AUTHOR_NAME_WS_SPLIT_RE to be the module-scope /\\s+/ literal',
    );
    assert.ok(
      src.includes('const AUTHOR_INITIAL_DOT_RE = /\\./g;'),
      'expected AUTHOR_INITIAL_DOT_RE to be the module-scope /\\./g literal',
    );
    // The `and` separator belongs to the BibTeX parser alone, so it must not have
    // been copied back in along with the two regexes splitAuthorName still uses.
    assert.ok(
      !coreSrc.includes('AUTHORS_AND_SPLIT_RE'),
      'expected the BibTeX-only AUTHORS_AND_SPLIT_RE to stay out of server-utils',
    );
  });

  it('splits a name on any whitespace run, not on a literal space', () => {
    // "Ada\nLovelace" only yields the family name "Lovelace" under a \s+ split, so
    // it collapses into "Ada Lovelace"; a single-space pattern would leave one
    // token and keep the two names apart.
    const merged = mergeMetadataSources({
      crossref: { authors: ['Ada Lovelace'] },
      dblp: { authors: ['Ada\nLovelace', 'Alan\tTuring'] },
    });
    assert.deepEqual(merged.authors, ['Ada Lovelace', 'Alan\tTuring']);
  });

  it('strips initial dots identically on every call (the /g instance keeps no lastIndex)', () => {
    // "J.R.R." and "Jrr" both reduce to the given name "jrr" only once the dots
    // are stripped, so the two spellings dedup to the first-seen one. Repeating
    // the merge must give the same answer: the shared /g instance carries no
    // state between the replace calls inside splitAuthorName.
    const sources = {
      crossref: { authors: ['J.R.R. Tolkien'] },
      dblp: { authors: ['Jrr Tolkien'] },
    };
    const first = mergeMetadataSources(sources);
    assert.deepEqual(first.authors, ['J.R.R. Tolkien']);
    const second = mergeMetadataSources(sources);
    assert.deepEqual(second.authors, first.authors);
  });
});
