import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// references.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const referencesRoutes = require('../server/routes/references.js');
const yaml = require('js-yaml');

// The deduped citation logic now lives in a single exported module-scope helper.
const { buildCitation } = referencesRoutes;

const PROJECT_ROOT = '/fake/root';
const REFS_PATH = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');

// Drive a GET references route with a mocked ctx and capture the json() response.
// fs.readFileSync only answers for the references.yaml path so an accidental extra
// read surfaces as ENOENT rather than silent reuse. No statSync is provided, so
// loadReferencesCached bypasses its cache and re-reads the fixture every call.
async function callRoute(pathname, refs, search = '') {
  const yamlText = yaml.dump(refs);
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    fs: {
      readFileSync(fp) {
        if (fp === REFS_PATH) return yamlText;
        const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
      },
    },
    json: (_res, status, body) => { captured = { status, body }; return captured; },
  };
  const url = new URL(`http://localhost${pathname}${search}`);
  await referencesRoutes({ method: 'GET' }, { writableEnded: false }, url, pathname, ctx);
  return captured;
}

describe('buildCitation helper (single source of citation formatting)', () => {
  it('is exported as a module-scope function', () => {
    assert.equal(typeof buildCitation, 'function');
  });

  describe('APA style', () => {
    it('formats zero authors as Unknown with a trailing space when venue is empty', () => {
      assert.equal(
        buildCitation('apa', { authors: [], year: 2024, title: 'Anonymous Survey', venue: '' }),
        'Unknown (2024). Anonymous Survey. ',
      );
    });
    it('formats a single author as last name plus initials', () => {
      assert.equal(
        buildCitation('apa', { authors: ['John Smith'], year: 2024, title: 'Test Paper', venue: 'NeurIPS' }),
        'Smith, J. (2024). Test Paper. NeurIPS.',
      );
    });
    it('formats many authors with a serial ampersand before the last', () => {
      assert.equal(
        buildCitation('apa', { authors: ['Alice Johnson', 'Bob Williams', 'Carol Davis'], year: 2023, title: 'Group Paper', venue: 'ICML' }),
        'Johnson, A., Williams, B., & Davis, C. (2023). Group Paper. ICML.',
      );
    });
  });

  describe('MLA style', () => {
    it('formats zero authors as Unknown', () => {
      assert.equal(
        buildCitation('mla', { authors: [], year: 2024, title: 'Anonymous Survey', venue: '' }),
        'Unknown. "Anonymous Survey." 2024.',
      );
    });
    it('formats a single author with the last name first', () => {
      assert.equal(
        buildCitation('mla', { authors: ['John Smith'], year: 2024, title: 'Test Paper', venue: 'NeurIPS' }),
        'Smith, John. "Test Paper." NeurIPS, 2024.',
      );
    });
    it('collapses many authors to the first plus et al. (the et al. period and the template period both land, byte-for-byte)', () => {
      assert.equal(
        buildCitation('mla', { authors: ['Alice Johnson', 'Bob Williams', 'Carol Davis'], year: 2023, title: 'Group Paper', venue: 'ICML' }),
        'Johnson, Alice, et al.. "Group Paper." ICML, 2023.',
      );
    });
  });

  describe('Chicago / default style', () => {
    it('formats zero authors as Unknown, with the empty venue leaving a double space', () => {
      assert.equal(
        buildCitation('chicago', { authors: [], year: 2024, title: 'Anonymous Survey', venue: '' }),
        'Unknown. "Anonymous Survey."  (2024).',
      );
    });
    it('formats a single author verbatim', () => {
      assert.equal(
        buildCitation('chicago', { authors: ['John Smith'], year: 2024, title: 'Test Paper', venue: 'NeurIPS' }),
        'John Smith. "Test Paper." NeurIPS (2024).',
      );
    });
    it('joins many authors with commas', () => {
      assert.equal(
        buildCitation('chicago', { authors: ['Alice Johnson', 'Bob Williams', 'Carol Davis'], year: 2023, title: 'Group Paper', venue: 'ICML' }),
        'Alice Johnson, Bob Williams, Carol Davis. "Group Paper." ICML (2023).',
      );
    });
    it('treats any unrecognized style the same as the chicago default', () => {
      const args = { authors: ['John Smith'], year: 2024, title: 'Test Paper', venue: 'NeurIPS' };
      assert.equal(buildCitation('harvard', args), buildCitation('chicago', args));
    });
  });
});

// Representative entries covering 0, 1, and many authors.
const ENTRIES = {
  anon: { title: 'Anonymous Survey', year: 2024, venue: '' },
  solo: { title: 'Solo Paper', author: ['John Smith'], year: 2024, venue: 'NeurIPS' },
  team: { title: 'Group Paper', author: ['Alice Johnson', 'Bob Williams', 'Carol Davis'], year: 2023, venue: 'ICML' },
};
const STYLES = ['apa', 'mla', 'chicago'];

describe('GET /api/references/format and /format-all route through buildCitation', () => {
  for (const style of STYLES) {
    for (const key of Object.keys(ENTRIES)) {
      it(`/format and /format-all agree for key=${key} style=${style}`, async () => {
        const single = await callRoute('/api/references/format', ENTRIES, `?key=${key}&style=${style}`);
        assert.equal(single.status, 200);
        const all = await callRoute('/api/references/format-all', ENTRIES, `?style=${style}`);
        assert.equal(all.status, 200);
        const fromAll = all.body.references.find(r => r.key === key);
        assert.ok(fromAll, `format-all must include ${key}`);
        assert.equal(single.body.formatted, fromAll.citation);
      });

      it(`/format output matches buildCitation directly for key=${key} style=${style}`, async () => {
        const single = await callRoute('/api/references/format', ENTRIES, `?key=${key}&style=${style}`);
        const entry = ENTRIES[key];
        const expected = buildCitation(style, {
          authors: entry.author || [],
          year: entry.year || 'n.d.',
          title: entry.title || '',
          venue: entry.venue || '',
        });
        assert.equal(single.body.formatted, expected);
      });
    }
  }

  it('preserves the /format 404 path for an unknown key', async () => {
    const res = await callRoute('/api/references/format', ENTRIES, '?key=does-not-exist&style=apa');
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Reference not found' });
  });

  it('preserves the /format-all response envelope and citation sort order', async () => {
    const res = await callRoute('/api/references/format-all', ENTRIES, '?style=apa');
    assert.equal(res.status, 200);
    assert.equal(res.body.style, 'apa');
    assert.equal(res.body.total, Object.keys(ENTRIES).length);
    assert.equal(res.body.references.length, Object.keys(ENTRIES).length);
    const citations = res.body.references.map(r => r.citation);
    const sorted = [...citations].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(citations, sorted);
  });

  it('defaults to the apa style when none is supplied', async () => {
    const withDefault = await callRoute('/api/references/format', ENTRIES, '?key=solo');
    const explicit = await callRoute('/api/references/format', ENTRIES, '?key=solo&style=apa');
    assert.equal(withDefault.body.style, 'apa');
    assert.equal(withDefault.body.formatted, explicit.body.formatted);
  });
});
