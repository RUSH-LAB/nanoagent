/**
 * __TITLE__: the build half.
 *
 * Runs in Node during the Docusaurus build. It publishes only code-owned
 * metadata and registers routes; workspace records are loaded through the
 * scoped plugin API at request time.
 *
 * Delete what this tool does not need: a plugin with no pages needs no
 * addRoute, and a plugin that only serves an API needs no index.js at all.
 */
module.exports = function __CAMEL__Plugin() {
  return {
    name: '__NAME__',
    async contentLoaded({actions}) {
      const {setGlobalData, addRoute} = actions;

      // `command` is the contract with the shell. Declaring one is how the CLI
      // and the Cmd+K palette learn this tool exists; neither of them is edited
      // to add it. `icon` is a key into src/components/commands.js rather than
      // an SVG, because global data has to survive being serialized.
      setGlobalData({
        command: {
          id: '__NAME__',
          plugin: '__NAME__',
          scope: 'workspace',
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
      addRoute({
        path: '/w/:workspaceSlug/__NAME__',
        component: '@site/plugins/__NAME__/components/Page',
        exact: true,
      });
    },
  };
};
