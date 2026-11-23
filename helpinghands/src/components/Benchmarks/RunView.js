import React, {useEffect, useRef, useState} from 'react';
import {useHistory, useLocation} from '@docusaurus/router';
import useBaseUrl from '@docusaurus/useBaseUrl';
import market from '@site/src/pages/marketplace/styles.module.css';
import {jsonPost} from '../PluginFrame/host.js';
import {benchmarkJson, runnerNotice} from './api';
import {CaseList} from './Choice';
import {useBenchmarkPlugins} from './PluginCards';
import {RunResult, metric} from './MyBenchmarksView';
import {ACTIVE, countOf, harnessLabel, installedFirst, isBenchmarkRun, toggled} from './runs';
import useLoad, {usePoll} from './useLoad';
import useUrlParam from './useUrlParam';
import styles from './run.module.css';

const HARNESS_LOGOS = {claude: 'claude', codex: 'codex', dsh: 'dsh', deepseek: 'dsh', hermes: 'hermes', pi: 'pi'};

/** A link to another Benchmarks view: `?view=` and its own parameters, replacing the rest. */
function useViewLink() {
  const {pathname} = useLocation();
  return params => `${pathname}?${new URLSearchParams(params)}`;
}

/** The agents to run, then Run: one run per agent, queued on the member's computer. `onQueued` follows each queued batch. */
function RunPanel({benchmark, onQueued}) {
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
  const [state, setState] = useState({busy: false, error: null});
  const [notice, setNotice] = useState(null);
  useEffect(() => {
    let live = true;
    runnerNotice().then(next => live && setNotice(next));
    return () => { live = false; };
  }, []);
  // The idempotency key of each harness's submission until it is queued: a retry of one the server may have taken cannot queue it twice.
  const keys = useRef(new Map());
  usePoll(defaults.reload, 5000, rush);
  const count = harnesses.size + Number(rush);

  // One run per harness; a harness RUSH refuses is told beside the runs it queued.
  const run = async () => {
    setState({busy: true, error: null});
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
        errors.push(`${harnessLabel(harness)}: ${failure.message}`);
      }
    }
    // Only what failed stays selected, so running again retries just that.
    setHarnesses(previous => new Set([...previous].filter(name => !queued.includes(name))));
    if (queued.includes(rushHarness)) setRush(false);
    setState({busy: false, error: errors.join(' ') || null});
    if (queued.length) onQueued();
  };
  return (
    <section className={styles.panel} aria-labelledby="run-heading">
      <div className={styles.panelHead}>
        <h2 id="run-heading">Run agents</h2>
        <span className={styles.hint}>Each agent gets the same prompts in a fresh sandbox; the plugin&apos;s verifier grades what it leaves behind.</span>
      </div>
      {notice && notice.tone !== 'ok' && <div className={market.notice}>{notice.text}</div>}
      {defaults.error && <div className={market.error}>{defaults.error}</div>}
      <div className={styles.agents} role="group" aria-label="Agents">
        {(defaults.data?.harnesses ?? []).map(name => (
          <button type="button" className={styles.agent} key={name} aria-pressed={harnesses.has(name)} onClick={() => setHarnesses(toggled(harnesses, name))}>
            {name === 'nanoagent' ? <span className={styles.nanoagentIcon} aria-hidden="true">N</span>
              : HARNESS_LOGOS[name] && <img className={`${styles.agentLogo} ${name === 'codex' || name === 'hermes' ? styles.monochromeLogo : ''}`} src={`${logoBase}${HARNESS_LOGOS[name]}.svg`} alt="" />}
            <span>{name}</span>
          </button>
        ))}
        <button type="button" className={styles.agent} aria-pressed={rush} onClick={() => setRush(!rush)}>
          <span className={styles.nanoagentIcon} aria-hidden="true">$</span>
          <span>Installed agent…</span>
        </button>
      </div>
      {rush && (
        <div className={styles.rush}>
          <label>
            <span>Agent</span>
            <select className={styles.input} value={command} onChange={event => setCommand(event.target.value)}>
              <option value="">Choose an installed agent</option>
              {installedAgents.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <label>
            <span>Arguments</span>
            <input className={styles.input} type="text" spellCheck={false} placeholder="--model openai/<model> --message" value={args} onChange={event => setArgs(event.target.value)} />
          </label>
          {!installedAgents.length && <p>No saved agents yet. Install an agent in the RUSH Terminal, run it with <code>rush &lt;command&gt;</code>, then exit the Terminal to save its installation.</p>}
          {validCommand && <p>Runs <code>{rushHarness}</code> with each case&apos;s prompt as the last argument.</p>}
        </div>
      )}
      <div className={styles.panelFoot}>
        <span className={styles.hint}>{count ? `${countOf(count, 'agent')} selected` : 'Select one or more agents'}</span>
        <button type="button" className="button button--primary" disabled={state.busy || !count || (rush && !validCommand)} onClick={run}>
          {state.busy ? 'Queuing…' : count > 1 ? `Run ${count} agents` : 'Run'}
        </button>
      </div>
      {state.error && <div className={market.error} role="alert">{state.error}</div>}
    </section>
  );
}

