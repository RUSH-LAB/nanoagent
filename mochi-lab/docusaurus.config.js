/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {themes as prismThemes} from 'prism-react-renderer';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const remarkCite = require('./plugins/remark-cite');

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'Mochi Lab',
  tagline: 'Innovative Research & Development',
  favicon: 'img/mochi.jpg',

  customFields: {
    authEnabled: false,
  },

  // Future flags, see https://docusaurus.io/docs/api/docusaurus-config#future
  future: {
    v4: true, // Improve compatibility with the upcoming Docusaurus v4
  },

  // Set the production url of your site here
  url: 'https://mochi-lab.vercel.app',
  // Set the /<baseUrl>/ pathname under which your site is served
  // For GitHub pages deployment, it is often '/<projectName>/'
  baseUrl: '/',

  // GitHub pages deployment config.
  // If you aren't using GitHub pages, you don't need these.
  organizationName: 'zeyuyang8', // Usually your GitHub org/user name.
  projectName: 'mochi-lab', // Usually your repo name.

  onBrokenLinks: 'throw',
  onBrokenAnchors: 'ignore',
  markdown: {
    format: 'detect',
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  // Even if you don't use internationalization, you can use this field to set
  // useful metadata like html lang. For example, if your site is Chinese, you
  // may want to replace "en" with "zh-Hans".
  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          path: 'programming',
          routeBasePath: 'programming',
          sidebarPath: './sidebars.js',
          // Please change this to your repo.
          // Remove this to remove the "edit this page" links.
          editUrl:
            'https://github.com/zeyuyang8/mochi-lab/tree/main/mochi-lab/',
          // Add math support to docs with KaTeX
          remarkPlugins: [
            [require('remark-math'), { strict: false }],
            remarkCite,
          ],
          rehypePlugins: [
            [require('rehype-katex'), {
              strict: false,
              trust: true,
              fleqn: false,
              // Remove the eqref macro - it doesn't work properly
            }]
          ],
        },
        blog: false, // Disable default blog, we'll use a plugin instead
        // Main blog configuration remains here
        theme: {
          customCss: './src/css/custom.css',
        },
      }),
    ],
  ],
  // Add this plugins section
  plugins: [
    // Local search plugin
    [
      '@easyops-cn/docusaurus-search-local',
      {
        hashed: true,
        indexBlog: true,
        indexDocs: true,
        indexPages: false,
        docsRouteBasePath: ['/programming', '/math', '/build-with-ai', '/survey'],
        docsDir: ['programming', 'math', 'build-with-ai', 'survey'],
        blogRouteBasePath: ['/blog', '/research'],
        // Enable search in development
        searchBarShortcut: true,
        searchBarShortcutHint: true,
        highlightSearchTermsOnTargetPage: true,
        explicitSearchResultPath: true,
        // This will make search work in development
        // but note it might be slower to build
        searchResultContextMaxLength: 50,
        searchResultLimits: 10,
      },
    ],
    // Survey docs plugin
    [
      '@docusaurus/plugin-content-docs',
      {
        id: 'survey',
        path: 'survey',
        routeBasePath: 'survey',
        editUrl: 'https://github.com/zeyuyang8/mochi-lab/tree/main/mochi-lab/',
        remarkPlugins: [remarkCite],
      },
    ],
    // Build with AI docs plugin
    [
      '@docusaurus/plugin-content-docs',
      {
        id: 'build-with-ai',
        path: 'build-with-ai',
        routeBasePath: 'build-with-ai',
        editUrl: 'https://github.com/zeyuyang8/mochi-lab/tree/main/mochi-lab/',
        remarkPlugins: [
          [require('remark-math'), { strict: false }],
          remarkCite,
        ],
        rehypePlugins: [
          [require('rehype-katex'), {
            strict: false,
            trust: true,
            fleqn: false,
          }]
        ],
      },
    ],
    // Math docs plugin
    [
      '@docusaurus/plugin-content-docs',
      {
        id: 'math',
        path: 'math',
        routeBasePath: 'math',
        editUrl: 'https://github.com/zeyuyang8/mochi-lab/tree/main/mochi-lab/',
        remarkPlugins: [
          [require('remark-math'), { strict: false }],
          remarkCite,
        ],
        rehypePlugins: [
          [require('rehype-katex'), {
            strict: false,
            trust: true,
            fleqn: false,
          }]
        ],
      },
    ],
    // Blog plugin
    [
      '@docusaurus/plugin-content-blog',
      {
        id: 'blog',
        path: 'blog',
        routeBasePath: 'blog',
        showReadingTime: false,
        blogTitle: 'Blog',
        blogDescription: 'Blog posts',
        blogSidebarTitle: 'All Posts',
        blogSidebarCount: 0,
        authorsMapPath: '../authors.yml',
        feedOptions: {
          type: ['rss', 'atom'],
          xslt: true,
        },
        editUrl: 'https://github.com/zeyuyang8/mochi-lab/tree/main/mochi-lab/',
        onInlineTags: 'warn',
        onInlineAuthors: 'warn',
        onUntruncatedBlogPosts: 'warn',
        remarkPlugins: [require('remark-math'), remarkCite],
        rehypePlugins: [
          [require('rehype-katex'), {
            strict: false,
            trust: true,
            fleqn: false,
            macros: {
              "\\eqref": "\\href{###1}{(\\text{#1})}"
            }
          }]
        ],
      },
    ],
    // Research blog plugin
    [
      '@docusaurus/plugin-content-blog',
      {
        id: 'research',
        path: 'research',
        routeBasePath: 'research',
        showReadingTime: true,
        blogTitle: 'Research Papers',
        blogDescription: 'Collection of research paper summaries and discussions',
        blogSidebarTitle: 'Recent Papers',
        blogSidebarCount: 0,
        authorsMapPath: '../authors.yml',
        feedOptions: {
          type: ['rss', 'atom'],
          xslt: true,
        },
        editUrl: 'https://github.com/zeyuyang8/mochi-lab/tree/main/mochi-lab/',
        remarkPlugins: [require('remark-math'), remarkCite],
        rehypePlugins: [
          [require('rehype-katex'), {
            strict: false,
            trust: true,
            fleqn: false,
            macros: {
              "\\eqref": "\\href{###1}{(\\text{#1})}"
            }
          }]
        ],
      },
    ],
    // Bibliography data plugin
    require('./plugins/docusaurus-plugin-bibliography'),
    // Math cross-page registry plugin — scans multiple content dirs for <Ref> support
    [
      require('./plugins/docusaurus-plugin-math-registry'),
      {
        contentDirs: [
          { dir: 'math', routeBase: 'math' },
          { dir: 'build-with-ai', routeBase: 'build-with-ai' },
        ],
      },
    ],
  ],
  // Add KaTeX CSS with auto-render extension
  stylesheets: [
    {
      href: 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css',
      type: 'text/css',
      integrity: 'sha384-n8MVd4RsNIU0tAv4ct0nTaAbDJwPJzDEaqSD1odI+WdtXRGWt2kTvGFasHpSy3SV',
      crossorigin: 'anonymous',
    },
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      // Replace with your project's social card
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
          {
            type: 'doc',
            docId: 'intro',
            docsPluginId: 'build-with-ai',
            label: 'Build with AI',
          },
          {
            href: 'https://github.com/zeyuyang8/mochi-lab',
            label: 'GitHub',
            position: 'right',
          },
          {
            to: '/bibliography',
            label: 'Bibliography',
            position: 'right',
          },
        ],
      },
      footer: {
        style: 'dark',
        copyright: `Copyright © ${new Date().getFullYear()} Mochi Lab. Built with Docusaurus.`,
      },
      prism: {
        theme: prismThemes.github,
        darkTheme: prismThemes.dracula,
      },
    }),
};

export default config;
