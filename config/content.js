// Single source of truth for every book and post on the site.
//
// Each collection is declared exactly once in `books` / `posts` below. From that
// list `docusaurus.config.js` derives the content plugins, the local-search
// index, and the math-registry scan dirs, so a new book or post (or a change to
// what features it supports) only has to be edited here.
//
// This runs in Node.js - don't use client-side code here (browser APIs, JSX...).

// remark-math / rehype-katex are ESM-only; required from a nested CommonJS
// module they arrive as a namespace object, so unwrap the default export.
const interop = (mod) => (mod && mod.__esModule ? mod.default : mod);
const remarkMath = () => interop(require('remark-math'));
const rehypeKatex = () => interop(require('rehype-katex'));
const remarkCite = require('../plugins/remark-cite');

const EDIT_URL = 'https://github.com/zeyuyang8/mochi-lab/tree/main/mochi-lab/';
const BOOKS_DIR = 'content/books';
const POSTS_DIR = 'content/posts';

// ── Features ────────────────────────────────────────────────────────────────
// Every collection inherits DEFAULT_FEATURES and may override individual flags
// via its `features` field. Code-block syntax highlighting is global (it comes
// from themeConfig.prism) and always on, so it needs no flag here.
const DEFAULT_FEATURES = {
  math: true, // $...$ and $$...$$ via remark-math + rehype-katex
  cite: true, // [@key] citations via remark-cite
  eqref: true, // \eqref{label} renders a linked equation reference
  mathRegistry: false, // auto-number <Theorem>/<Equation>/... blocks
};

// Resolve a collection's effective feature set.
function featuresOf(collection) {
  return { ...DEFAULT_FEATURES, ...(collection.features || {}) };
}

// Compile a feature set into Docusaurus remark/rehype plugin arrays.
function compileFeatures(features) {
  const remarkPlugins = [];
  const rehypePlugins = [];

  if (features.math) {
    remarkPlugins.push([remarkMath(), { strict: false }]);
    const katexOptions = { strict: false, trust: true, fleqn: false };
    if (features.eqref) {
      katexOptions.macros = { '\\eqref': '\\href{###1}{(\\text{#1})}' };
    }
    rehypePlugins.push([rehypeKatex(), katexOptions]);
  }
  if (features.cite) {
    remarkPlugins.push(remarkCite);
  }

  return { remarkPlugins, rehypePlugins };
}

// ── Collections ─────────────────────────────────────────────────────────────
// A book lives under content/books/<id> and is served at /<id>. Exactly one book
// is marked `preset: true` - it is served by the classic preset's docs instance
// (and is the only one with a hand-authored sidebar); the rest become standalone
// plugin-content-docs instances.
const books = [
  { id: 'programming', preset: true },
  { id: 'survey' },
  { id: 'math', features: { mathRegistry: true } },
  { id: 'builder', features: { mathRegistry: true } },
];

// A post lives under content/posts/<id> and is served at /<id>.
const posts = [
  {
    id: 'blog',
    title: 'Blog',
    description: 'Blog posts',
    sidebarTitle: 'All Posts',
  },
  {
    id: 'research',
    title: 'Research Papers',
    description: 'Collection of research paper summaries and discussions',
    sidebarTitle: 'Recent Papers',
    showReadingTime: true,
  },
];

const bookDir = (book) => `${BOOKS_DIR}/${book.id}`;
const postDir = (post) => `${POSTS_DIR}/${post.id}`;

// ── Derived Docusaurus inputs ───────────────────────────────────────────────

// The single book served by the classic preset's `docs` option.
function presetDocsOptions() {
  const book = books.find((b) => b.preset);
  return {
    path: bookDir(book),
    routeBasePath: book.id,
    sidebarPath: './sidebars.js',
    editUrl: EDIT_URL,
    ...compileFeatures(featuresOf(book)),
  };
}

// One plugin-content-docs instance per non-preset book.
function docsPlugins() {
  return books
    .filter((book) => !book.preset)
    .map((book) => [
      '@docusaurus/plugin-content-docs',
      {
        id: book.id,
        path: bookDir(book),
        routeBasePath: book.id,
        editUrl: EDIT_URL,
        ...compileFeatures(featuresOf(book)),
      },
    ]);
}

// One plugin-content-blog instance per post collection.
function blogPlugins() {
  return posts.map((post) => [
    '@docusaurus/plugin-content-blog',
    {
      id: post.id,
      path: postDir(post),
      routeBasePath: post.id,
      showReadingTime: Boolean(post.showReadingTime),
      blogTitle: post.title,
      blogDescription: post.description,
      blogSidebarTitle: post.sidebarTitle,
      blogSidebarCount: 0,
      authorsMapPath: '../../../authors.yml',
      feedOptions: { type: ['rss', 'atom'], xslt: true },
      editUrl: EDIT_URL,
      onInlineTags: 'warn',
      onInlineAuthors: 'warn',
      onUntruncatedBlogPosts: 'warn',
      ...compileFeatures(featuresOf(post)),
    },
  ]);
}

// Index every collection in the local search plugin.
function searchDirs() {
  return {
    docsDir: books.map(bookDir),
    docsRouteBasePath: books.map((book) => `/${book.id}`),
    blogDir: posts.map(postDir),
    blogRouteBasePath: posts.map((post) => `/${post.id}`),
  };
}

// Directories the math-registry plugin should scan (collections with the flag on).
function mathRegistryDirs() {
  const all = [
    ...books.map((book) => ({ collection: book, dir: bookDir(book) })),
    ...posts.map((post) => ({ collection: post, dir: postDir(post) })),
  ];
  return all
    .filter(({ collection }) => featuresOf(collection).mathRegistry)
    .map(({ collection, dir }) => ({ dir, routeBase: collection.id }));
}

module.exports = {
  EDIT_URL,
  BOOKS_DIR,
  POSTS_DIR,
  books,
  posts,
  presetDocsOptions,
  docsPlugins,
  blogPlugins,
  searchDirs,
  mathRegistryDirs,
};
