#!/usr/bin/env node
/**
 * node scripts/release/promote-lab.mjs <artifacts> [--apps]: upload to rush-lab.org what the
 * release pull request built and checked (.github/workflows/helpinghands-desktop.yml), downloaded
 * into <artifacts>, one folder per artifact, so a release builds nothing again: the engine
 * (rush-lab-engine/), and with --apps, when the release changed the shell, each target's app and
 * update (rush-lab-<target>/). Each must be for this checkout's shell (desktop/scripts/shell.mjs),
 * and is done only once rush-lab.org serves it. RUSH may still be deploying the commit that serves
 * an upload, so each is tried for 15 minutes. Needs LAB_UPLOAD_TOKEN.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {shellId} from '../../desktop/scripts/shell.mjs';

const SITE = 'https://rush-lab.org';
const TARGETS = ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-pc-windows-msvc'];
const RETRY_MS = 15 * 60_000;
const WAIT_MS = 30_000;

const token = process.env.LAB_UPLOAD_TOKEN;
const say = message => console.log(`${new Date().toISOString()} ${message}`);

/** Every file under `folder`, by its path. */
function files(folder) {
  return fs.readdirSync(folder, {recursive: true}).map(name => path.join(folder, name)).filter(file => fs.statSync(file).isFile());
}

/** The one file under `folder` whose name `test` takes. */
function one(folder, test, what) {
  const found = files(folder).filter(file => test(path.basename(file)));
  if (found.length !== 1) throw new Error(`${folder} has ${found.length} ${what}, not one`);
  return found[0];
}

const text = file => fs.readFileSync(file, 'utf8').trim();

/** PUT `file` to `route` with `headers`, for RETRY_MS. */
async function put(file, route, headers) {
  const deadline = Date.now() + RETRY_MS;
  for (;;) {
    const response = await fetch(`${SITE}${route}`, {
      method: 'PUT',
      body: fs.readFileSync(file),
      headers: {Authorization: `Bearer ${token}`, ...headers},
    }).catch(error => ({ok: false, status: error.message, text: async () => ''}));
    if (response.ok) return;
    const why = `${response.status} ${await response.text()}`;
    if (Date.now() > deadline) throw new Error(`${SITE} did not take ${path.basename(file)} at ${route} within ${RETRY_MS / 60_000} minutes: ${why}`);
    say(`${route}: ${why}; trying again in ${WAIT_MS / 1000}s`);
    await new Promise(resolve => setTimeout(resolve, WAIT_MS));
  }
}

/** Fail unless `got`, what the site serves, is `stamp`. */
function served(what, got, stamp) {
  if (got !== stamp) throw new Error(`${SITE} serves ${what} ${got}, not the ${stamp} uploaded`);
  say(`${SITE} serves ${what} ${stamp}.`);
}

async function main() {
  const [folder, ...flags] = process.argv.slice(2);
  if (!folder) throw new Error('usage: node scripts/release/promote-lab.mjs <artifacts> [--apps]');
  if (!token) throw new Error('LAB_UPLOAD_TOKEN is not set');
  const shell = shellId();

  const engine = path.join(folder, 'rush-lab-engine');
  if (text(path.join(engine, 'shell')) !== shell) throw new Error(`the engine built is for shell ${text(path.join(engine, 'shell'))}, and this checkout is ${shell}`);
  const stamp = text(path.join(engine, 'stamp'));
  const archive = path.join(engine, 'engine.tar.gz');
  await put(archive, '/api/lab/engine', {'X-Lab-Stamp': stamp, 'X-Lab-Signature': text(`${archive}.sig`), 'X-Lab-Shell': shell});
  served('the engine', (await (await fetch(`${SITE}/api/lab/engine`)).json()).stamp, stamp);

  if (!flags.includes('--apps')) return;
  for (const target of TARGETS) {
    const built = path.join(folder, `rush-lab-${target}`);
    const builtShell = text(one(built, name => name === 'shell', 'shell files'));
    if (builtShell !== shell) throw new Error(`${target}'s app is for shell ${builtShell}, and this checkout is ${shell}`);
    const appStamp = text(one(built, name => name === 'stamp', 'stamps'));
    const windows = target.includes('-windows-');
    const app = one(built, name => (windows ? name.endsWith('-setup.exe') : name.endsWith('.dmg')), 'apps');
    const update = windows ? app : one(built, name => name.endsWith('.app.tar.gz'), 'updates');
    await put(app, `/api/lab/bundles/${target}`, {'X-Lab-Stamp': appStamp});
    await put(update, `/api/lab/updates/${target}`, {'X-Lab-Stamp': appStamp, 'X-Lab-Signature': text(`${update}.sig`)});
    const response = await fetch(`${SITE}/api/lab/bundles/${target}`);
    await response.body?.cancel();
    served(`${target}'s app`, response.headers.get('x-lab-stamp'), appStamp);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
