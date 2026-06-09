import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// The math-registry plugin exports a function that creates a Docusaurus plugin.
// We test the plugin creation and its internal logic.
const mathRegistryPlugin = require('../../plugins/docusaurus-plugin-math-registry');

describe('math-registry plugin', () => {
  it('creates a plugin with correct name', () => {
    const plugin = mathRegistryPlugin({}, {});
    assert.equal(plugin.name, 'math-registry');
  });

  it('creates plugin with default options', () => {
    const plugin = mathRegistryPlugin({}, {});
    assert.ok(plugin.loadContent, 'has loadContent method');
    assert.ok(plugin.contentLoaded, 'has contentLoaded method');
  });

  it('loadContent returns empty manifest for non-existent directory', async () => {
    const plugin = mathRegistryPlugin({}, {
      contentDirs: [{dir: '/tmp/nonexistent-math-dir-12345', routeBase: 'test'}],
    });
    const manifest = await plugin.loadContent();
    assert.deepEqual(manifest, {});
  });

  it('contentLoaded calls setGlobalData', async () => {
    const plugin = mathRegistryPlugin({}, {});
    const testContent = {foo: {type: 'Theorem', number: '1.1', page: '/math/test'}};
    let globalData = null;
    await plugin.contentLoaded({
      content: testContent,
      actions: {
        setGlobalData: (data) => { globalData = data; },
      },
    });
    assert.deepEqual(globalData, testContent);
  });
});

// Test the toRoutePath logic by reimplementing it
// (the function is internal to the module, not exported)
function toRoutePath(relPath, routeBase) {
  let route = relPath
    .replace(/\.(mdx?|md)$/, '')
    .split(path.sep)
    .map(seg => seg.replace(/^\d+-/, ''))
    .join('/');
  if (route.endsWith('/index') || route === 'index') {
    route = route.replace(/\/?index$/, '');
  }
  return `/${routeBase}${route ? '/' + route : ''}`;
}

describe('toRoutePath logic', () => {
  it('converts simple .md file', () => {
    assert.equal(toRoutePath('chapter1.md', 'math'), '/math/chapter1');
  });

  it('converts .mdx file', () => {
    assert.equal(toRoutePath('chapter1.mdx', 'math'), '/math/chapter1');
  });

  it('converts nested path', () => {
    assert.equal(toRoutePath('algebra/groups.md', 'math'), '/math/algebra/groups');
  });

  it('strips numeric prefix from segments', () => {
    assert.equal(toRoutePath('01-intro.md', 'math'), '/math/intro');
  });

  it('strips numeric prefix from nested segments', () => {
    assert.equal(toRoutePath('02-algebra/01-groups.md', 'math'), '/math/algebra/groups');
  });

  it('handles index.md at root', () => {
    assert.equal(toRoutePath('index.md', 'math'), '/math');
  });

  it('handles index.md in subdirectory', () => {
    assert.equal(toRoutePath('algebra/index.md', 'math'), '/math/algebra');
  });

  it('handles index.mdx', () => {
    assert.equal(toRoutePath('index.mdx', 'math'), '/math');
  });

  it('uses routeBase correctly', () => {
    assert.equal(toRoutePath('test.md', 'docs'), '/docs/test');
  });
});

// Test KNOWN_TYPES and TAG_RE pattern matching
describe('TAG_RE pattern matching', () => {
  const KNOWN_TYPES = [
    'Theorem', 'Lemma', 'Proposition', 'Corollary',
    'Definition', 'Remark', 'Example',
    'Equation', 'Figure', 'Table', 'Code', 'Algorithm',
  ];

  const TAG_RE = new RegExp(
    `<(${KNOWN_TYPES.join('|')})\\s[^>]*?id=["']([^"']+)["'][^>]*>`,
    'g',
  );

  it('matches Theorem with double-quoted id', () => {
    const input = '<Theorem id="thm-main" name="Main Theorem">';
    TAG_RE.lastIndex = 0;
    const match = TAG_RE.exec(input);
    assert.ok(match, 'should match');
    assert.equal(match[1], 'Theorem');
    assert.equal(match[2], 'thm-main');
  });

  it('matches Equation with single-quoted id', () => {
    const input = "<Equation id='eq-1'>";
    TAG_RE.lastIndex = 0;
    const match = TAG_RE.exec(input);
    assert.ok(match, 'should match');
    assert.equal(match[1], 'Equation');
    assert.equal(match[2], 'eq-1');
  });

  it('matches Definition', () => {
    const input = '<Definition id="def-group" name="Group">';
    TAG_RE.lastIndex = 0;
    const match = TAG_RE.exec(input);
    assert.ok(match);
    assert.equal(match[1], 'Definition');
    assert.equal(match[2], 'def-group');
  });

  it('matches multiple types in same text', () => {
    const input = '<Theorem id="thm-1">content</Theorem>\n<Lemma id="lem-1">';
    TAG_RE.lastIndex = 0;
    const matches = [];
    let m;
    while ((m = TAG_RE.exec(input)) !== null) {
      matches.push({type: m[1], id: m[2]});
    }
    assert.equal(matches.length, 2);
    assert.equal(matches[0].type, 'Theorem');
    assert.equal(matches[1].type, 'Lemma');
  });

  it('does not match unknown types', () => {
    const input = '<Unknown id="unk-1">';
    TAG_RE.lastIndex = 0;
    const match = TAG_RE.exec(input);
    assert.equal(match, null);
  });

  it('does not match without id attribute', () => {
    const input = '<Theorem name="No ID">';
    TAG_RE.lastIndex = 0;
    const match = TAG_RE.exec(input);
    assert.equal(match, null);
  });

  it('matches all KNOWN_TYPES', () => {
    for (const type of KNOWN_TYPES) {
      const input = `<${type} id="test-${type.toLowerCase()}">`;
      TAG_RE.lastIndex = 0;
      const match = TAG_RE.exec(input);
      assert.ok(match, `should match ${type}`);
      assert.equal(match[1], type);
    }
  });
});

describe('chapterCounterKey logic', () => {
  const THEOREM_LIKE = new Set([
    'Theorem', 'Lemma', 'Proposition', 'Corollary',
    'Definition', 'Remark', 'Example',
  ]);

  function chapterCounterKey(type) {
    return THEOREM_LIKE.has(type) ? '_theoremLike' : type;
  }

  it('theorem-like types share counter key', () => {
    for (const type of THEOREM_LIKE) {
      assert.equal(chapterCounterKey(type), '_theoremLike', `${type} should use _theoremLike`);
    }
  });

  it('non-theorem types use own key', () => {
    assert.equal(chapterCounterKey('Figure'), 'Figure');
    assert.equal(chapterCounterKey('Table'), 'Table');
    assert.equal(chapterCounterKey('Code'), 'Code');
    assert.equal(chapterCounterKey('Algorithm'), 'Algorithm');
    assert.equal(chapterCounterKey('Equation'), 'Equation');
  });
});
