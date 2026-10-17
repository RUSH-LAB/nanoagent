/**
 * server/cloud-runs.js: whether a deployment offers RUSH Lab cloud, where each
 * member's runs go, and how they choose. The routing of a run is
 * runner.test.mjs's; this is the choice it reads.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {createCloudRuns, cloudRunsOffered, RUNNERS} = require('../../../src/server/cloud-runs.js');
const {createPreferences} = require('../../../src/server/preferences.js');

/** The SQLite preferences the unit suites use, on a scratch database of their own. */
function scratchPreferences() {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE user_preferences ("userId" TEXT PRIMARY KEY, "value" TEXT NOT NULL, "updatedAt" TEXT NOT NULL)');
  return createPreferences({db});
}

const GATEWAY = Object.freeze({local: false, name: 'mochi-nanoagent'});

describe('RUSH Lab cloud, offered or not (CLOUD_RUNS)', () => {
  it('is offered only when CLOUD_RUNS is on, and off while it is unset or empty', () => {
    assert.equal(cloudRunsOffered({CLOUD_RUNS: 'on'}), true);
    assert.equal(cloudRunsOffered({}), false);
    assert.equal(cloudRunsOffered({CLOUD_RUNS: ''}), false);
  });

  it('refuses any other value, so a typo cannot turn it on or off unseen', () => {
    for (const value of ['true', '1', 'ON', 'yes', 'off', ' on']) {
      assert.throws(() => cloudRunsOffered({CLOUD_RUNS: value}), new RegExp(`CLOUD_RUNS must be "on" or unset, not ${JSON.stringify(JSON.stringify(value)).slice(1, -1)}`));
      assert.throws(() => createCloudRuns({env: {CLOUD_RUNS: value}, gateway: GATEWAY, preferences: scratchPreferences()}), /CLOUD_RUNS must be/);
    }
  });

  it('names its two runners', () => {
    assert.deepEqual([...RUNNERS], ['cloud', 'computer']);
    assert.ok(Object.isFrozen(RUNNERS));
  });
});

describe('where a member\'s runs go (runnerOf)', () => {
  it('is the member\'s computer for a member who has not chosen, where RUSH Lab cloud is offered too', async () => {
    const cloud = createCloudRuns({env: {CLOUD_RUNS: 'on'}, gateway: GATEWAY, preferences: scratchPreferences()});
    assert.equal(cloud.offered, true);
    assert.equal(cloud.gateway, GATEWAY);
    assert.equal(await cloud.runnerOf('u1'), 'computer');
  });

  it('is what the member chose, where it is offered', async () => {
    const preferences = scratchPreferences();
    const cloud = createCloudRuns({env: {CLOUD_RUNS: 'on'}, gateway: GATEWAY, preferences});
    preferences.merge('u1', {runner: 'computer'});
    preferences.merge('u2', {runner: 'cloud'});
    assert.equal(await cloud.runnerOf('u1'), 'computer');
    assert.equal(await cloud.runnerOf('u2'), 'cloud');
  });

  it('is always the member\'s computer where it is not offered, whatever they chose before', async () => {
    const preferences = scratchPreferences();
    preferences.merge('u1', {runner: 'cloud'});
    const cloud = createCloudRuns({env: {}, gateway: GATEWAY, preferences});
    assert.equal(cloud.offered, false);
    assert.equal(await cloud.runnerOf('u1'), 'computer');
    assert.equal(await cloud.runnerOf('u2'), 'computer');
  });

  it('takes no other value as a choice of RUSH Lab cloud, as PUT /api/preferences may store anything', async () => {
    const preferences = scratchPreferences();
    const cloud = createCloudRuns({env: {CLOUD_RUNS: 'on'}, gateway: GATEWAY, preferences});
    for (const stored of ['laptop', 'Cloud', 'CLOUD', '', 7, null, true, {runner: 'cloud'}, ['cloud']]) {
      preferences.merge('u1', {runner: stored});
      assert.equal(await cloud.runnerOf('u1'), 'computer', JSON.stringify(stored));
    }
  });

  it('is the computer for nobody signed in, asking no preferences', async () => {
    const preferences = {get: () => assert.fail('nobody has preferences'), merge: () => assert.fail('nobody has preferences')};
    const cloud = createCloudRuns({env: {CLOUD_RUNS: 'on'}, gateway: GATEWAY, preferences});
    assert.equal(await cloud.runnerOf(null), 'computer');
    assert.equal(await cloud.runnerOf(undefined), 'computer');
    assert.equal(await cloud.runnerOf(''), 'computer');
  });
});

describe('choosing where runs go (choose)', () => {
  it('keeps the choice beside the member\'s other preferences', async () => {
    const preferences = scratchPreferences();
    preferences.merge('u1', {ai: {behaviour: {}, instructions: 'Be brief.'}, theme: 'dark'});
    const cloud = createCloudRuns({env: {CLOUD_RUNS: 'on'}, gateway: GATEWAY, preferences});
    assert.deepEqual(await cloud.choose('u1', 'computer'), {value: 'computer'});
    assert.equal(await cloud.runnerOf('u1'), 'computer');
    assert.deepEqual(await cloud.choose('u1', 'cloud'), {value: 'cloud'});
    assert.equal(await cloud.runnerOf('u1'), 'cloud');
    const kept = preferences.get('u1');
    assert.deepEqual({ai: kept.ai, theme: kept.theme, runner: kept.runner}, {ai: {behaviour: {}, instructions: 'Be brief.'}, theme: 'dark', runner: 'cloud'});
  });

  it('refuses a runner that is not one, keeping nothing', async () => {
    const preferences = scratchPreferences();
    const cloud = createCloudRuns({env: {CLOUD_RUNS: 'on'}, gateway: GATEWAY, preferences});
    for (const bad of ['laptop', 'CLOUD', '', null, undefined, 1, ['cloud'], {runner: 'cloud'}]) {
      assert.deepEqual(await cloud.choose('u1', bad), {error: 'runner must be "cloud" or "computer"', status: 400}, JSON.stringify(bad));
    }
    assert.deepEqual(preferences.get('u1'), {});
  });

  it('refuses RUSH Lab cloud where it is not offered, and keeps the computer', async () => {
    const preferences = scratchPreferences();
    const cloud = createCloudRuns({env: {}, gateway: GATEWAY, preferences});
    assert.deepEqual(await cloud.choose('u1', 'cloud'), {error: 'This site does not offer RUSH Lab cloud: run on your computer', status: 409});
    assert.deepEqual(preferences.get('u1'), {});
    assert.deepEqual(await cloud.choose('u1', 'computer'), {value: 'computer'});
    assert.equal(preferences.get('u1').runner, 'computer');
  });
});
