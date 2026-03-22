/**
 * Docusaurus plugin that exposes references.yaml data via setGlobalData(),
 * making it available to React pages via usePluginData('bibliography').
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

module.exports = function bibliographyPlugin() {
  return {
    name: 'bibliography',
    async loadContent() {
      const bibPath = path.resolve(__dirname, '..', 'references.yaml');
      try {
        const raw = fs.readFileSync(bibPath, 'utf8');
        return yaml.load(raw) || {};
      } catch (err) {
        console.warn(`[bibliography] Could not load ${bibPath}: ${err.message}`);
        return {};
      }
    },
    async contentLoaded({ content, actions }) {
      const { setGlobalData } = actions;
      setGlobalData({ references: content });
    },
  };
};
