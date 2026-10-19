#!/usr/bin/env node
/**
 * The engine: what RUSH Lab runs, the same on every target, apart from the app around it (its
 * shell, scripts/shell.mjs), so a release that changes only the engine needs no new app:
 *
 *   runner/      the relay that lends this computer's NanoAgent to RUSH (src/runner), and in plugin-project/
 *                what `<command> new` writes into a plugin project: project.md and the publish-plugin skill
 *   nanoagent/   NanoAgent's source (site/), its uv.lock, the PI runner's bundle, and the config the app runs
 *   stamp        names this engine, its build's time first, so a later one sorts after it
 *   shell        the shell it runs in, which an app takes it only for
 *
 * Every app bundles the engine it was built with (scripts/stage.mjs), and takes a newer one for its
 * shell from its site (src-tauri/src/engine.rs). `node scripts/engine.mjs <folder>` writes
 * <folder>/engine.tar.gz, its signature engine.tar.gz.sig, made with the app's update key
 * (TAURI_SIGNING_PRIVATE_KEY), and its stamp and shell, which the release job
 * uploads (PUT /api/lab/engine).
 */
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {shellId} from './shell.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mochiRoot = path.dirname(desktop);
const repoRoot = path.dirname(mochiRoot);
const nanoagentRoot = path.resolve(mochiRoot, '..', 'nanoagent');
const cache = path.join(desktop, '.cache');
// Never bundled from a checkout: environments, caches, and run output are rebuilt where they run.
const SKIP = new Set(['node_modules', '.venv', '__pycache__', '.pytest_cache', '.ruff_cache', 'outputs', '.DS_Store', '.lake']);

export function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(' ')}`);
  // npm is npm.cmd on Windows, which only a shell runs.
  execFileSync(command, args, {stdio: 'inherit', shell: process.platform === 'win32', ...options});
}

export function copy(from, to) {
  fs.cpSync(from, to, {recursive: true, filter: source => !SKIP.has(path.basename(source))});
}

// lab.mjs, the relay and the protocol it shares with RUSH's server; Node's own modules are all they load.
// Beside project.md, the preface `<command> new` writes into a plugin project, goes the publish-plugin skill it follows.
function stageRunner(out) {
  copy(path.join(mochiRoot, 'src', 'runner'), path.join(out, 'runner'));
  fs.copyFileSync(path.join(repoRoot, 'docs', 'instructions', 'skills', 'publish-plugin', 'SKILL.md'), path.join(out, 'runner', 'plugin-project', 'SKILL.md'));
}

/**
 * NanoAgent's package ships as its source, in nanoagent/site/, and its dependencies are installed
 * from the uv.lock resolved here, which holds for every platform, on the engine's first start.
 * Beside them go the PI runner's two bundled files and the config lab.mjs runs, at the paths that
 * config names them by.
 */
function stageNanoAgent(out, uv) {
  copy(path.join(nanoagentRoot, 'src', 'nanoagent'), path.join(out, 'site', 'nanoagent'));
  // NanoAgent is a library and keeps no lock; the app pins the versions resolved for this build,
  // which it installs with `uv sync --frozen` on first start. Locking reads NanoAgent's version
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

/** Stage the engine into `out` (runner/, nanoagent/, stamp, shell), locking NanoAgent with `uv`: its stamp. */
export function stageEngine(out, uv) {
  stageRunner(out);
  stageNanoAgent(path.join(out, 'nanoagent'), uv);
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {cwd: mochiRoot, encoding: 'utf8'}).trim();
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${commit}`;
  fs.writeFileSync(path.join(out, 'stamp'), `${stamp}\n`);
  fs.writeFileSync(path.join(out, 'shell'), `${shellId()}\n`);
  return stamp;
}

/** Windows' own tar: a GNU tar earlier on PATH (Git Bash) reads the drive letter as a remote host. */
export const tar = () => (process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar');

async function main() {
  const [folder] = process.argv.slice(2);
  if (!folder) throw new Error('usage: node scripts/engine.mjs <folder>');
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY) throw new Error('TAURI_SIGNING_PRIVATE_KEY, the app\'s update key, signs the engine: set it to the key or its file');
  const {fetchUv} = await import('./stage.mjs');
  const out = path.resolve(folder);
  const staging = path.join(out, 'engine');
  fs.rmSync(out, {recursive: true, force: true});
  fs.mkdirSync(staging, {recursive: true});
  const stamp = stageEngine(staging, await fetchUv());
  const archive = path.join(out, 'engine.tar.gz');
  run(tar(), ['-czf', archive, '-C', staging, '.']);
  // Beside it, what it is, for its upload's headers.
  for (const file of ['stamp', 'shell']) fs.copyFileSync(path.join(staging, file), path.join(out, file));
  fs.rmSync(staging, {recursive: true, force: true});
  run(process.execPath, [path.join(desktop, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'), 'signer', 'sign', archive], {
    env: {...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? ''},
    shell: false,
  });
  if (!fs.existsSync(`${archive}.sig`)) throw new Error(`tauri signer sign wrote no ${archive}.sig`);
  console.log(`Engine ${stamp}: ${archive}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch(error => {
    console.error(`The engine was not built: ${error.message}`);
    process.exit(1);
  });
}
