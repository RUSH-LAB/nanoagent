import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {loadRoute, makeCtx, invoke} from '../../_harness.mjs';
import {as, migratedDatabase} from './_pglite.mjs';

const require = createRequire(import.meta.url);
const {createPostgresFs, createPublicFsReader} = require('../../../../src/server/fs/store.js');
const {servePublicPage, treeToHtml} = require('../../../../src/server/public-pages.js');
const {compileMarkdown, parseFrontmatter} = require('../../../../src/server/mdx.js');
const {resolveWorkspaceSite} = require('../../../../src/server/workspace-site.js');

describe('publishing', () => {
  let db;
  let publicFs;
  let ctx;
  const routes = loadRoute('public');
  const visit = (path, options = {}) => invoke(routes, {ctx, path, auth: null, ...options});

  before(async () => {
    const database = await migratedDatabase();
    db = database.db;
    const fs = createPostgresFs({pool: database.pool});
    publicFs = createPublicFsReader({pool: database.pool});
    ctx = makeCtx({publicFs});
    const alice = as('alice');
    await fs.write(alice, 'posts/hello.md', '---\ntitle: Hello\ndescription: A first post\n---\nHello, <world> & friends.');
    await fs.write(alice, 'posts/plot.png', Buffer.from('png'));
    await fs.write(alice, 'notes/private.md', 'members only');
    await fs.setAccess(alice, 'posts', 'public');
    await fs.write(as('carol', 'other'), 'secret.md', 'nobody');
  });
  after(() => db?.close());

  it('describes a workspace that publishes, and no other', async () => {
    const lab = await visit('/api/public/lab');
    assert.equal(lab.status, 200);
    assert.equal(lab.payload.workspace.name, 'Lab');
    assert.equal((await visit('/api/public/other')).status, 404);
    assert.equal((await visit('/api/public/missing')).status, 404);
  });

  it('serves public documents through the document routes and nothing else', async () => {
    const tree = await visit('/api/public/lab/documents/tree');
    assert.deepEqual(tree.payload.documents.map(document => document.path), ['posts/hello.md']);
    const page = await visit('/api/public/lab/documents', {query: {path: 'posts/hello'}});
    assert.equal(page.status, 200);
    assert.equal(page.payload.document.title, 'Hello');
    assert.match(JSON.stringify(page.payload.tree), /friends/);
    assert.equal((await visit('/api/public/lab/documents', {query: {path: 'notes/private'}})).status, 404);
  });

  it('serves public files and refuses writes', async () => {
    const file = await visit('/api/public/lab/fs/file', {query: {path: 'posts/plot.png'}});
    assert.equal(file.written.status, 200);
    assert.equal(file.written.body.toString(), 'png');
    assert.equal((await visit('/api/public/lab/fs/file', {query: {path: 'notes/private.md'}})).status, 404);
    const write = await visit('/api/public/lab/documents', {method: 'POST', body: {path: 'posts/x.md', markdown: 'x'}});
    assert.equal(write.status, 405);
  });

  it('renders a public page as HTML for visitors and crawlers', async () => {
    const shell = '<html><head><title>Mochi</title><meta name="description" content="app"></head><body><div id="__docusaurus"></div></body></html>';
    const res = {
      written: null,
      writeHead(status, headers) { this.written = {status, headers}; },
      end(body) { this.written.body = String(body); },
    };
    const served = await servePublicPage({method: 'GET', url: '/w/lab/documents/posts/hello'}, res, {
      root: '/build', publicFs, compileMarkdown, parseFrontmatter, resolveWorkspaceSite,
      files: {readFileSync: () => shell},
    });
    assert.equal(served, true);
    assert.match(res.written.body, /<title>Hello \| Lab<\/title>/);
    assert.match(res.written.body, /<meta name="description" content="A first post">/);
    assert.match(res.written.body, /<noscript><article><h1>Hello<\/h1><p>Hello, &lt;world&gt; &amp; friends\.<\/p>/);
    assert.ok(!res.written.body.includes('<title>Mochi</title>'));

    const unpublished = await servePublicPage({method: 'GET', url: '/w/lab/documents/notes/private'}, res, {
      root: '/build', publicFs, compileMarkdown, parseFrontmatter, resolveWorkspaceSite, files: {readFileSync: () => shell},
    });
    assert.equal(unpublished, false);
  });

  it('never turns tree text or links into markup', () => {
    const html = treeToHtml({type: 'root', children: [
      {type: 'link', url: 'javascript:alert(1)', children: [{type: 'text', value: '<script>'}]},
      {type: 'component', name: 'Unknown', children: [{type: 'text', value: '"quoted"'}]},
    ]});
    assert.equal(html, '<a href="#">&lt;script&gt;</a>&quot;quoted&quot;');
  });
});