/** The member's runs of this benchmark, newest first, followed while any is still running. */
function BenchmarkRuns({runs, link}) {
  const history = useHistory();
  if (!runs) return <p className={styles.hint}>Reading your runs…</p>;
  if (!runs.length) return <p className={styles.empty}>No runs yet. Pick agents above and press Run.</p>;
  return (
    <div className={styles.list}>
      {runs.map(run => (
        <button type="button" key={run.run_id} className={styles.runRow} onClick={() => history.push(link({view: 'runs', run: run.run_id}))}>
          <span className={styles.runAgent}>{harnessLabel(run.harness.name)}</span>
          <RunResult run={run} />
          <span className={styles.runMeta}>{metric(run.metrics, 'elapsed_ms', true)}</span>
          <span className={styles.runMeta}>{metric(run.metrics, 'input_tokens')} in · {metric(run.metrics, 'output_tokens')} out</span>
          <span className={styles.runMeta}>{new Date(run.created_at).toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'})}</span>
          <span className={styles.chevron} aria-hidden="true">›</span>
        </button>
      ))}
    </div>
  );
}

/** One benchmark's page: what it is, Run agents on it, its runs, then its cases. */
function BenchmarkPage({benchmarkId, plugins, onBack}) {
  const link = useViewLink();
  const detail = useLoad(() => benchmarkJson(`/benchmarks/${benchmarkId}`).then(read => read.benchmark), [benchmarkId]);
  const runs = useLoad(() => benchmarkJson('/runs?limit=200').then(read => read.runs), []);
  const benchmark = detail.data;
  const mine = benchmark && runs.data?.filter(run => isBenchmarkRun(run) && run.benchmark.name === benchmark.name
    && run.plugin.id === benchmark.plugin.id && run.plugin.version === benchmark.plugin.version);
  usePoll(runs.reload, 3000, Boolean(mine?.some(run => ACTIVE.has(run.status))));
  const back = <button type="button" className={styles.back} onClick={onBack}>← Benchmarks</button>;
  if (detail.error) return <>{back}<div className={market.error}>{detail.error}</div></>;
  if (!benchmark) return <>{back}<p className={styles.hint}>Reading the benchmark…</p></>;
  const plugin = plugins?.find(app => app.id === benchmark.plugin.id);
  return (
    <>
      {back}
      <header className={styles.pageHead}>
        {plugin && <img className={styles.headIcon} src={plugin.product.icon} alt="" />}
        <div>
          <h1>{benchmark.name}</h1>
          <p className={styles.hint}>
            {benchmark.plugin.name ?? benchmark.plugin.id} v{benchmark.plugin.version} · <code>{benchmark.task_id}</code> · {countOf(benchmark.cases.length, 'case')} · {benchmark.model} · by {benchmark.publisher.name}
          </p>
        </div>
      </header>
      <RunPanel benchmark={benchmark} onQueued={runs.reload} />
      <section className={styles.section}>
        <h2>Your runs</h2>
        {runs.error ? <div className={market.error}>{runs.error}</div> : <BenchmarkRuns runs={mine} link={link} />}
      </section>
      <details className={styles.cases}>
        <summary><h2>Cases <span className={styles.count}>{benchmark.cases.length}</span></h2></summary>
        <CaseList cases={benchmark.cases} />
      </details>
    </>
  );
}

/** Every published benchmark of the member's installed plugins, grouped by plugin; a plugin with none offers to publish one. */
function BenchmarkList({plugins, onPick}) {
  const link = useViewLink();
  const [query, setQuery] = useState('');
  const listed = useLoad(() => Promise.all((plugins ?? []).map(plugin => benchmarkJson(`/benchmarks?${new URLSearchParams({plugin_id: plugin.id, limit: '200'})}`)
    .then(read => ({plugin, benchmarks: installedFirst(read.benchmarks, plugin.version)})))), [(plugins ?? []).map(plugin => plugin.id).join(',')]);
  if (!plugins) return <p className={styles.hint}>Reading your plugins…</p>;
  if (!plugins.length) return <p className={styles.empty}>No installed plugin is ready to benchmark. Install one from the Marketplace.</p>;
  if (listed.error) return <div className={market.error}>{listed.error}</div>;
  if (!listed.data) return <p className={styles.hint}>Reading the benchmarks…</p>;
  const words = query.trim().toLowerCase();
  const matches = (plugin, benchmark) => !words || `${plugin.name} ${plugin.id} ${benchmark.name} ${benchmark.publisher.name}`.toLowerCase().includes(words);
  const groups = listed.data.map(group => ({...group, benchmarks: group.benchmarks.filter(one => matches(group.plugin, one))}));
  const withBenchmarks = groups.filter(group => group.benchmarks.length);
  const without = listed.data.filter(group => !group.benchmarks.length && (!words || `${group.plugin.name} ${group.plugin.id}`.toLowerCase().includes(words)));
  return (
    <>
      <input className={`${styles.input} ${styles.search}`} type="search" aria-label="Search benchmarks" placeholder="Search benchmarks or plugins" value={query} onChange={event => setQuery(event.target.value)} />
      {!withBenchmarks.length && !without.length && <p className={styles.empty}>Nothing matches “{query}”.</p>}
      {withBenchmarks.map(({plugin, benchmarks}) => (
        <section className={styles.group} key={plugin.id}>
          <h2 className={styles.groupHead}><img src={plugin.product.icon} alt="" />{plugin.name}<span className={styles.count}>v{plugin.version}</span></h2>
          <div className={styles.list}>
            {benchmarks.map(one => (
              <button type="button" key={one.benchmark_id} className={styles.benchmarkRow} onClick={() => onPick(one.benchmark_id)}>
                <span className={styles.benchmarkName}>{one.name}</span>
                <span className={styles.runMeta}><code>{one.task_id}</code></span>
                <span className={styles.runMeta}>{countOf(one.case_count, 'case')}</span>
                <span className={styles.runMeta}>{one.plugin.version === plugin.version ? one.model : `for v${one.plugin.version}`}</span>
                <span className={styles.runMeta}>by {one.publisher.name}</span>
                <span className={styles.chevron} aria-hidden="true">›</span>
              </button>
            ))}
          </div>
        </section>
      ))}
      {without.length > 0 && (
        <section className={styles.group}>
          <h2 className={styles.groupHead}>No benchmark yet</h2>
          <div className={styles.list}>
            {without.map(({plugin}) => (
              <a key={plugin.id} className={styles.benchmarkRow} href={link({view: 'publish', plugin: plugin.id})}>
                <img className={styles.rowIcon} src={plugin.product.icon} alt="" />
                <span className={styles.benchmarkName}>{plugin.name}</span>
                <span className={styles.publishLink}>Publish one</span>
                <span className={styles.chevron} aria-hidden="true">›</span>
              </a>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

/** Benchmarks: every benchmark of the installed plugins, then the picked one's page (`?benchmark=`). */
export default function RunView() {
  const {apps, error} = useBenchmarkPlugins();
  const [benchmarkId, setBenchmarkId] = useUrlParam('benchmark');
  if (benchmarkId) return <BenchmarkPage key={benchmarkId} benchmarkId={benchmarkId} plugins={apps} onBack={() => setBenchmarkId(null)} />;
  return (
    <>
      <header className={styles.pageHead}>
        <div>
          <h1>Benchmarks</h1>
          <p className={styles.hint}>Pick a benchmark to run agents on it and compare how they do.</p>
        </div>
      </header>
      {error && <div className={market.error}>{error}</div>}
      <BenchmarkList plugins={apps} onPick={setBenchmarkId} />
    </>
  );
}
