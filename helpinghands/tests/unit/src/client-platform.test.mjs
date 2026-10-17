import assert from 'node:assert/strict';
import {afterEach, describe, it} from 'node:test';

import {
  clientPlatform,
  installClientPlatform,
  resetClientPlatform,
} from '../../../src/platform/client.js';
import {resolveApiBase} from '../../../src/utils/api.js';

afterEach(() => resetClientPlatform());

function adapter(overrides = {}) {
  return {
    kind: 'test',
    capabilities: {filesystem: false, terminal: false},
    runtimeConfig: () => ({}),
    location: {},
    storage: {},
    clipboard: {},
    dialogs: {},
    notifications: {},
    ...overrides,
  };
}

describe('client platform facade', () => {
  it('routes client integrations through an installed adapter', async () => {
    const writes = [];
    const visits = [];
    installClientPlatform(adapter({
      kind: 'desktop',
      capabilities: {filesystem: true, terminal: true},
      runtimeConfig: () => ({apiBaseUrl: 'https://mochi.example'}),
      location: {
        href: () => 'app://mochi/workspace',
        assign: target => visits.push(target),
      },
      storage: {
        getItem: key => key === 'remembered' ? 'yes' : null,
        setItem: (key, value) => writes.push([key, value]),
        removeItem: () => {},
        keys: () => [],
      },
      clipboard: {writeText: text => writes.push(['clipboard', text])},
      dialogs: {alert: () => {}, confirm: async () => true, prompt: () => 'answer'},
    }));

    assert.equal(clientPlatform.kind, 'desktop');
    assert.equal(clientPlatform.capabilities.filesystem, true);
    assert.deepEqual(clientPlatform.runtimeConfig(), {apiBaseUrl: 'https://mochi.example'});
    assert.equal(clientPlatform.location.href(), 'app://mochi/workspace');
    assert.equal(clientPlatform.storage.getItem('remembered'), 'yes');
    clientPlatform.storage.setItem('key', 'value');
    await clientPlatform.clipboard.writeText('copied');
    clientPlatform.location.assign('/next');
    assert.equal(await clientPlatform.dialogs.confirm('Continue?'), true);
    assert.equal(await clientPlatform.dialogs.prompt('Name?'), 'answer');
    assert.equal(await clientPlatform.dialogs.alert('Done'), undefined);
    assert.deepEqual(writes, [['key', 'value'], ['clipboard', 'copied']]);
    assert.deepEqual(visits, ['/next']);
  });

  it('makes unavailable optional capabilities safe', async () => {
    installClientPlatform(adapter());
    assert.equal(clientPlatform.storage.getItem('missing'), null);
    assert.equal(clientPlatform.notifications.permission(), 'unsupported');
    await assert.rejects(clientPlatform.clipboard.writeText('copy'), /unavailable/);
  });

  it('refuses a dialog a platform cannot show, rather than answering for the member', async () => {
    installClientPlatform(adapter());
    await assert.rejects(clientPlatform.dialogs.confirm('Continue?'), /no confirm dialog/);
    await assert.rejects(clientPlatform.dialogs.prompt('Name?'), /no prompt dialog/);
    await assert.rejects(clientPlatform.dialogs.alert('Done'), /no alert dialog/);
  });

  it('removes only storage keys selected by the caller', () => {
    const removed = [];
    installClientPlatform(adapter({
      storage: {
        keys: () => ['mochi-cli-sessions:a', 'unrelated', 'mochi-cli-sessions:b'],
        removeItem: key => removed.push(key),
      },
    }));
    clientPlatform.storage.removeMatching(key => key.startsWith('mochi-cli-sessions:'));
    assert.deepEqual(removed, ['mochi-cli-sessions:a', 'mochi-cli-sessions:b']);
  });
});

describe('runtime API configuration', () => {
  it('uses an explicit desktop or hosted API origin', () => {
    assert.equal(resolveApiBase({configured: ' https://api.example.com/ ', hostname: 'tauri.localhost'}), 'https://api.example.com');
  });

  it('otherwise uses the page\'s own origin', () => {
    assert.equal(resolveApiBase({configured: ' '}), '');
    assert.equal(resolveApiBase(), '');
  });
});
