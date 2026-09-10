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
  it('extracts only supported frontmatter fields as inert data', () => {
    assert.deepEqual(mdx.parseFrontmatter('---\ntitle: Hello\ntags: [one, two]\nsidebar_position: 3\ndraft: true\nunknown: nope\n---\nbody'), {
      title: 'Hello', sidebarPosition: 3, draft: true, authors: [], tags: ['one', 'two'],
    });
  });

  it('preserves the Docusaurus blog truncate boundary as metadata', () => {
    assert.deepEqual(mdx.splitBlogPost('Before\n\n<!-- truncate -->\n\nAfter'), {
      hasTruncateMarker: true,
      excerpt: 'Before\n\n',
    });
    assert.deepEqual(mdx.splitBlogPost('Before\n\n{/* truncate */}\n\nAfter'), {
      hasTruncateMarker: true,
      excerpt: 'Before\n\n',
    });
  });
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

  it('preserves display math as a centered block, including inside Equation', async () => {
    const tree = await mdx.compileMarkdown(
      '<Equation id="eq-energy">\n\n$$\nE = mc^2\n$$\n\n</Equation>',
    );
    const equation = all(tree).find(node => node.type === 'component' && node.name === 'Equation');
    const math = all(equation).find(node => node.type === 'math');
    assert.deepEqual(equation.props, {id: 'eq-energy'});
    assert.equal(math.display, true);
    assert.match(math.html, /katex-display/);
  });

  it('keeps math inert when the workspace disables the built-in renderer', async () => {
    const tree = await mdx.compileMarkdown('The value is $x^2$.', {rendering: {math: false}});
    assert.equal(all(tree).some(node => node.type === 'math'), false);
    assert.match(all(tree).filter(node => node.type === 'text').map(node => node.value).join(''), /\$x\^2\$/);
  });

  it('keeps LaTeX braces and table pipes out of the MDX expression grammar', async () => {
    const tree = await mdx.compileMarkdown('| Formula |\n| --- |\n| $e^{-x|y}$ |');
    const table = all(tree).find(node => node.type === 'table');
    const row = table.children[1];
    assert.equal(row.children.length, 1);
    assert.ok(all(row).some(node => node.type === 'math' && node.tex === 'e^{-x|y}'));
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

  it('selects runtime plugin syntax from workspace settings', async () => {
    const tree = await mdx.compileMarkdown('See [[math/intro|the introduction]].', {
      plugins: {'wiki-links': {enabled: false}},
    });
    assert.equal(all(tree).some(node => node.type === 'link'), false);
    assert.match(all(tree).filter(node => node.type === 'text').map(node => node.value).join(''), /\[\[math\/intro/);
  });

  it('rejects components owned by a plugin disabled in this workspace', async () => {
    await assert.rejects(
      () => mdx.compileMarkdown('<Theorem id="t1">No longer enabled.</Theorem>', {
        plugins: {'math-registry': {enabled: false}},
      }),
      /Component <Theorem> is not allowed/,
    );
  });

  it('coerces plugin-declared number and boolean props generically', async () => {
    const tree = await mdx.compileMarkdown('<Section number="2"><LeanProof name="p" runnable="false" /></Section>');
    const nodes = all(tree);
    assert.equal(nodes.find(node => node.name === 'Section').props.number, 2);
    assert.equal(nodes.find(node => node.name === 'LeanProof').props.runnable, false);
  });

  it('allows the safe details and summary HTML used by existing documents', async () => {
    const tree = await mdx.compileMarkdown('<details><summary>Answer</summary>Text</details>');
    const nodes = all(tree);
    assert.ok(nodes.some(node => node.type === 'element' && node.name === 'details'));
    assert.ok(nodes.some(node => node.type === 'element' && node.name === 'summary'));
  });

  it('accepts safe relative document and asset URLs', async () => {
    const tree = await mdx.compileMarkdown('[Next](../next.md)\n\n![Plot](./assets/plot.png)');
    const nodes = all(tree);
    assert.ok(nodes.some(node => node.type === 'link' && node.url === '../next.md'));
    assert.ok(nodes.some(node => node.type === 'image' && node.url === './assets/plot.png'));
  });

  it('treats Docusaurus truncate comments as inert metadata', async () => {
    const tree = await mdx.compileMarkdown('Before\n\n<!-- truncate -->\n\nAfter\n\n{/* truncate */}');
    assert.equal(all(tree).some(node => JSON.stringify(node).includes('truncate')), false);
  });

  it('creates stable heading ids and Docusaurus admonition nodes', async () => {
    const tree = await mdx.compileMarkdown('## Same heading\n\n## Same heading\n\n:::tip[Remember]\nUse the workspace URL.\n:::');
    const nodes = all(tree);
    assert.deepEqual(nodes.filter(node => node.type === 'heading').map(node => node.id), ['same-heading', 'same-heading-1']);
    const admonition = nodes.find(node => node.type === 'admonition');
    assert.equal(admonition.admonitionType, 'tip');
    assert.equal(admonition.title, 'Remember');
  });

  for (const [name, source, message] of [
    ['imports', 'import x from "evil"\n\n# Hello', /import and export/],
    ['exports', 'export const x = 1\n\n# Hello', /import and export/],
    ['expressions', '# Hello {globalThis.document.cookie}', /expressions are not allowed/],
    ['unknown components', '<Script src="/x" />', /is not allowed/],
    ['expression attributes', '<Theorem id={globalThis.document.cookie}>x</Theorem>', /expressions are not allowed/i],
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
    const heading = all(tree).find(node => node.type === 'heading');
    assert.deepEqual(heading.position, {startLine: 4, endLine: 4});
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

  it('keeps compiled documents separate across workspace plugin configurations', async () => {
    const document = doc('t1', 'See [[math/intro]].');
    const enabled = await mdx.compileDocument(document);
    const disabled = await mdx.compileDocument(document, {plugins: {'wiki-links': {enabled: false}}});
    assert.notDeepEqual(enabled, disabled);
    assert.equal(mdx._cacheSize(), 2);
  });

  it('keeps documents apart and stays bounded', async () => {
    for (let i = 0; i < mdx.MAX_CACHE_ENTRIES + 10; i++) {
      await mdx.compileDocument({id: `d${i}`, updatedAt: 't', markdown: `# ${i}`});
    }
    assert.equal(mdx._cacheSize(), mdx.MAX_CACHE_ENTRIES);
  });

  it('does not cache a rejected document', async () => {
    await assert.rejects(() => mdx.compileDocument({id: 'bad', updatedAt: 't', markdown: '{globalThis.evil}'}));
    assert.equal(mdx._cacheSize(), 0);
  });
});
