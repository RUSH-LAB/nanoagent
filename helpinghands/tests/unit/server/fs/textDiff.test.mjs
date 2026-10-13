import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {changedRange} = require('../../../../src/server/fs/textDiff.js');

const apply = (text, {from, to, insert}) => text.slice(0, from) + insert + text.slice(to);

describe('changedRange', () => {
  it('is null for equal texts', () => {
    assert.equal(changedRange('same', 'same'), null);
  });

  it('spans only what lies between the common prefix and suffix', () => {
    assert.deepEqual(changedRange('The quick brown fox', 'The quick red fox'), {from: 10, to: 15, insert: 'red'});
    assert.deepEqual(changedRange('ab', 'axb'), {from: 1, to: 1, insert: 'x'});
    assert.deepEqual(changedRange('axb', 'ab'), {from: 1, to: 2, insert: ''});
  });

  it('never counts a character in both the prefix and the suffix', () => {
    for (const [current, target] of [['aa', 'aaa'], ['aaa', 'a'], ['', 'abc'], ['abc', ''], ['abab', 'ab']]) {
      assert.equal(apply(current, changedRange(current, target)), target);
    }
  });
});
