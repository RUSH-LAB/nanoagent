import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {inferBibtexType, paperToBibtex} = require('../../../../plugins/bibliography/lib/protocol');

describe('bibliography venue-regex inproceedings export', () => {
  const key = 'paper2026';
  const paper = {
    type: 'misc',
    title: 'A Paper',
    author: ['Ada Lovelace'],
    year: 2026,
    venue: 'International Workshop on Reliable Systems',
  };

  it('infers inproceedings from a conference-like venue', () => {
    assert.equal(inferBibtexType(paper), 'inproceedings');
  });

  it('emits an inproceedings header and booktitle field', () => {
    const bib = paperToBibtex(key, paper);
    assert.ok(bib.startsWith(`@inproceedings{${key},`));
    assert.ok(bib.includes(`\n  booktitle = {${paper.venue}}`));
    assert.ok(!bib.includes('journal ='));
    assert.ok(!bib.includes('publisher ='));
    assert.ok(!bib.includes('howpublished ='));
  });
});
