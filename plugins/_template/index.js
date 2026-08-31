/**
 * __TITLE__: the build half.
 *
 * Runs in Node during the Docusaurus build. It reads whatever the tool is built
 * on, publishes it as global data the pages can read, and registers those pages.
 *
 * Delete what this tool does not need: a plugin with no pages needs no
 * addRoute, and a plugin that only serves an API needs no index.js at all.
 */
const fs = require('fs');
const path = require('path');

module.exports = function __CAMEL__Plugin(context, options = {}) {
  // context.siteDir is the repo root. Prefer it over resolving from __dirname,
  // so the plugin keeps working wherever the directory is moved to.
  const siteDir = context?.siteDir ?? path.resolve(__dirname, '..', '..');
  const dataDir = path.join(siteDir, options.dir ?? 'content');

  return {
    name: '__NAME__',

    /** Files the dev server watches, so an edit rebuilds the pages. */
    getPathsToWatch() {
      return [`${dataDir}/**/*.md`];
    },

    /** Whatever the pages need, gathered once at build time. */
    async loadContent() {
      return {itemCount: fs.existsSync(dataDir) ? fs.readdirSync(dataDir).length : 0};
    },

    async contentLoaded({content, actions}) {
      const {setGlobalData, addRoute} = actions;

      // `command` is the contract with the shell. Declaring one is how the CLI
      // and the Cmd+K palette learn this tool exists; neither of them is edited
      // to add it. `icon` is a key into src/components/commands.js rather than
      // an SVG, because global data has to survive being serialized.
      setGlobalData({
        ...content,
        command: {
          id: '__NAME__',
          name: '__NAME__',
          category: 'Tools',
          icon: 'search',
          title: '__TITLE__',
          description: 'One line about what this tool is for',
          href: '/__NAME__',
        },
      });

      addRoute({
        path: '/__NAME__',
        component: '@site/plugins/__NAME__/components/Page',
        exact: true,
      });
    },
  };
};
