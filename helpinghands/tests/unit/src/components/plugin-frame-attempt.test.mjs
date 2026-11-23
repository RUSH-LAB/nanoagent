import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {attemptStatus} from '../../../../src/components/PluginFrame/attempt.js';

const attempt = (state, extra = {}) => ({state, execution: state === 'final' ? {status: 'answered', reason: null} : null, cancel_requested: false, ...extra});

describe('Harness tab attempt', () => {
  it('says what the attempt is doing', () => {
    assert.deepEqual([attempt('queued'), attempt('leased'), attempt('leased', {cancel_requested: true}), attempt('final'),
      attempt('final', {execution: {status: 'build_failed'}})].map(attemptStatus), ['Queued', 'Running', 'Canceling', 'Answered', 'Build failed']);
  });
});
