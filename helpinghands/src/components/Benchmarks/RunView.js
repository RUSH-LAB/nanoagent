import React, {useCallback, useEffect, useState} from 'react';
import Link from '@docusaurus/Link';
import {useLocation} from '@docusaurus/router';
import market from '@site/src/pages/marketplace/styles.module.css';
import {workerNotice} from '../PluginFrame/worker.js';
import {benchmarkJson, jsonPost, runnerStatus} from './api';
import {CaseList, Pill, Step} from './Choice';
import PluginCards, {PluginHeader, useBenchmarkPlugins} from './PluginCards';
import {ACTIVE, countOf, installedFirst, scoreText, toggled} from './runs';
import useLoad, {usePoll} from './useLoad';
import useUrlParam from './useUrlParam';
import styles from './styles.module.css';
import runStyles from './run.module.css';

const POLL_MS = 2000;

/** A benchmark's card with its cases read-only under it. */
function BenchmarkCard({benchmark, pressed, onPick}) {
  const [cases, setCases] = useState(null);
  const [error, setError] = useState(null);
  const toggle = async event => {
    if (!event.target.open || cases) return;
    try {
      setCases((await benchmarkJson(`/benchmarks/${benchmark.benchmark_id}`)).benchmark.cases);
    } catch (failure) {
      setError(failure.message);
    }
  };
  return (
    <div className={runStyles.benchmarkCard} data-selected={pressed}>
      <button type="button" className={runStyles.benchmarkPick} aria-pressed={pressed} onClick={onPick}>
        <span className={market.cardBody}>
          <span className={market.name}>{benchmark.name}</span>
          <span className={market.meta}>v{benchmark.plugin.version} · {countOf(benchmark.case_count, 'case')} · {benchmark.model}</span>
          <span className={market.meta}>Created by {benchmark.publisher.name}</span>
        </span>
      </button>
      <details onToggle={toggle}>
        <summary>Cases</summary>
        {error && <div className={market.error}>{error}</div>}
        {!cases && !error && <p>Loading the cases…</p>}
        {cases && <CaseList cases={cases} />}
      </details>
    </div>
  );
}

/** The runs just queued, followed until each is over. */
function SubmittedRuns({ids}) {
  const {pathname} = useLocation();
  const [runs, setRuns] = useState({});
  const [error, setError] = useState(null);
  const reload = useCallback(async () => {
    try {
      const read = await Promise.all(ids.map(async id => (await benchmarkJson(`/runs/${id}`)).run));
      setRuns(Object.fromEntries(read.map(run => [run.run_id, run])));
      setError(null);
    } catch (failure) {
      setError(failure.message);
    }
  }, [ids]);
  useEffect(() => { reload(); }, [reload]);
  usePoll(reload, POLL_MS, ids.some(id => !runs[id] || ACTIVE.has(runs[id].status)));
  const cancel = id => benchmarkJson(`/runs/${id}/cancel`, {method: 'POST'}).then(reload, failure => setError(failure.message));
  return (
    <div className={styles.cases}>
      {error && <div className={market.error}>{error}</div>}
      {ids.map(id => runs[id] && (
        <div className={runStyles.runCard} key={id}>
          <Link className={runStyles.runLink} to={`${pathname}?${new URLSearchParams({view: 'mine', run: id})}`}>
            <strong>{runs[id].harness.name}</strong>
            <Pill word={runs[id].status} />
            <span>{scoreText(runs[id].score)}</span>
            <span className={runStyles.viewRun}>View run →</span>
          </Link>
          {ACTIVE.has(runs[id].status) && <button type="button" className={runStyles.cancel} onClick={() => cancel(id)}>Cancel</button>}
        </div>
      ))}
    </div>
  );
}

