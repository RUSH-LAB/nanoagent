import {describe, it} from 'node:test';
import assert from 'node:assert/strict';

// The page kit's bridge listens on the page's window as it loads.
globalThis.window ??= {addEventListener() {}, parent: {postMessage() {}}};
const {usageFigures} = await import('../../../../../nanoagent/src/nanoagent/plugin/v0001/page/kit/session.js');

const known = sum => ({sum, count: 1});
const usage = {durationS: known(90), modelS: known(32), toolsS: known(461), inputTokens: known(159900), outputTokens: known(1900), cost: known(0.0067)};
const UNMEASURED = ['—', 'not measured for this agent; only nanoagent reports its own steps'];
const totals = agent => usageFigures([usage], 1, 'session', agent).map(figure => figure.total[0]);

describe('the Dashboard shows a figure only where it is measured exactly', () => {
  it('shows a claude session its model time, tokens and cost, and "—" for End-to-End Latency and Tool Time, in Total and Average', () => {
    assert.deepEqual(totals('claude'), ['—', '32 s', '—', '159.9k', '1.9k', '$0.0067']);
    const [latency, , tools] = usageFigures([usage], 1, 'session', 'claude');
    assert.deepEqual([latency, tools], [{total: UNMEASURED, average: UNMEASURED}, {total: UNMEASURED, average: UNMEASURED}]);
  });

  it('shows a nanoagent session every figure, its own steps measuring its latency and tool time', () => {
    assert.deepEqual(totals('nanoagent'), ['1 min 30 s', '32 s', '7 min 41 s', '159.9k', '1.9k', '$0.0067']);
  });
});
