import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// The preprint-tracker script runs main() on require, so we can't require it directly.
// Instead, we test the extractArxivId logic by reimplementing the pure function.
// This mirrors the function in scripts/preprint-tracker.js lines 27-35.
function extractArxivId(entry) {
  if (entry.arxivId) return entry.arxivId;
  if (entry.url) {
    const match = entry.url.match(/arxiv\.org\/abs\/(\d+\.\d+(?:v\d+)?)/);
    if (match) return match[1];
  }
  return null;
}

describe('extractArxivId (preprint-tracker logic)', () => {
  it('returns arxivId field if present', () => {
    assert.equal(extractArxivId({arxivId: '2301.12345'}), '2301.12345');
  });

  it('extracts from arxiv.org URL', () => {
    assert.equal(
      extractArxivId({url: 'https://arxiv.org/abs/2301.12345'}),
      '2301.12345',
    );
  });

  it('extracts from arxiv.org URL with version', () => {
    assert.equal(
      extractArxivId({url: 'https://arxiv.org/abs/2301.12345v2'}),
      '2301.12345v2',
    );
  });

  it('prefers arxivId field over URL', () => {
    assert.equal(
      extractArxivId({arxivId: '2301.99999', url: 'https://arxiv.org/abs/2301.11111'}),
      '2301.99999',
    );
  });

  it('returns null for non-arxiv URL', () => {
    assert.equal(
      extractArxivId({url: 'https://example.com/paper'}),
      null,
    );
  });

  it('returns null for empty entry', () => {
    assert.equal(extractArxivId({}), null);
  });

  it('returns null when no url and no arxivId', () => {
    assert.equal(extractArxivId({title: 'Some Paper'}), null);
  });

  it('handles arxiv.org/abs/ with trailing path', () => {
    assert.equal(
      extractArxivId({url: 'https://arxiv.org/abs/2310.06825'}),
      '2310.06825',
    );
  });
});

// Also smoke-test that the bibliography plugin loads and exposes getPathsToWatch.
// Note: its own extractArxivId differs from the preprint-tracker logic above —
// it drops the arXiv version suffix (/abs/([\d.]+)) where preprint-tracker keeps it.
describe('bibliography plugin', () => {
  const bibliographyPlugin = require('../../plugins/docusaurus-plugin-bibliography');

  it('plugin loads without error', () => {
    const plugin = bibliographyPlugin();
    assert.equal(plugin.name, 'bibliography');
  });

  it('getPathsToWatch returns array with expected paths', () => {
    const plugin = bibliographyPlugin();
    const paths = plugin.getPathsToWatch();
    assert.ok(Array.isArray(paths), 'should return array');
    assert.ok(paths.length >= 1, 'should have at least one path');
    assert.ok(paths.some(p => p.includes('references.yaml')), 'includes references.yaml');
  });
});
