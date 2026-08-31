/** Bibliography UI routes. Paper data is fetched from the scoped API at runtime. */
module.exports = function bibliographyPlugin() {
  return {
    name: 'bibliography',

    async loadContent() {
      // Never serialize one workspace's references into the application build.
      return null;
    },

    async contentLoaded({actions}) {
      const {setGlobalData, addRoute} = actions;
      setGlobalData({
        command: {
          id: 'bibliography',
          name: 'bibliography',
          category: 'Tools',
          icon: 'book',
          title: 'Bibliography',
          description: 'Browse and manage references',
          href: '/bibliography',
        },
      });

      // Legacy routes are navigation shims; workspace-aware routes fetch every
      // paper and attachment from the request-scoped server API.
      addRoute({path: '/bibliography', component: '@site/plugins/bibliography/components/Page', exact: true});
      addRoute({path: '/bibliography/:key', component: '@site/plugins/bibliography/components/Item', exact: true});
      addRoute({path: '/w/:workspaceSlug/bibliography', component: '@site/plugins/bibliography/components/Page', exact: true});
      addRoute({path: '/w/:workspaceSlug/bibliography/:key', component: '@site/plugins/bibliography/components/Item', exact: true});
    },
  };
};
