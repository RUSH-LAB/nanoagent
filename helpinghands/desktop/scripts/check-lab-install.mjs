#!/usr/bin/env node
/**
 * Installs a built bundle the way a member does, and checks it starts: serves
 * dist/mochi-lab-<target>.tar.gz and src/runner/install.sh from a local server
 * as Mochi does (routes/lab.js), pipes the script to sh, waits until lab.mjs
 * says NanoAgent is ready, its plugin sandbox proven, then uninstalls. The
 * relay may not sign in (this server is no Mochi); that is not checked.
 * The release job runs it on Linux, before uploading (helpinghands-desktop.yml).
 *
 *   TAURI_ENV_TARGET_TRIPLE=<target> node scripts/check-lab-install.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {execFileSync, spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.env.TAURI_ENV_TARGET_TRIPLE;
const bundle = path.join(desktop, 'dist', `mochi-lab-${target}.tar.gz`);
const linux = process.platform === 'linux';
// Served from here, not from its own site, the bundle installs as another site's (lab.mjs's installFor).
const {label} = JSON.parse(execFileSync('tar', ['-xOzf', bundle, 'mochi-lab/config.json'], {encoding: 'utf8'})).other_site;
const data = linux
  ? path.join(os.homedir(), '.local', 'share', label)
  : path.join(os.homedir(), 'Library', 'Application Support', label);
const READY_MS = 5 * 60_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function uninstall() {
  if (linux) {
    spawnSync('systemctl', ['--user', 'disable', '--now', `${label}.service`], {stdio: 'inherit'});
    fs.rmSync(path.join(os.homedir(), '.config', 'systemd', 'user', `${label}.service`), {force: true});
  } else {
    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${label}`], {stdio: 'inherit'});
    fs.rmSync(path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`), {force: true});
  }
  fs.rmSync(data, {recursive: true, force: true});
}

async function main() {
  const archive = fs.readFileSync(bundle);
  const sha256 = crypto.createHash('sha256').update(archive).digest('hex');
  const stamp = execFileSync('tar', ['-xOzf', bundle, 'mochi-lab/stamp'], {encoding: 'utf8'}).trim();
  const server = http.createServer((req, res) => {
    if (req.url.startsWith(`/api/lab/bundles/${target}?token=check`)) {
      res.writeHead(200, {'Content-Type': 'application/gzip', 'Content-Length': archive.length, 'X-Lab-Stamp': stamp, 'X-Lab-Sha256': sha256});
      return res.end(archive);
    }
    // A session no Mochi knows: the relay then asks to sign in, which is not checked.
    if (req.method === 'POST' && req.url === '/api/lab/session?token=check') return res.writeHead(200).end('check-session');
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const site = `http://127.0.0.1:${server.address().port}`;
  const script = fs.readFileSync(path.join(desktop, '..', 'src', 'runner', 'install.sh'), 'utf8')
    .replaceAll('__MOCHI_SITE__', site).replaceAll('__MOCHI_TOKEN__', 'check');
  try {
    // The script waits on lab.mjs, so the server must answer while sh runs.
    const installed = await new Promise(resolve => {
      const sh = spawn('sh', [], {stdio: ['pipe', 'inherit', 'inherit']});
      sh.on('close', resolve);
      sh.stdin.end(script);
    });
    if (installed !== 0) throw new Error(`install.sh exited ${installed}`);
    const log = path.join(data, 'logs', 'lab.log');
    const deadline = Date.now() + READY_MS;
    while (!fs.readFileSync(log, 'utf8').includes('NanoAgent is ready')) {
      if (Date.now() > deadline) throw new Error(`NanoAgent was not ready within ${READY_MS / 1000}s`);
      await sleep(2000);
    }
    console.log(`RUSH Lab ${stamp} installed and started NanoAgent.`);
  } catch (error) {
    // What NanoAgent's Python is, through its links: what a sandbox has to let it reach.
    const python = path.join(data, 'app', 'current', 'mochi-lab', 'nanoagent', '.venv', 'bin', 'python');
    spawnSync('sh', ['-c', `ls -l "${python}"; readlink -f "${python}"; "${python}" -c 'import sys; print(sys.prefix, sys.base_prefix, sys._base_executable)'`], {stdio: 'inherit'});
    for (const name of ['lab.log', 'uv-sync.log', 'nanoagent.log', 'relay.log']) {
      const file = path.join(data, 'logs', name);
      if (fs.existsSync(file)) console.error(`--- ${name}\n${fs.readFileSync(file, 'utf8').slice(-6000)}`);
    }
    throw error;
  } finally {
    uninstall();
    server.close();
  }
}

main().catch(error => {
  console.error(`The install check failed: ${error.message}`);
  process.exit(1);
});
