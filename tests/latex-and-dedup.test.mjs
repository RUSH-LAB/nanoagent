import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

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
