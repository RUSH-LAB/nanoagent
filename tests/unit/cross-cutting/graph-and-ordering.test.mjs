import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('DOT format generation', () => {
  function toDot(nodes, edges) {
    const esc = s => s.replace(/"/g, '\\"');
    let dot = 'digraph G {\n';
    for (const n of nodes) dot += `  "${esc(n)}";\n`;
    for (const e of edges) dot += `  "${esc(e.from)}" -> "${esc(e.to)}";\n`;
    dot += '}\n';
    return dot;
  }

  it('generates valid DOT with nodes', () => {
    const dot = toDot(['a', 'b'], []);
    assert.ok(dot.includes('digraph G'));
    assert.ok(dot.includes('"a"'));
    assert.ok(dot.includes('"b"'));
  });

  it('generates edges', () => {
    const dot = toDot(['a', 'b'], [{from: 'a', to: 'b'}]);
    assert.ok(dot.includes('"a" -> "b"'));
  });

  it('escapes quotes in node names', () => {
    const dot = toDot(['a"b'], []);
    assert.ok(dot.includes('a\\"b'));
  });

  it('handles empty graph', () => {
    const dot = toDot([], []);
    assert.ok(dot.includes('digraph G'));
    assert.ok(dot.includes('}'));
  });
});

describe('topological sort for reading order', () => {
  function topoSort(keys, deps) {
    const visited = new Set();
    const order = [];
    function visit(key) {
      if (visited.has(key)) return;
      visited.add(key);
      for (const dep of (deps[key] || [])) visit(dep);
      order.push(key);
    }
    for (const key of keys) visit(key);
    return order;
  }

  it('sorts independent items in order', () => {
    const result = topoSort(['a', 'b', 'c'], {});
    assert.equal(result.length, 3);
  });

  it('puts dependencies before dependents', () => {
    const result = topoSort(['b', 'a'], {b: ['a']});
    assert.ok(result.indexOf('a') < result.indexOf('b'));
  });

  it('handles chain dependencies', () => {
    const result = topoSort(['c', 'b', 'a'], {c: ['b'], b: ['a']});
    assert.ok(result.indexOf('a') < result.indexOf('b'));
    assert.ok(result.indexOf('b') < result.indexOf('c'));
  });

  it('handles no dependencies', () => {
    const result = topoSort(['x'], {});
    assert.deepEqual(result, ['x']);
  });

  it('handles empty input', () => {
    assert.deepEqual(topoSort([], {}), []);
  });
});

describe('citation year ordering', () => {
  function orderByYear(papers) {
    return [...papers].sort((a, b) => (a.year || 9999) - (b.year || 9999));
  }

  it('sorts by year ascending', () => {
    const result = orderByYear([{key: 'b', year: 2020}, {key: 'a', year: 2018}]);
    assert.equal(result[0].key, 'a');
  });

  it('puts unknown years last', () => {
    const result = orderByYear([{key: 'a', year: null}, {key: 'b', year: 2020}]);
    assert.equal(result[0].key, 'b');
  });

  it('handles all same year', () => {
    const result = orderByYear([{key: 'a', year: 2020}, {key: 'b', year: 2020}]);
    assert.equal(result.length, 2);
  });
});

describe('xref matrix building', () => {
  function buildMatrix(pages, links) {
    const matrix = {};
    for (const p of pages) matrix[p] = new Set();
    for (const link of links) {
      if (matrix[link.from]) matrix[link.from].add(link.to);
    }
    return Object.fromEntries(Object.entries(matrix).map(([k, v]) => [k, [...v]]));
  }

  it('creates empty matrix for pages with no links', () => {
    const m = buildMatrix(['a', 'b'], []);
    assert.deepEqual(m.a, []);
    assert.deepEqual(m.b, []);
  });

  it('records outgoing links', () => {
    const m = buildMatrix(['a', 'b'], [{from: 'a', to: 'b'}]);
    assert.deepEqual(m.a, ['b']);
    assert.deepEqual(m.b, []);
  });

  it('handles multiple links from one page', () => {
    const m = buildMatrix(['a', 'b', 'c'], [{from: 'a', to: 'b'}, {from: 'a', to: 'c'}]);
    assert.equal(m.a.length, 2);
  });
});

describe('content coverage percentage', () => {
  function coverage(cited, total) {
    return total > 0 ? Math.round((cited / total) * 100) : 0;
  }

  it('returns 100 for full coverage', () => {
    assert.equal(coverage(10, 10), 100);
  });

  it('returns 50 for half', () => {
    assert.equal(coverage(5, 10), 50);
  });

  it('returns 0 for no coverage', () => {
    assert.equal(coverage(0, 10), 0);
  });

  it('handles zero total', () => {
    assert.equal(coverage(0, 0), 0);
  });
});
