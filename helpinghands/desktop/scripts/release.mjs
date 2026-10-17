#!/usr/bin/env node
/**
 * npm run build:release: RUSH Lab as a release, which updates itself (src-tauri/src/update.rs). It
 * builds as `tauri build` does, with tauri.release.conf.json, which signs the updater's archive with
 * the update key (TAURI_SIGNING_PRIVATE_KEY), and with a
 * version of its own, its build's time in UTC (0.<yyyymmdd>.<hhmmss>), so a later build is newer. The
 * signature names that version, which the site announces the update by (server/routes/lab.js).
 * Arguments after `--` go to `tauri build`.
 */
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [date, time] = new Date().toISOString().split(/[T.]/);
const version = `0.${date.replaceAll('-', '')}.${Number(time.replaceAll(':', ''))}`;
console.log(`RUSH Lab ${version}`);
const tauri = path.join(desktop, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
execFileSync(process.execPath, [tauri, 'build', '--config', 'src-tauri/tauri.release.conf.json', '--config', JSON.stringify({version}), ...process.argv.slice(2)], {
  cwd: desktop,
  stdio: 'inherit',
});
