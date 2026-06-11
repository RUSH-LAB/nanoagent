import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeMetadataSources } = require('../server/server-utils.js');

describe('LaTeX conversion', () => {
  function mdToLatex(md) {
    let latex = md;
    latex = latex.replace(/^# (.+)$/gm, '\\section{$1}');
    latex = latex.replace(/^## (.+)$/gm, '\\subsection{$1}');
    latex = latex.replace(/^### (.+)$/gm, '\\subsubsection{$1}');
    latex = latex.replace(/\*\*(.+?)\*\*/g, '\\textbf{$1}');
    latex = latex.replace(/\*(.+?)\*/g, '\\textit{$1}');
    latex = latex.replace(/`([^`]+)`/g, '\\texttt{$1}');
    return latex;
  }

  it('converts h1 to section', () => {
    assert.ok(mdToLatex('# Title').includes('\\section{Title}'));
  });

  it('converts h2 to subsection', () => {
    assert.ok(mdToLatex('## Sub').includes('\\subsection{Sub}'));
  });

  it('converts h3 to subsubsection', () => {
    assert.ok(mdToLatex('### SubSub').includes('\\subsubsection{SubSub}'));
  });

  it('converts bold to textbf', () => {
    assert.ok(mdToLatex('**bold**').includes('\\textbf{bold}'));
  });

  it('converts italic to textit', () => {
    assert.ok(mdToLatex('*italic*').includes('\\textit{italic}'));
  });

  it('converts inline code to texttt', () => {
    assert.ok(mdToLatex('`code`').includes('\\texttt{code}'));
  });

  it('handles mixed formatting', () => {
    const result = mdToLatex('# Title\n**bold** and *italic* with `code`');
    assert.ok(result.includes('\\section'));
    assert.ok(result.includes('\\textbf'));
    assert.ok(result.includes('\\textit'));
    assert.ok(result.includes('\\texttt'));
  });
});

describe('LaTeX special character escaping', () => {
  function escapeLatex(str) {
    return str.replace(/[&%$#_{}~^\\]/g, s => '\\' + s);
  }

  it('escapes ampersand', () => assert.equal(escapeLatex('A&B'), 'A\\&B'));
  it('escapes percent', () => assert.equal(escapeLatex('100%'), '100\\%'));
  it('escapes dollar', () => assert.equal(escapeLatex('$5'), '\\$5'));
  it('escapes hash', () => assert.equal(escapeLatex('#1'), '\\#1'));
  it('escapes underscore', () => assert.equal(escapeLatex('a_b'), 'a\\_b'));
  it('preserves normal text', () => assert.equal(escapeLatex('Hello World'), 'Hello World'));
});

describe('reference title normalization for dedup', () => {
  function normalize(title) {
    return (title || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  }

  it('lowercases', () => assert.equal(normalize('Hello World'), 'hello world'));
  it('removes punctuation', () => assert.equal(normalize('Title: A Study!'), 'title a study'));
  it('trims whitespace', () => assert.equal(normalize('  spaced  '), 'spaced'));
  it('handles empty', () => assert.equal(normalize(''), ''));
  it('handles null', () => assert.equal(normalize(null), ''));
  it('removes special chars', () => assert.equal(normalize('AT&T: 100% Study'), 'att 100 study'));
});

describe('duplicate detection grouping', () => {
  function findDuplicates(entries) {
    const titleMap = {};
    for (const [key, entry] of entries) {
      const norm = (entry.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
      if (norm.length < 5) continue;
      if (!titleMap[norm]) titleMap[norm] = [];
      titleMap[norm].push({key, title: entry.title});
    }
    return Object.values(titleMap).filter(g => g.length > 1);
  }

  it('finds exact duplicates', () => {
    const entries = [['a', {title: 'Same Paper'}], ['b', {title: 'Same Paper'}]];
    assert.equal(findDuplicates(entries).length, 1);
  });

  it('finds case-insensitive duplicates', () => {
    const entries = [['a', {title: 'Same Paper'}], ['b', {title: 'same paper'}]];
    assert.equal(findDuplicates(entries).length, 1);
  });

  it('ignores unique titles', () => {
    const entries = [['a', {title: 'Paper A'}], ['b', {title: 'Paper B'}]];
    assert.equal(findDuplicates(entries).length, 0);
  });

  it('skips very short titles', () => {
    const entries = [['a', {title: 'Hi'}], ['b', {title: 'Hi'}]];
    assert.equal(findDuplicates(entries).length, 0);
  });
});

describe('mergeMetadataSources', () => {
  it('fills each missing field from whichever source has it', () => {
    const merged = mergeMetadataSources({
      semanticScholar: {title: 'Attention Is All You Need', year: 2017, citationCount: 100000},
      crossref: {doi: '10.1234/abc', publisher: 'ACM'},
      dblp: {venue: 'NeurIPS'},
    });
    assert.equal(merged.title, 'Attention Is All You Need');
    assert.equal(merged.year, 2017);
    assert.equal(merged.citationCount, 100000);
    assert.equal(merged.doi, '10.1234/abc');
    assert.equal(merged.publisher, 'ACM');
    assert.equal(merged.venue, 'NeurIPS');
  });

  it('keeps a zero-valued field rather than treating it as missing', () => {
    const merged = mergeMetadataSources({
      crossref: {citationCount: 0},
      semanticScholar: {citationCount: 5},
    });
    // 0 is a real value: the higher-precedence CrossRef 0 must win over the
    // lower-precedence Semantic Scholar 5, never fall through as if absent.
    assert.equal(merged.citationCount, 0);
  });

  it('applies deterministic field precedence across sources', () => {
    const merged = mergeMetadataSources({
      semanticScholar: {title: 'S2 Title', doi: 's2-doi', venue: 'S2 Venue', year: 2000},
      crossref: {title: 'CrossRef Title', doi: 'crossref-doi', venue: 'CrossRef Venue', year: 2001},
      dblp: {title: 'DBLP Title', doi: 'dblp-doi', venue: 'DBLP Venue', year: 2002},
    });
    assert.equal(merged.doi, 'crossref-doi'); // CrossRef wins for DOI
    assert.equal(merged.venue, 'DBLP Venue'); // DBLP wins for venue
    assert.equal(merged.title, 'CrossRef Title'); // default order: CrossRef first
    assert.equal(merged.year, 2001); // default order: CrossRef first
  });

  it('de-duplicates authors across name formats, keeping the fuller spelling', () => {
    const merged = mergeMetadataSources({
      crossref: {authors: ['John Doe', 'Jane Smith']},
      semanticScholar: {authors: ['J. Doe', 'Jane Smith', 'Bob Lee']},
    });
    assert.deepEqual(merged.authors, ['John Doe', 'Jane Smith', 'Bob Lee']);
    assert.ok(!merged.authors.includes('J. Doe'));
  });

  it('keeps distinct full first names with the same initial separate', () => {
    const merged = mergeMetadataSources({
      crossref: {authors: ['John Doe']},
      semanticScholar: {authors: ['Jane Doe']},
    });
    assert.deepEqual(merged.authors, ['John Doe', 'Jane Doe']);
  });

  it('ignores prototype-polluting field names without throwing', () => {
    // Own __proto__/constructor keys (as JSON.parse produces) must not crash the
    // precedence lookup or pollute the output, while normal fields still merge.
    const evil = JSON.parse('{"__proto__": {"polluted": true}, "constructor": "x", "title": "Safe", "doi": "10.1/ok"}');
    let merged;
    assert.doesNotThrow(() => { merged = mergeMetadataSources({crossref: evil}); });
    assert.equal(merged.title, 'Safe');
    assert.equal(merged.doi, '10.1/ok');
    assert.ok(!Object.prototype.hasOwnProperty.call(merged, 'constructor'));
    assert.equal({}.polluted, undefined);
  });

  it('returns {} for empty, missing, or partial input without throwing', () => {
    assert.deepEqual(mergeMetadataSources({}), {});
    assert.deepEqual(mergeMetadataSources(), {});
    assert.deepEqual(mergeMetadataSources(null), {});
    assert.deepEqual(mergeMetadataSources({semanticScholar: null, crossref: null, dblp: null}), {});
    assert.deepEqual(mergeMetadataSources({crossref: {doi: 'x'}}), {doi: 'x'});
  });
});
