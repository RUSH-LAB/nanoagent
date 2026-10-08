import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const plugin = require('../../../scripts/babel/context-source-plugin.cjs');
const root = path.resolve('.');

function transform(source, filename) {
  return babel.transformSync(source, {
    filename: path.join(root, filename),
    configFile: false,
    babelrc: false,
    parserOpts: {plugins: ['jsx']},
    plugins: [[plugin, {root}]],
  }).code;
}

describe('copy-context JSX source instrumentation', () => {
  it('stamps native app elements with their source file and full line range', () => {
    const output = transform([
      'const page = (',
      '  <main>',
      '    <p>Selectable text</p>',
      '  </main>',
      ');',
    ].join('\n'), 'src/pages/example/index.js');
    assert.match(output, /data-context-file="src\/pages\/example\/index\.js"/);
    assert.match(output, /<p data-context-file="src\/pages\/example\/index\.js" data-context-start-line="3" data-context-end-line="3">/);
    assert.match(output, /<main data-context-file="src\/pages\/example\/index\.js" data-context-start-line="2" data-context-end-line="4">/);
  });

  it('does not stamp custom components or code outside app source', () => {
    const custom = transform('const page = <Card>Text</Card>;', 'src/pages/example/index.js');
    const dependency = transform('const page = <p>Text</p>;', 'node_modules/example/index.js');
    assert.doesNotMatch(custom, /data-context-file/);
    assert.doesNotMatch(dependency, /data-context-file/);
  });

  it('leaves runtime Markdown to its more precise document metadata', () => {
    assert.equal(plugin.isApplicationSource('src/runtime-content/SafeDocument.js'), false);
  });
});
