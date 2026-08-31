import {themes as prismThemes} from 'prism-react-renderer';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

// The tools in plugins/, discovered rather than listed: see plugins/loader.js
// and plugins/README.md. Nothing below names a plugin, which is what makes
// adding one a matter of adding a directory.
const { loadBuildPlugins, loadRemarkPlugins } = require('./plugins/loader');

const fs = require('fs');
const nodePath = require('path');

// ── Organizations ──────────────────────────────────────────────────────────
//
// Content is one tree per workspace: content/<org slug>/{books,posts}. The
// plugin list below is generated from whichever of those directories exist on
// disk, rather than written out, so adding a workspace is adding a directory.
//
// The primary organization keeps the bare routes. `content/mochi/books/math`
// serves /math, exactly as `content/books/math` did, which is what lets 181
// files keep linking to each other through a move that would otherwise have
// rewritten every URL on the site. Every other workspace is served under its
// own slug: content/hello-world/books/math serves /hello-world/math.
//
// The consequence worth knowing: a workspace created while the site is running
// has no pages until the site restarts, because Docusaurus fixes its plugin
// list at startup. The API, the editor, and the file tree see it immediately.
const PRIMARY_ORG = process.env.ROOT_ORG_SLUG || 'mochi';
const CONTENT_ROOT = 'content';

/** The workspace slugs with a content tree, primary first. */
function organizationSlugs() {
  let entries = [];
  try {
    entries = fs.readdirSync(CONTENT_ROOT, {withFileTypes: true})
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name);
  } catch {
    // No content at all is a checkout that has not been set up, not an error
    // worth failing the build over; the primary org's plugins simply find
    // nothing and Docusaurus says so per plugin.
    return [PRIMARY_ORG];
  }
  return [PRIMARY_ORG, ...entries.filter(name => name !== PRIMARY_ORG).sort()];
}

/** Where one workspace's books and posts live, and where they are served. */
function spaceFor(slug) {
  return {
    slug,
    booksDir: `${CONTENT_ROOT}/${slug}/books`,
    postsDir: `${CONTENT_ROOT}/${slug}/posts`,
    // The primary workspace owns the bare routes; the rest are namespaced.
    routePrefix: slug === PRIMARY_ORG ? '' : `${slug}/`,
    // Plugin ids must be unique across the whole site, and two workspaces can
    // both have a book called math.
    idPrefix: slug === PRIMARY_ORG ? '' : `${slug}-`,
  };
}

const SPACES = organizationSlugs().map(spaceFor);
const PRIMARY = SPACES[0];

const exists = p => fs.existsSync(nodePath.join(p));

/** Every book directory that exists, across every workspace. */
const BOOKS = SPACES.flatMap(space =>
  (() => {
    try {
      return fs.readdirSync(space.booksDir, {withFileTypes: true})
        .filter(e => e.isDirectory())
        .map(e => ({space, name: e.name}));
    } catch {
      return [];
    }
  })(),
);

/** Every blog directory that exists, with the titling the two known ones use. */
const BLOG_TITLES = {
  blog: {title: 'Blog', description: 'Blog posts', sidebarTitle: 'All Posts'},
  research: {
    title: 'Research Papers',
    description: 'Collection of research paper summaries and discussions',
    sidebarTitle: 'Recent Papers',
    showReadingTime: true,
  },
};

const BLOGS = SPACES.flatMap(space =>
  (() => {
    try {
      return fs.readdirSync(space.postsDir, {withFileTypes: true})
        .filter(e => e.isDirectory())
        .map(e => ({space, name: e.name}));
    } catch {
      return [];
    }
  })(),
);

// ── Shared plugin configs ──────────────────────────────────────────────────
// The primary workspace's directories, for the preset, which takes exactly one
// docs instance and must therefore be the primary org's `programming`.
const BOOKS_DIR = PRIMARY.booksDir;
const POSTS_DIR = PRIMARY.postsDir;

// remark-math runs first so math is parsed out of the tree before any plugin's
// syntax walks its text nodes.
const defaultRemarkPlugins = [
  [require('remark-math'), { strict: false }],
  ...loadRemarkPlugins(),
];

