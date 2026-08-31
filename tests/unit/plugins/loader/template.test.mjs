import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { renderPlugin, toCamel, toTitle } from '../../../../scripts/new-plugin.mjs';

const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const {listPlugins, loadBuildPlugins, loadRemarkPlugins, requireSlot} = require('../../../../plugins/loader');
const {API_VERSION} = require('../../../../src/server/plugin-api');

// ---------------------------------------------------------------------------
// plugins/_template is a working plugin that the loaders skip, so the only way
// to know it still satisfies the contract is to scaffold one and load it. That
// is what this does, which makes the template executable documentation rather
// than a copy of the real thing that quietly rots.
//
// It renders inside the repo rather than into os.tmpdir(), because the template's
// server.js imports #plugin-api, and node resolves a # import against the nearest
// package.json — which, from /tmp, is nowhere.
// ---------------------------------------------------------------------------

const HERE = path.dirname(require.resolve('./template.test.mjs'));
const NAME = 'reading-list';

let root;
let dest;

before(() => {
  root = fs.mkdtempSync(path.join(HERE, '.tmp-scaffold-'));
  dest = path.join(root, NAME);
  renderPlugin({name: NAME, dest});
});

after(() => {
  fs.rmSync(root, {recursive: true, force: true});
});

describe('scripts/new-plugin: the names it derives', () => {
  it('turns a kebab-case directory name into an identifier and a title', () => {
    assert.equal(toCamel('reading-list'), 'readingList');
    assert.equal(toTitle('reading-list'), 'Reading List');
    assert.equal(toCamel('bibliography'), 'bibliography');
    assert.equal(toTitle('bibliography'), 'Bibliography');
  });

  it('refuses a name that is not kebab-case, or a directory that already exists', () => {
    assert.throws(() => renderPlugin({name: 'Reading List', dest: path.join(root, 'x')}), /kebab-case/);
    assert.throws(() => renderPlugin({name: '_private', dest: path.join(root, 'y')}), /kebab-case/);
    assert.throws(() => renderPlugin({name: NAME, dest}), /already exists/);
  });
});

describe('the scaffolded plugin', () => {
  it('writes every slot, plus the components directory and a README', () => {
    for (const rel of ['plugin.json', 'index.js', 'server.js', 'remark.js', 'components/Page.js', 'README.md']) {
      assert.ok(fs.existsSync(path.join(dest, rel)), `${rel} is missing`);
    }
  });

  it('leaves no template token behind', () => {
    const walk = (dir) => fs.readdirSync(dir, {withFileTypes: true}).flatMap(e =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
    for (const file of walk(dest)) {
      const body = fs.readFileSync(file, 'utf8');
      assert.ok(!/__[A-Z]+__/.test(body), `${path.relative(dest, file)} still has a token`);
    }
  });

  it('is discovered as a plugin filling all three slots', () => {
    const found = listPlugins(root);
    assert.deepEqual(found.map(p => p.name), [NAME]);
    assert.deepEqual(Object.keys(found[0].slots).sort(), ['build', 'remark', 'server']);
    assert.equal(found[0].manifest.title, 'Reading List');
  });

  it('has a build half that names itself and routes its page', () => {
    const [[factory, options]] = loadBuildPlugins(root);
    const plugin = factory({siteDir: root}, options);
    assert.equal(plugin.name, NAME);

    const routes = [];
    let globalData = null;
    plugin.contentLoaded({
      content: {itemCount: 0},
      actions: {addRoute: r => routes.push(r), setGlobalData: d => { globalData = d; }},
    });
    assert.deepEqual(routes.map(r => r.path), [`/${NAME}`]);
    assert.equal(routes[0].component, `@site/plugins/${NAME}/components/Page`);
    // The command is the contract with the shell: src/components/commands.js
    // requires a name and an href, and drops anything without both.
    assert.equal(globalData.command.name, NAME);
    assert.equal(globalData.command.href, `/${NAME}`);
  });

  it('declares the API version it was written against, so the server can refuse it', () => {
    assert.equal(listPlugins(root)[0].manifest.apiVersion, API_VERSION);
    assert.deepEqual(listPlugins(root)[0].manifest.requires, []);
  });

  it('has an API half of the shape the dispatcher calls, that answers its own path only', async () => {
    const routes = requireSlot(listPlugins(root)[0], 'server');
    assert.equal(typeof routes, 'function');

    // The narrow API, not ctx: a plugin never sees the server's own object.
    const sent = [];
    const api = {respond: (res, status, body) => sent.push([status, body])};
    const url = new URL(`http://localhost/api/${NAME}/items?limit=5`);
    await routes({method: 'GET'}, {}, url, `/api/${NAME}/items`, api);
    assert.deepEqual(sent, [[200, {items: [], limit: 5}]]);

    // Anything it does not own falls through untouched, so the next module gets it.
    sent.length = 0;
    await routes({method: 'GET'}, {}, new URL('http://localhost/api/files'), '/api/files', api);
    assert.deepEqual(sent, []);
  });

  it('bounds the page size it hands back, however much is asked for', async () => {
    const routes = requireSlot(listPlugins(root)[0], 'server');
    const sent = [];
    const api = {respond: (res, status, body) => sent.push([status, body])};
    const call = q => routes({method: 'GET'}, {}, new URL(`http://localhost/api/${NAME}/items${q}`),
      `/api/${NAME}/items`, api);

    await call('?limit=9999');
    await call('');
    await call('?limit=nonsense');
    assert.deepEqual(sent.map(([, body]) => body.limit), [100, 20, 20]);
  });

  it('has a markdown half that starts as a no-op, so a new plugin changes no page', () => {
    const [remark] = loadRemarkPlugins(root);
    const tree = {type: 'root', children: [
      {type: 'paragraph', children: [{type: 'text', value: 'Left [[alone]] entirely.'}]},
    ]};
    const before = JSON.stringify(tree);
    remark()(tree, {message: () => {}});
    assert.equal(JSON.stringify(tree), before);
  });
});
