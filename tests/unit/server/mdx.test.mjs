import {describe, it, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const mdx = require('../../../src/server/mdx.js');

beforeEach(() => mdx._clearCache());

function all(node) {
  return [node, ...(node?.children ?? []).flatMap(all)];
}

describe('safe workspace markdown', () => {
  it('returns an inert render tree rather than JavaScript', async () => {
    const tree = await mdx.compileMarkdown('# Hello');
    assert.equal(tree.type, 'root');
    assert.equal(tree.children[0].type, 'heading');
    assert.equal(JSON.stringify(tree).includes('function'), false);
  });

  it('renders math through KaTeX with trust disabled', async () => {
    const tree = await mdx.compileMarkdown('The identity $e^{i\\pi} + 1 = 0$.');
    const math = all(tree).find(node => node.type === 'math');
    assert.ok(math);
    assert.match(math.html, /katex/);
  });

  it('keeps an allowed academic component and static attributes', async () => {
    const tree = await mdx.compileMarkdown('<Theorem id="t1" name="Result">Every page is a row.</Theorem>');
    const component = all(tree).find(node => node.type === 'component');
    assert.deepEqual(component.props, {id: 't1', name: 'Result'});
    assert.equal(component.name, 'Theorem');
  });

  it('uses plugin-owned runtime syntax and component schemas', async () => {
    const tree = await mdx.compileMarkdown('See [[math/intro|the introduction]].\n\n```lean4\n#check Nat\n```');
    const nodes = all(tree);
    assert.ok(nodes.some(node => node.type === 'link' && node.url === '/math/intro'));
    const lean = nodes.find(node => node.type === 'component' && node.name === 'LeanCode');
    assert.equal(lean.props.source, '#check Nat');
    assert.equal(lean.props.language, 'lean4');
  });

  it('coerces plugin-declared number and boolean props generically', async () => {
    const tree = await mdx.compileMarkdown('<Section number="2"><LeanProof name="p" runnable="false" /></Section>');
    const nodes = all(tree);
    assert.equal(nodes.find(node => node.name === 'Section').props.number, 2);
    assert.equal(nodes.find(node => node.name === 'LeanProof').props.runnable, false);
  });

  for (const [name, source, message] of [
    ['imports', 'import x from "evil"\n\n# Hello', /import and export/],
    ['exports', 'export const x = 1\n\n# Hello', /import and export/],
    ['expressions', '# Hello {globalThis.document.cookie}', /expressions are not allowed/],
    ['unknown components', '<Script src="/x" />', /is not allowed/],
    ['expression attributes', '<Theorem id={globalThis.document.cookie}>x</Theorem>', /Expressions are not allowed/],
    ['raw html', '<script>alert(1)</script>', /is not allowed/],
    ['javascript links', '[click](javascript:alert(1))', /allowed/],
  ]) {
    it(`rejects ${name}`, async () => {
      await assert.rejects(() => mdx.compileMarkdown(source), message);
    });
  }

  it('strips frontmatter rather than rendering it', async () => {
    const tree = await mdx.compileMarkdown('---\ntitle: Hello\n---\n# Body');
    assert.equal(all(tree).some(node => node.value === 'title: Hello'), false);
  });

  it('accepts an empty document', async () => {
    assert.deepEqual(await mdx.compileMarkdown(''), {type: 'root', children: []});
    assert.deepEqual(await mdx.compileMarkdown(undefined), {type: 'root', children: []});
  });
});

describe('the render-tree cache', () => {
  const doc = (updatedAt, markdown) => ({id: 'd1', updatedAt, markdown});

  it('parses a document once however often it is read', async () => {
    const d = doc('t1', '# a');
    assert.equal(await mdx.compileDocument(d), await mdx.compileDocument(d));
    assert.equal(mdx._cacheSize(), 1);
  });

  it('misses when the document changes', async () => {
    const before = await mdx.compileDocument(doc('t1', '# before'));
    const after = await mdx.compileDocument(doc('t2', '# after'));
    assert.notDeepEqual(before, after);
  });

  it('keeps documents apart and stays bounded', async () => {
    for (let i = 0; i < mdx.MAX_CACHE_ENTRIES + 10; i++) {
      await mdx.compileDocument({id: `d${i}`, updatedAt: 't', markdown: `# ${i}`});
    }
    assert.equal(mdx._cacheSize(), mdx.MAX_CACHE_ENTRIES);
  });

  it('does not cache a rejected document', async () => {
    await assert.rejects(() => mdx.compileDocument({id: 'bad', updatedAt: 't', markdown: '{evil}'}));
    assert.equal(mdx._cacheSize(), 0);
  });
});
