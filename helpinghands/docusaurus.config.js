import {themes as prismThemes} from 'prism-react-renderer';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

// The tools in plugins/, discovered rather than listed: see plugins/loader.js
// and plugins/README.md. Nothing below names a plugin, which is what makes
// adding one a matter of adding a directory.
const { loadBuildPlugins, writeClientComponentRegistry } = require('./plugins/loader');
const runtimeContentPlugin = require('./src/runtime-content');
const {platformConfig} = require('./src/platform');
const {asksForSession, redirectFor} = require('./src/utils/signIn');

// This file describes one deployable application, not one workspace. A
// workspace's title, logo, homepage, navigation, and collections are loaded
// from PostgreSQL at request time. These values are deliberately only the
// platform identity shown before a workspace has been resolved.
const {name: platformName, tagline: platformTagline} = platformConfig();

writeClientComponentRegistry();

const apiOrigin = `http://localhost:${process.env.EDITOR_PORT || 3001}`;

/** The development server's half of the sign-in gate; see the api-proxy plugin below. */
async function signInGate(req, res, next) {
  if (!asksForSession(req)) return next();
  let session;
  try {
    const answer = await fetch(`${apiOrigin}/api/auth/get-session`, {headers: {cookie: req.headers.cookie || ''}});
    if (!answer.ok) throw new Error(`get-session returned ${answer.status}`);
    session = await answer.json();
  } catch (err) {
    res.writeHead(502, {'Content-Type': 'text/plain; charset=utf-8'});
    return res.end(`Could not reach the API server at ${apiOrigin} to check the session: ${err.message}`);
  }
  const redirect = redirectFor(req, Boolean(session?.user));
  if (!redirect) return next();
  res.writeHead(302, {Location: redirect, 'Cache-Control': 'no-store'});
  res.end();
}

// ── Main config ────────────────────────────────────────────────────────────
/** @type {import('@docusaurus/types').Config} */
const config = {
  title: platformName,
  tagline: platformTagline,
  favicon: 'img/rush-lab.png',

  // Served assets live with the rest of the source rather than at the root.
  staticDirectories: ['src/static'],

  customFields: {
    platformName,
  },

  future: {
    v4: true,
    // Copy-as-context needs source file/line metadata on Mochi's JSX. The SWC
    // fast path has no project-local transform hook, so keep the other faster
    // defaults and use Babel only for JavaScript/TypeScript compilation.
    faster: {
      swcJsLoader: false,
    },
  },

  url: process.env.SITE_URL || 'http://localhost:3000',
  baseUrl: '/',

  organizationName: 'RUSH-LAB',
  projectName: 'nanoagent',

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
    require.resolve('./src/client/serviceWorker.js'),
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

    // The development site serves the API from its own origin, as the
    // production server does, by passing /api to the API server
    // (scripts/dev/start-local.mjs). Compression is off so event streams
    // reach the browser as they are written. A page that needs a session is
    // gated here as the production server gates it (src/utils/signIn.js), by
    // asking the API server whether the request's cookie is signed in.
    () => ({
      name: 'api-proxy',
      configureWebpack: () => ({
        devServer: {
          compress: false,
          // `ws`: Mochi Lab's relay connects to /api/runner as a WebSocket (src/server/runner.js).
          proxy: [{context: ['/api'], target: apiOrigin, ws: true}],
          // Docusaurus has its own setupMiddlewares, and the two are composed by
          // concatenating what each returns, so this one returns nothing and
          // mounts the gate on the app directly, ahead of everything the
          // development server mounts once the list is assembled.
          setupMiddlewares: (middlewares, devServer) => {
            devServer.app.use(signInGate);
            return [];
          },
        },
      }),
    }),

    // Every plugin's build half, in alphabetical order, configured by its own
    // plugin.json rather than from here.
    ...loadBuildPlugins(),

  ],

  headTags: [
    {tagName: 'link', attributes: {rel: 'preconnect', href: 'https://fonts.googleapis.com'}},
    {tagName: 'link', attributes: {rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: 'anonymous'}},
  ],

  // Inter for the interface; Instrument Serif for a workspace's name on its
  // home page (runtime-content/workspaceHome.module.css).
  stylesheets: [
    {
      href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif&display=swap',
      type: 'text/css',
    },
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      image: 'img/rush-lab.png',
      docs: {
        sidebar: {
          // Adds the collapse control at the foot of the chapter sidebar, so a
          // page can be read against the full width of the shell.
          hideable: true,
        },
      },
      navbar: {
        // No logo: the corner names the workspace you are in (WorkspaceSwitcher),
        // and a picture beside it read as either the workspace or the app.
        title: platformName,
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