const defaultRehypePlugins = [
  [require('rehype-katex'), {
    strict: false,
    trust: true,
    fleqn: false,
  }],
];

const defaultRehypePluginsWithEqref = [
  [require('rehype-katex'), {
    strict: false,
    trust: true,
    fleqn: false,
    macros: {
      "\\eqref": "\\href{###1}{(\\text{#1})}"
    },
  }],
];

/** One book of one workspace: `{space, name}` from BOOKS. */
function makeDocsPlugin({space, name}) {
  return [
    '@docusaurus/plugin-content-docs',
    {
      id: `${space.idPrefix}${name}`,
      path: `${space.booksDir}/${name}`,
      routeBasePath: `${space.routePrefix}${name}`,
      // The breadcrumb bar's last crumb repeats the page title that the
      // <h1> right below it already carries.
      breadcrumbs: false,
      remarkPlugins: defaultRemarkPlugins,
      rehypePlugins: defaultRehypePlugins,
    },
  ];
}

/**
 * One blog of one workspace: `{space, name}` from BLOGS.
 *
 * `authorsMapPath` is resolved against this plugin's own `path`, so `../` lands
 * on `content/<slug>/posts/authors.yml`: each workspace names its own authors,
 * which is the only sensible reading of an author list once there is more than
 * one research group on the machine.
 *
 * A workspace whose blog has no authors.yml would fail the build on the first
 * post that names an author, so a missing one is left unset rather than
 * pointing at a file that is not there.
 */
function makeBlogPlugin({space, name}) {
  const titles = BLOG_TITLES[name] ?? {
    title: name.charAt(0).toUpperCase() + name.slice(1),
    description: `${name} posts`,
    sidebarTitle: 'Recent Posts',
  };
  const authorsMap = exists(`${space.postsDir}/authors.yml`);
  return [
    '@docusaurus/plugin-content-blog',
    {
      id: `${space.idPrefix}${name}`,
      path: `${space.postsDir}/${name}`,
      routeBasePath: `${space.routePrefix}${name}`,
      showReadingTime: titles.showReadingTime ?? false,
      blogTitle: titles.title,
      blogDescription: titles.description,
      blogSidebarTitle: titles.sidebarTitle,
      blogSidebarCount: 0,
      ...(authorsMap ? {authorsMapPath: '../authors.yml'} : {}),
      feedOptions: { type: ['rss', 'atom'], xslt: true },
      onInlineTags: 'warn',
      onInlineAuthors: 'warn',
      onUntruncatedBlogPosts: 'warn',
      remarkPlugins: defaultRemarkPlugins,
      rehypePlugins: defaultRehypePluginsWithEqref,
    },
  ];
}

