import {themes as prismThemes} from 'prism-react-renderer';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const remarkCite = require('./plugins/remark-cite');
const remarkWikiLinks = require('./plugins/remark-wiki-links');

// ── Shared plugin configs ──────────────────────────────────────────────────
const EDIT_URL = 'https://github.com/zeyuyang8/mochi-lab/tree/main/mochi-lab/';
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
      authorsMapPath: '../../../authors.yml',
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

  customFields: {
    // Set DISABLE_AUTH=true to skip the Clerk auth gate (used by `npm start`).
    authEnabled: process.env.DISABLE_AUTH !== 'true',
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
    require.resolve('./src/prism-lean4.js'),
    require.resolve('./src/copyHeadingLink.js'),
  ],

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          path: `${BOOKS_DIR}/programming`,
          routeBasePath: 'programming',
          sidebarPath: './sidebars.js',
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
            sidebarId: 'tutorialSidebar',
            label: 'Programming',
          },
          {
            type: 'doc',
            docId: 'intro',
            docsPluginId: 'math',
            label: 'Math',
          },
          {to: '/discussions', label: 'Discuss'},
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Content',
            items: [
              {label: 'Research', to: '/research'},
              {label: 'Blog', to: '/blog'},
              {label: 'Survey', to: '/survey/intro'},
              {label: 'Math', to: '/math/intro'},
              {label: 'Programming', to: '/programming/intro'},
              {label: 'Builder', to: '/builder/intro'},
            ],
          },
          {
            title: 'Tools',
            items: [
              {label: 'Editor', to: '/editor'},
              {label: 'Bibliography', to: '/bibliography'},
              {label: 'Reading Lists', to: '/reading-lists'},
              {label: 'Discussions', to: '/discussions'},
              {label: 'Graph', to: '/graph'},
            ],
          },
          {
            title: 'More',
            items: [
              {label: 'Discover', to: '/recommendations'},
              {label: 'Analytics', to: '/analytics'},
              {label: 'API Docs', to: '/api-docs'},
              {label: 'About', to: '/about'},
              {label: 'GitHub', href: 'https://github.com/zeyuyang8/mochi-lab'},
            ],
          },
        ],
        copyright: `Copyright © ${new Date().getFullYear()} Mochi Lab. Built with Docusaurus.`,
      },
      prism: {
        theme: prismThemes.github,
        darkTheme: prismThemes.dracula,
      },
    }),
};

export default config;
