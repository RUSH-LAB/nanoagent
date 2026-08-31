import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {migratedDatabase} from '../_harness.mjs';

const require = createRequire(import.meta.url);
const {createPreferences} = require('../../../src/server/preferences.js');

describe('global user preferences', () => {
  it('are keyed only by the authenticated user, not a workspace', () => {
    const preferences = createPreferences({db: migratedDatabase(), now: () => '2026-08-31T00:00:00.000Z'});
    preferences.merge('ada', {theme: 'dark'});
    assert.equal(preferences.get('ada').theme, 'dark');
    assert.deepEqual(preferences.get('grace'), {});
  });

  it('merges partial updates atomically', () => {
    const preferences = createPreferences({db: migratedDatabase(), now: () => '2026-08-31T00:00:00.000Z'});
    preferences.set('ada', {theme: 'dark', language: 'en'});
    assert.deepEqual(preferences.merge('ada', {theme: 'light'}), {
      theme: 'light', language: 'en', updatedAt: '2026-08-31T00:00:00.000Z',
    });
  });

  it('rejects an absent identity', () => {
    const preferences = createPreferences({db: migratedDatabase()});
    assert.throws(() => preferences.get(null), /signed-in user/);
  });
});