// ── Main config ────────────────────────────────────────────────────────────
/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'Mochi Lab',
  tagline: 'Innovative Research & Development',
  favicon: 'img/mochi.jpg',

  // Served assets live with the rest of the source rather than at the root.
  staticDirectories: ['src/static'],

  customFields: {
    // Whether the sign-in gate is shown. The API server reads the same
    // variable to decide whether it requires a session, so the two can never
    // disagree. `npm start` sets it; `npm run start:noauth` does not.
    authEnabled: process.env.ENABLE_AUTH === 'true',
    // Whether the sign-in screen should sign itself in as root. Set by
    // `npm start` only; the server enforces the same flag plus a loopback
    // check, so a stray value here cannot grant a session by itself.
    devAutoLogin: process.env.DEV_AUTOLOGIN === 'true' && process.env.NODE_ENV !== 'production',
  },

  future: {
    v4: true,
  },

  url: 'https://mochi-lab.vercel.app',
  baseUrl: '/',

  organizationName: 'zeyuyang8',
  projectName: 'mochi-lab',

  onBrokenLinks: 'throw',
  onBrokenAnchors: 'ignore',
  markdown: {
    format: 'detect',
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  clientModules: [
    require.resolve('./src/client/prism-lean4.js'),
    require.resolve('./src/client/copyHeadingLink.js'),
  ],

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          path: `${BOOKS_DIR}/programming`,
          routeBasePath: 'programming',
          breadcrumbs: false,
          remarkPlugins: defaultRemarkPlugins,
          rehypePlugins: defaultRehypePlugins,
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      }),
    ],
  ],

  plugins: [
    // Every plugin's build half, in alphabetical order, configured by its own
    // plugin.json rather than from here.
    ...loadBuildPlugins(),

    // Local search
    [
      '@easyops-cn/docusaurus-search-local',
      {
        hashed: true,
        indexBlog: true,
        indexDocs: true,
        indexPages: false,
        // Generated from the same lists the plugins are, so a workspace cannot
        // be built and left out of search, or indexed under a route that moved.
        // These four arrays are positional: each docsDir must line up with the
        // docsRouteBasePath at the same index.
        docsRouteBasePath: BOOKS.map(b => `/${b.space.routePrefix}${b.name}`),
        docsDir: BOOKS.map(b => `${b.space.booksDir}/${b.name}`),
        blogDir: BLOGS.map(b => `${b.space.postsDir}/${b.name}`),
        blogRouteBasePath: BLOGS.map(b => `/${b.space.routePrefix}${b.name}`),
        searchBarShortcut: true,
        searchBarShortcutHint: true,
        highlightSearchTermsOnTargetPage: true,
        explicitSearchResultPath: true,
        searchResultContextMaxLength: 50,
        searchResultLimits: 10,
      },
    ],

    // One docs instance per book per workspace, and one blog instance per blog
    // per workspace, from whatever is on disk. `programming` of the primary
    // workspace is excluded because the classic preset above already declares
    // it, and two instances on one directory collide on their route.
    ...BOOKS
      .filter(b => !(b.space === PRIMARY && b.name === 'programming'))
      .map(makeDocsPlugin),
    ...BLOGS.map(makeBlogPlugin),
  ],

  headTags: [
    // Preconnect to external APIs for faster first requests
    {tagName: 'link', attributes: {rel: 'preconnect', href: 'https://api.semanticscholar.org'}},
    {tagName: 'link', attributes: {rel: 'preconnect', href: 'https://cdn.jsdelivr.net'}},
    {tagName: 'link', attributes: {rel: 'preconnect', href: 'https://fonts.googleapis.com'}},
    {tagName: 'link', attributes: {rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: 'anonymous'}},
  ],

  stylesheets: [
    {
      href: 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css',
      type: 'text/css',
      integrity: 'sha384-n8MVd4RsNIU0tAv4ct0nTaAbDJwPJzDEaqSD1odI+WdtXRGWt2kTvGFasHpSy3SV',
      crossorigin: 'anonymous',
    },
    {
      href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
      type: 'text/css',
    },
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      image: 'img/mochi.jpg',
      docs: {
        sidebar: {
          // Adds the collapse control at the foot of the chapter sidebar, so a
          // page can be read against the full width of the shell.
          hideable: true,
        },
      },
      navbar: {
        title: 'Mochi Lab',
        logo: {
          alt: 'Mochi Lab Logo',
          src: 'img/mochi.jpg',
        },
        items: [
          {to: '/research', label: 'Research'},
          {to: '/blog', label: 'Blog'},
          {
            type: 'doc',
            docId: 'intro',
            docsPluginId: 'survey',
            label: 'Survey',
          },
          {
            type: 'docSidebar',
            sidebarId: 'defaultSidebar',
            label: 'Programming',
          },
          {
            type: 'doc',
            docId: 'intro',
            docsPluginId: 'math',
            label: 'Math',
          },
          // Naming the search bar explicitly moves it from its default
          // auto-appended position to here, which is what lets the account
          // button sit to the right of it.
          {type: 'search', position: 'right'},
          {type: 'custom-userButton', position: 'right'},
        ],
      },
      prism: {
        theme: prismThemes.github,
        darkTheme: prismThemes.dracula,
      },
    }),
};

export default config;
