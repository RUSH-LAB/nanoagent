import {themes as prismThemes} from 'prism-react-renderer';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const remarkCite = require('./plugins/remark-cite');
const remarkWikiLinks = require('./plugins/remark-wiki-links');

// ── Shared plugin configs ──────────────────────────────────────────────────
const BOOKS_DIR = 'content/books';
const POSTS_DIR = 'content/posts';

const defaultRemarkPlugins = [
  [require('remark-math'), { strict: false }],
  remarkCite,
  remarkWikiLinks,
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

function makeDocsPlugin(id, name) {
  return [
    '@docusaurus/plugin-content-docs',
    {
      id,
      path: `${BOOKS_DIR}/${name}`,
      routeBasePath: name,
      // The breadcrumb bar's last crumb repeats the page title that the
      // <h1> right below it already carries.
      breadcrumbs: false,
      remarkPlugins: defaultRemarkPlugins,
      rehypePlugins: defaultRehypePlugins,
    },
  ];
}

function makeBlogPlugin(id, name, {title, description, sidebarTitle, showReadingTime = false}) {
  return [
    '@docusaurus/plugin-content-blog',
    {
      id,
      path: `${POSTS_DIR}/${name}`,
      routeBasePath: name,
      showReadingTime,
      blogTitle: title,
      blogDescription: description,
      blogSidebarTitle: sidebarTitle,
      blogSidebarCount: 0,
      authorsMapPath: '../authors.yml',
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
    // Serves the Lake project's declarations so <LeanProof name="..."> can
    // render the real, lake-checked source.
    './plugins/lean-proofs',
    // Local search
    [
      '@easyops-cn/docusaurus-search-local',
      {
        hashed: true,
        indexBlog: true,
        indexDocs: true,
        indexPages: false,
        docsRouteBasePath: ['/programming', '/math', '/builder', '/survey'],
        docsDir: [`${BOOKS_DIR}/programming`, `${BOOKS_DIR}/math`, `${BOOKS_DIR}/builder`, `${BOOKS_DIR}/survey`],
        blogDir: [`${POSTS_DIR}/blog`, `${POSTS_DIR}/research`],
        blogRouteBasePath: ['/blog', '/research'],
        searchBarShortcut: true,
        searchBarShortcutHint: true,
        highlightSearchTermsOnTargetPage: true,
        explicitSearchResultPath: true,
        searchResultContextMaxLength: 50,
        searchResultLimits: 10,
      },
    ],

    // Docs plugins
    makeDocsPlugin('survey', 'survey'),
    makeDocsPlugin('builder', 'builder'),
    makeDocsPlugin('math', 'math'),

    // Blog plugins
    makeBlogPlugin('blog', 'blog', {
      title: 'Blog',
      description: 'Blog posts',
      sidebarTitle: 'All Posts',
    }),
    makeBlogPlugin('research', 'research', {
      title: 'Research Papers',
      description: 'Collection of research paper summaries and discussions',
      sidebarTitle: 'Recent Papers',
      showReadingTime: true,
    }),

    // Custom plugins
    require('./plugins/docusaurus-plugin-bibliography'),
    [
      require('./plugins/docusaurus-plugin-math-registry'),
      {
        contentDirs: [
          { dir: `${BOOKS_DIR}/math`, routeBase: 'math' },
          { dir: `${BOOKS_DIR}/builder`, routeBase: 'builder' },
        ],
      },
    ],
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
