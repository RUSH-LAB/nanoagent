/**
 * The benchmark worker RUSH Lab runs for a connection: NanoAgent's `nanoagent.uploaded.worker`, started with the bundled
 * Python, claiming that member's benchmark runs from the connection's site with a worker credential minted for this device,
 * on the OpenRouter key in the member's settings. Its sandboxes are microVMs (microsandbox, a NanoAgent dependency), so the
 * member installs nothing. lab.mjs owns one per connection: start() once the member is signed in, keysChanged() when settings
 * change, stop() when the connection ends or the app quits, and recheck() / restart() when the member asks from the Benchmark
 * worker panel.
 *
 * Starting it is a chain of health checks (CHECKS), each with a clear pass, warn or fail and a fix the member can act on;
 * the first failure stops the chain, and later checks stay pending. Every change is handed to `report` as one object,
 * {state, message, platform, concurrency, progress, checks, log}, `progress` the bytes of images pulled ({done, total}) while it pulls them: lab.mjs gives it to the relay, which sends it to RUSH in its `hello`, and the
 * Benchmark screens read it from GET /api/runner/status. `state` is ready, starting, no-key, unsupported or failed.
 */
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const STOP_MS = 10_000;
// A worker that ran this long before exiting is restarted at once again, and one that dies in startup gets its one restart again.
const STABLE_MS = 10 * 60_000;
// The waits, doubling from the first to the last, between tries of a credential while RUSH is down (a restart, a deploy) and between
// restarts of a worker that keeps exiting after its startup proofs.
const RETRY_FIRST_MS = 1000;
const RETRY_MAX_MS = 30_000;
const LOG_LINES = 10;

const CHECKS = [
  ['host', 'Sandbox support'],
  ['key', 'OpenRouter key'],
  ['proofs', 'Worker startup proofs'],
  ['claims', 'Worker reaches RUSH'],
];

// The proofs the worker logs once each (nanoagent/uploaded/worker.py), in the order it makes them; the last ends startup.
const PROOFS = [
  ['plugin sandbox verified', 'plugin sandbox'],
  ['leftover reaping passed', 'leftover cleanup'],
  ['images ready', 'images'],
  ['guest tools ready', 'guest tools'],
  ['tracer probe passed', 'toolchain probes'],
  ['egress fence verified', 'egress fence'],
];
const PROOFS_DONE = 'advertised capabilities';
// What the worker logs while it pulls its pinned images (the guest tools, every toolchain's runtime image), until `images ready`.
const PULLING = /pulling images: (\d+) of (\d+) bytes/;
// The worker logs this once on its first answer from RUSH (a claim answered, with or without a job), and again after an outage.
const CLAIMING = 'claiming from RUSH';

/**
 * Whether microsandbox runs here: [state, message, fix]. It boots microVMs with Apple's Hypervisor framework (Apple silicon),
 * KVM on Linux, or the Windows Hypervisor Platform.
 */
export function hostSupport({platform, arch, kvm = () => fs.existsSync('/dev/kvm')}) {
  if (platform === 'darwin') {
    return arch === 'arm64' ? ['pass', 'Apple silicon.'] : ['fail', 'Benchmarks need a Mac with Apple silicon.', null];
  }
  if (platform === 'linux') {
    if (!['x64', 'arm64'].includes(arch)) return ['fail', `Benchmarks do not run on ${arch} Linux.`, null];
    return kvm() ? ['pass', 'KVM is available.'] : ['fail', 'This Linux has no /dev/kvm, which the benchmark sandboxes need.', 'Enable virtualization (KVM) and give your user access to /dev/kvm, then press Re-check.'];
  }
  if (platform === 'win32') return ['pass', 'The worker checks the Windows Hypervisor Platform as it starts.'];
  return ['fail', `Benchmarks do not run on ${platform}.`, null];
}

/** Whether `error` from mintCredential is RUSH not answering (no answer, or a 5xx), which passes once it is back. */
export const rushDown = error => error.status === undefined || error.status >= 500;

