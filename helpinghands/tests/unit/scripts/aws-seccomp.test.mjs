/**
 * The runner's seccomp profile (infra/aws/runner/seccomp.json, scripts/aws/seccomp.mjs):
 * Docker's default, the pinned moby/profiles release, and exactly one rule more.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {BUBBLEWRAP, DEFAULT_CANONICAL, PROFILE, canonical, withBubblewrap} from '../../../scripts/aws/seccomp.mjs';

const profile = JSON.parse(fs.readFileSync(PROFILE, 'utf8'));

describe('the runner\'s seccomp profile', () => {
  it('is Docker\'s default profile, the pinned release, with BUBBLEWRAP as its one rule more', () => {
    const added = profile.syscalls.filter(rule => rule.comment === BUBBLEWRAP.comment);
    assert.equal(added.length, 1);
    assert.deepEqual(profile.syscalls.at(-1), {...BUBBLEWRAP});
    assert.equal(canonical({...profile, syscalls: profile.syscalls.slice(0, -1)}), DEFAULT_CANONICAL);
  });

  it('refuses every call no rule allows, as Docker\'s default does', () => {
    assert.equal(profile.defaultAction, 'SCMP_ACT_ERRNO');
  });

  it('adds only the namespace and mount calls bubblewrap makes, for every process, with no condition', () => {
    assert.deepEqual([...BUBBLEWRAP.names].sort(), ['clone', 'mount', 'pivot_root', 'umount2', 'unshare']);
    assert.equal(BUBBLEWRAP.action, 'SCMP_ACT_ALLOW');
    assert.deepEqual(Object.keys(BUBBLEWRAP).sort(), ['action', 'comment', 'names']);
  });

  it('is written from the default without changing it', () => {
    const defaults = {defaultAction: 'SCMP_ACT_ERRNO', syscalls: [{names: ['read'], action: 'SCMP_ACT_ALLOW'}]};
    const before = JSON.stringify(defaults);
    const written = withBubblewrap(defaults);
    assert.equal(JSON.stringify(defaults), before);
    assert.deepEqual(written.syscalls, [{names: ['read'], action: 'SCMP_ACT_ALLOW'}, {...BUBBLEWRAP}]);
    assert.notEqual(written.syscalls[1].names, BUBBLEWRAP.names);
  });
});
