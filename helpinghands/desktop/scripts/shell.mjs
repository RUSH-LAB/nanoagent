/**
 * The shell: what an app build is made of apart from its engine, the files in desktop/. Its id is
 * their git tree as this checkout has them, committed or not (the tree of HEAD's desktop/ when they
 * are as committed), so the same files give the same id on every computer. An app takes only an
 * engine made for its own shell (scripts/engine.mjs, src-tauri/src/engine.rs).
 */
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function shellId() {
  const git = (args, env = {}) => execFileSync('git', args, {cwd: desktop, encoding: 'utf8', env: {...process.env, ...env}}).trim();
  const prefix = git(['rev-parse', '--show-prefix']);
  // A scratch index of HEAD with desktop/ as it is here, so the checkout's own index is left alone.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rush-lab-shell-'));
  const env = {GIT_INDEX_FILE: path.join(scratch, 'index')};
  try {
    git(['read-tree', 'HEAD'], env);
    git(['add', '--all', '--', '.'], env);
    return git(['write-tree', `--prefix=${prefix}`], env);
  } finally {
    fs.rmSync(scratch, {recursive: true, force: true});
  }
}
