#!/usr/bin/env node
/**
 * Stages everything the desktop app bundles, for the target Tauri is building
 * (TAURI_ENV_TARGET_TRIPLE, which Tauri sets for beforeBuildCommand):
 *
 *   src-tauri/resources/runner/, nanoagent/, stamp, shell   the engine the app is built with (scripts/engine.mjs),
 *                                   which it runs until its site serves a newer one for its shell
 *   src-tauri/resources/config.json this folder's config.yaml, as JSON (scripts/config.mjs): lab.mjs loads only
 *                                   Node's own modules; with --release (npm run build:release), the target it
 *                                   updates itself as; with --dev (npm run desktop:dev), RUSH Lab Dev's
 *   src-tauri/resources/git/        git: on macOS built from source, on Windows MinGit with busybox-w32 as its shell
 *   src-tauri/binaries/{node,uv}-<target>   the runtimes, downloaded and checksum-verified
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {readConfig} from './config.mjs';
import {run, stageEngine, tar} from './engine.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resources = path.join(desktop, 'src-tauri', 'resources');
const binaries = path.join(desktop, 'src-tauri', 'binaries');
const cache = path.join(desktop, '.cache');
const release = process.argv.includes('--release');
const dev = process.argv.includes('--dev');
const config = readConfig({dev});

// Rust target triple -> the runtimes' own platform names.
const TARGETS = {
  'aarch64-apple-darwin': {node: 'darwin-arm64', archive: 'tar.gz', exe: '', arch: 'arm64'},
  'x86_64-apple-darwin': {node: 'darwin-x64', archive: 'tar.gz', exe: '', arch: 'x86_64'},
  'x86_64-unknown-linux-gnu': {node: 'linux-x64', archive: 'tar.gz', exe: ''},
  'x86_64-pc-windows-msvc': {node: 'win-x64', archive: 'zip', exe: '.exe'},
};
// This computer's target, for the uv the engine is locked with (fetchUv).
const HOSTS = {'darwin arm64': 'aarch64-apple-darwin', 'darwin x64': 'x86_64-apple-darwin', 'linux x64': 'x86_64-unknown-linux-gnu', 'win32 x64': 'x86_64-pc-windows-msvc'};

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
  run(tar(), ['-xf', file, '-C', unpacked]);
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

/** uv for `target` (this computer's by default), downloaded into the cache and checked: its program. */
export async function fetchUv(target = HOSTS[`${process.platform} ${process.arch}`]) {
  const platform = TARGETS[target];
  if (!platform) throw new Error(`uv for ${process.platform} ${process.arch} is not one the app knows`);
  const archive = `uv-${target}.${platform.archive}`;
  const url = `https://github.com/astral-sh/uv/releases/download/${config.uv_version}/${archive}`;
  const sumFile = path.join(cache, `${archive}-${config.uv_version}.sha256`);
  await download(`${url}.sha256`, sumFile);
  const unpacked = await fetchVerified(url, fs.readFileSync(sumFile, 'utf8').split(/\s+/)[0]);
  return platform.exe ? path.join(unpacked, 'uv.exe') : path.join(unpacked, `uv-${target}`, 'uv');
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

/**
 * macOS only: git, built for `arch` from its source. It links only to the system's libraries
 * (curl, zlib, iconv), and with RUNTIME_PREFIX finds its own helpers beside wherever it is, as the
 * app installs it in the data folder (src-tauri/src/lab.rs). The build is kept in the cache.
 */
async function stageMacGit(target, arch) {
  const built = path.join(cache, `git-${config.git_version}-${target}`);
  if (!fs.existsSync(built)) {
    const unpacked = await fetchVerified(`https://mirrors.edge.kernel.org/pub/software/scm/git/git-${config.git_version}.tar.xz`, config.git_sha256);
    run('make', [
      `-j${os.availableParallelism()}`,
      `CFLAGS=-O2 -arch ${arch}`,
      `LDFLAGS=-arch ${arch}`,
      'prefix=/',
      'gitexecdir=libexec/git-core',
      'template_dir=share/git-core/templates',
      'sysconfdir=etc',
      'RUNTIME_PREFIX=YesPlease',
      // Never the libraries Homebrew has on the building Mac.
      'NO_HOMEBREW=YesPlease',
      'NO_GETTEXT=YesPlease',
      'NO_TCLTK=YesPlease',
      'NO_PERL=YesPlease',
      'NO_PYTHON=YesPlease',
      'NO_EXPAT=YesPlease',
      'SKIP_DASHED_BUILT_INS=YesPlease',
      `DESTDIR=${built}.partial`,
      'install',
    ], {cwd: path.join(unpacked, `git-${config.git_version}`), env: {...process.env, MACOSX_DEPLOYMENT_TARGET: '10.13'}});
    fs.renameSync(`${built}.partial`, built);
  }
  // A link the install made between its programs is copied as the program it names.
  fs.cpSync(built, path.join(resources, 'git'), {recursive: true, dereference: true});
}

async function main() {
  const target = process.env.TAURI_ENV_TARGET_TRIPLE;
  const platform = TARGETS[target];
  // RUSH Lab Dev never updates itself: its local site's database is a copy of production's, release archives too.
  if (release && dev) throw new Error('--release and --dev cannot be given together: RUSH Lab Dev is never a release');
  if (!platform) {
    throw new Error(`TAURI_ENV_TARGET_TRIPLE is ${JSON.stringify(target)}; run this through npm run build (targets: ${Object.keys(TARGETS).join(', ')})`);
  }
  fs.rmSync(resources, {recursive: true, force: true});
  // Tauri copies resources into its target folder and never removes a file a later build dropped.
  for (const part of ['runner', 'nanoagent', 'git']) fs.rmSync(path.join(desktop, 'src-tauri', 'target', 'release', part), {recursive: true, force: true});
  fs.mkdirSync(resources, {recursive: true});
  fs.mkdirSync(binaries, {recursive: true});
  await stageNode(target, platform);
  const uv = path.join(binaries, `uv-${target}${platform.exe}`);
  fs.copyFileSync(await fetchUv(target), uv);
  if (platform.exe) await stageGit();
  if (platform.arch) await stageMacGit(target, platform.arch);
  stageEngine(resources, uv);
  // A release updates itself from its site (src-tauri/src/update.rs); any other build stays as built.
  if (release) config.update_target = target;
  fs.writeFileSync(path.join(resources, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch(error => {
    console.error(`Staging failed: ${error.message}`);
    process.exit(1);
  });
}
