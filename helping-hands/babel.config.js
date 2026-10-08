'use strict';

module.exports = {
  presets: [require.resolve('@docusaurus/core/lib/babel/preset')],
  plugins: [[
    require.resolve('./scripts/babel/context-source-plugin.cjs'),
    {root: __dirname},
  ]],
};