/**
 * The member's worker credential for this device, over their RUSH session `token`: those already named `name` are revoked first, so a
 * restart replaces the credential rather than adding one. {credential_id, name, token, created_at}. An error RUSH answered carries
 * its `status`.
 */
export async function mintCredential({site, token, name, fetchImpl = fetch}) {
  const call = async (method, route, body) => {
    const response = await fetchImpl(`${site}/api/benchmark${route}`, {
      method,
      headers: {Authorization: `Bearer ${token}`, Origin: site, ...(body ? {'Content-Type': 'application/json'} : {})},
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    // An error answer without a JSON body still fails with its status; a successful one must be JSON.
    const answered = message => Object.assign(new Error(message), {status: response.status});
    const data = await response.json().catch(error => {
      if (response.ok) throw answered(`${site} answered ${method} ${route} with something that is not JSON: ${error.message}`);
      return {};
    });
    if (!response.ok) throw answered(data.error ?? `${site} answered ${response.status}`);
    return data;
  };
  for (const credential of (await call('GET', '/worker-credentials')).credentials) {
    if (credential.name === name && !credential.revoked_at) await call('DELETE', `/worker-credentials/${credential.credential_id}`);
  }
  return call('POST', '/worker-credentials', {name});
}

/** The worker's command, run in the bundle's `nanoagent` folder (secrets are in its environment, never its arguments). */
export function workerCommand({python, folder, site, worker, concurrency = 1}) {
  return [python, [
    '-I', '-m', 'nanoagent.uploaded.worker',
    'config=deploy/worker/worker.openrouter.yaml', `home=${JSON.stringify(path.join(folder, 'worker-run'))}`,
    '--', `rush.base_url=${site}`, `worker_id=${worker}`,
    // Attempts' scratch and the cached guest tools: the connection's own, removed with it.
    `scratch=${JSON.stringify(path.join(folder, 'worker'))}`,
    // The attempts the member lets it run at once; the worker clamps it to the machine's CPUs.
    `limits.concurrency=${concurrency}`,
  ]];
}

/** Start `program args` in `cwd` with `env`, each output line given to `onLine`: {child, exited} (resolves {code, signal, error}). */
function runProcess(program, args, {cwd, env, onLine}) {
  const child = spawn(program, args, {cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
  for (const stream of [child.stdout, child.stderr]) readline.createInterface({input: stream}).on('line', onLine);
  const exited = new Promise(resolve => {
    child.once('error', error => resolve({code: null, signal: null, error}));
    child.once('close', (code, signal) => resolve({code, signal}));
  });
  return {child, exited};
}

const blank = ([id, label]) => ({id, label, state: 'pending', message: null, fix: null});
const clip = text => (text.length > 300 ? `${text.slice(0, 300)}…` : text);

/**
 * The worker for one connection. `python` and `nanoagent` are the bundle's, `folder` the connection's, `system` the environment
 * NanoAgent runs in; `readKey()` is the OpenRouter key in the settings now, `readSession()` the member's RUSH session token (null
 * until they have signed in), `report(snapshot)` hears every change and `log(message)` the connection's log; `readConcurrency()`
 * and `writeConcurrency(n)` are the member's runner concurrency in RUSH Lab's local settings; `run`, `mint`, `sleep`, `platform`
 * and `arch` are what tests replace.
 */
export function benchmarkWorker({
  site, device, product, logFile, python, nanoagent, folder, system, readKey, readConcurrency = () => 1, writeConcurrency = () => {}, readSession,
  report, log, run = runProcess, mint = mintCredential, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  platform = process.platform, arch = process.arch, kvm, now = Date.now,
}) {
  const credentialName = `${product} on ${device}`.slice(0, 100);
  let checks = CHECKS.map(blank);
  let logTail = [];
  // Which start is current: stop() and each new start move it on, and an older one that wakes up leaves quietly.
  let generation = 0;
  let worker = null;
  // Serialize launch and stop, including their cleanup and credential minting.
  let transitioning = null;
  let keyInUse;
  let concurrencyInUse;
  // The member's setting as last read (at start, a settings change, or set), so publishing never reads the file.
  let concurrencySetting = null;
  // What the worker advertised once its proofs passed (its concurrency is already clamped to the machine's CPUs), null until then.
  let advertised = null;
  // The startup images' bytes pulled so far, {done, total}, while the worker pulls them; null otherwise.
  let progress = null;
  let autoRestarts = 0;
  // The wait before restarting a worker that exited after its startup proofs.
  let restartWait = RETRY_FIRST_MS;
  let stopped = false;

  const check = checkId => checks.find(entry => entry.id === checkId);
  const summary = () => {
    const failed = checks.find(entry => entry.state === 'fail');
    if (failed) return {state: failed.id === 'host' ? 'unsupported' : 'failed', message: [failed.message, failed.fix].filter(Boolean).join(' ')};
    if (check('key').state === 'wait') return {state: 'no-key', message: [check('key').message, check('key').fix].join(' ')};
    if (checks.every(entry => entry.state === 'pass' || entry.state === 'warn')) return {state: 'ready', message: null};
    return {state: 'starting', message: null};
  };
  const concurrency = () => ({setting: concurrencySetting, cpus: os.availableParallelism(), effective: advertised?.concurrency ?? null});
  const snapshot = () => ({...summary(), platform, concurrency: concurrency(), progress, checks, log: logTail});
  const publish = () => report(snapshot());
  const mark = (checkId, state, message = null, fix = null) => {
    Object.assign(check(checkId), {state, message, fix});
    if (state === 'fail' || state === 'wait') log(`${check(checkId).label}: ${message}${fix ? ` ${fix}` : ''}`);
    publish();
  };

  const checkers = {
    async host() {
      return hostSupport({platform, arch, ...(kvm ? {kvm} : {})});
    },
    async key() {
      keyInUse = readKey() || null;
      // Not a failure: the member may add it later, and everything before it has run by then.
      return keyInUse ? ['pass', 'Set.'] : ['wait', 'Add your OpenRouter key in Settings to run benchmarks.', 'It is under API keys; the worker starts as soon as it is saved.'];
    },
  };

  /** Run `ids` in order, stopping at the first failure: whether all of them passed (or warned). `mine` is the start they belong to. */
  async function chain(mine, ids) {
    for (const checkId of ids) {
      mark(checkId, 'running');
      let result;
      try {
        result = await checkers[checkId]();
      } catch (error) {
        result = ['fail', error.message, null];
      }
      if (mine !== generation) return false;
      mark(checkId, ...result);
      if (result[0] === 'fail' || result[0] === 'wait') return false;
    }
    return true;
  }

  const appendLog = line => {
    fs.appendFileSync(logFile, `${line}\n`);
    logTail = [...logTail, clip(line)].slice(-LOG_LINES);
  };

  function transition(mine, operation) {
    const previous = transitioning;
    transitioning = (async () => {
      await previous?.catch(() => {});
      if (mine === generation) await operation();
    })();
    return transitioning;
  }

  /** Mint a credential and start the worker, then follow it until it exits. */
  async function launch(mine) {
    return transition(mine, () => launchCurrent(mine));
  }

  async function launchCurrent(mine) {
    mark('proofs', 'running', 'Starting the worker.');
    // The relay signs in on its own, in the member's browser; the worker waits for that.
    let session = readSession();
    while (!session) {
      await sleep(1000);
      if (mine !== generation) return;
      session = readSession();
    }
    let credential;
    // RUSH restarting or down is waited out; a session RUSH no longer knows (401: the relay signs in again, as after its database
    // changed) is waited out until the relay holds a new one; any other refusal fails.
    for (let wait = RETRY_FIRST_MS; !credential; wait = Math.min(wait * 2, RETRY_MAX_MS)) {
      try {
        credential = await mint({site, token: session, name: credentialName});
      } catch (error) {
        if (mine !== generation) return;
        if (error.status === 401) {
          mark('proofs', 'running', `${site} does not know RUSH Lab's sign-in; the worker starts once RUSH Lab has signed in again.`);
          while (readSession() === session) {
            await sleep(1000);
            if (mine !== generation) return;
          }
          session = readSession();
          wait = RETRY_FIRST_MS / 2;
          continue;
        }
        if (!rushDown(error)) {
          mark('proofs', 'fail', `Could not get a worker credential from ${site}: ${error.message}`, 'Check that RUSH is reachable, then press Re-check.');
          return;
        }
        mark('proofs', 'running', `${site} is not answering (${error.message}); trying again in ${wait / 1000}s.`);
        await sleep(wait);
      }
      if (mine !== generation) return;
    }
    fs.writeFileSync(logFile, '');
    logTail = [];
    advertised = null;
    progress = null;
    concurrencySetting = concurrencyInUse = readConcurrency();
    const [program, args] = workerCommand({
      python, folder, site, worker: `lab-${device.replace(/[^A-Za-z0-9_-]/g, '-')}`, concurrency: concurrencyInUse,
    });
    const followed = follower(mine);
    worker = run(program, args, {
      cwd: nanoagent, env: {...system, RUSH_WORKER_TOKEN: credential.token, OPENROUTER_API_KEY: keyInUse}, onLine: followed.onLine,
    });
    const startedAt = now();
    log('Benchmark worker running.');
    followed.until(worker, startedAt).catch(error => log(`could not follow the worker: ${error.message}`));
  }

  /** The worker's output into the connection's log and the checks 3 and 4, until it exits: then started again (always, once it passed its startup proofs; once, if it died in startup), or failed. */
  function follower(mine) {
    const seen = new Set();
    let proofsDone = false;
    const proofText = () => `Passed: ${[...seen].join(', ') || 'none yet'}.${progress ? ` Pulling images: ${progress.done} of ${progress.total} bytes.` : ''}`;
    return {
      onLine(line) {
        if (mine !== generation) return;
        appendLog(line);
        for (const [needle, label] of PROOFS) if (line.includes(needle)) seen.add(label);
        const pulled = !seen.has('images') && line.match(PULLING);
        progress = pulled ? {done: Number(pulled[1]), total: Number(pulled[2])} : seen.has('images') ? null : progress;
        if (!proofsDone && line.includes(PROOFS_DONE)) {
          proofsDone = true;
          try {
            advertised = JSON.parse(line.slice(line.indexOf(PROOFS_DONE) + PROOFS_DONE.length + 1));
          } catch (error) {
            // NanoAgent and this app disagree on what the worker reports: stop it rather than run it unreported.
            mark('proofs', 'fail', `The worker's advertised capabilities are not readable (${error.message}): ${clip(line)}`, 'Update RUSH Lab, then press Restart.');
            halt().catch(stopError => log(`could not stop the worker: ${stopError.message}`));
            return;
          }
          mark('proofs', 'pass', `${proofText()} The worker's startup proofs passed.`);
          mark('claims', 'running', 'Waiting for RUSH to answer a claim.');
        } else if (!proofsDone) {
          mark('proofs', 'running', proofText());
        }
        if (proofsDone && line.includes('RUSH is unreachable')) {
          mark('claims', 'warn', 'The worker cannot reach RUSH and is retrying.', 'Check your internet connection.');
        } else if (proofsDone && line.includes(CLAIMING)) {
          mark('claims', 'pass', 'The worker reaches RUSH and is polling for your runs.');
        }
      },
      async until(started, startedAt) {
        const exited = await started.exited;
        if (mine !== generation) return;
        worker = null;
        progress = null;
        const status = exited.error?.message ?? (exited.signal ? `signal ${exited.signal}` : `status ${exited.code}`);
        const unauthorized = logTail.some(line => /\b401\b|unauthori[sz]ed|revoked/i.test(line));
        const reason = unauthorized ? 'RUSH rejected the worker\'s credential' : `The worker exited (${status})`;
        if (now() - startedAt > STABLE_MS) {
          autoRestarts = 0;
          restartWait = RETRY_FIRST_MS;
        }
        // A worker that passed its startup proofs was serving: it is always started again, after a wait that grows while it keeps exiting.
        if (proofsDone) {
          log(`${reason}; starting it again in ${restartWait / 1000}s.`);
          const wait = restartWait;
          restartWait = Math.min(restartWait * 2, RETRY_MAX_MS);
          await sleep(wait);
          if (mine === generation) await start(false);
          return;
        }
        if (autoRestarts < 1) {
          autoRestarts += 1;
          log(`${reason}; starting it once more${unauthorized ? ' with a new credential' : ''}.`);
          await start(false);
          return;
        }
        mark(proofsDone ? 'claims' : 'proofs', 'fail', `${reason}. Last log lines: ${clip(logTail.slice(-3).join(' | '))}`, 'Press Restart to try again.');
      },
    };
  }

  /** Check, then launch. Resolves once the worker is started or a check has failed. */
  async function start(manual = true) {
    const mine = ++generation;
    stopped = false;
    if (manual) {
      autoRestarts = 0;
      restartWait = RETRY_FIRST_MS;
    }
    checks = CHECKS.map(blank);
    publish();
    try {
      concurrencySetting = readConcurrency();
      if (await chain(mine, ['host', 'key'])) await launch(mine);
    } catch (error) {
      if (mine === generation) mark(checks.find(entry => entry.state === 'running')?.id ?? 'proofs', 'fail', error.message);
    }
  }

  /** Stop the worker (SIGTERM, then SIGKILL after STOP_MS), and any start in the middle of its checks. */
  async function halt() {
    const mine = ++generation;
    await transition(mine, async () => {
      const current = worker;
      if (!current) return;
      worker = null;
      current.child.kill('SIGTERM');
      const killed = setTimeout(() => current.child.kill('SIGKILL'), STOP_MS);
      await current.exited;
      clearTimeout(killed);
    });
    return mine;
  }

  return {
    start,
    /** The connection ends or the app quits. */
    async stop() {
      stopped = true;
      const mine = await halt();
      if (mine !== generation) return;
      checks = CHECKS.map(blank);
    },
    /**
     * The settings changed (the key, or the runner concurrency). A key added starts the worker from the key check on; another key restarts it with that one, and a key
     * removed stops it and waits again. A restart interrupts the attempts in flight, whose leases then expire. Called by lab.mjs's
     * updateKeys, so no polling. Before the machine's own check has passed there is nothing to resume: start reads the key itself.
     */
    async keysChanged() {
      if (stopped || generation === 0) return;
      concurrencySetting = readConcurrency();
      if ((readKey() || null) === (keyInUse ?? null) && (concurrencyInUse === undefined || concurrencySetting === concurrencyInUse)) return;
      if (!['pass', 'warn'].includes(check('host').state)) return;
      log('The OpenRouter key or the runner concurrency changed; restarting the worker from the key check.');
      // This call's own generation: another halt or start during the stop supersedes it, and it leaves.
      const mine = await halt();
      if (mine !== generation) return;
      for (const checkId of ['key', 'proofs', 'claims']) Object.assign(check(checkId), blank([checkId, check(checkId).label]));
      logTail = [];
      if (await chain(mine, ['key'])) await launch(mine);
    },
    /** The member set the runner concurrency: kept in the local settings, and the worker restarted with it as a key change does. */
    async setConcurrency(value) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('Runner concurrency must be a whole number of at least 1');
      writeConcurrency(value);
      concurrencySetting = value;
      publish();
      await this.keysChanged();
    },
    /** The member pressed Restart. */
    async restart() {
      const mine = await halt();
      // A stop or another start during the stop supersedes this restart, as in keysChanged.
      if (mine === generation) start();
    },
    /** The member pressed Re-check: a running worker is left alone and the checks before it run again; one that is not is started. */
    async recheck() {
      if (!worker) return this.restart();
      await chain(generation, ['host', 'key']);
      return undefined;
    },
    snapshot,
  };
}
