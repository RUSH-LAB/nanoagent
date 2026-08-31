import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const remarkLeanProofs = require('../../../../plugins/lean-proofs/remark');

describe('lean-proofs remark extension', () => {
  it('turns a Lean fence into the plugin-owned runnable component', () => {
    const tree = {type: 'root', children: [{type: 'code', lang: 'lean4', value: '#check Nat'}]};
    remarkLeanProofs()(tree);
    assert.equal(tree.children[0].name, 'LeanCode');
    assert.deepEqual(Object.fromEntries(tree.children[0].attributes.map(item => [item.name, item.value])), {
      source: '#check Nat', language: 'lean4',
    });
  });

  it('leaves noRun and non-Lean fences unchanged', () => {
    const tree = {type: 'root', children: [
      {type: 'code', lang: 'lean', meta: 'noRun', value: '#check Nat'},
      {type: 'code', lang: 'js', value: '1'},
    ]};
    remarkLeanProofs()(tree);
    assert.deepEqual(tree.children.map(node => node.type), ['code', 'code']);
  });
});
