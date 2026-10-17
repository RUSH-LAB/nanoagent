#!/usr/bin/env node
/**
 * Stages everything the desktop app bundles, for the target Tauri is building
 * (TAURI_ENV_TARGET_TRIPLE, which Tauri sets for beforeBuildCommand):
 *
 *   src-tauri/resources/runner/     the relay that lends this computer's NanoAgent to Mochi
 *   src-tauri/resources/nanoagent/  NanoAgent compiled by Nuitka (site/), its uv.lock, the PI runner's bundle, and the config the app runs
 *   src-tauri/resources/config.json this folder's config.yaml, as JSON: lab.mjs loads only Node's own modules
 *   src-tauri/resources/stamp       names this staging; the app installs each stamp once
 *   src-tauri/resources/git/        Windows only: MinGit, with busybox-w32 as its shell
 *   src-tauri/binaries/{node,uv}-<target>   the runtimes, downloaded and checksum-verified
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
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

/** Download `url` into the cache and check it against `expected`: its file. */
async function fetchChecked(url, expected) {
  const file = path.join(cache, path.basename(url));
  await download(url, file);
  const actual = sha256(file);
  if (actual !== expected) {
    fs.rmSync(file);
    throw new Error(`${path.basename(url)}: sha256 ${actual}, expected ${expected}`);
  }
  return file;
}

/** Download `url` into the cache, check it against `expected`, and unpack it into a fresh folder. */
async function fetchVerified(url, expected) {
  const file = await fetchChecked(url, expected);
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

/**
 * Windows only: git, which uv runs to fetch a git dependency. MinGit's shell is MSYS's, which cannot
 * start in a plugin's AppContainer, so busybox-w32 takes its place as usr/bin/sh.exe.
 */
async function stageGit() {
  const unpacked = await fetchVerified(
    `https://github.com/git-for-windows/git/releases/download/${config.mingit_release}/MinGit-${config.mingit_version}-64-bit.zip`,
    config.mingit_sha256,
  );
  const git = path.join(resources, 'git');
  fs.cpSync(unpacked, git, {recursive: true});
  const busybox = await fetchChecked(`https://frippery.org/files/busybox/busybox-w64u-${config.busybox_build}.exe`, config.busybox_sha256);
  fs.copyFileSync(busybox, path.join(git, 'usr', 'bin', 'sh.exe'));
}

// lab.mjs, the relay and the protocol it shares with Mochi's server; Node's own modules are all they load.
function stageRunner() {
  copy(path.join(mochiRoot, 'src', 'runner'), path.join(resources, 'runner'));
}

/**
 * NanoAgent ships compiled, not as source: Nuitka builds its package into one module, for the
 * Python the app runs it on, in resources/nanoagent/site/ with the files it reads beside it.
 * Its dependencies are open source and are installed from the uv.lock resolved here, on first
 * launch. Beside them go the PI runner's two bundled files and the config lab.mjs runs, at
 * the paths that config names them by.
 */
async function stageNanoAgent(uv) {
  const out = path.join(resources, 'nanoagent');
  const build = path.join(cache, 'nuitka');
  fs.rmSync(build, {recursive: true, force: true});
  run(uv, [
    'run', '--no-project', '--managed-python', '--python', config.python_version, '--with-editable', '.[compile]',
    'python', '-m', 'nuitka', '--mode=package', '--assume-yes-for-downloads', `--output-dir=${build}`, 'src/nanoagent',
  ], {cwd: nanoagentRoot});
  // Nuitka's module is a .so on macOS and Linux, a .pyd on Windows.
  const [module] = fs.readdirSync(build).filter(name => /\.(so|pyd)$/.test(name));
  copy(path.join(build, module), path.join(out, 'site', module));
  // What the code reads from its package's folder: every file but its .py, and the plugin
  // template whole, which `nanoagent plugin new` copies.
  const source = path.join(nanoagentRoot, 'src', 'nanoagent');
  const template = path.join(source, 'plugin', 'template');
  fs.cpSync(source, path.join(out, 'site', 'nanoagent'), {
    recursive: true,
    filter: from => !SKIP.has(path.basename(from)) && (from.startsWith(template) || !from.endsWith('.py')),
  });
  // NanoAgent is a library and keeps no lock; the app pins the versions resolved for this build,
  // which it installs with `uv sync --frozen` on first launch. Locking reads NanoAgent's version
  // from its source, so it runs on a copy with the source, and only the lock ships.
  const locking = path.join(cache, 'nanoagent-lock');
  fs.rmSync(locking, {recursive: true, force: true});
  for (const entry of ['pyproject.toml', 'README.md', 'LICENSE', 'src']) {
    copy(path.join(nanoagentRoot, entry), path.join(locking, entry));
  }
  run(uv, ['lock'], {cwd: locking});
  for (const entry of ['pyproject.toml', 'uv.lock']) {
    copy(path.join(locking, entry), path.join(out, entry));
  }
  // Built as the Dockerfile builds it, with dev dependencies; only the bundle ships.
  const runner = path.join(cache, 'pi-runner');
  fs.rmSync(runner, {recursive: true, force: true});
  for (const entry of ['package.json', 'package-lock.json', 'tsconfig.json', 'build.mjs', 'src']) {
    copy(path.join(nanoagentRoot, 'js', 'pi-runner', entry), path.join(runner, entry));
  }
  run('npm', ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], {cwd: runner});
  run('npm', ['run', 'build'], {cwd: runner});
  for (const file of ['index.js', 'models.js']) {
    copy(path.join(runner, 'dist', file), path.join(out, 'js', 'pi-runner', 'dist', file));
  }
  for (const file of ['deploy/railway/nanoagent.yaml', 'deploy/railway/profiles']) {
    copy(path.join(nanoagentRoot, file), path.join(out, file));
  }
}

async function main() {
  const target = process.env.TAURI_ENV_TARGET_TRIPLE;
  const platform = TARGETS[target];
  if (!platform) {
    throw new Error(`TAURI_ENV_TARGET_TRIPLE is ${JSON.stringify(target)}; run this through npm run build (targets: ${Object.keys(TARGETS).join(', ')})`);
  }
  fs.rmSync(resources, {recursive: true, force: true});
  // Tauri copies resources into its target folder and never removes a file a later build dropped.
  for (const part of ['runner', 'nanoagent', 'git']) fs.rmSync(path.join(desktop, 'src-tauri', 'target', 'release', part), {recursive: true, force: true});
  fs.mkdirSync(resources, {recursive: true});
  fs.mkdirSync(binaries, {recursive: true});
  await stageNode(target, platform);
  await stageUv(target, platform);
  stageRunner();
  if (platform.exe) await stageGit();
  await stageNanoAgent(path.join(binaries, `uv-${target}${platform.exe}`));
  fs.writeFileSync(path.join(resources, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {cwd: mochiRoot, encoding: 'utf8'}).trim();
  fs.writeFileSync(path.join(resources, 'stamp'), `${new Date().toISOString().replace(/[:.]/g, '-')}-${commit}\n`);
}

main().catch(error => {
  console.error(`Staging failed: ${error.message}`);
  process.exit(1);
});
