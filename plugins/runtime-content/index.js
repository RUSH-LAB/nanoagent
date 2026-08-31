/**
 * The build half of runtime content: one route, and nothing compiled into it.
 *
 * Every other content route on this site is a page the build produced from a
 * file. This one is a single catch-all under /w that produces nothing: the
 * component behind it asks the API for a document, gets back MDX the server
 * compiled a moment ago, and runs it. Which pages exist is therefore a question
 * about the caller's session rather than about what was on disk when the site
 * was built.
 *
 * The consequence is the point. A workspace created a minute ago has pages here
 * immediately, a private page is refused to whoever may not read it, and adding
 * a hundredth workspace adds nothing to the build, because there is nothing per
 * workspace in it.
 *
 * `exact: false` is what makes it a catch-all: /w/books/math/0-intro and
 * /w/posts/blog/hello are the same route with a different remainder, and the
 * remainder is the document. Declaring the route at build time is the one thing
 * about content that still has to happen then; knowing a single page is not.
 */

module.exports = function runtimeContentPlugin(context, options = {}) {
  const routeBasePath = String(options.routeBasePath ?? 'w').replace(/^\/+|\/+$/g, '');

  return {
    name: 'runtime-content',

    contentLoaded({actions}) {
      // The component strips this off the URL to get the document path, so it
      // is published rather than spelled in both places.
      actions.setGlobalData({routeBasePath});

      actions.addRoute({
        path: `/${routeBasePath}`,
        exact: false,
        component: require.resolve('./components/DocumentRoute.js'),
      });
    },
  };
};
