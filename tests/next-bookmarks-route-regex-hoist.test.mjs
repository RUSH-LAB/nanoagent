import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// bookmarks-reading-lists.js is CommonJS; load it the way the other server route
// tests do. This suite guards the hoist of the four route-match regexes
// (DISCUSSION_PIN_RE, READING_LIST_RE, READING_LIST_ITEMS_RE,
// READING_LIST_EXPORT_RE) from per-request inline literals to shared module-scope
// constants exported via `routeRegexes`. It proves each is a stateless,
// referentially stable RegExp that matches its intended paths and rejects near
// misses, so sharing one instance across requests is byte-for-byte behavior
// preserving.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/bookmarks-reading-lists.js');
const { routeRegexes } = routes;

const NAMES = ['DISCUSSION_PIN_RE', 'READING_LIST_RE', 'READING_LIST_ITEMS_RE', 'READING_LIST_EXPORT_RE'];

describe('bookmarks-reading-lists route-match regexes — module-scope hoist', () => {
  it('exports the four named regexes via routeRegexes', () => {
    assert.ok(routeRegexes, 'routeRegexes export is present');
    assert.deepEqual(Object.keys(routeRegexes).sort(), [...NAMES].sort());
    for (const name of NAMES) {
      assert.ok(routeRegexes[name] instanceof RegExp, `${name} is a RegExp`);
    }
  });

  it('every regex is stateless (global === false, sticky === false)', () => {
    // The handlers read each match only for truthiness and the patterns carry no
    // /g or /y flag, so a single shared instance keeps no lastIndex across
    // requests. A stray flag would silently break dispatch on repeat hits.
    for (const name of NAMES) {
      const re = routeRegexes[name];
      assert.equal(re.global, false, `${name}.global must be false`);
      assert.equal(re.sticky, false, `${name}.sticky must be false`);
    }
  });

  it('each regex is referentially stable across two accesses', () => {
    // Module-scope consts re-exported through a cached require must hand back the
    // very same instance every time; a getter rebuilding a literal per access
    // would defeat the point of the hoist.
    const second = require('../server/routes/bookmarks-reading-lists.js').routeRegexes;
    for (const name of NAMES) {
      assert.equal(routeRegexes[name], second[name], `${name} identity is stable`);
      assert.equal(routeRegexes[name], routeRegexes[name], `${name} repeat read is identical`);
    }
  });

  // Each case lists the regex plus paths it must match and near misses it must
  // reject. The accepts/rejects mirror the real dispatcher inputs (decoded
  // pathnames, no query string).
  const CASES = [
    {
      name: 'DISCUSSION_PIN_RE',
      accept: ['/api/discussions/general/pin', '/api/discussions/abc-123/pin', '/api/discussions/a b/pin'],
      reject: [
        '/api/discussions/general/pin/extra', // trailing segment
        '/api/discussions/general/unpin',      // segment must be exactly "pin"
        '/api/discussions//pin',               // empty channel id
        '/api/discussions/a/b/pin',            // slash inside channel id
        '/api/discussions/general/pin/',       // trailing slash
        '/api/discussions/pin',                // missing channel id
      ],
    },
    {
      name: 'READING_LIST_RE',
      accept: ['/api/reading-lists/abc', '/api/reading-lists/uuid-123'],
      reject: [
        '/api/reading-lists/abc/items',  // items subpath
        '/api/reading-lists/abc/export', // export subpath
        '/api/reading-lists',            // missing id
        '/api/reading-lists/',           // empty id
        '/api/reading-lists/abc/',       // trailing slash
      ],
    },
    {
      name: 'READING_LIST_ITEMS_RE',
      accept: ['/api/reading-lists/abc/items', '/api/reading-lists/uuid-123/items'],
      reject: [
        '/api/reading-lists/abc/items/5', // trailing item id
        '/api/reading-lists/abc',         // bare list
        '/api/reading-lists/abc/export',  // export subpath
        '/api/reading-lists//items',      // empty list id
        '/api/reading-lists/a/b/items',   // slash inside list id (pins [^/]+)
        '/api/reading-lists/abc/items/',  // trailing slash
      ],
    },
    {
      name: 'READING_LIST_EXPORT_RE',
      accept: ['/api/reading-lists/abc/export', '/api/reading-lists/uuid-123/export'],
      reject: [
        '/api/reading-lists/abc/export/x', // trailing segment
        '/api/reading-lists/abc',          // bare list
        '/api/reading-lists/abc/items',    // items subpath
        '/api/reading-lists//export',      // empty list id
        '/api/reading-lists/a/b/export',   // slash inside list id (pins [^/]+)
        '/api/reading-lists/abc/export/',  // trailing slash
      ],
    },
  ];

  for (const { name, accept, reject } of CASES) {
    it(`${name} matches its intended paths and rejects near misses`, () => {
      const re = routeRegexes[name];
      for (const p of accept) {
        assert.ok(re.test(p), `${name} should match ${p}`);
        assert.ok(p.match(re), `${name} should match ${p} via String.match`);
      }
      for (const p of reject) {
        assert.equal(re.test(p), false, `${name} should reject ${p}`);
        assert.equal(p.match(re), null, `${name} should reject ${p} via String.match`);
      }
    });
  }

  it('READING_LIST_RE does not match the /items or /export subpaths', () => {
    // The dispatcher pairs READING_LIST_RE with `&& !pathname.includes('/items')`;
    // this asserts the regex itself already excludes the subpaths, documenting why
    // the items/export handlers downstream are never shadowed by the delete-list
    // branch.
    const re = routeRegexes.READING_LIST_RE;
    assert.equal(re.test('/api/reading-lists/abc/items'), false);
    assert.equal(re.test('/api/reading-lists/abc/export'), false);
  });
});
