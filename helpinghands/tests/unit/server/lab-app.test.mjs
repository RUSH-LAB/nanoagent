import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {releaseApp, servedApp} = require('../../../src/server/lab-app.js');

const RELEASE = {productName: 'RUSH Lab', label: 'lab.mochi.lab', scheme: 'rushlab'};
const DEV = {productName: 'RUSH Lab Dev', label: 'lab.mochi.lab.dev', scheme: 'rushlab-dev'};

function configFile(text) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lab-app-')), 'config.yaml');
  fs.writeFileSync(file, text);
  return file;
}

describe('the RUSH Lab app that serves a site', () => {
  it('is RUSH Lab Dev on npm start\'s local site, and RUSH Lab on any other (desktop/config.yaml)', () => {
    assert.deepEqual(servedApp({MOCHI_LOCAL_SITE: '1'}), DEV);
    assert.deepEqual(servedApp({}), RELEASE);
    assert.deepEqual(releaseApp(), RELEASE);
  });

  it('fails clearly when it cannot be told', () => {
    assert.throws(() => servedApp({MOCHI_LOCAL_SITE: 'yes'}), /MOCHI_LOCAL_SITE is 1 or unset, not yes/);
    const noDev = configFile('product_name: A\nlabel: a.b\nscheme: a\n');
    assert.deepEqual(servedApp({}, noDev), {productName: 'A', label: 'a.b', scheme: 'a'});
    assert.throws(() => servedApp({MOCHI_LOCAL_SITE: '1'}, noDev), /has no dev block/);
    assert.throws(() => releaseApp(configFile('product_name: A\nlabel: a.b\n')), /names no scheme/);
    assert.throws(() => releaseApp(configFile('product_name: A\nlabel: a.b\nscheme: "a b"\n')), /is not a URL scheme/);
    assert.throws(() => servedApp({MOCHI_LOCAL_SITE: '1'}, configFile('product_name: A\nlabel: a.b\nscheme: a\ndev:\n  scheme: 1\n')), /dev block names no scheme/);
  });
});
