import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {serveStaticSite, candidateFiles} = require('../../../src/server/static-site.js');

function response() {
  return {
    status: null, headers: null, body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
}

describe('production static application shell', () => {
  it('serves hashed assets with immutable caching', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-static-'));
    try {
      fs.mkdirSync(path.join(root, 'assets'));
      fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'ok');
      const res = response();
      assert.equal(serveStaticSite({method: 'GET', url: '/assets/app.js'}, res, {root}), true);
      assert.equal(res.status, 200);
      assert.equal(res.body.toString(), 'ok');
      assert.match(res.headers['Cache-Control'], /immutable/);
    } finally { fs.rmSync(root, {recursive: true, force: true}); }
  });

  it('serves index.html for a runtime workspace URL', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-static-'));
    try {
      fs.writeFileSync(path.join(root, 'index.html'), '<main>shell</main>');
      const res = response();
      assert.equal(serveStaticSite({method: 'GET', url: '/w/team/documents/new'}, res, {root}), true);
      assert.equal(res.body.toString(), '<main>shell</main>');
      assert.equal(res.headers['Cache-Control'], 'no-cache');
    } finally { fs.rmSync(root, {recursive: true, force: true}); }
  });

  it('never produces a candidate outside the build directory', () => {
    const root = path.resolve('/tmp/mochi-build');
    assert.equal(candidateFiles(root, '/../../etc/passwd').every(file => file.startsWith(`${root}${path.sep}`)), true);
    assert.deepEqual(candidateFiles(root, '/bad%00path'), []);
  });

  it('does not serve non-read methods', () => {
    assert.equal(serveStaticSite({method: 'POST', url: '/'}, response(), {root: '/tmp/missing'}), false);
  });
});
