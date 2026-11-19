import {describe, it} from 'node:test';
import assert from 'node:assert/strict';

// The page kit's bridge listens on the page's window as it loads.
globalThis.window ??= {addEventListener() {}, parent: {postMessage() {}}};
const {reopening} = await import('../../../../../nanoagent/src/nanoagent/plugin/v0001/page/kit/session.js');

const ATTEMPT = '11111111-1111-4111-8111-111111111111';
const chat = fields => ({attemptId: ATTEMPT, agent: 'claude', conversation: 'aaaa-1', freeForm: true, resumable: true, running: false, ...fields});

describe('a session clicked on the Dashboard always opens in a terminal', () => {
  it('resumes one whose files this computer kept', () => {
    assert.deepEqual(reopening(chat({})), {resume: ATTEMPT, chat: {agent: 'claude', id: 'aaaa-1'}});
  });

  it('starts its agent anew, saying why, for one from a harness run or whose files are gone', () => {
    assert.deepEqual(reopening(chat({freeForm: false})), {start: 'claude', line: "That session ran in a harness run, not a terminal, so it can't be reopened; started a new claude session"});
    assert.deepEqual(reopening(chat({agent: 'codex', resumable: false})), {start: 'codex', line: "That session's files are no longer on this computer, so it can't be reopened; started a new codex session"});
  });

  it('shows the live session for one still running in it', () => {
    assert.deepEqual(reopening(chat({running: true})), {});
  });
});
