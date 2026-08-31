import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const os = require('os');
const path = require('path');
const {listPlugins, loadBuildPlugins, loadRemarkPlugins, writeClientComponentRegistry} = require('../../../../plugins/loader');
const {loadServerPlugins, collectProvides} = require('../../../../src/server/plugins');
const {API_VERSION} = require('../../../../src/server/plugin-api');

// ---------------------------------------------------------------------------
// A fixture plugins/ directory, one case per rule the loader states.
//
// The real plugins/ is asserted against separately at the bottom: the fixtures
// pin the rules, and that pins the tree those rules are applied to.
// ---------------------------------------------------------------------------

let root;

/** Write plugin.json plus whichever slot files the case needs. */
function makePlugin(name, {manifest = {}, files = {}} = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, {recursive: true});
  if (manifest !== null) {
    fs.writeFileSync(path.join(dir, 'plugin.json'), typeof manifest === 'string'
      ? manifest
      : JSON.stringify({title: name, ...manifest}));
  }
  for (const [file, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, file), body);
  }
  return dir;
}

const EXPORTS_FN = 'module.exports = function () { return {name: "x"}; };';

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-plugins-'));

  makePlugin('beta', {files: {'index.js': 'module.exports = (ctx, opts) => ({name: "beta", opts});'}});
  makePlugin('alpha', {
    manifest: {options: {greeting: 'hi'}, apiVersion: API_VERSION, requires: ['cache']},
    files: {
      'index.js': 'module.exports = (ctx, opts) => ({name: "alpha", opts});',
      'server.js': 'module.exports = function alphaRoutes() {}; module.exports.provides = {alphaData: 1};',
      'remark.js': 'module.exports = () => (tree) => { tree.touchedBy = "alpha"; };',
      'client.js': 'export const components = {Alpha: () => null};',
    },
  });
  makePlugin('_template', {files: {'index.js': EXPORTS_FN}});
  makePlugin('.hidden', {files: {'index.js': EXPORTS_FN}});
  makePlugin('turned-off', {manifest: {enabled: false}, files: {'index.js': EXPORTS_FN}});
  makePlugin('no-manifest', {manifest: null, files: {'index.js': EXPORTS_FN}});
  makePlugin('bad-manifest', {manifest: '{not json', files: {'index.js': EXPORTS_FN}});
  makePlugin('renamer', {manifest: {name: 'something-else'}, files: {'index.js': EXPORTS_FN}});
  makePlugin('not-a-function', {files: {'index.js': 'module.exports = {name: "nope"};'}});
  makePlugin('throws-on-load', {files: {'index.js': 'throw new Error("boom");'}});
  makePlugin('inert', {}); // legal: a manifest and nothing else
  fs.writeFileSync(path.join(root, 'loader.js'), '// a file, not a plugin');
});

after(() => {
  fs.rmSync(root, {recursive: true, force: true});
});

// Console noise is the point of several of these cases, so swallow it while
// asserting, and put the real console back afterwards.
function quietly(fn) {
  const realError = console.error;
  const seen = [];
  console.error = (...args) => seen.push(args.join(' '));
  try {
    return {result: fn(), errors: seen};
  } finally {
    console.error = realError;
  }
}

