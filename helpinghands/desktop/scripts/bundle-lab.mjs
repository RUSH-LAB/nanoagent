#!/usr/bin/env node
/**
 * Bundles Mochi Lab without its window, for the target in TAURI_ENV_TARGET_TRIPLE: stages it as
 * the app is staged (stage.mjs), then writes dist/mochi-lab-<target>.tar.gz, which
 * src/runner/install.sh unpacks and src/runner/lab.mjs runs from. Its one folder, mochi-lab/:
 *
 *   stamp          stage.mjs's, which names this bundle
 *   config.json    config.yaml, as JSON: lab.mjs loads only Node's own modules
 *   bin/node, bin/uv
 *   runner/        src/runner/, lab.mjs and the relay
 *   nanoagent/     NanoAgent compiled by Nuitka, for this computer's architecture
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import YAML from 'yaml';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resources = path.join(desktop, 'src-tauri', 'resources');
const binaries = path.join(desktop, 'src-tauri', 'binaries');
// Each target's platform and architecture: Nuitka compiles for the computer it runs on.
const TARGETS = {
  'aarch64-apple-darwin': ['darwin', 'arm64'],
  'x86_64-apple-darwin': ['darwin', 'x64'],
  'x86_64-unknown-linux-gnu': ['linux', 'x64'],
};

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, {stdio: 'inherit', ...options});
}

function main() {
  const target = process.env.TAURI_ENV_TARGET_TRIPLE;
  if (!TARGETS[target]) throw new Error(`TAURI_ENV_TARGET_TRIPLE is ${JSON.stringify(target)}; targets: ${Object.keys(TARGETS).join(', ')}`);
  const [platform, arch] = TARGETS[target];
  if (process.platform !== platform || process.arch !== arch) {
    throw new Error(`${target} builds on ${platform} ${arch}, which compiles its NanoAgent; this is ${process.platform} ${process.arch}`);
  }
  run(process.execPath, [path.join(desktop, 'scripts', 'stage.mjs')]);
  const out = path.join(desktop, '.cache', 'lab');
  const bundle = path.join(out, 'mochi-lab');
  fs.rmSync(out, {recursive: true, force: true});
  fs.mkdirSync(path.join(bundle, 'bin'), {recursive: true});
  fs.copyFileSync(path.join(resources, 'stamp'), path.join(bundle, 'stamp'));
  const config = YAML.parse(fs.readFileSync(path.join(resources, 'config.yaml'), 'utf8'));
  fs.writeFileSync(path.join(bundle, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  for (const name of ['node', 'uv']) {
    fs.copyFileSync(path.join(binaries, `${name}-${target}`), path.join(bundle, 'bin', name));
    fs.chmodSync(path.join(bundle, 'bin', name), 0o755);
  }
  for (const part of ['runner', 'nanoagent']) fs.cpSync(path.join(resources, part), path.join(bundle, part), {recursive: true});
  const archive = path.join(desktop, 'dist', `mochi-lab-${target}.tar.gz`);
  fs.mkdirSync(path.dirname(archive), {recursive: true});
  // COPYFILE_DISABLE: no AppleDouble ._ files beside each file in the archive.
  run('tar', ['-czf', archive, '--no-xattrs', '-C', out, 'mochi-lab'], {env: {...process.env, COPYFILE_DISABLE: '1'}});
  console.log(`${archive} (${fs.readFileSync(path.join(bundle, 'stamp'), 'utf8').trim()})`);
}

try {
  main();
} catch (error) {
  console.error(`Bundling failed: ${error.message}`);
  process.exit(1);
}
