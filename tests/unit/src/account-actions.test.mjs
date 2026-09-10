import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

describe('account actions', () => {
  it('keeps sign-out in the navbar account menu instead of the settings page', () => {
    const userButton = read('src/components/UserButton/index.js');
    const settings = read('src/pages/settings/index.js');
    assert.match(userButton, /signOutAndForget/);
    assert.match(userButton, /'Sign out'/);
    assert.doesNotMatch(settings, /signOutAndForget|>\s*Sign out/);
  });
});
