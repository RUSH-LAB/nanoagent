#!/usr/bin/env node
/**
 * npm run desktop:dev: RUSH Lab built from this checkout, installed in /Applications, and opened on
 * this checkout's `npm start` (--site, desktop/src-tauri/src/main.rs), whose window title names it.
 * Opened any other way (Finder, the Dock, at login) the app is on rush-lab.org again.
 */
import process from 'node:process';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {environmentFor} from './start-local.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const built = path.join(root, 'desktop', 'src-tauri', 'target', 'release', 'bundle', 'macos', 'RUSH Lab.app');
const installed = '/Applications/RUSH Lab.app';
const APP_ID = 'lab.mochi.lab';
// lab.mjs takes up to a minute to stop (src-tauri/src/lab.rs STOP_TIMEOUT).
const QUIT_TIMEOUT_MS = 90_000;

function run(command, args) {
  console.log(`$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, {stdio: 'inherit', cwd: root});
}

const running = () => {
  try {
    execFileSync('pgrep', ['-f', 'RUSH Lab.app/Contents/MacOS/'], {stdio: 'ignore'});
    return true;
  } catch {
    return false;
  }
};

async function main() {
  if (process.platform !== 'darwin') throw new Error('npm run desktop:dev builds the macOS app');
  // The same default as npm start's (start-local.mjs).
  const site = `http://localhost:${environmentFor().SITE_PORT || 3000}`;
  try {
    await fetch(site, {signal: AbortSignal.timeout(5_000)});
  } catch {
    throw new Error(`Nothing answers at ${site}: start Mochi with npm start first`);
  }
  run('npm', ['--prefix', 'desktop', 'install', '--no-audit', '--no-fund']);
  run('npm', ['--prefix', 'desktop', 'run', 'build', '--', '--bundles', 'app']);
  // One RUSH Lab runs at a time, and a second one opened only shows the first.
  if (running()) run('osascript', ['-e', `quit app id "${APP_ID}"`]);
  const deadline = Date.now() + QUIT_TIMEOUT_MS;
  while (running()) {
    if (Date.now() > deadline) throw new Error('RUSH Lab did not quit: quit it from its menu-bar icon, then run this again');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  run('rm', ['-rf', installed]);
  run('ditto', [built, installed]);
  // Only the installed copy may take rushlab: links (connect links from outside the window).
  run('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-u', built]);
  run('open', [installed, '--args', '--site', site]);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