function HarnessStep({benchmark}) {
  const defaults = useLoad(() => benchmarkJson('/defaults'), []);
  const [harnesses, setHarnesses] = useState(new Set());
  const [rush, setRush] = useState(false);
  const [command, setCommand] = useState('');
  const installedAgents = defaults.data?.endpoints.find(endpoint => endpoint.label === benchmark.endpoint_profile)?.capabilities.installed_agents ?? [];
  const validCommand = installedAgents.includes(command);
  const [copied, setCopied] = useState(false);
  const [state, setState] = useState({busy: false, error: null, ids: []});
  const [notice, setNotice] = useState(null);
  useEffect(() => { runnerStatus().then(status => setNotice(workerNotice(status))); }, []);
  usePoll(defaults.reload, 5000, rush);

  const copyShell = async () => {
    try {
      await navigator.clipboard.writeText('nanoagent harness harness=shell');
      setCopied(true);
    } catch (failure) {
      setState(previous => ({...previous, error: `Could not copy the command: ${failure.message}`}));
    }
  };

  // One run per harness; a harness RUSH refuses is told beside the runs it queued.
  const run = async () => {
    setState(previous => ({...previous, busy: true, error: null}));
    const ids = [];
    const errors = [];
    for (const harness of [...harnesses, ...(rush ? [`rush ${command}`] : [])]) {
      try {
        ids.push((await benchmarkJson('/runs', jsonPost({benchmark_id: benchmark.benchmark_id, harness, idempotency_key: crypto.randomUUID()}))).run.run_id);
      } catch (failure) {
        errors.push(`${harness}: ${failure.message}`);
      }
    }
    setState(previous => ({busy: false, error: errors.join(' ') || null, ids: [...previous.ids, ...ids]}));
  };
  return (
    <>
      {notice && notice.tone !== 'ok' && <div className={market.notice}>{notice.text}</div>}
      {defaults.error && <div className={market.error}>{defaults.error}</div>}
      <div className={runStyles.harnesses}>
        {(defaults.data?.harnesses ?? []).map(name => (
          <button type="button" className={runStyles.harness} key={name} aria-pressed={harnesses.has(name)} onClick={() => setHarnesses(toggled(harnesses, name))}>{name}</button>
        ))}
        <button type="button" className={runStyles.harness} aria-pressed={rush} onClick={() => setRush(!rush)}>Rush command</button>
      </div>
      {rush && (
        <div className={runStyles.rush}>
          <label htmlFor="rush-command">Installed Terminal agent</label>
          <select id="rush-command" className={runStyles.agentSelect} value={command} onChange={event => setCommand(event.target.value)}>
            <option value="">Choose an installed agent</option>
            {installedAgents.map(name => <option key={name} value={name}>rush {name}</option>)}
          </select>
          {!installedAgents.length && <p>No saved agents yet. Install an agent in the RUSH Terminal, run it with <code>rush &lt;command&gt;</code>, then exit the Terminal to save its installation.</p>}
          {validCommand && <p>Each case runs <code>rush {command}</code> with its prompt using the saved installation.</p>}
          <div className={runStyles.shellCommand}>
            <span>Open a RUSH Terminal</span>
            <div className={runStyles.command}><code>nanoagent harness harness=shell</code><button type="button" className={runStyles.copyCommand} aria-label="Copy Terminal command" onClick={copyShell}>{copied ? 'Copied' : 'Copy'}</button></div>
          </div>
        </div>
      )}
      <p>
        <button type="button" className="button button--primary" disabled={state.busy || (!harnesses.size && !rush) || (rush && !validCommand)} onClick={run}>
          Run
        </button>
      </p>
      {state.error && <div className={market.error} role="alert">{state.error}</div>}
      <SubmittedRuns ids={state.ids} />
    </>
  );
}

/** One plugin's screen: its benchmarks, the harnesses, then the runs followed live. */
function RunPlugin({plugin, onBack}) {
  const [benchmark, setBenchmark] = useState(null);
  const [search, setSearch] = useState('');
  const benchmarks = useLoad(
    () => benchmarkJson(`/benchmarks?${new URLSearchParams({plugin_id: plugin.id, limit: '200'})}`).then(read => installedFirst(read.benchmarks, plugin.version)),
    [plugin.id],
  );
  return (
    <>
      <PluginHeader plugin={plugin} back="Benchmark a Harness" onBack={onBack} />
      <Step title="1. Benchmark">
        {benchmarks.error && <div className={market.error}>{benchmarks.error}</div>}
        {benchmarks.data && !benchmarks.data.length && <p>No benchmark is published for {plugin.name} yet: publish one first.</p>}
        <input className={runStyles.search} type="search" aria-label="Search benchmarks" placeholder="Search benchmarks" value={search} onChange={event => setSearch(event.target.value)} />
        {benchmarks.data?.length > 0 && !benchmarks.data.some(one => `${one.name} ${one.publisher.name}`.toLowerCase().includes(search.toLowerCase())) && <p>No benchmarks match your search.</p>}
        <div className={market.grid}>
          {(benchmarks.data ?? []).filter(one => `${one.name} ${one.publisher.name}`.toLowerCase().includes(search.toLowerCase())).map(one => (
            <BenchmarkCard key={one.benchmark_id} benchmark={one} pressed={one.benchmark_id === benchmark?.benchmark_id} onPick={() => setBenchmark(one)} />
          ))}
        </div>
        {benchmark && <p className={runStyles.selection} role="status"><span aria-hidden="true">✓</span> Selected <strong>{benchmark.name}</strong><span>Created by {benchmark.publisher.name}</span></p>}
      </Step>
      {benchmark && <Step title="2. Harnesses"><HarnessStep key={benchmark.benchmark_id} benchmark={benchmark} /></Step>}
    </>
  );
}

/** Benchmark a Harness: the plugin list, then the picked plugin's own screen (`?plugin=`). */
export default function RunView() {
  const {apps, error} = useBenchmarkPlugins();
  const [pluginId, setPluginId] = useUrlParam('plugin');
  const plugin = apps?.find(app => app.id === pluginId);
  if (plugin) return <RunPlugin key={plugin.id} plugin={plugin} onBack={() => setPluginId(null)} />;
  return (
    <>
      <header className={market.header}><h1>Benchmark a Harness</h1></header>
      {error && <div className={market.error}>{error}</div>}
      <PluginCards apps={apps} onPick={app => setPluginId(app.id)} />
    </>
  );
}
