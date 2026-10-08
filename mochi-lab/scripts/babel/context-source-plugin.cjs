'use strict';

const path = require('path');

const ATTRS = Object.freeze({
  file: 'data-context-file',
  start: 'data-context-start-line',
  end: 'data-context-end-line',
});

function normalizedRelative(root, filename) {
  if (!filename) return null;
  return path.relative(root, filename).split(path.sep).join('/');
}

function isApplicationSource(relative) {
  if (!relative || relative.startsWith('../')) return false;
  if (!relative.startsWith('src/') && !relative.startsWith('plugins/')) return false;
  if (relative.includes('/node_modules/') || relative.includes('/.docusaurus/')) return false;
  if (/\.generated\.[jt]sx?$/.test(relative)) return false;
  // Runtime Markdown already carries the actual document file and lines. A
  // build-source stamp here would overwrite that more useful origin.
  return relative !== 'src/runtime-content/SafeDocument.js';
}

function hasAttribute(opening, name) {
  return opening.attributes.some(attribute => (
    attribute.type === 'JSXAttribute' && attribute.name?.name === name
  ));
}

module.exports = function contextSourcePlugin({types: t}) {
  return {
    name: 'mochi-context-source-locations',
    visitor: {
      JSXOpeningElement(path_, state) {
        const opening = path_.node;
        if (!t.isJSXIdentifier(opening.name) || !/^[a-z]/.test(opening.name.name)) return;

        const root = state.opts.root || process.cwd();
        const relative = normalizedRelative(root, state.file.opts.filename);
        if (!isApplicationSource(relative) || hasAttribute(opening, ATTRS.file)) return;

        const element = path_.parentPath?.isJSXElement() ? path_.parentPath.node : opening;
        const startLine = element.loc?.start?.line;
        const endLine = element.loc?.end?.line;
        if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return;

        opening.attributes.push(
          t.jsxAttribute(t.jsxIdentifier(ATTRS.file), t.stringLiteral(relative)),
          t.jsxAttribute(t.jsxIdentifier(ATTRS.start), t.stringLiteral(String(startLine))),
          t.jsxAttribute(t.jsxIdentifier(ATTRS.end), t.stringLiteral(String(endLine))),
        );
      },
    },
  };
};

module.exports.ATTRS = ATTRS;
module.exports.isApplicationSource = isApplicationSource;
