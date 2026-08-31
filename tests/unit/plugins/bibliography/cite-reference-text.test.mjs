import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// `fs` here is the very same module object that plugins/remark-cite.js captured
// through its own require('fs'), so spying on fs.readFileSync / fs.statSync below
// is observed inside the plugin's loadBibliography().
const fs = require('fs');
const yaml = require('js-yaml');
const remarkCitePath = require.resolve('../../../../plugins/bibliography/remark');

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
//   - The existing tests/plugins/remark-cite.test.mjs suite asserts reference
//     section STRUCTURE (ids, classes, link vs text, the detail link) using real
//     bibliography keys, but never the reference TEXT content. The real
//     bibliography/references.yaml always carries a year and a title and never a
//     volume or pages, so the MISSING_YEAR, title fallback, volume, and pages
//     branches are dead against real data and were unpinned until now.
//   - This test feeds a synthetic bibliography through the fs-spy seam used by
//     tests/next-cite-bib-cache.test.mjs, runs the REAL remarkCite() transform
//     once, and locks each reference line to a golden captured from the real
//     code. No source is modified and formatReference is not reimplemented.

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
    const realRead = fs.readFileSync;
    const realStat = fs.statSync;
    const dumped = yaml.dump(SYNTHETIC_BIB);

    // Feed the synthetic bibliography for any references.yaml read, and report a
    // stable stat for it; all other paths fall through to the real fs.
    fs.readFileSync = function (p, ...rest) {
      if (String(p).includes('references.yaml')) return dumped;
      return realRead.call(this, p, ...rest);
    };
    fs.statSync = function (p, ...rest) {
      if (String(p).includes('references.yaml')) return { mtimeMs: 1, size: 1 };
      return realStat.call(this, p, ...rest);
    };

    try {
      // Re-require the plugin under the spy so loadBibliography reads the
      // synthetic data rather than any earlier cached parse.
      delete require.cache[remarkCitePath];
      const remarkCite = require('../../../../plugins/bibliography/remark');

      const keys = Object.keys(SYNTHETIC_BIB);
      const tree = makeCitedTree(keys);
      remarkCite()(tree, { message() {} });

      const list = tree.children.find((n) => n.type === 'list');
      assert.ok(list, 'transform must append a reference list when citations exist');
      // Exactly one reference item per cited key: pins the count so a dropped or
      // duplicated reference item cannot slip past the keyed-map comparison.
      assert.equal(list.children.length, keys.length);

      assert.deepStrictEqual(extractReferenceText(list), EXPECTED);
    } finally {
      fs.readFileSync = realRead;
      fs.statSync = realStat;
      // Drop the spy-loaded instance so later suites re-read the real file.
      delete require.cache[remarkCitePath];
    }
  });
});
