import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const remarkCite = require('../../../../plugins/bibliography/remark');

// What this pins, and why it is add-only test coverage (NOT a behavior change):
//
//   - formatReference(key, entry) in plugins/remark-cite.js assembles each
//     reference-list line as
//       `${authors} (${year}). ${title}${venue}${vol}${pages}.`
//     with these branches: authors joined by ", "; `year || MISSING_YEAR`
//     (the "????" fallback); `title || key` (title falls back to the citation
//     key); venue as ". ${venue}"; volume as ", ${volume}"; pages as
//     ", pp. ${pages}". The text becomes the child of the reference link when
//     entry.url is set, or a bare text node when there is no url.
//   - The main remark suite asserts reference section STRUCTURE (ids, classes,
//     link vs text, and the detail link), while this synthetic bibliography
//     covers the less common text-formatting branches.
//   - The bibliography is injected exactly as the database-backed caller would
//     provide it; no production data file is needed by the test.

// Synthetic bibliography crafted so a single transform pass exercises every
// formatReference branch. Each entry is annotated with the branch it drives.
const SYNTHETIC_BIB = {
  // All fields plus a url: multi-author join, venue, volume, pages, and the
  // url-wrapped reference-link path.
  allfields: {
    author: ['Ada Lovelace', 'Alan Turing'],
    year: 2021,
    title: 'On Computable Numbers',
    venue: 'Journal of Computing',
    volume: '42',
    pages: '100-120',
    url: 'https://example.com/paper',
  },
  // Missing year: the MISSING_YEAR ("????") fallback. No url: bare text node.
  noyear: {
    author: ['Grace Hopper'],
    title: 'The Compiler',
  },
  // Missing title: title falls back to the citation key ("notitle").
  notitle: {
    author: ['Edsger Dijkstra'],
    year: 1968,
  },
  // Volume plus pages without a venue: the volume and pages branches in
  // isolation from venue.
  volpages: {
    author: ['Donald Knuth'],
    year: 1997,
    title: 'The Art of Computer Programming',
    volume: '3',
    pages: '1-50',
  },
};

// Goldens captured by running the real remarkCite() transform over SYNTHETIC_BIB
// once, then locked in here as literals. Keyed by citation key; `url` is the
// reference link target when entry.url is set, or null for a bare text node.
const EXPECTED = {
  allfields: {
    text: 'Ada Lovelace, Alan Turing (2021). On Computable Numbers. Journal of Computing, 42, pp. 100-120.',
    url: 'https://example.com/paper',
  },
  noyear: {
    text: 'Grace Hopper (????). The Compiler.',
    url: null,
  },
  notitle: {
    text: 'Edsger Dijkstra (1968). notitle.',
    url: null,
  },
  volpages: {
    text: 'Donald Knuth (1997). The Art of Computer Programming, 3, pp. 1-50.',
    url: null,
  },
};

// A minimal mdast root with one paragraph citing every synthetic key, so the
// transform resolves all of them and appends one reference list.
function makeCitedTree(keys) {
  return {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [
          { type: 'text', value: keys.map((k) => `[@${k}]`).join(' ') },
        ],
      },
    ],
  };
}

// Pull the assembled reference text out of each reference-list item, keyed by
// citation key. The first child of each item's paragraph holds the reference
// text: a link node (children[0].value) when entry.url is set, otherwise a bare
// text node (value). The trailing " " and the "↗" detail link are ignored here.
function extractReferenceText(list) {
  const out = {};
  for (const item of list.children) {
    const key = item.data.hProperties.id.replace(/^ref-/, '');
    const holder = item.children[0].children[0];
    out[key] =
      holder.type === 'link'
        ? { text: holder.children[0].value, url: holder.url }
        : { text: holder.value, url: null };
  }
  return out;
}

describe('next-cite-reference-text: formatReference reference-line goldens', () => {
  it('assembles each reference line, exercising MISSING_YEAR, title fallback, venue, volume, and pages', () => {
    const keys = Object.keys(SYNTHETIC_BIB);
    const tree = makeCitedTree(keys);
    remarkCite({bibliography: SYNTHETIC_BIB})(tree, { message() {} });

    const list = tree.children.find((n) => n.type === 'list');
    assert.ok(list, 'transform must append a reference list when citations exist');
    assert.equal(list.children.length, keys.length);
    assert.deepStrictEqual(extractReferenceText(list), EXPECTED);
  });
});
