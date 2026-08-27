import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The editor's recent-files list is keyed by a single shared constant. The
// module is authored as an ES module under src/utils (consumed by the
// Docusaurus build); Node's module-syntax detection lets this .mjs test import
// the .js source directly and read the named export.
import { RECENT_FILES_KEY } from '../../../../src/utils/recentFiles.js';

describe('recentFiles shared module', () => {
  it('exports RECENT_FILES_KEY as the canonical localStorage key', () => {
    assert.equal(RECENT_FILES_KEY, 'mochi-recent-files');
  });
});
