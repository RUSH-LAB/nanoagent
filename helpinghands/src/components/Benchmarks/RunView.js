import React, {useEffect, useRef, useState} from 'react';
import {useHistory, useLocation} from '@docusaurus/router';
import useBaseUrl from '@docusaurus/useBaseUrl';
import market from '@site/src/pages/marketplace/styles.module.css';
import {jsonPost} from '../PluginFrame/host.js';
import {benchmarkJson, runnerNotice} from './api';
import {CaseList, Step} from './Choice';
import PluginCards, {PluginHeader, useBenchmarkPlugins} from './PluginCards';
import {countOf, installedFirst, toggled} from './runs';
import useLoad, {usePoll} from './useLoad';
import useUrlParam from './useUrlParam';
import runStyles from './run.module.css';


/** A benchmark's selectable card. */
function BenchmarkCard({benchmark, pressed, onPick}) {
  return (
    <div className={runStyles.benchmarkCard} data-selected={pressed}>
      <button type="button" className={runStyles.benchmarkPick} aria-pressed={pressed} onClick={onPick}>
        <span className={market.cardBody}>
          <span className={market.name}>{benchmark.name}</span>
          <span className={market.meta}>v{benchmark.plugin.version} · {countOf(benchmark.case_count, 'case')} · {benchmark.model}</span>
          <span className={market.meta}>Created by {benchmark.publisher.name}</span>
        </span>
      </button>
    </div>
  );
}

function BenchmarkCases({benchmark}) {
  const [cases, setCases] = useState(null);
  const [error, setError] = useState(null);
  const toggle = async event => {
    if (!event.target.open || cases) return;
    try {
      setCases((await benchmarkJson(`/benchmarks/${benchmark.benchmark_id}`)).benchmark.cases);
      setError(null);
    } catch (failure) {
      setError(failure.message);
    }
  };
  return <details className={runStyles.benchmarkCases} onToggle={toggle}>
    <summary><span>Cases <span className={runStyles.caseCount}>{benchmark.case_count}</span></span><span className={runStyles.caseChevron} aria-hidden="true" /></summary>
    <div className={runStyles.caseContent}>
      {error && <div className={market.error}>{error}</div>}
      {!cases && !error && <p>Loading the cases…</p>}
      {cases && <CaseList cases={cases} />}
    </div>
  </details>;
}

const HARNESS_LOGOS = {claude: 'claude', codex: 'codex', dsh: 'dsh', deepseek: 'dsh', hermes: 'hermes', pi: 'pi'};

