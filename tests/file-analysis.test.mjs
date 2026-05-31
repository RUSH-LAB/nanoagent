import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('file outline extraction', () => {
  function extractHeadings(content) {
    const headings = [];
    const lines = content.split('\n');
    let inCode = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('```')) { inCode = !inCode; continue; }
      if (inCode) continue;
      const match = line.match(/^(#{1,6})\s+(.+)$/);
      if (match) {
        headings.push({level: match[1].length, text: match[2].trim(), line: i + 1});
      }
    }
    return headings;
  }

  it('extracts h1 heading', () => {
    const h = extractHeadings('# Hello World');
    assert.equal(h.length, 1);
    assert.equal(h[0].level, 1);
    assert.equal(h[0].text, 'Hello World');
  });

  it('extracts multiple heading levels', () => {
    const h = extractHeadings('# Title\n## Section\n### Subsection');
    assert.equal(h.length, 3);
    assert.equal(h[0].level, 1);
    assert.equal(h[1].level, 2);
    assert.equal(h[2].level, 3);
  });

  it('skips headings in code blocks', () => {
    const h = extractHeadings('# Real\n```\n# In Code\n```\n## Also Real');
    assert.equal(h.length, 2);
    assert.equal(h[0].text, 'Real');
    assert.equal(h[1].text, 'Also Real');
  });

  it('returns empty for no headings', () => {
    const h = extractHeadings('Just some text\nwith no headings');
    assert.equal(h.length, 0);
  });

  it('includes correct line numbers', () => {
    const h = extractHeadings('text\n# Heading\nmore text');
    assert.equal(h[0].line, 2);
  });

  it('handles h6', () => {
    const h = extractHeadings('###### Deep Heading');
    assert.equal(h.length, 1);
    assert.equal(h[0].level, 6);
  });

  it('does not match lines without space after #', () => {
    const h = extractHeadings('#NoSpace\n# With Space');
    assert.equal(h.length, 1);
    assert.equal(h[0].text, 'With Space');
  });
});

describe('Jaccard similarity', () => {
  function jaccard(set1, set2) {
    let intersection = 0;
    for (const w of set1) if (set2.has(w)) intersection++;
    const union = new Set([...set1, ...set2]).size;
    return union > 0 ? Math.round((intersection / union) * 1000) / 1000 : 0;
  }

  it('returns 1 for identical sets', () => {
    const s = new Set(['a', 'b', 'c']);
    assert.equal(jaccard(s, s), 1);
  });

  it('returns 0 for disjoint sets', () => {
    assert.equal(jaccard(new Set(['a', 'b']), new Set(['c', 'd'])), 0);
  });

  it('returns correct value for partial overlap', () => {
    const s1 = new Set(['a', 'b', 'c']);
    const s2 = new Set(['b', 'c', 'd']);
    assert.equal(jaccard(s1, s2), 0.5);
  });

  it('handles empty sets', () => {
    assert.equal(jaccard(new Set(), new Set()), 0);
  });

  it('handles one empty set', () => {
    assert.equal(jaccard(new Set(['a']), new Set()), 0);
  });
});

describe('readability scoring', () => {
  function countSyllables(word) {
    const clean = word.toLowerCase().replace(/[^a-z]/g, '');
    if (!clean) return 1;
    let syllables = clean.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
    return Math.max(1, syllables ? syllables.length : 1);
  }

  it('counts syllables correctly for simple words', () => {
    assert.equal(countSyllables('the'), 1);
    assert.equal(countSyllables('machine'), 2);
    assert.equal(countSyllables('computer'), 3);
  });

  it('returns at least 1 for any word', () => {
    assert.ok(countSyllables('a') >= 1);
    assert.ok(countSyllables('xyz') >= 1);
  });

  it('handles empty/non-alpha input', () => {
    assert.equal(countSyllables(''), 1);
    assert.equal(countSyllables('123'), 1);
  });
});

describe('markdown lint', () => {
  function lintContent(content) {
    const issues = [];
    const lines = content.split('\n');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) {
      issues.push({line: 1, severity: 'warning', message: 'Missing frontmatter'});
    } else if (!/^title:/m.test(fmMatch[1])) {
      issues.push({line: 1, severity: 'warning', message: 'Missing title'});
    }
    let inCode = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('```')) { inCode = !inCode; continue; }
      if (inCode) continue;
      if (/^#{1,6}\s*$/.test(line)) {
        issues.push({line: i + 1, severity: 'warning', message: 'Empty heading'});
      }
    }
    if (inCode) {
      issues.push({line: lines.length, severity: 'error', message: 'Unclosed code block'});
    }
    return issues;
  }

  it('detects missing frontmatter', () => {
    const issues = lintContent('# Hello\nSome content');
    assert.ok(issues.some(i => i.message.includes('Missing frontmatter')));
  });

  it('detects missing title in frontmatter', () => {
    const issues = lintContent('---\ndate: 2025-01-01\n---\n# Hello');
    assert.ok(issues.some(i => i.message.includes('Missing title')));
  });

  it('no issues for valid content', () => {
    const issues = lintContent('---\ntitle: Hello\n---\n# Hello\nContent here');
    assert.equal(issues.length, 0);
  });

  it('detects empty heading', () => {
    const issues = lintContent('---\ntitle: Test\n---\n## \nContent');
    assert.ok(issues.some(i => i.message.includes('Empty heading')));
  });

  it('detects unclosed code block', () => {
    const issues = lintContent('---\ntitle: Test\n---\n```\ncode here');
    assert.ok(issues.some(i => i.message.includes('Unclosed code block')));
    assert.ok(issues.some(i => i.severity === 'error'));
  });

  it('does not flag code block headings', () => {
    const issues = lintContent('---\ntitle: Test\n---\n```\n## In Code\n```\n');
    const headingIssues = issues.filter(i => i.message.includes('Empty heading'));
    assert.equal(headingIssues.length, 0);
  });
});
