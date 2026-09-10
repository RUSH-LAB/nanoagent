import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {
  PAPER_SCHEMA,
  normalizePaper,
  paperForStorage,
  validatePaper,
  citationKeyFor,
  paperToBibtex,
  isIntegrationTestPaper,
} = require('../../../../../plugins/bibliography/lib/protocol.js');

describe('Mochi Paper Protocol v2', () => {
  it('upgrades an old arXiv entry into the canonical shape', () => {
    const paper = normalizePaper('vaswani2017', {
      title: 'Attention Is All You Need',
      author: ['Ashish Vaswani'],
      year: '2017',
      url: 'https://arxiv.org/abs/1706.03762',
      tags: ['Transformers', ' transformers ', 'Foundational'],
    });

    assert.equal(paper.schema, PAPER_SCHEMA);
    assert.equal(paper.key, 'vaswani2017');
    assert.deepEqual(paper.authors, ['Ashish Vaswani']);
    assert.equal(paper.arxivId, '1706.03762');
    assert.deepEqual(paper.source, {
      type: 'arxiv',
      id: '1706.03762',
      url: 'https://arxiv.org/abs/1706.03762',
      provider: null,
    });
    assert.equal(paper.officialUrl, 'https://arxiv.org/abs/1706.03762');
    assert.equal(paper.pdfUrl, 'https://arxiv.org/pdf/1706.03762.pdf');
    assert.deepEqual(paper.tags, ['Transformers', 'Foundational']);
  });

  it('uses plural authors as the canonical field while accepting legacy author input', () => {
    const canonical = normalizePaper('paper', {
      title: 'Paper', authors: ['Ada Lovelace'], year: 1843, venue: 'Notes',
    });
    assert.deepEqual(canonical.authors, ['Ada Lovelace']);
    assert.deepEqual(canonical.author, canonical.authors);
    assert.deepEqual(paperForStorage(canonical).authors, ['Ada Lovelace']);
  });

  it('keeps the official page separate from a directly viewable PDF', () => {
    const paper = normalizePaper('paper', {
      title: 'A Paper',
      source: {type: 'publisher', id: 'paper-1', url: 'https://publisher.test/paper'},
      officialUrl: 'https://publisher.test/paper',
      pdfUrl: 'https://publisher.test/paper.pdf',
    });
    assert.equal(paper.source.type, 'publisher');
    assert.equal(paper.officialUrl, 'https://publisher.test/paper');
    assert.equal(paper.pdfUrl, 'https://publisher.test/paper.pdf');
  });

  it('normalizes DOI URLs into a DOI source', () => {
    const paper = normalizePaper('doi-paper', {
      title: 'A DOI Paper',
      doi: 'https://doi.org/10.1000/Example',
    });
    assert.equal(paper.doi, '10.1000/Example');
    assert.equal(paper.source.type, 'doi');
    assert.equal(paper.officialUrl, 'https://doi.org/10.1000/Example');
  });

  it('writes only protocol fields to storage', () => {
    const stored = paperForStorage({
      title: 'Stored', author: ['Ada Lovelace'], year: 2024,
      url: 'https://example.test/paper', tags: ['math'],
      bibtex: 'derived', notes: 'elsewhere', raw: {hasPdf: true},
    });
    assert.equal(stored.schema, PAPER_SCHEMA);
    assert.equal(stored.officialUrl, 'https://example.test/paper');
    assert.deepEqual(stored.tags, ['math']);
    assert.equal('bibtex' in stored, false);
    assert.equal('notes' in stored, false);
    assert.equal('raw' in stored, false);
  });

  it('requires a title', () => {
    assert.deepEqual(validatePaper({source: {type: 'manual'}}).errors, ['title is required']);
  });

  it('generates stable collision-free citation keys', () => {
    const paper = {title: 'Computing', author: ['Ada Lovelace'], year: 1843};
    assert.equal(citationKeyFor(paper), 'lovelace1843');
    assert.equal(citationKeyFor(paper, ['lovelace1843']), 'lovelace1843a');
  });

  it('exports canonical links and conference venues to BibTeX', () => {
    const bib = paperToBibtex('vaswani2017', {
      title: 'Attention & Transformers', author: ['Ashish Vaswani'], year: 2017,
      venue: 'NeurIPS', doi: '10.1/example', officialUrl: 'https://doi.org/10.1/example',
    });
    assert.ok(bib.startsWith('@inproceedings{vaswani2017,'));
    assert.ok(bib.includes('title = {Attention \\& Transformers}'));
    assert.ok(bib.includes('booktitle = {NeurIPS}'));
    assert.ok(bib.includes('url = {https://doi.org/10.1/example}'));
  });

  it('recognizes only the integration fixtures that must never become papers', () => {
    assert.equal(isIntegrationTestPaper('__test_1780134850531_import', {title: 'Imported Test Paper'}), true);
    assert.equal(isIntegrationTestPaper('wftest-1780241027128_ref', {title: 'Workflow Test Reference Paper'}), true);
    assert.equal(isIntegrationTestPaper('author2025', {title: 'Test Paper __rem_1788057713997'}), true);
    assert.equal(isIntegrationTestPaper('real2025', {title: 'A Real Test of Generalization'}), false);
  });
});
