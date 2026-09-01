import {themes as prismThemes} from 'prism-react-renderer';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

// The tools in plugins/, discovered rather than listed: see plugins/loader.js
// and plugins/README.md. Nothing below names a plugin, which is what makes
// adding one a matter of adding a directory.
const { loadBuildPlugins, writeClientComponentRegistry } = require('./plugins/loader');
const runtimeContentPlugin = require('./src/runtime-content');
const {platformConfig} = require('./src/platform');

// This file describes one deployable application, not one workspace. A
// workspace's title, logo, homepage, navigation, and collections are loaded
// from PostgreSQL at request time. These values are deliberately only the
// platform identity shown before a workspace has been resolved.
const {name: platformName, tagline: platformTagline} = platformConfig();

writeClientComponentRegistry();

// ── Main config ────────────────────────────────────────────────────────────
/** @type {import('@docusaurus/types').Config} */
const config = {
  title: platformName,
  tagline: platformTagline,
  favicon: 'img/mochi.jpg',

  // Served assets live with the rest of the source rather than at the root.
  staticDirectories: ['src/static'],

  customFields: {
    platformName,
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

  url: process.env.SITE_URL || 'http://localhost:3000',
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
    require.resolve('./src/client/copyHeadingLink.js'),
    require.resolve('./src/client/workspaceRoutes.js'),
  ],

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: false,
        blog: false,
        theme: {
          customCss: [
            require.resolve('katex/dist/katex.min.css'),
            require.resolve('./src/css/custom.css'),
          ],
        },
      }),
    ],
  ],

  plugins: [
    // Workspace documents and management screens are application routing, not
    // an optional tool. Keeping this in core lets every actual plugin remain
    // removable without taking workspace navigation with it.
    [runtimeContentPlugin, {routeBasePath: 'w'}],

    // Every plugin's build half, in alphabetical order, configured by its own
    // plugin.json rather than from here.
    ...loadBuildPlugins(),

  ],

  headTags: [
    {tagName: 'link', attributes: {rel: 'preconnect', href: 'https://fonts.googleapis.com'}},
    {tagName: 'link', attributes: {rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: 'anonymous'}},
  ],

  stylesheets: [
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
        title: platformName,
        logo: {
          alt: `${platformName} logo`,
          src: 'img/mochi.jpg',
        },
        items: [
          // Content navigation belongs to the workspace and is supplied by
          // workspace_settings after the URL workspace has been verified.
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