function HarnessStep({benchmark}) {
  const logoBase = useBaseUrl('/img/harnesses/');
  const defaults = useLoad(() => benchmarkJson('/defaults'), []);
  const [harnesses, setHarnesses] = useState(new Set());
  const [rush, setRush] = useState(false);
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  // `rush <agent> [<argument>…]`, each case's prompt following as the last argument (the server checks the words: harness.js).
  const rushHarness = ['rush', command, ...args.split(/\s+/).filter(Boolean)].join(' ');
  const installedAgents = defaults.data?.endpoints.find(endpoint => endpoint.label === benchmark.endpoint_profile)?.capabilities.installed_agents ?? [];
  const validCommand = installedAgents.includes(command);
  const history = useHistory();
  const {pathname} = useLocation();
  const [state, setState] = useState({busy: false, error: null, queued: false});
  const [notice, setNotice] = useState(null);
  useEffect(() => {
    let live = true;
    runnerNotice().then(next => live && setNotice(next));
    return () => { live = false; };
  }, []);
  // The idempotency key of each harness's submission until it is queued: a retry of one the server may have taken cannot queue it twice.
  const keys = useRef(new Map());
  usePoll(defaults.reload, 5000, rush);

  // One run per harness; a harness RUSH refuses is told beside the runs it queued.
  const run = async () => {
    setState(previous => ({...previous, busy: true, error: null}));
    const queued = [];
    const errors = [];
    for (const harness of [...harnesses, ...(rush ? [rushHarness] : [])]) {
      const key = keys.current.get(harness) ?? crypto.randomUUID();
      keys.current.set(harness, key);
      try {
        await benchmarkJson('/runs', jsonPost({benchmark_id: benchmark.benchmark_id, harness, idempotency_key: key}));
        keys.current.delete(harness);
        queued.push(harness);
      } catch (failure) {
        errors.push(`${harness}: ${failure.message}`);
      }
    }
    // Only what failed stays selected, so running again retries just that.
    setHarnesses(previous => new Set([...previous].filter(name => !queued.includes(name))));
    if (queued.includes(rushHarness)) setRush(false);
    setState({busy: false, error: errors.join(' ') || null, queued: queued.length > 0});
    if (queued.length && !errors.length) history.push(`${pathname}?view=mine`);
  };
  return (
    <>
      {notice && notice.tone !== 'ok' && <div className={market.notice}>{notice.text}</div>}
      {defaults.error && <div className={market.error}>{defaults.error}</div>}
      <div className={runStyles.pickerHeading}>
        <p>Choose one or more harnesses to benchmark.</p>
        <span>{harnesses.size + Number(rush)} selected</span>
      </div>
      <div className={runStyles.harnesses}>
        {(defaults.data?.harnesses ?? []).map(name => (
          <button type="button" className={runStyles.harness} key={name} aria-pressed={harnesses.has(name)} onClick={() => setHarnesses(toggled(harnesses, name))}>
            {name === 'nanoagent' ? <span className={runStyles.nanoagentIcon} aria-hidden="true">N</span>
              : HARNESS_LOGOS[name] && <img className={`${runStyles.harnessLogo} ${name === 'codex' || name === 'hermes' ? runStyles.monochromeLogo : ''}`} src={`${logoBase}${HARNESS_LOGOS[name]}.svg`} alt="" />}
            <span className={runStyles.harnessName}>{name}</span>
          </button>
        ))}
      </div>
      <button type="button" className={runStyles.installed} aria-pressed={rush} onClick={() => setRush(!rush)}>
        <span className={runStyles.installedText}>Installed agent</span>
      </button>
      {rush && (
        <div className={runStyles.rush}>
          <label htmlFor="rush-command">Installed Terminal agent</label>
          <select id="rush-command" className={runStyles.agentSelect} value={command} onChange={event => setCommand(event.target.value)}>
            <option value="">Choose an installed agent</option>
            {installedAgents.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
          {!installedAgents.length && <p>No saved agents yet. Install an agent in the RUSH Terminal, run it with <code>rush &lt;command&gt;</code>, then exit the Terminal to save its installation.</p>}
          <label htmlFor="rush-arguments">Arguments</label>
          <input id="rush-arguments" className={runStyles.agentSelect} type="text" spellCheck={false} placeholder="--model openai/<model> --message" value={args} onChange={event => setArgs(event.target.value)} />
          {validCommand && <p><code>{rushHarness}</code></p>}

        </div>
      )}
      <div className={runStyles.runAction}>
        <button type="button" className="button button--primary" disabled={state.busy || (!harnesses.size && !rush) || (rush && !validCommand)} onClick={run}>
          Run
        </button>
      </div>
      {state.error && <div className={market.error} role="alert">{state.error}{state.queued && <p>Some runs were queued. <a href={`${pathname}?view=mine`}>View My Benchmarks</a></p>}</div>}
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
        {benchmark && <><p className={runStyles.selection} role="status"><span aria-hidden="true">✓</span> Selected <strong>{benchmark.name}</strong><span>Created by {benchmark.publisher.name}</span></p><BenchmarkCases key={benchmark.benchmark_id} benchmark={benchmark} /></>}
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
      {pluginId && apps && <div className={market.error} role="alert">The plugin &quot;{pluginId}&quot; in the address is not installed or not ready to benchmark.</div>}
      <PluginCards apps={apps} onPick={app => setPluginId(app.id)} />
    </>
  );
}
