import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {inferBibtexType, paperToBibtex} = require('../../../../plugins/bibliography/lib/protocol');

describe('bibliography misc venue export', () => {
  const key = 'manual2026';
  const paper = {
    type: 'misc',
    title: 'Technical Notes',
    author: ['Grace Hopper'],
    year: 2026,
    venue: 'Mochi Lab Notes',
  };

  it('keeps a non-conference miscellaneous record as misc', () => {
    assert.equal(inferBibtexType(paper), 'misc');
  });

  it('maps its venue to howpublished only', () => {
    const bib = paperToBibtex(key, paper);
    assert.ok(bib.startsWith(`@misc{${key},`));
    assert.ok(bib.includes(`howpublished = {${paper.venue}}`));
    assert.ok(!bib.includes('journal ='));
    assert.ok(!bib.includes('booktitle ='));
  });
});
