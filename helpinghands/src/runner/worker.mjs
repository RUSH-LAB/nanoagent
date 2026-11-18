/**
 * The benchmark worker RUSH Lab runs for a connection (docs/plans/local-benchmark-worker.md, Phase 6): the golden image
 * (nanoagent/deploy/gvisor/Dockerfile) in a privileged container on the member's Docker, claiming that member's benchmark
 * runs from the connection's site with a worker credential minted for this device, on the OpenRouter key in the member's
 * settings. lab.mjs owns one per connection: start() once the member is signed in, keysChanged() when settings change, stop()
 * when the connection ends or the app quits, and recheck() / restart() when the member asks from the Benchmark worker panel.
 *
 * Starting it is a chain of health checks (CHECKS), each with a clear pass, warn or fail and a fix the member can act on;
 * the first failure stops the chain, and later checks stay pending. Every change is handed to `report` as one object,
 * {state, message, platform, concurrency, progress, checks, log}: lab.mjs gives it to the relay, which sends it to RUSH in its `hello`, and the
 * Benchmark screens read it from GET /api/runner/status. `state` is ready, starting, pulling, no-key, no-docker or failed.
 * Docker is never installed for the member: it needs administrator rights and a license choice, so the fix only says how.
 */
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import {LINK} from './docker-help.js';

// The one place the image is named. RUSH Lab never pulls a tag: each build pins the digest it was tested with.
// TODO: pin the image benchmark-worker-image.yml publishes from production (ghcr.io/rush-lab/benchmark-worker, tested and
// attested in CI) instead of this one, built locally and pushed by hand to a personal namespace.
export const WORKER_IMAGE = 'ghcr.io/hosung-k1m/benchmark-worker@sha256:810a1bd9c476b672fd231fc0877da02491ff173845e939c02d25b45b8f2c4cdb';

// What Docker's VM should have (docker info): the worker's sandboxes and the toolchain images need room. Below either, the
// resources check warns and the worker still starts.
const MIN_CPUS = 2;
const MIN_MEMORY_BYTES = 4 * 1024 ** 3;

const STOP_SECONDS = 10;
const DOCKER_RETRY_MS = 10_000;
// A worker that ran this long before exiting gets its one automatic restart again.
const STABLE_MS = 10 * 60_000;
const LOG_LINES = 10;

const CHECKS = [
  ['docker-cli', 'Docker installed'],
  ['docker-daemon', 'Docker running'],
  ['privileged', 'Privileged containers'],
  ['resources', 'Docker resources'],
  ['image', 'Worker image'],
  ['key', 'OpenRouter key'],
  ['proofs', 'Worker startup proofs'],
  ['claims', 'Worker reaches RUSH'],
];

// The proofs the worker logs once each (nanoagent/uploaded/worker.py), in the order it makes them; the last ends startup.
const PROOFS = [
  ['plugin sandbox verified', 'plugin sandbox'],
  ['leftover reaping passed', 'leftover cleanup'],
  ['collector probe passed', 'toolchain probes'],
  ['egress filter verified', 'egress filter'],
];
const PROOFS_DONE = 'advertised capabilities';
// The worker logs this once on its first answer from RUSH (a claim answered, with or without a job), and again after an outage.
const CLAIMING = 'claiming from RUSH';

/** Where to get Docker on `platform`, with links. */
function installAdvice(platform) {
  if (platform === 'darwin') return `Install Docker Desktop (${LINK.desktop}), then open RUSH Lab again or press Re-check.`;
  if (platform === 'win32') return `Install Docker Desktop with the WSL 2 backend (${LINK.desktop}), then press Re-check.`;
  return `Install Docker Engine (${LINK.engine}), then press Re-check.`;
}

/** The container's name for a connection: Docker's names take letters, digits, underscores, dots and hyphens. */
export const containerName = id => `rush-lab-worker-${id.replace(/[^A-Za-z0-9_.-]/g, '-')}`;

/** Remove a deleted connection's container and its two volumes (workerArgs), whatever state they are in; `--force` passes over absent ones. */
export async function removeWorkerData(id, {dockerEnv, docker = dockerRun}) {
  const name = containerName(id);
  const env = await dockerEnv();
  for (const args of [['rm', '--force', name], ['volume', 'rm', '--force', `${name}-docker`, `${name}-home`]]) {
    const {code, error, tail} = await docker(args, {env});
    if (code !== 0) throw new Error(`docker ${args.slice(0, 2).join(' ')} for ${name} failed: ${error?.message ?? tail.join(' ')}`);
  }
}

