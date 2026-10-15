#!/usr/bin/env node
/**
 * Builds RUSH Lab for this computer from this checkout (desktop/scripts/bundle-lab.mjs) and keeps
 * it as the local database's bundle for this computer's target, as the release job uploads
 * production's (routes/lab.js). The local site's install command then installs it, as
 * rush-lab.org's does, as a connection of the same install (src/runner/lab.mjs).
 *
 *   npm run lab:bundle
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {LOCAL_OWNER_URL, startLocal} from '../db/local.mjs';

const require = createRequire(import.meta.url);
const {createPostgresLab} = require('../../src/server/postgres/lab.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktop = path.join(root, 'desktop');
// The bundle's target for this computer, as install.sh names it.
const TARGETS = {'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin', 'linux-x64': 'x86_64-unknown-linux-gnu'};
// What routes/lab.js lets an upload be.
const MAX_BUNDLE_BYTES = 200 * 1024 * 1024;

async function main() {
  const target = TARGETS[`${process.platform}-${process.arch}`];
  if (!target) throw new Error(`RUSH Lab has no bundle for ${process.platform} ${process.arch}`);
  execFileSync('npm', ['--prefix', desktop, 'run', 'bundle:lab'], {stdio: 'inherit', env: {...process.env, TAURI_ENV_TARGET_TRIPLE: target}});
  const archive = path.join(desktop, 'dist', `mochi-lab-${target}.tar.gz`);
  const stamp = fs.readFileSync(path.join(desktop, '.cache', 'lab', 'mochi-lab', 'stamp'), 'utf8').trim();
  startLocal();
  const pool = new pg.Pool({connectionString: LOCAL_OWNER_URL});
  try {
    const bundle = await createPostgresLab({pool}).replace(target, stamp, fs.createReadStream(archive), MAX_BUNDLE_BYTES);
    console.log(`The local site now installs RUSH Lab ${bundle.stamp} for ${target} (${(bundle.size / 1024 / 1024).toFixed(1)} MB).`);
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error(`npm run lab:bundle failed: ${error.message}`);
  process.exitCode = 1;
});