describe('plugins/loader: discovery', () => {
  it('finds each enabled plugin directory, in alphabetical order', () => {
    const {result} = quietly(() => listPlugins(root));
    // A slot that fails to load is still a discovered plugin: listPlugins reads
    // the directory, and requiring the slot happens later.
    assert.deepEqual(result.map(p => p.name), [
      'alpha', 'beta', 'inert', 'not-a-function', 'renamer', 'throws-on-load',
    ]);
  });

  it('skips a directory whose name starts with _ or ., which is what makes _template a template', () => {
    const {result} = quietly(() => listPlugins(root));
    const names = result.map(p => p.name);
    assert.ok(!names.includes('_template'));
    assert.ok(!names.includes('.hidden'));
  });

  it('skips a directory with no plugin.json, and a loose file in plugins/', () => {
    const {result} = quietly(() => listPlugins(root));
    const names = result.map(p => p.name);
    assert.ok(!names.includes('no-manifest'));
    assert.ok(!names.includes('loader.js'));
  });

  it('skips a plugin whose manifest says enabled: false', () => {
    const {result} = quietly(() => listPlugins(root));
    assert.ok(!result.map(p => p.name).includes('turned-off'));
  });

  it('reports malformed JSON by name and skips only that plugin', () => {
    const {result, errors} = quietly(() => listPlugins(root));
    assert.ok(!result.map(p => p.name).includes('bad-manifest'));
    assert.ok(errors.some(e => e.includes('bad-manifest/plugin.json')));
    assert.ok(result.map(p => p.name).includes('alpha'));
  });

  it('takes the name from the directory, ignoring a name field in the manifest', () => {
    const {result} = quietly(() => listPlugins(root));
    assert.ok(result.map(p => p.name).includes('renamer'));
    assert.ok(!result.map(p => p.name).includes('something-else'));
  });

  it('records only the slots a plugin actually fills', () => {
    const {result} = quietly(() => listPlugins(root));
    const byName = Object.fromEntries(result.map(p => [p.name, p]));
    assert.deepEqual(Object.keys(byName.alpha.slots).sort(), ['build', 'remark', 'server']);
    assert.deepEqual(Object.keys(byName.beta.slots), ['build']);
    assert.deepEqual(Object.keys(byName.inert.slots), []);
  });

  it('defaults the manifest fields a plugin leaves out', () => {
    const {result} = quietly(() => listPlugins(root));
    const beta = result.find(p => p.name === 'beta');
    assert.equal(beta.manifest.enabled, true);
    assert.deepEqual(beta.manifest.options, {});
    assert.equal(beta.manifest.description, '');
    assert.deepEqual(beta.manifest.commands, []);
    assert.deepEqual(beta.manifest.safeComponents, {});
    assert.equal(beta.manifest.runtimeRemark, false);
  });
});

describe('plugins/loader: the build half', () => {
  it('returns [factory, options] pairs, options coming from the manifest', () => {
    const {result} = quietly(() => loadBuildPlugins(root));
    const alpha = result.find(([factory]) => factory({}, {}).name === 'alpha');
    assert.deepEqual(alpha[1], {greeting: 'hi'});
    assert.deepEqual(alpha[0]({}, alpha[1]).opts, {greeting: 'hi'});
  });

  it('reports a slot that does not export a function, and one that throws, then carries on', () => {
    const {result, errors} = quietly(() => loadBuildPlugins(root));
    assert.ok(errors.some(e => e.includes('not-a-function/index.js') && e.includes('does not export a function')));
    assert.ok(errors.some(e => e.includes('throws-on-load/index.js') && e.includes('boom')));
    // alpha, beta and renamer still load: one broken plugin costs only itself.
    assert.equal(result.length, 3);
  });
});

describe('plugins/loader: the browser component registry', () => {
  it('generates explicit top-level imports instead of a recursive webpack scan', () => {
    const target = writeClientComponentRegistry(root);
    const source = fs.readFileSync(target, 'utf8');
    assert.match(source, /import \* as client0 from "\.\/alpha\/client\.js"/);
    assert.doesNotMatch(source, /require\.context/);
    assert.doesNotMatch(source, /beta\/client\.js/);
  });
});

describe('plugins/loader: the markdown half', () => {
  it('returns only the plugins with a remark.js, as bare factories', () => {
    const {result} = quietly(() => loadRemarkPlugins(root));
    assert.equal(result.length, 1);
    const tree = {};
    result[0]()(tree);
    assert.equal(tree.touchedBy, 'alpha');
  });
});

