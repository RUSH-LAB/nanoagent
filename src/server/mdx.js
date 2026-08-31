/**
 * Compiling a document at request time instead of at build time.
 *
 * Docusaurus compiles every page's MDX once, into a static bundle, before
 * anybody has asked for anything. That is why a new workspace has no pages
 * until the site restarts, why a private page cannot be private, and why build
 * time grows with the number of workspaces: there is no point in that pipeline
 * at which a reader is known.
 *
 * The moat is not the pipeline. It is MDX plus the component library: the
 * theorem environments, the Lean proofs, the interactive figures, KaTeX, the
 * citations. All of that is a compiler and a set of React components, and
 * neither needs to run at build time. This module runs the compiler when a
 * document is asked for, against the caller's session, and hands the result to
 * the same components.
 *
 * ── What it compiles to ─────────────────────────────────────────────────────
 *
 * `outputFormat: 'function-body'`, which is a string of JavaScript that takes a
 * JSX runtime and returns the component. Not a module, so the browser needs no
 * bundler and no import map to run it; the client passes in its own React
 * runtime and its own component registry, which is what keeps `<Theorem>`
 * meaning the site's Theorem rather than whatever the document says.
 *
 * The plugin list is the same one the build uses, taken from plugins/loader.js
 * and the two math plugins rather than written out again, so a page rendered
 * this way and the same page rendered by the build cannot disagree about what
 * the syntax means. Node 24 can require() an ES module, which is what makes
 * that list reachable from CommonJS at all.
 *
 * ── The cache ───────────────────────────────────────────────────────────────
 *
 * Compilation is the expensive part and its input never changes without the
 * document changing, so the result is memoized on the document's id and its
 * updatedAt. A save moves updatedAt and the next read misses; nothing else
 * does, so a page that is read a thousand times compiles once.
 */
const {compile} = require('@mdx-js/mdx');
const remarkMath = require('remark-math');
const rehypeKatex = require('rehype-katex');
const {loadRemarkPlugins} = require('../../plugins/loader');

/**
 * The plugin itself out of what require() gave back.
 *
 * These two are ES modules. Node 24 will require() one, which is what makes
 * them reachable from here at all, but what it hands back is the namespace
 * object and the plugin is its default export. unified calls what it is given,
 * so passing the namespace fails inside the compiler with "attacher.call is not
 * a function", which names neither the plugin nor the reason.
 */
const attacher = mod => mod?.default ?? mod;

/**
 * The plugin chain, built once.
 *
 * remark-math runs first so that math is parsed out of the tree before any
 * plugin's syntax walks its text nodes, which is the same ordering, and the
 * same reason, as docusaurus.config.js.
 */
const REMARK_PLUGINS = [[attacher(remarkMath), {strict: false}], ...loadRemarkPlugins()];

/**
 * KaTeX, with the \eqref macro the blog instances configure. The build gives
 * that macro to blogs and not to books; here every document gets it, because
 * which of two plugin instances a page happened to be served by is not a
 * property of the page and was never meant to be one.
 */
const REHYPE_PLUGINS = [[attacher(rehypeKatex), {
  strict: false,
  trust: true,
  fleqn: false,
  macros: {'\\eqref': '\\href{###1}{(\\text{#1})}'},
}]];

/** How many compiled documents to hold. Roughly a large workspace's worth. */
const MAX_CACHE_ENTRIES = 500;

/**
 * Compiled bodies, keyed by document id and the updatedAt they were compiled
 * from, so a stale entry is not reachable rather than merely unlikely.
 * Bounded with the same least-recently-used eviction as ./data-store.
 */
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

function cacheSet(key, value) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
}

/**
 * Compile `markdown` to a function body.
 *
 * Rejects with the compiler's own error, which names the line, so a document
 * with broken MDX reports what is wrong with it rather than a blank page.
 */
async function compileMarkdown(markdown) {
  const compiled = await compile(String(markdown ?? ''), {
    outputFormat: 'function-body',
    development: false,
    remarkPlugins: REMARK_PLUGINS,
    rehypePlugins: REHYPE_PLUGINS,
  });
  return String(compiled);
}

/**
 * The compiled body of a document, from the cache when it has not changed.
 *
 * Takes the document rather than a path, because the caller has already read it
 * through the scoped layer and reading it again here would be a second chance
 * to get the scoping wrong.
 */
async function compileDocument(document) {
  const key = `${document.id}@${document.updatedAt}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const code = await compileMarkdown(document.markdown);
  cacheSet(key, code);
  return code;
}

/** Diagnostics and test hooks. Routes do not use these. */
function _cacheSize() {
  return cache.size;
}

function _clearCache() {
  cache.clear();
}

module.exports = {
  compileMarkdown,
  compileDocument,
  REMARK_PLUGINS,
  REHYPE_PLUGINS,
  MAX_CACHE_ENTRIES,
  _cacheSize,
  _clearCache,
};
