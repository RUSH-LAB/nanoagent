import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {admits} = require('../../../../src/utils/runner.js');

describe('who the site lets in (utils/runner.js admits)', () => {
  it('lets in a member who runs in RUSH Lab cloud, whether or not a computer of theirs is connected', () => {
    assert.equal(admits({runner: 'cloud', cloud: true, connected: false}), true);
    assert.equal(admits({runner: 'cloud', cloud: true, connected: true}), true);
  });

  it('lets in a member who runs on their computer only once it is connected', () => {
    assert.equal(admits({runner: 'computer', cloud: true, connected: true}), true);
    assert.equal(admits({runner: 'computer', cloud: true, connected: false}), false);
    assert.equal(admits({runner: 'computer', cloud: false, connected: true}), true);
    assert.equal(admits({runner: 'computer', cloud: false, connected: false}), false);
  });

  it('lets nobody in on an answer that says neither', () => {
    for (const status of [null, undefined, {}, {connected: 'yes'}, {runner: 'laptop'}, {runner: 'Cloud'}, {connected: 1}]) {
      assert.equal(admits(status), false, JSON.stringify(status));
    }
  });
});