describe('plugins/loader: runtime Markdown and components', () => {
  it('loads only remark plugins that explicitly opt into runtime documents', () => {
    const manifest = path.join(root, 'alpha', 'plugin.json');
    const original = fs.readFileSync(manifest, 'utf8');
    fs.writeFileSync(manifest, JSON.stringify({
      title: 'alpha', runtimeRemark: true, safeComponents: {Alpha: {name: 'string'}},
      apiVersion: API_VERSION, requires: ['cache'],
    }));
    try {
      const {loadRuntimeRemarkPlugins, loadSafeComponents} = require('../../../../plugins/loader');
      assert.equal(loadRuntimeRemarkPlugins(root).length, 1);
      assert.deepEqual(loadSafeComponents(root), {Alpha: {name: 'string'}});
    } finally {
      fs.writeFileSync(manifest, original);
    }
  });
});

describe('src/server/plugins: the API half, on the same discovery', () => {
  it('loads only the plugins with a server.js, with what it publishes and asks for', () => {
    const {result} = quietly(() => loadServerPlugins(root));
    assert.deepEqual(result.map(p => p.name), ['alpha']);
    assert.deepEqual(collectProvides(result), {alphaData: 1});
    // The capabilities travel with the plugin, because the API is built per
    // request from exactly this list.
    assert.deepEqual(result[0].requires, ['cache']);
  });

  it('refuses a server half written against a different API version', () => {
    const manifest = path.join(root, 'alpha', 'plugin.json');
    const original = fs.readFileSync(manifest, 'utf8');
    fs.writeFileSync(manifest, JSON.stringify({title: 'alpha', apiVersion: API_VERSION + 1}));
    try {
      const {result, errors} = quietly(() => loadServerPlugins(root));
      assert.deepEqual(result, []);
      assert.ok(errors.some(e => e.includes('alpha/server.js') && e.includes('apiVersion')));
    } finally {
      fs.writeFileSync(manifest, original);
    }
  });

  it('refuses a server half that declares no API version at all', () => {
    const manifest = path.join(root, 'alpha', 'plugin.json');
    const original = fs.readFileSync(manifest, 'utf8');
    fs.writeFileSync(manifest, JSON.stringify({title: 'alpha'}));
    try {
      assert.deepEqual(quietly(() => loadServerPlugins(root)).result, []);
      // The build and markdown halves are unaffected: apiVersion is a promise
      // about the server API, and a page makes no such promise.
      assert.equal(quietly(() => loadRemarkPlugins(root)).result.length, 1);
    } finally {
      fs.writeFileSync(manifest, original);
    }
  });

  it('respects enabled: false, so one switch turns a whole tool off', () => {
    fs.writeFileSync(
      path.join(root, 'alpha', 'plugin.json'),
      JSON.stringify({title: 'alpha', enabled: false, apiVersion: API_VERSION}),
    );
    try {
      const {result} = quietly(() => loadServerPlugins(root));
      assert.deepEqual(result, []);
      assert.deepEqual(quietly(() => loadRemarkPlugins(root)).result, []);
    } finally {
      fs.writeFileSync(
        path.join(root, 'alpha', 'plugin.json'),
        JSON.stringify({title: 'alpha', options: {greeting: 'hi'}, apiVersion: API_VERSION, requires: ['cache']}),
      );
    }
  });
});

describe('the plugins this site actually has', () => {
  it('is the four optional tools under plugins/, each filling the slots it declares', () => {
    const found = Object.fromEntries(
      listPlugins().map(p => [p.name, Object.keys(p.slots).sort()]),
    );
    assert.deepEqual(found, {
      'bibliography': ['build', 'remark', 'server'],
      'lean-proofs': ['build', 'remark', 'server'],
      'math-registry': ['build'],
      'wiki-links': ['remark'],
    });
  });

  it('puts the bibliography ahead of wiki-links in the remark chain, as the site config assumes', () => {
    assert.deepEqual(listPlugins().map(p => p.name).filter(n => ['bibliography', 'wiki-links'].includes(n)),
      ['bibliography', 'wiki-links']);
  });
});
