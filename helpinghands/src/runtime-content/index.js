/**
 * The build half of runtime content: one route, and nothing compiled into it.
 *
 * Every other content route on this site is a page the build produced from a
 * file. This one is a single catch-all under /w that produces nothing: the
 * component behind it asks the API for a document and receives a constrained
 * render tree produced from Markdown. Which pages exist is therefore a question
 * about the caller's session rather than about what was on disk when the site
 * was built.
 *
 * The consequence is the point. A workspace created a minute ago has pages here
 * immediately, a private page is refused to whoever may not read it, and adding
 * a hundredth workspace adds nothing to the build, because there is nothing per
 * workspace in it.
 *
 * `exact: false` is what makes it a catch-all:
 * /w/acme/documents/handbook/intro and
 * /w/acme/documents/updates/hello are the same route with a different
 * remainder. Declaring the route at build time is the one thing
 * about content that still has to happen then; knowing a single page is not.
 */

module.exports = function runtimeContentPlugin(_context, options = {}) {
  const routeBasePath = String(options.routeBasePath ?? 'w').replace(/^\/+|\/+$/g, '');
  const workspacePages = [
    'analytics', 'apps', 'channels', 'compare', 'content-search', 'files', 'flashcards',
    'glossary', 'graph', 'marketplace', 'mindmap', 'reading-lists',
    'recommendations', 'settings', 'stats', 'tasks', 'timeline', 'whiteboard', 'workspace',
  ];

  return {
    name: 'runtime-content',

    contentLoaded({actions}) {
      // The component strips this off the URL to get the document path, so it
      // is published rather than spelled in both places.
      actions.setGlobalData({routeBasePath});

      actions.addRoute({
        path: `/${routeBasePath}/:workspaceSlug/documents`,
        exact: false,
        component: require.resolve('./DocumentRoute.js'),
      });
      actions.addRoute({
        path: '/documents',
        exact: false,
        component: require.resolve('./LegacyDocumentRedirect.js'),
      });
      actions.addRoute({
        path: `/${routeBasePath}/:workspaceSlug`,
        exact: true,
        component: require.resolve('./WorkspaceHomeRoute.js'),
      });
      for (const page of workspacePages) {
        actions.addRoute({
          path: `/${routeBasePath}/:workspaceSlug/${page}`,
          exact: true,
          component: require.resolve(`../pages/${page}/index.js`),
        });
      }
    },
  };
};
