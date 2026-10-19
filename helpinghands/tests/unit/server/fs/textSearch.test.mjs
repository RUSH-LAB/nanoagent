import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const {matchesIn, lineMatches, replaceAll} = createRequire(import.meta.url)('../../../../src/server/fs/textSearch.js');

describe('workspace text search', () => {
  it('matches literally, ignoring case unless asked', () => {
    assert.deepEqual(matchesIn('a.b A.B', 'a.b'), [[0, 3], [4, 7]]);
    assert.deepEqual(matchesIn('a.b A.B', 'a.b', {matchCase: true}), [[0, 3]]);
    assert.deepEqual(matchesIn('(.*)', '.*'), [[1, 3]]);
  });

  it('matches whole words only when asked', () => {
    assert.deepEqual(matchesIn('cat concat cat_x cat.', 'cat', {wholeWord: true}), [[0, 3], [17, 20]]);
  });

  it('reports matches by line and column, at most the limit', () => {
    assert.deepEqual(lineMatches('one\ntwo two\r\nthree', 'two'), [
      {line: 2, column: 1, length: 3, preview: 'two two'},
      {line: 2, column: 5, length: 3, preview: 'two two'},
    ]);
    assert.equal(lineMatches('x x x', 'x', {}, 2).length, 2);
  });

  it('replaces every match and counts them', () => {
    assert.deepEqual(replaceAll('Foo foo', 'foo', 'bar'), {text: 'bar bar', count: 2});
    assert.deepEqual(replaceAll('Foo foo', 'foo', 'bar', {matchCase: true}), {text: 'Foo bar', count: 1});
  });
});
