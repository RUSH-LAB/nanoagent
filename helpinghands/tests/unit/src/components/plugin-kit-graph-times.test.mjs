import {describe, it} from 'node:test';
import assert from 'node:assert/strict';

// The page kit's bridge listens on the page's window as it loads.
globalThis.window ??= {addEventListener() {}, parent: {postMessage() {}}};
const {loopTimes} = await import('../../../../../nanoagent/src/nanoagent/plugin/v0001/page/kit/graph.js');

const request = (id, seconds, parent) => ({id, type: 'model_request', modelCalls: [{duration_s: seconds}], ...(parent ? {parent} : {})});
const tool = (id, seconds, parent) => ({id, type: 'tool_call', duration_s: seconds, ...(parent ? {parent} : {})});

describe("a run's graph counts each span's own time", () => {
  it('counts a task tool call\'s 2 model requests as Model Time and only its own time as Tool Time', () => {
    const nodes = [
      request('r1', 1),
      tool('task', 10),
      request('t:r1', 2, 'task'),
      tool('t:read', 1, 'task'),
      request('t:r2', 3, 'task'),
    ];
    const {modelS, toolsS} = loopTimes(nodes);
    assert.equal(modelS, 6); // its own 1, and the task's 2 and 3
    assert.equal(toolsS, 5); // the task's own 4 and its read's 1
    assert.equal(modelS + toolsS, 11); // the top level's 1 + 10: nothing counted twice
  });
});
