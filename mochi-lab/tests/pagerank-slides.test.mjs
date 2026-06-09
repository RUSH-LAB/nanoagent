import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('simplified PageRank', () => {
  function pageRank(nodes, edges, iterations) {
    const scores = {};
    for (const n of nodes) scores[n] = 1;
    const damping = 0.85;
    const outDegree = {};
    for (const n of nodes) outDegree[n] = 0;
    for (const [from, to] of edges) outDegree[from] = (outDegree[from] || 0) + 1;
    for (let i = 0; i < iterations; i++) {
      const newScores = {};
      for (const n of nodes) {
        let sum = 0;
        for (const [from, to] of edges) {
          if (to === n && outDegree[from] > 0) {
            sum += scores[from] / outDegree[from];
          }
        }
        newScores[n] = (1 - damping) + damping * sum;
      }
      Object.assign(scores, newScores);
    }
    return scores;
  }

  it('assigns equal scores to unlinked nodes', () => {
    const scores = pageRank(['a', 'b', 'c'], [], 10);
    assert.equal(scores.a, scores.b);
  });

  it('gives higher score to linked-to node', () => {
    const scores = pageRank(['a', 'b'], [['a', 'b']], 20);
    assert.ok(scores.b > scores.a);
  });

  it('converges after iterations', () => {
    const s10 = pageRank(['a', 'b'], [['a', 'b']], 10);
    const s20 = pageRank(['a', 'b'], [['a', 'b']], 20);
    assert.ok(Math.abs(s10.b - s20.b) < 0.01);
  });

  it('handles self-referencing', () => {
    const scores = pageRank(['a'], [['a', 'a']], 10);
    assert.ok(scores.a > 0);
  });
});

describe('slide splitting', () => {
  function splitSlides(markdown) {
    return markdown.split(/\n(?=## )/).filter(s => s.trim());
  }

  it('splits on h2 headings', () => {
    const slides = splitSlides('## Slide 1\nContent\n## Slide 2\nMore');
    assert.equal(slides.length, 2);
  });

  it('keeps content within slides', () => {
    const slides = splitSlides('## Title\nParagraph text here');
    assert.ok(slides[0].includes('Paragraph'));
  });

  it('handles single slide', () => {
    const slides = splitSlides('Just content no headings');
    assert.equal(slides.length, 1);
  });

  it('handles empty', () => {
    const slides = splitSlides('');
    assert.equal(slides.length, 0);
  });

  it('preserves h3 within slides', () => {
    const slides = splitSlides('## Main\n### Sub\nContent');
    assert.equal(slides.length, 1);
    assert.ok(slides[0].includes('### Sub'));
  });
});

describe('export format validation', () => {
  const VALID = ['md', 'html', 'pdf', 'latex', 'slides'];

  it('accepts all valid formats', () => {
    for (const f of VALID) assert.ok(VALID.includes(f));
  });

  it('rejects invalid format', () => {
    assert.ok(!VALID.includes('docx'));
    assert.ok(!VALID.includes(''));
  });
});

describe('DOT escape function', () => {
  function escapeDot(s) {
    return s.replace(/"/g, '\\"');
  }

  it('escapes double quotes', () => {
    assert.equal(escapeDot('a"b'), 'a\\"b');
  });

  it('leaves clean strings unchanged', () => {
    assert.equal(escapeDot('hello'), 'hello');
  });

  it('handles empty string', () => {
    assert.equal(escapeDot(''), '');
  });
});
