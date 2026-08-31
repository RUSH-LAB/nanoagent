import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Load the REAL transform under test. `fs` here is the very same module object
// that plugins/remark-cite.js captured through its own require('fs'), so spying
// on fs.readFileSync / fs.statSync below is observed inside loadBibliography().
const remarkCite = require('../../../../plugins/bibliography/remark');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// ---------------------------------------------------------------------------
// What this proves, and why it is a pure efficiency win (NOT a behavior change):
//
//   - yaml.load is deterministic: identical bytes parse to a deep-equal object,
//     so a cache hit hands back exactly what a fresh parse would have produced.
//   - loadBibliography caches keyed on (mtimeMs, size) and reuses the stored
//     parse ONLY when statSync reports the SAME mtimeMs AND size. Any edit to
//     references.yaml changes its mtime (and size), so the dev-server hot reload
//     the source comment describes is preserved. Step 4 below locks this in by
//     forcing a stat change and asserting a re-read, so the cache cannot decay
//     into a read-once-ever bug.
//   - remark-cite only READS bibliography[key], so sharing one cached object
//     across calls is safe. The rendered output is unchanged: the existing
//     tests/plugins/remark-cite.test.mjs suite (also run by verify.sh) drives
//     the transform many times and still passes byte for byte.
// ---------------------------------------------------------------------------

// Resolve the same references.yaml the plugin reads, and pick a real citation
// key so the transform takes the cited path. This read uses the real fs before
// any spy is installed and does not touch the plugin's module-level cache (it is
// our own call to yaml.load, not loadBibliography()).
// Content is one tree per organization, and the build renders the primary one,
// so the slug is resolved exactly as remark.js resolves it.
const PRIMARY_ORG = process.env.ROOT_ORG_SLUG || 'mochi';
const bibPath = path.resolve(
  path.dirname(require.resolve('../../../../plugins/bibliography/remark')),
  '..', '..',
  'content',
  PRIMARY_ORG,
  'bibliography',
  'references.yaml',
);
const bibliography = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};
const citeKey = Object.keys(bibliography)[0];

// A minimal mdast tree carrying one [@key] citation, mirroring the helper in
// tests/plugins/remark-cite.test.mjs.
function makeCitedTree(key) {
  return {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [{ type: 'text', value: `See [@${key}].` }],
      },
    ],
  };
}

// Run the real transform; the citation key is valid, so file.message is never
// called, but provide a no-op VFile-like object to match the plugin contract.
function run(tree) {
  remarkCite()(tree, { message() {} });
}

describe('next-cite-bib-cache: references.yaml is read and parsed once per build', () => {
  it('reads references.yaml once across calls and re-reads only when it changes', () => {
    assert.ok(citeKey, 'expected at least one bibliography entry to cite');

    const realReadFileSync = fs.readFileSync;
    const realStatSync = fs.statSync;

    // Spy fs.readFileSync: count only reads of references.yaml, delegating the
    // actual read to the original so the plugin still gets real bytes.
    let yamlReads = 0;
    fs.readFileSync = function (p, ...rest) {
      if (String(p).includes('references.yaml')) yamlReads += 1;
      return realReadFileSync.call(this, p, ...rest);
    };

    try {
      // (2) Cold miss: the first transform reads and parses the file once.
      run(makeCitedTree(citeKey));
      assert.equal(yamlReads, 1, 'cold call should read references.yaml exactly once');

      // (3) Warm hit: a second transform over a different tree, with the file
      // unchanged on disk (real statSync reports the same mtimeMs + size), is
      // served from the cache with NO extra read. This is the build-time win.
      run(makeCitedTree(citeKey));
      assert.equal(yamlReads, 1, 'warm call must NOT re-read (cache hit)');

      // (4) Change detection: make statSync report a different mtimeMs and size,
      // so the cache key no longer matches and the loader re-reads + re-parses.
      // Proves the memo is invalidated on change (hot reload preserved), not a
      // read-once-ever bug. Other paths fall through to the real statSync.
      const realStat = realStatSync(bibPath);
      fs.statSync = function (p, ...rest) {
        if (String(p).includes('references.yaml')) {
          return { mtimeMs: realStat.mtimeMs + 1000, size: realStat.size + 1 };
        }
        return realStatSync.call(this, p, ...rest);
      };

      run(makeCitedTree(citeKey));
      assert.equal(yamlReads, 2, 'a changed stat must force exactly one re-read');

      // (5) Best-effort stat: when statSync THROWS (for example a missing file,
      // or an fs stub without it) the error must NOT escape loadBibliography. It
      // is swallowed to stat = null and the loader falls through to the read, so
      // the transform still succeeds and references.yaml is read again. Mirrors
      // the try-caught statSync in loadReferencesCached.
      fs.statSync = function (p, ...rest) {
        if (String(p).includes('references.yaml')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return realStatSync.call(this, p, ...rest);
      };
      assert.doesNotThrow(
        () => run(makeCitedTree(citeKey)),
        'a statSync failure must not escape loadBibliography',
      );
      assert.equal(yamlReads, 3, 'a statSync failure falls through to a fresh read');

      // (6) Missing or broken file: when the READ itself throws, the preserved
      // fallback warns exactly once and returns {}, so the transform completes
      // with NO citation resolved and NO References section appended (citedKeys
      // stays empty). statSync still throws here, so the catch path also clears
      // the cache. This pins the behavior-preservation half of the change.
      const warnings = [];
      const realWarn = console.warn;
      console.warn = (msg) => { warnings.push(String(msg)); };
      fs.readFileSync = function (p, ...rest) {
        if (String(p).includes('references.yaml')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return realReadFileSync.call(this, p, ...rest);
      };
      try {
        const tree = makeCitedTree(citeKey);
        assert.doesNotThrow(
          () => run(tree),
          'a broken references.yaml must not throw out of the transform',
        );
        const hasRefsHeading = tree.children.some(
          (n) => n.type === 'heading' && n.children?.[0]?.value === 'References',
        );
        assert.equal(
          hasRefsHeading,
          false,
          'a {} fallback resolves no citation, so no References section is appended',
        );
        assert.equal(warnings.length, 1, 'the broken-file fallback warns exactly once');
        assert.ok(
          warnings[0].includes('references.yaml'),
          'the warning names the file it could not load',
        );
      } finally {
        console.warn = realWarn;
      }
    } finally {
      fs.readFileSync = realReadFileSync;
      fs.statSync = realStatSync;
    }
  });
});
