#!/usr/bin/env node
/**
 * npm run desktop:dev: RUSH Lab Dev built from this checkout, installed in /Applications beside
 * RUSH Lab, and opened. It is built by RUSH Lab's code and steps, with config.yaml's `dev` block
 * (desktop/scripts/stage.mjs --dev) instead of a release's --release: its own name, identifier and
 * data folder, link scheme and folders, and this checkout's `npm start` as its only site. It never
 * updates itself, and nothing here touches RUSH Lab. npm run desktop:dev:build only builds it.
 */
import fs from 'node:fs';
import process from 'node:process';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readConfig} from '../../desktop/scripts/config.mjs';
import {environmentFor} from './start-local.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktop = path.join(root, 'desktop');
// Git-ignored (desktop/.gitignore): written from config.yaml for each build.
const overlayFile = path.join(desktop, 'src-tauri', 'tauri.dev.conf.json');
const config = readConfig({dev: true});
const built = path.join(desktop, 'src-tauri', 'target', 'release', 'bundle', 'macos', `${config.product_name}.app`);
const installed = `/Applications/${config.product_name}.app`;
// lab.mjs takes up to a minute to stop (src-tauri/src/lab.rs STOP_TIMEOUT).
const QUIT_TIMEOUT_MS = 90_000;

function run(command, args) {
  console.log(`$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, {stdio: 'inherit', cwd: root});
}

/** What RUSH Lab Dev's build changes in tauri.conf.json, which keeps RUSH Lab's: who the app is, and its staging. */
export function devOverlay(dev) {
  return {
    productName: dev.product_name,
    identifier: dev.label,
    build: {beforeBuildCommand: 'node scripts/stage.mjs --dev'},
    plugins: {'deep-link': {desktop: {schemes: [dev.scheme]}}},
  };
}

/** Build RUSH Lab Dev's macOS app: `built`. */
export function buildDev() {
  if (process.platform !== 'darwin') throw new Error('RUSH Lab Dev is built for macOS');
  fs.writeFileSync(overlayFile, `${JSON.stringify(devOverlay(config), null, 2)}\n`);
  run('npm', ['--prefix', 'desktop', 'install', '--no-audit', '--no-fund']);
  run('npm', ['--prefix', 'desktop', 'run', 'build', '--', '--config', overlayFile, '--bundles', 'app']);
}

// Only RUSH Lab Dev: RUSH Lab's executable is under RUSH Lab.app/.
const running = () => {
  try {
    execFileSync('pgrep', ['-f', `${config.product_name}.app/Contents/MacOS/`], {stdio: 'ignore'});
    return true;
  } catch {
    return false;
  }
};

async function main() {
  // The site npm start serves (start-local.mjs) must be the one RUSH Lab Dev is built for.
  const port = String(environmentFor().SITE_PORT || 3000);
  const site = new URL(config.site_url);
  if (site.port !== port) {
    throw new Error(`RUSH Lab Dev serves ${config.site_url} (desktop/config.yaml dev.site_url), but npm start serves port ${port} (SITE_PORT)`);
  }
  try {
    await fetch(site, {signal: AbortSignal.timeout(5_000)});
  } catch {
    throw new Error(`Nothing answers at ${config.site_url}: start Mochi with npm start first`);
  }
  buildDev();
  // A second copy opened only shows the first, so the one running quits for the new build.
  if (running()) run('osascript', ['-e', `quit app id "${config.label}"`]);
  const deadline = Date.now() + QUIT_TIMEOUT_MS;
  while (running()) {
    if (Date.now() > deadline) throw new Error(`${config.product_name} did not quit: quit it from its menu-bar icon, then run this again`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  run('rm', ['-rf', installed]);
  run('ditto', [built, installed]);
  // Only the installed copy may take its scheme's links (connect links from outside the window).
  run('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-u', built]);
  run('open', [installed]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
