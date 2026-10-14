import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {platformConfig} = require('../../src/platform.js');

describe('platform deployment identity', () => {
  it('has a neutral product default independent of workspace data', () => {
    assert.deepEqual(platformConfig({}), {
      name: 'RUSH Lab',
      tagline: 'Collaborative knowledge workspaces',
    });
  });

  it('accepts deployment overrides and trims them', () => {
    assert.deepEqual(platformConfig({PLATFORM_NAME: ' Atlas ', PLATFORM_TAGLINE: ' Knowledge '}), {
      name: 'Atlas',
      tagline: 'Knowledge',
    });
  });
});
