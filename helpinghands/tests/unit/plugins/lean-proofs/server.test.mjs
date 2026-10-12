import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const routes = require('../../../../plugins/lean-proofs/server');
const request = method => ({method, socket: {remoteAddress: '127.0.0.1'}, caller: 'test-user'});

function api(body, overrides = {}) {
  const replies = [];
  return {
    replies,
    value: {
      caller: {userId: 'u1'},
      rateLimit: () => true,
      readBody: async () => body,
      sanitize: value => typeof value === 'string' ? value : '',
      respond: (_res, status, payload) => replies.push({status, payload}),
      ai: {describe: () => ({available: true}), complete: async () => ({text: '```lean\n#check Nat\n```'})},
      exec: async () => ({ok: true, code: 0, stdout: 'Lean 4', stderr: '', timedOut: false}),
      ...overrides,
    },
  };
}

describe('lean-proofs server', () => {
  it('formalizes prose and strips Markdown fences from the candidate', async () => {
    const fake = api({statement: 'True is true.', proof: 'Trivial.'});
    await routes(request('POST'), {}, null, '/api/lean-proofs/formalize', fake.value);
    assert.deepEqual(fake.replies, [{status: 200, payload: {source: '#check Nat', verified: false}}]);
  });

  it('checks source with the pinned Lake project', async () => {
    let called;
    const fake = api({source: 'example : True := by trivial'}, {
      exec: async (...args) => { called = args; return {ok: true, code: 0, stdout: '', stderr: '', timedOut: false}; },
    });
    await routes(request('POST'), {}, null, '/api/lean-proofs/check', fake.value);
    assert.deepEqual(called.slice(0, 2), ['lake', ['env', 'lean', '--stdin', '--timeout=400000']]);
    assert.equal(fake.replies[0].payload.verified, true);
  });

  it('refuses placeholders that would make verification meaningless', async () => {
    const fake = api({source: 'theorem nope : True := by sorry'});
    await routes(request('POST'), {}, null, '/api/lean-proofs/check', fake.value);
    assert.equal(fake.replies[0].status, 400);
    assert.match(fake.replies[0].payload.error, /refuses/);
  });

  it('does not execute Lean for a remote caller by default', async () => {
    const fake = api({source: 'example : True := by trivial'});
    await routes({method: 'POST', socket: {remoteAddress: '203.0.113.5'}}, {}, null, '/api/lean-proofs/check', fake.value);
    assert.equal(fake.replies[0].status, 403);
  });
});
