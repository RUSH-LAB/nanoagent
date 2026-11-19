import {describe, it} from 'node:test';
import assert from 'node:assert/strict';

// The page kit's bridge listens on the page's window as it loads.
globalThis.window ??= {addEventListener() {}, parent: {postMessage() {}}};
const {outcomeText} = await import('../../../../../nanoagent/src/nanoagent/plugin/v0001/page/kit/harness.js');

const outcome = fields => ({ended: true, reason: null, inputTokens: 100, outputTokens: 20, elapsedMs: 3000, cost: 0.01, uploadError: null, ...fields});

describe('the line a Terminal session prints once it is over', () => {
  it('says why its files did not go to RUSH, and nothing of them when they did', () => {
    assert.doesNotMatch(outcomeText(outcome({})), /uploaded/);
    assert.match(outcomeText(outcome({uploadError: 'its files are larger than the 200 MB a session uploads, compressed'})),
      /^Session ended · .* · Files not uploaded to RUSH: its files are larger than the 200 MB a session uploads, compressed$/);
  });
});
