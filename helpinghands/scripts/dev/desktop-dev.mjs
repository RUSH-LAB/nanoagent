#!/usr/bin/env node
/**
 * npm run desktop:dev: RUSH Lab Dev built from this checkout, installed beside RUSH Lab
 * (/Applications on macOS, %LOCALAPPDATA% on Windows), and opened. It is built by RUSH Lab's code
 * and steps, with config.yaml's `dev` block (desktop/scripts/stage.mjs --dev) instead of a
 * release's --release: its own name, identifier and data folder, link scheme and folders, and this checkout's `npm start` as its only site. It never
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
const mac = process.platform === 'darwin';
const windows = process.platform === 'win32';
const bundleFolder = path.join(desktop, 'src-tauri', 'target', 'release', 'bundle');
const built = path.join(bundleFolder, 'macos', `${config.product_name}.app`);
const installed = `/Applications/${config.product_name}.app`;
// On Windows, where the NSIS installer puts the app for this user (tauri.conf.json: nsis installMode currentUser),
// and the data folder NanoAgent and its services run from, which RUSH Lab Dev's quitting must reach as well.
const ownFolders = [config.product_name, config.label].map(name => path.join(process.env.LOCALAPPDATA || '', name));
// lab.mjs takes up to a minute to stop (src-tauri/src/lab.rs STOP_TIMEOUT).
const QUIT_TIMEOUT_MS = 90_000;

function run(command, args) {
  console.log(`$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, {stdio: 'inherit', cwd: root});
}

// npm is npm.cmd on Windows, which only a shell runs: run npm's own script with this Node instead.
const npm = args => run(process.execPath, [process.env.npm_execpath, ...args]);

/** What RUSH Lab Dev's build changes in tauri.conf.json, which keeps RUSH Lab's: who the app is, and its staging. */
export function devOverlay(dev) {
  return {
    productName: dev.product_name,
    identifier: dev.label,
    build: {beforeBuildCommand: 'node scripts/stage.mjs --dev'},
    plugins: {'deep-link': {desktop: {schemes: [dev.scheme]}}},
  };
}

/** Build RUSH Lab Dev: `built` on macOS, its NSIS installer on Windows (returned). */
export function buildDev() {
  if (!mac && !windows) throw new Error('RUSH Lab Dev is built for macOS and Windows');
  fs.writeFileSync(overlayFile, `${JSON.stringify(devOverlay(config), null, 2)}\n`);
  npm(['--prefix', 'desktop', 'install', '--no-audit', '--no-fund']);
  npm(['--prefix', 'desktop', 'run', 'build', '--', '--config', overlayFile, '--bundles', mac ? 'app' : 'nsis']);
  if (mac) return built;
  const folder = path.join(bundleFolder, 'nsis');
  const setups = fs.readdirSync(folder).filter(name => name.startsWith(`${config.product_name}_`) && name.endsWith('-setup.exe'));
  if (setups.length !== 1) throw new Error(`${folder} has ${setups.length} installers of ${config.product_name}, not one`);
  return path.join(folder, setups[0]);
}

/** The ids of RUSH Lab Dev's processes: the app and every service it started. Only its own folders, not RUSH Lab's. */
function processIds() {
  const command = mac
    ? ['pgrep', ['-f', `${config.product_name}.app/Contents/MacOS/`]]
    : ['powershell', ['-NoProfile', '-Command', `$folders = @(${ownFolders.map(folder => `'${folder}\\'`).join(', ')}); Get-Process | Where-Object { $path = $_.Path; $path -and ($folders | Where-Object { $path.StartsWith($_, 'OrdinalIgnoreCase') }) } | ForEach-Object { $_.Id }`]];
  try {
    return execFileSync(command[0], command[1], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}
const running = () => processIds().length > 0;

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
    throw new Error(`Nothing answers at ${config.site_url}: start RUSH with npm start first`);
  }
  const output = buildDev();
  // A second copy opened only shows the first, so the one running quits for the new build.
  if (running()) {
    if (mac) run('osascript', ['-e', `quit app id "${config.label}"`]);
    // /T takes a process's children with it, so one listed may be gone by its turn.
    else for (const id of processIds()) if (processIds().includes(id)) run('taskkill', ['/PID', id, '/T', '/F']);
  }
  const deadline = Date.now() + QUIT_TIMEOUT_MS;
  while (running()) {
    if (Date.now() > deadline) throw new Error(`${config.product_name} did not quit: quit it from its icon, then run this again`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (windows) {
    // /S installs with no questions; /R opens the app once it is installed.
    run(output, ['/S', '/R']);
    return;
  }
  run('rm', ['-rf', installed]);
  run('ditto', [output, installed]);
  // Only the installed copy may take its scheme's links (connect links from outside the window).
  run('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-u', output]);
  run('open', [installed]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
