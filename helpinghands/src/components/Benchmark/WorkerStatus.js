import React, {useCallback, useState} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import {useLocation} from '@docusaurus/router';
import {apiRequest} from '../../utils/api.js';
import useLoad, {usePoll} from './useLoad';
import {searchFor} from './location';
import {checkMark, workerNotice} from './worker';
import {homebrewLink, installOptions, startOptions} from '../../runner/docker-help.js';
import styles from './styles.module.css';

const status = () => apiRequest('/api/runner/status');

/** The worker's status, read again every few seconds (faster until it is ready): the same channel as Settings → AI's computer and keys. */
function useWorkerStatus() {
  const load = useLoad(status, []);
  usePoll(load.reload, load.data?.worker?.state === 'ready' ? 10_000 : 2_000, true);
  return load;
}

/** A command with a button that copies it. */
function Command({command}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div>
      <code>{command}</code>{' '}
      <button type="button" className="button button--secondary button--sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

/** What to run for a failed Docker check, for the member's OS (`platform` comes from RUSH Lab's own process.platform): install, or start. */
function DockerHelp({check, platform}) {
  if (check.state !== 'fail' || !['docker-cli', 'docker-daemon'].includes(check.id)) return null;
  const options = check.id === 'docker-cli' ? installOptions(platform) : startOptions(platform);
  const brew = check.id === 'docker-cli' ? homebrewLink(platform) : null;
  return (
    <div>
      {options.map(option => (
        <div key={option.title}>
          <strong>{option.title}</strong>
          {(option.commands ?? []).map(command => <Command key={command} command={command} />)}
          {option.then && <div className={styles.muted}>{option.then}</div>}
        </div>
      ))}
      {brew && <div className={styles.muted}>These use Homebrew; if it is missing, see <Link to={brew}>brew.sh</Link>.</div>}
    </div>
  );
}

/** Runner health on the setup and publication screens. */
export function WorkerBanner() {
  const location = useLocation();
  const {data, error} = useWorkerStatus();
  const notice = error ? {tone: 'bad', text: `Could not check runner health: ${error}`} : workerNotice(data);
  return (
    <div className={styles.workerBanner} role="status">
      <span>Benchmark Runner Health:</span>
      <Link className={clsx(styles.healthLink, notice?.tone === 'ok' ? styles.healthOk : notice?.tone === 'bad' ? styles.healthBad : styles.healthWait)}
        to={`${location.pathname}${searchFor({view: 'worker'})}`} title="Open Benchmark Runner Health" aria-label="Open Benchmark Runner Health">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 10h4l2-5 4 10 2-5h4" /></svg>
      </Link>
      <span className={styles.fieldHint}>{notice?.text ?? 'Checking…'}</span>
    </div>
  );
}

/** Advanced settings: the attempts the local runner runs at once (kept by RUSH Lab; changing it restarts the worker). */
function AdvancedSettings({worker, disabled, onSave}) {
  const {setting, cpus, effective} = worker.concurrency ?? {setting: 1, cpus: null, effective: null};
  const [value, setValue] = useState(String(setting));
  const number = Number(value);
  const valid = Number.isInteger(number) && number >= 1 && (cpus === null || number <= cpus);
  return (
    <details>
      <summary>Advanced settings</summary>
      <p>
        <label>
          Runner concurrency{' '}
          <input type="number" min={1} max={cpus ?? undefined} step={1} value={value} onChange={event => setValue(event.target.value)} style={{width: '5rem'}} />
        </label>{' '}
        <button type="button" className="button button--secondary button--sm" disabled={disabled || !valid || number === setting} onClick={() => onSave(number)}>Save and restart worker</button>
      </p>
      <p className={styles.muted}>
        How many attempts this computer runs at once (default 1{cpus ? `, at most its ${cpus} CPUs` : ''}).
        {effective !== null && ` The worker is running ${effective} at once.`}
      </p>
    </details>
  );
}

/** Local Runner Health Check: each health check with its state and fix, Re-check and Restart. */
export function WorkerPanel() {
  const {data, error, reload} = useWorkerStatus();
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);
  const act = useCallback(async (action, value) => {
    setBusy(action);
    setProblem(null);
    try {
      await apiRequest('/api/runner/worker', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({action, value})});
      await reload();
    } catch (failure) {
      setProblem(failure.message);
    } finally {
      setBusy(null);
    }
  }, [reload]);
  const worker = data?.connected ? data.worker : null;
  const notice = workerNotice(data);
  return (
    <section className={styles.section}>
      <h2>Local Runner Health Check</h2>
      <p className={styles.muted}>
        RUSH Lab runs your benchmark runs in a container on this computer&apos;s Docker, with your OpenRouter key.
        It never installs Docker for you.
      </p>
      {error && <p className={styles.warn}>{error}</p>}
      {notice && <p role="status">{notice.text}</p>}
      {worker && (
        <ol className={styles.workerChecks}>
          {worker.checks.map(check => (
            <li key={check.id} data-state={check.state}>
              <strong>{checkMark(check.state)} {check.label}</strong>
              {check.message && <div>{check.message}</div>}
              {check.fix && <div className={styles.muted}>{check.fix}</div>}
              <DockerHelp check={check} platform={worker.platform} />
            </li>
          ))}
        </ol>
      )}
      {worker?.state === 'failed' && worker.log.length > 0 && <pre>{worker.log.join('\n')}</pre>}
      {worker && <AdvancedSettings key={worker.concurrency?.setting} worker={worker} disabled={busy !== null} onSave={value => act('concurrency', value)} />}
      {problem && <p className={styles.warn}>{problem}</p>}
      <p>
        <button type="button" className="button button--secondary button--sm" disabled={!data?.connected || busy !== null} onClick={() => act('recheck')}>Re-check</button>{' '}
        <button type="button" className="button button--secondary button--sm" disabled={!data?.connected || busy !== null} onClick={() => act('restart')}>Restart worker</button>{' '}
        {worker?.state === 'no-key' && <Link to="/settings#ai">OpenRouter key in Settings</Link>}
      </p>
    </section>
  );
}
