import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {parseEventFrame, takeEventFrames} from '../../../../src/utils/eventStream.js';

describe('event stream framing', () => {
  it('keeps a partial frame for the next network chunk', () => {
    assert.deepEqual(takeEventFrames('event: delta\ndata: {"text":"a"}\n\nevent: del'), {
      frames: ['event: delta\ndata: {"text":"a"}'],
      rest: 'event: del',
    });
  });

  it('parses JSON data and ignores heartbeat comments', () => {
    assert.deepEqual(parseEventFrame(': ping\nevent: delta\ndata: {"text":"hello"}'), {
      event: 'delta', data: {text: 'hello'},
    });
  });
});