const pendingIds = file => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []);

/** Remember in `file` that connection `id`'s container and volumes are still to be removed: removal can fail (Docker down) after its folder is gone. */
export function queueRemoval(file, id) {
  fs.writeFileSync(file, JSON.stringify([...new Set([...pendingIds(file), id])]));
}

/**
 * Try each removal queued in `file`, dropping an id only once its removal succeeded: the failures, {id, error}. An id in `present` is a connection that
 * is back (its container name is the same), so it is dropped without removing anything.
 */
export async function retryRemovals(file, {dockerEnv, docker = dockerRun, present = new Set()}) {
  const failed = [];
  for (const id of pendingIds(file)) {
    if (present.has(id)) continue;
    try {
      await removeWorkerData(id, {dockerEnv, docker});
    } catch (error) {
      failed.push({id, error});
    }
  }
  fs.writeFileSync(file, JSON.stringify(failed.map(({id}) => id)));
  return failed;
}

/** `docker args`, in `env`, each output line given to `onLine`: {code, error, tail} (the last lines). A missing docker is error.code ENOENT. */
function dockerRun(args, {env, onLine} = {}) {
  return new Promise(resolve => {
    const tail = [];
    const child = spawn('docker', args, {env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
    for (const stream of [child.stdout, child.stderr]) {
      readline.createInterface({input: stream}).on('line', line => {
        tail.push(line);
        if (tail.length > LOG_LINES) tail.shift();
        onLine?.(line);
      });
    }
    child.once('error', error => resolve({code: null, error, tail}));
    child.once('close', code => resolve({code, tail}));
  });
}

/**
 * The member's worker credential for this device, over their RUSH session `token`: those already named `name` are revoked first, so a
 * restart replaces the credential rather than adding one. {credential_id, name, token, created_at}.
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
    const data = await response.json().catch(error => {
      if (response.ok) throw new Error(`${site} answered ${method} ${route} with something that is not JSON: ${error.message}`);
      return {};
    });
    if (!response.ok) throw new Error(data.error ?? `${site} answered ${response.status}`);
    return data;
  };
  for (const credential of (await call('GET', '/worker-credentials')).credentials) {
    if (credential.name === name && !credential.revoked_at) await call('DELETE', `/worker-credentials/${credential.credential_id}`);
  }
  return call('POST', '/worker-credentials', {name});
}

/** The origin the container reaches RUSH at: a site on this computer is reached as the host. */
export function containerSite(site) {
  const url = new URL(site);
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) url.hostname = 'host.docker.internal';
  return url.origin;
}

/**
 * `docker run` arguments for the worker image (secrets by name only: they are in the environment of the docker process). `lifetime` is
 * `-d` or `--rm`; `volumes` are the two named volumes, /var/lib/docker's and the worker's home; `overrides` follow the other `--` ones.
 * Two dockerds on one /var/lib/docker corrupt it, so each caller names volumes of its own.
 */
export function workerRunArgs({lifetime, name, volumes: [dockerVolume, homeVolume], image, baseUrl, workerId, overrides = []}) {
  return [
    'run', lifetime, '--init', '--privileged', '--cgroupns=private', '--name', name,
    '--add-host', 'host.docker.internal:host-gateway',
    '-v', `${dockerVolume}:/var/lib/docker`, '-v', `${homeVolume}:/home/rush/rush-worker`,
    '-e', 'RUSH_WORKER_TOKEN', '-e', 'OPENROUTER_API_KEY',
    image,
    'python', '-m', 'nanoagent.uploaded.worker',
    'config=/opt/nanoagent/deploy/gvisor/worker.openrouter.yaml', 'home=/home/rush/rush-worker/run',
    '--', `rush.base_url=${baseUrl}`, `worker_id=${workerId}`,
    ...overrides,
  ];
}

/** `docker run` arguments for a connection's worker. */
export function workerArgs({name, site, worker, concurrency = 1}) {
  return workerRunArgs({
    lifetime: '-d',
    name,
    // Volumes of this connection's own (its name has the site and member, so RUSH Lab and RUSH Lab Dev never share): `npm start` and
    // the acceptance suite have theirs (rush-worker-*, rush-acceptance-*).
    volumes: [`${name}-docker`, `${name}-home`],
    image: WORKER_IMAGE,
    baseUrl: containerSite(site),
    workerId: worker,
    // The attempts the member lets it run at once; the worker clamps it to the machine's CPUs.
    overrides: [`limits.concurrency=${concurrency}`],
  });
}

const blank = ([id, label]) => ({id, label, state: 'pending', message: null, fix: null});
const clip = text => (text.length > 300 ? `${text.slice(0, 300)}…` : text);

/**
 * The worker for one connection. `readKey()` is the OpenRouter key in the settings now, `readSession()` the member's RUSH session
 * token (null until they have signed in), `dockerEnv()` the environment docker runs in (the member's PATH), `report(snapshot)` hears
 * every change and `log(message)` the connection's log; `readConcurrency()` and `writeConcurrency(n)` are the member's runner concurrency in RUSH Lab's local settings; `docker`, `mint`, `sleep` and `platform` are what tests replace.
 */
export function benchmarkWorker({
  id, site, device, product, logFile, readKey, readConcurrency = () => 1, writeConcurrency = () => {}, readSession, dockerEnv, report, log,
  docker = dockerRun, mint = mintCredential, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  platform = process.platform, retryMs = DOCKER_RETRY_MS, now = Date.now,
}) {
  const name = containerName(id);
  const credentialName = `${product} on ${device}`.slice(0, 100);
  let checks = CHECKS.map(blank);
  let progress = null;
  let logTail = [];
  // Which start is current: stop() and each new start move it on, and an older one that wakes up leaves quietly.
  let generation = 0;
  let container = false;
  // Serialize launch and stop, including their cleanup, environment lookup and credential minting.
  let transitioning = null;
  let keyInUse;
  let concurrencyInUse;
  // The member's setting as last read (at start, a settings change, or set), so publishing never reads the file.
  let concurrencySetting = null;
  // What the worker advertised once its proofs passed (its concurrency is already clamped to the machine's CPUs), null until then.
  let advertised = null;
  let autoRestarts = 0;
  let info = null;
  let stopped = false;

  const check = checkId => checks.find(entry => entry.id === checkId);
  const summary = () => {
    const failed = checks.find(entry => entry.state === 'fail');
    if (failed) {
      const state = ['docker-cli', 'docker-daemon', 'privileged'].includes(failed.id) ? 'no-docker' : 'failed';
      return {state, message: [failed.message, failed.fix].filter(Boolean).join(' ')};
    }
    if (check('key').state === 'wait') return {state: 'no-key', message: [check('key').message, check('key').fix].join(' ')};
    if (check('image').state === 'running') return {state: 'pulling', message: null};
    if (checks.every(entry => entry.state === 'pass' || entry.state === 'warn')) return {state: 'ready', message: null};
    return {state: 'starting', message: null};
  };
  const snapshot = () => ({
    ...summary(), platform, concurrency: {setting: concurrencySetting, cpus: info?.NCPU ?? null, effective: advertised?.concurrency ?? null}, progress, checks, log: logTail,
  });
  const publish = () => report(snapshot());
  const mark = (checkId, state, message = null, fix = null) => {
    Object.assign(check(checkId), {state, message, fix});
    if (state === 'fail' || state === 'wait') log(`${check(checkId).label}: ${message}${fix ? ` ${fix}` : ''}`);
    publish();
  };

  // `docker args` in the member's environment, for the calls that pass no other options.
  const run = async args => docker(args, {env: await dockerEnv()});
  const removeContainer = async () => {
    container = false;
    await run(['rm', '--force', name]);
  };

  const checkers = {
    async 'docker-cli'() {
      const result = await run(['--version']);
      if (result.error?.code === 'ENOENT') return ['fail', 'Docker is not installed.', installAdvice(platform)];
      if (result.error || result.code !== 0) return ['fail', `docker did not run: ${result.error?.message ?? result.tail.at(-1)}`, installAdvice(platform)];
      return ['pass', result.tail.at(-1) ?? 'docker found'];
    },
    async 'docker-daemon'() {
      const result = await run(['info', '--format', '{{json .}}']);
      if (result.code !== 0) {
        return ['fail', 'Docker is installed but not running.', 'Start Docker Desktop, then press Re-check.'];
      }
      try {
        info = JSON.parse(result.tail.join('\n'));
      } catch {
        return ['fail', 'Docker answered `docker info` with something that is not its information.', 'Update Docker, then press Re-check.'];
      }
      return ['pass', `Docker ${info.ServerVersion ?? ''}`.trim()];
    },
    async privileged() {
      // The worker runs its own Docker and gVisor inside: it needs `--privileged --cgroupns=private`, which a rootless daemon refuses.
      // The container's own startup (proofs) is what shows the rest.
      if ((info.SecurityOptions ?? []).some(option => String(option).includes('rootless'))) {
        return ['fail', 'Docker runs rootless here, which cannot run the privileged containers the benchmark worker needs.',
          'Use Docker Desktop or a rootful Docker Engine, then press Re-check.'];
      }
      return ['pass', 'Allowed.'];
    },
    async resources() {
      const gib = (info.MemTotal ?? 0) / 1024 ** 3;
      const summaryText = `${info.NCPU ?? '?'} CPUs, ${gib.toFixed(1)} GiB memory`;
      if ((info.NCPU ?? 0) < MIN_CPUS || (info.MemTotal ?? 0) < MIN_MEMORY_BYTES) {
        return ['warn', `Docker has ${summaryText}; the worker wants at least ${MIN_CPUS} CPUs and ${MIN_MEMORY_BYTES / 1024 ** 3} GiB, and may be slow or fail.`,
          'Give Docker more in Docker Desktop (Settings, Resources).'];
      }
      return ['pass', summaryText];
    },
    async image() {
      const present = await run(['image', 'inspect', WORKER_IMAGE]);
      if (present.code === 0) return ['pass', 'Present.'];
      const layers = new Set();
      const done = new Set();
      progress = {done: 0, total: 0};
      const pulled = await docker(['pull', WORKER_IMAGE], {
        env: await dockerEnv(),
        onLine(line) {
          const layer = line.match(/^([0-9a-f]{12}): (.+)$/);
          if (!layer) return;
          if (layer[2].startsWith('Pulling fs layer')) layers.add(layer[1]);
          if (/^(Pull complete|Already exists)/.test(layer[2])) done.add(layer[1]);
          progress = {done: done.size, total: Math.max(layers.size, done.size)};
          publish();
        },
      });
      progress = null;
      if (pulled.code !== 0) {
        return ['fail', `Could not pull the worker image: ${pulled.error?.message ?? clip(pulled.tail.join(' '))}`, 'Check your internet connection, then press Re-check.'];
      }
      return ['pass', 'Pulled.'];
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

  /** Mint a credential and run the container, then follow it until it exits. */
  async function launch(mine) {
    await removeContainer();
    if (mine !== generation) return;
    mark('proofs', 'running', 'Starting the worker.');
    // The relay signs in on its own, in the member's browser; the worker waits for that.
    let session = readSession();
    while (!session) {
      await sleep(1000);
      if (mine !== generation) return;
      session = readSession();
    }
    let credential;
    try {
      credential = await mint({site, token: session, name: credentialName});
    } catch (error) {
      if (mine === generation) mark('proofs', 'fail', `Could not get a worker credential from ${site}: ${error.message}`, 'Check that RUSH is reachable, then press Re-check.');
      return;
    }
    if (mine !== generation) return;
    fs.writeFileSync(logFile, '');
    logTail = [];
    advertised = null;
    concurrencySetting = concurrencyInUse = readConcurrency();
    const dockerEnvironment = await dockerEnv();
    if (mine !== generation) return;
    const started = await docker(workerArgs({name, site, worker: `lab-${device.replace(/[^A-Za-z0-9_-]/g, '-')}`, concurrency: concurrencyInUse}), {
      env: {...dockerEnvironment, RUSH_WORKER_TOKEN: credential.token, OPENROUTER_API_KEY: keyInUse},
    });
    if (mine !== generation) {
      if (started.code === 0) await docker(['rm', '--force', started.tail.at(-1)], {env: dockerEnvironment});
      return;
    }
    if (started.code !== 0) {
      mark('proofs', 'fail', `Docker could not start the worker: ${started.error?.message ?? clip(started.tail.join(' '))}`,
        'Docker must allow privileged containers (`--privileged --cgroupns=private`); then press Re-check.');
      return;
    }
    container = true;
    const startedAt = now();
    log(`Benchmark worker running in container ${name}`);
    follow(mine, startedAt).catch(error => log(`could not follow the worker: ${error.message}`));
  }

  /** The container's log into the connection's log and the checks 7 and 8, until it exits: then its one automatic restart, or failed. */
  async function follow(mine, startedAt) {
    const seen = new Set();
    let proofsDone = false;
    const proofText = () => `Passed: ${[...seen].join(', ') || 'none yet'}.`;
    const logs = docker(['logs', '--follow', name], {
      env: await dockerEnv(),
      onLine(line) {
        if (mine !== generation) return;
        appendLog(line);
        for (const [needle, label] of PROOFS) if (line.includes(needle)) seen.add(label);
        if (!proofsDone && line.includes(PROOFS_DONE)) {
          proofsDone = true;
          try {
            advertised = JSON.parse(line.slice(line.indexOf(PROOFS_DONE) + PROOFS_DONE.length + 1));
          } catch (error) {
            // The worker image and this app disagree on what the worker reports: stop it rather than run it unreported.
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
    });
    const exited = await run(['wait', name]);
    await logs;
    if (mine !== generation) return;
    container = false;
    const code = exited.tail.at(-1);
    const unauthorized = logTail.some(line => /\b401\b|unauthori[sz]ed|revoked/i.test(line));
    const reason = unauthorized ? 'RUSH rejected the worker\'s credential' : `The worker exited (status ${code ?? exited.error?.message ?? 'unknown'})`;
    if (now() - startedAt > STABLE_MS) autoRestarts = 0;
    if (autoRestarts < 1) {
      autoRestarts += 1;
      log(`${reason}; starting it once more${unauthorized ? ' with a new credential' : ''}.`);
      await start(false);
      return;
    }
    mark(proofsDone ? 'claims' : 'proofs', 'fail', `${reason}. Last log lines: ${clip(logTail.slice(-3).join(' | '))}`, 'Press Restart to try again.');
  }

  /** Check, then launch. Resolves once the container is started or a check has failed; Docker missing is checked again until it is there. */
  async function start(manual = true) {
    const mine = ++generation;
    stopped = false;
    if (manual) autoRestarts = 0;
    checks = CHECKS.map(blank);
    progress = null;
    publish();
    try {
      concurrencySetting = readConcurrency();
      for (;;) {
        if (await chain(mine, ['docker-cli', 'docker-daemon', 'privileged', 'resources', 'image', 'key'])) break;
        if (mine !== generation) return;
        // A member who installs or starts Docker meanwhile is found without pressing anything; a missing key waits for keysChanged.
        if (!['docker-cli', 'docker-daemon'].includes(checks.find(entry => entry.state === 'fail')?.id)) return;
        await sleep(retryMs);
        if (mine !== generation) return;
        checks = CHECKS.map(blank);
      }
      await transition(mine, () => launch(mine));
    } catch (error) {
      if (mine === generation) mark(checks.find(entry => entry.state === 'running')?.id ?? 'proofs', 'fail', error.message);
    }
  }

  /** Stop the container (docker's own timeout first), and any start in the middle of its checks. */
  async function halt() {
    const mine = ++generation;
    await transition(mine, async () => {
      if (!container) return;
      await run(['stop', '--time', String(STOP_SECONDS), name]);
      await removeContainer();
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
      progress = null;
    },
    /**
     * The settings changed (the key, or the runner concurrency). A key added starts the worker from the key check on; another key restarts it with that one, and a key
     * removed stops it and waits again. A restart interrupts the attempts in flight, whose leases then expire. Called by lab.mjs's
     * updateKeys, so no polling. Before the machine's own checks have passed there is nothing to resume: start reads the key itself.
     */
    async keysChanged() {
      if (stopped || generation === 0) return;
      concurrencySetting = readConcurrency();
      if ((readKey() || null) === (keyInUse ?? null) && (concurrencyInUse === undefined || concurrencySetting === concurrencyInUse)) return;
      if (!CHECKS.slice(0, 5).every(([checkId]) => ['pass', 'warn'].includes(check(checkId).state))) return;
      log('The OpenRouter key or the runner concurrency changed; restarting the worker from the key check.');
      // This call's own generation: another halt or start during the stop supersedes it, and it leaves.
      const mine = await halt();
      if (mine !== generation) return;
      for (const checkId of ['key', 'proofs', 'claims']) Object.assign(check(checkId), blank([checkId, check(checkId).label]));
      logTail = [];
      if (await chain(mine, ['key'])) await transition(mine, () => launch(mine));
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
      if (!container) return this.restart();
      const mine = generation;
      await chain(mine, ['docker-cli', 'docker-daemon', 'privileged', 'resources', 'key']);
      return undefined;
    },
    snapshot,
  };
}
