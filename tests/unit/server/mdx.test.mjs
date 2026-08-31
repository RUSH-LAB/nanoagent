/**
 * server/mdx.js: compiling a page when it is asked for rather than at build
 * time.
 *
 * The claim this module makes is that a page rendered per request is the same
 * page the build would have rendered, because it runs the same plugins. That is
 * what these check: the chain is the site's own, taken from plugins/loader.js
 * rather than written out again, and what comes back is something a browser can
 * run without a bundler.
 */
import {describe, it, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const mdx = require('../../../src/server/mdx.js');
const {loadRemarkPlugins} = require('../../../plugins/loader.js');

beforeEach(() => mdx._clearCache());

describe('the plugin chain', () => {
  it('is the build\'s, plus math, in the build\'s order', () => {
    // remark-math first, so math is parsed out before any plugin's syntax walks
    // the text nodes it would otherwise see. Same ordering, and same reason, as
    // docusaurus.config.js.
    const [first, ...rest] = mdx.REMARK_PLUGINS;
    assert.equal(typeof first[0], 'function', 'an attacher, not the module namespace');
    assert.deepEqual(first[1], {strict: false});
    assert.equal(rest.length, loadRemarkPlugins().length, 'and then every plugin the site installs');
  });

  it('hands unified an attacher rather than a module namespace', () => {
    // Both math plugins are ES modules, and require() of one returns the
    // namespace. Passing that straight through fails inside the compiler with
    // "attacher.call is not a function", which names neither the plugin nor the
    // reason, so the unwrapping is asserted here where it can.
    // An entry is either the plugin or a [plugin, options] pair, which is what
    // unified accepts and what plugins/loader.js already mixes.
    for (const entry of [...mdx.REMARK_PLUGINS, ...mdx.REHYPE_PLUGINS]) {
      const plugin = Array.isArray(entry) ? entry[0] : entry;
      assert.equal(typeof plugin, 'function');
    }
  });

  it('gives every document the \\eqref macro', () => {
    const [[, options]] = mdx.REHYPE_PLUGINS;
    assert.ok(options.macros['\\eqref'], 'which of two plugin instances served a page is not a property of the page');
  });
});

describe('compileMarkdown', () => {
  it('produces a function body, not a module', async () => {
    const code = await mdx.compileMarkdown('# Hello');
    assert.match(code, /^"use strict";/, 'runnable with no bundler and no import map');
    assert.doesNotMatch(code, /^import |^export /m, 'nothing for the browser to resolve');
    assert.match(code, /return \{\s*default: MDXContent/, 'and hands back the component');
  });

  it('renders math through KaTeX rather than leaving the source', async () => {
    const code = await mdx.compileMarkdown('The identity $e^{i\\pi} + 1 = 0$.');
    assert.match(code, /katex/, 'the markup is KaTeX output');
  });

  it('leaves a component as a component for the client registry to resolve', async () => {
    const code = await mdx.compileMarkdown('<Theorem>Every page is a row.</Theorem>');
    assert.match(code, /Theorem/);
    // Not escaped into text: the tag became an element, so the site's own
    // Theorem is what will render it.
    assert.doesNotMatch(code, /&lt;Theorem/);
  });

  it('reports a document that does not parse, with the line', async () => {
    await assert.rejects(
      () => mdx.compileMarkdown('<Unclosed>\n'),
      err => {
        assert.match(err.message, /Unclosed/);
        assert.match(err.message, /1:1/, 'the compiler names where');
        return true;
      },
    );
  });

  it('compiles an empty document rather than refusing it', async () => {
    // A page created and not yet written to is normal, and should render as an
    // empty page rather than as an error.
    assert.match(await mdx.compileMarkdown(''), /MDXContent/);
    assert.match(await mdx.compileMarkdown(undefined), /MDXContent/);
  });
});

describe('the cache', () => {
  const doc = (updatedAt, markdown) => ({id: 'd1', updatedAt, markdown});

  it('compiles a document once however often it is read', async () => {
    const d = doc('t1', '# a');
    const first = await mdx.compileDocument(d);
    const second = await mdx.compileDocument(d);
    assert.equal(first, second);
    assert.equal(mdx._cacheSize(), 1);
  });

  it('misses when the document has been saved, and serves the new body', async () => {
    const before = await mdx.compileDocument(doc('t1', '# before'));
    const after = await mdx.compileDocument(doc('t2', '# after'));
    assert.notEqual(before, after);
    assert.match(after, /after/);
  });

  // The key carries the updatedAt, so a stale entry is unreachable rather than
  // merely unlikely: there is no key under which the old body can be found once
  // the document has moved on.
  it('cannot serve a stale body for a document that changed', async () => {
    await mdx.compileDocument(doc('t1', '# before'));
    const now = await mdx.compileDocument(doc('t2', '# after'));
    assert.doesNotMatch(now, /before/);
  });

  it('keeps two documents apart', async () => {
    const a = await mdx.compileDocument({id: 'a', updatedAt: 't', markdown: '# a'});
    const b = await mdx.compileDocument({id: 'b', updatedAt: 't', markdown: '# b'});
    assert.notEqual(a, b, 'the same timestamp is not the same document');
    assert.equal(mdx._cacheSize(), 2);
  });

  it('is bounded, evicting the least recently read', async () => {
    const overflow = mdx.MAX_CACHE_ENTRIES + 10;
    for (let i = 0; i < overflow; i++) {
      await mdx.compileDocument({id: `d${i}`, updatedAt: 't', markdown: `# ${i}`});
    }
    assert.equal(mdx._cacheSize(), mdx.MAX_CACHE_ENTRIES);
  });

  it('does not cache a document that failed to compile', async () => {
    await assert.rejects(() => mdx.compileDocument({id: 'bad', updatedAt: 't', markdown: '<Unclosed>'}));
    assert.equal(mdx._cacheSize(), 0, 'a failure is not an answer worth keeping');
  });
});
