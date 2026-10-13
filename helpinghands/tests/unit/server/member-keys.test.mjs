import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {sealingKey, seal, open, keyHint, checkChanges} = require('../../../src/server/postgres/member-keys.js');

describe('members\' own API keys, kept by Mochi (postgres/member-keys.js)', () => {
  const key = sealingKey('a'.repeat(64));

  it('seals a key so only its member and name open it', () => {
    const sealed = seal(key, 'u1', 'OPENROUTER_API_KEY', 'sk-or-v1-secret');
    assert.ok(!sealed.includes('sk-or'));
    assert.notEqual(sealed, seal(key, 'u1', 'OPENROUTER_API_KEY', 'sk-or-v1-secret'));
    assert.equal(open(key, 'u1', 'OPENROUTER_API_KEY', sealed), 'sk-or-v1-secret');
    assert.throws(() => open(key, 'u2', 'OPENROUTER_API_KEY', sealed));
    assert.throws(() => open(key, 'u1', 'OPENAI_API_KEY', sealed));
    assert.throws(() => open(sealingKey('b'.repeat(64)), 'u1', 'OPENROUTER_API_KEY', sealed));
  });

  it('shows a key by its hint alone', () => {
    assert.equal(keyHint('sk-or-v1-0123456789abcdef'), 'sk-or-…cdef');
    assert.equal(keyHint('short'), '…');
  });

  it('keeps only the keys it names, each one key or null', () => {
    assert.deepEqual(checkChanges({OPENROUTER_API_KEY: ' sk-1 '}), {value: [['OPENROUTER_API_KEY', 'sk-1']]});
    assert.deepEqual(checkChanges({OPENROUTER_API_KEY: null}), {value: [['OPENROUTER_API_KEY', null]]});
    assert.match(checkChanges({}).error, /at least one/);
    assert.match(checkChanges({OPENAI_API_KEY: 'sk'}).error, /not a key Mochi keeps/);
    assert.match(checkChanges({OPENROUTER_API_KEY: 'two words'}).error, /without spaces/);
    assert.match(checkChanges({OPENROUTER_API_KEY: ''}).error, /without spaces/);
  });
});
