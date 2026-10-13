#!/usr/bin/env node
/**
 * Stages everything the desktop app bundles, for the target Tauri is building
 * (TAURI_ENV_TARGET_TRIPLE, which Tauri sets for beforeBuildCommand):
 *
 *   src-tauri/resources/runner/     the relay that lends this computer's NanoAgent to Mochi
 *   src-tauri/resources/nanoagent/  NanoAgent's sources, uv.lock, plugins, and the built PI runner
 *   src-tauri/resources/config.yaml this folder's config.yaml
 *   src-tauri/resources/stamp       names this staging; the app installs each stamp once
 *   src-tauri/binaries/{node,uv}-<target>   the runtimes, downloaded and checksum-verified
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {nodeFileTrace} from '@vercel/nft';
import YAML from 'yaml';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mochiRoot = path.dirname(desktop);
const nanoagentRoot = path.resolve(mochiRoot, '..', 'nanoagent');
const resources = path.join(desktop, 'src-tauri', 'resources');
const binaries = path.join(desktop, 'src-tauri', 'binaries');
const cache = path.join(desktop, '.cache');
const config = YAML.parse(fs.readFileSync(path.join(desktop, 'config.yaml'), 'utf8'));

// Rust target triple -> the runtimes' own platform names.
const TARGETS = {
  'aarch64-apple-darwin': {node: 'darwin-arm64', archive: 'tar.gz', exe: ''},
  'x86_64-apple-darwin': {node: 'darwin-x64', archive: 'tar.gz', exe: ''},
  'x86_64-unknown-linux-gnu': {node: 'linux-x64', archive: 'tar.gz', exe: ''},
  'x86_64-pc-windows-msvc': {node: 'win-x64', archive: 'zip', exe: '.exe'},
};
// Never bundled from a checkout: environments, caches, and run output are rebuilt where they run.
const SKIP = new Set(['node_modules', '.venv', '__pycache__', '.pytest_cache', '.ruff_cache', 'outputs', '.DS_Store', '.lake']);

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(' ')}`);
  // npm is npm.cmd on Windows, which only a shell runs.
  execFileSync(command, args, {stdio: 'inherit', shell: process.platform === 'win32', ...options});
}

function copy(from, to) {
  fs.cpSync(from, to, {recursive: true, filter: source => !SKIP.has(path.basename(source))});
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function download(url, file) {
  if (fs.existsSync(file)) return;
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(`${file}.partial`, Buffer.from(await response.arrayBuffer()));
  fs.renameSync(`${file}.partial`, file);
}

/** Download `url` into the cache, check it against `expected`, and unpack it into a fresh folder. */
async function fetchVerified(url, expected) {
  const file = path.join(cache, path.basename(url));
  await download(url, file);
  const actual = sha256(file);
  if (actual !== expected) {
    fs.rmSync(file);
    throw new Error(`${path.basename(url)}: sha256 ${actual}, expected ${expected}`);
  }
  const unpacked = path.join(cache, `${path.basename(url)}.d`);
  fs.rmSync(unpacked, {recursive: true, force: true});
  fs.mkdirSync(unpacked);
  run('tar', ['-xf', file, '-C', unpacked]);
  return unpacked;
}

async function stageNode(target, platform) {
  const name = `node-v${config.node_version}-${platform.node}`;
  const base = `https://nodejs.org/dist/v${config.node_version}`;
  const archive = `${name}.${platform.archive}`;
  const sums = path.join(cache, `node-v${config.node_version}-SHASUMS256.txt`);
  await download(`${base}/SHASUMS256.txt`, sums);
  const line = fs.readFileSync(sums, 'utf8').split('\n').find(entry => entry.endsWith(`  ${archive}`));
  if (!line) throw new Error(`SHASUMS256.txt has no ${archive}`);
  const unpacked = await fetchVerified(`${base}/${archive}`, line.split(/\s+/)[0]);
  const binary = platform.exe ? path.join(unpacked, name, 'node.exe') : path.join(unpacked, name, 'bin', 'node');
  fs.copyFileSync(binary, path.join(binaries, `node-${target}${platform.exe}`));
}

async function stageUv(target, platform) {
  const archive = `uv-${target}.${platform.archive}`;
  const url = `https://github.com/astral-sh/uv/releases/download/${config.uv_version}/${archive}`;
  const sumFile = path.join(cache, `${archive}-${config.uv_version}.sha256`);
  await download(`${url}.sha256`, sumFile);
  const unpacked = await fetchVerified(url, fs.readFileSync(sumFile, 'utf8').split(/\s+/)[0]);
  const binary = platform.exe ? path.join(unpacked, 'uv.exe') : path.join(unpacked, `uv-${target}`, 'uv');
  fs.copyFileSync(binary, path.join(binaries, `uv-${target}${platform.exe}`));
}

// The relay and the protocol it shares with Mochi's server; Node's own modules are all it loads.
function stageRunner() {
  copy(path.join(mochiRoot, 'src', 'runner'), path.join(resources, 'runner'));
}

/** Keep only the files of `out`'s node_modules that `entries` load. */
async function trimNodeModules(out, entries) {
  const {fileList} = await nodeFileTrace(entries, {base: out});
  const full = path.join(out, 'node_modules');
  const kept = path.join(out, 'node_modules.kept');
  for (const file of fileList) {
    if (file.split(/[\\/]/)[0] !== 'node_modules') continue;
    const from = path.join(out, file);
    if (!fs.statSync(from).isFile()) continue;
    const to = path.join(kept, path.relative(full, from));
    fs.mkdirSync(path.dirname(to), {recursive: true});
    fs.copyFileSync(from, to);
  }
  fs.rmSync(full, {recursive: true});
  fs.renameSync(kept, full);
}

async function stageNanoAgent() {
  const out = path.join(resources, 'nanoagent');
  for (const entry of ['pyproject.toml', 'uv.lock', 'README.md', 'LICENSE', 'src', 'deploy', 'plugins']) {
    copy(path.join(nanoagentRoot, entry), path.join(out, entry));
  }
  // Built as the Dockerfile builds it, with dev dependencies; trimmed to what it loads.
  const runner = path.join(out, 'js', 'pi-runner');
  for (const entry of ['package.json', 'package-lock.json', 'tsconfig.json', 'src']) {
    copy(path.join(nanoagentRoot, 'js', 'pi-runner', entry), path.join(runner, entry));
  }
  run('npm', ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], {cwd: runner});
  run('npm', ['run', 'build'], {cwd: runner});
  await trimNodeModules(runner, [path.join(runner, 'dist', 'index.js')]);
}

async function main() {
  const target = process.env.TAURI_ENV_TARGET_TRIPLE;
  const platform = TARGETS[target];
  if (!platform) {
    throw new Error(`TAURI_ENV_TARGET_TRIPLE is ${JSON.stringify(target)}; run this through npm run build (targets: ${Object.keys(TARGETS).join(', ')})`);
  }
  fs.rmSync(resources, {recursive: true, force: true});
  fs.mkdirSync(resources, {recursive: true});
  fs.mkdirSync(binaries, {recursive: true});
  await stageNode(target, platform);
  await stageUv(target, platform);
  stageRunner();
  await stageNanoAgent();
  fs.copyFileSync(path.join(desktop, 'config.yaml'), path.join(resources, 'config.yaml'));
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {cwd: mochiRoot, encoding: 'utf8'}).trim();
  fs.writeFileSync(path.join(resources, 'stamp'), `${new Date().toISOString().replace(/[:.]/g, '-')}-${commit}\n`);
}

main().catch(error => {
  console.error(`Staging failed: ${error.message}`);
  process.exit(1);
});
