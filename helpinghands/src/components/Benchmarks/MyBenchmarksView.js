import React, {useCallback, useEffect, useState} from 'react';
import {useHistory, useLocation} from '@docusaurus/router';
import market from '@site/src/pages/marketplace/styles.module.css';
import BenchmarkTrace, {BenchmarkTraceCompare} from '@site/src/components/BenchmarkTrace';
import {benchmarkJson, runDetail} from './api';
import {Pill} from './Choice';
import {ACTIVE, formatCost, formatTime, formatTokens, harnessLabel, harnessNames, historyRuns, isBenchmarkRun, latestAttempts, scoreText, toggleSelection, toggled, verdictOf} from './runs';
import useLoad, {usePoll} from './useLoad';
import styles from './history.module.css';

const PAGE = 200;

async function allRuns() {
  const runs = [];
  let before = null;
  let beforeId = null;
  do {
    const page = (await benchmarkJson(`/runs?limit=${PAGE}${before ? `&before=${encodeURIComponent(before)}&before_id=${encodeURIComponent(beforeId)}` : ''}`)).runs;
    runs.push(...page);
    if (page.length < PAGE) break;
    const last = page[page.length - 1];
    if (last.created_at === before && last.run_id === beforeId) throw new Error('Could not advance the run history cursor');
    before = last.created_at;
    beforeId = last.run_id;
  } while (true);
  return runs;
}

function useDetails(ids) {
  const loaded = useLoad(() => Promise.all(ids.map(runDetail)), [ids.join(',')]);
  usePoll(loaded.reload, 3000, Boolean(loaded.data?.some(({run}) => ACTIVE.has(run.status))));
  return loaded;
}

const metric = (metrics, field, time = false) => {
  const value = metrics?.[field];
  if (value == null) return '—';
  if (typeof value === 'object') return time ? formatTime(value.total, value.missing_attempts) : formatTokens(value.total, value.missing_attempts);
  return time ? formatTime(value, false) : formatTokens(value, false);
};

function Metrics({run, cost}) {
  const m = run.metrics;
  const attempts = Object.values(latestAttempts(run));
  const toolCalls = attempts.some(attempt => attempt.metrics?.tool_calls != null) ? metric(m, 'tool_calls') : '—';
  return <dl className={styles.metrics}>
    {[['Pass rate', scoreText(run.score)], ['Input tokens', metric(m, 'input_tokens')], ['Output tokens', metric(m, 'output_tokens')],
      ['Cache read', metric(m, 'cache_read_tokens')], ['Cache write', metric(m, 'cache_write_tokens')], ['Time', metric(m, 'elapsed_ms', true)],
      ['Tool calls', toolCalls], ['Cost', formatCost(cost)]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
  </dl>;
}

function RunDetail({id, openTrace, back}) {
  const {data, error, reload} = useDetails([id]);
  const [cancelError, setCancelError] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const cancel = async () => {
    setCancelling(true);
    try { await benchmarkJson(`/runs/${id}/cancel`, {method: 'POST'}); await reload(); setCancelError(null); }
    catch (failure) { setCancelError(failure.message); }
    finally { setCancelling(false); }
  };
  if (error) return <><button className={styles.link} onClick={back}>← My Benchmarks</button><div className={market.error}>{error}</div><button type="button" className="button button--secondary" onClick={reload}>Retry</button></>;
  if (!data) return <p>Reading the run…</p>;
  const {run, cost_usd: cost} = data[0];
  const attempts = latestAttempts(run);
  return <>
    <button className={styles.link} onClick={back}>← My Benchmarks</button>
    <div className={styles.detailHeading}>
      <h1>{harnessLabel(run.harness.name)}</h1><Pill word={run.status} />
      {ACTIVE.has(run.status) && <button type="button" className={styles.cancel} disabled={cancelling} onClick={cancel}>{cancelling ? 'Cancelling…' : 'Cancel run'}</button>}
    </div>
    <p className={styles.meta}>{run.model} · {run.benchmark.name} · {run.case_set.plugin.name ?? run.case_set.plugin.id} v{run.case_set.plugin.version} · {new Date(run.created_at).toLocaleString()}</p>
    {cancelError && <div className={market.error} role="alert">{cancelError}</div>}
    <Metrics run={run} cost={cost} />
    <h2 className={styles.tableTitle}>Cases</h2><div className={styles.scroll}><table className={styles.table}><thead><tr><th>Case</th><th>Verdict</th><th>Time</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th></th></tr></thead><tbody>
      {run.cases.map(one => { const attempt = attempts[one.case_id]; return <tr key={one.case_id}>
        <td className={styles.caseName}>{one.case_id}</td>
        <td>{attempt ? <Pill word={verdictOf(attempt)} /> : '—'}</td><td>{metric(attempt?.metrics, 'elapsed_ms', true)}</td>{['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'].map(field => <td key={field}>{metric(attempt?.metrics, field)}</td>)}
        <td><button type="button" className={styles.traceButton} disabled={!attempt || attempt.state === 'queued'} onClick={() => openTrace(attempt.attempt_id)}>Traces</button></td>
      </tr>; })}
    </tbody></table></div>
  </>;
}

function ComparedCase({sides, ids, attempts, openTrace}) {
  const [left, right] = sides;
  const caseName = left && right && left.case_id !== right.case_id
    ? `${left.case_id} / ${right.case_id}` : (left?.case_id ?? right.case_id);
  return <tr>
    <td className={styles.caseName}>{caseName}</td>
    {sides.map((side, index) => {
      const attempt = side && attempts[index][side.case_id];
      return <td key={ids[index]}>{attempt ? <><Pill word={verdictOf(attempt)} /><div className={styles.tokenDetail}>Input {metric(attempt.metrics, 'input_tokens')} · Output {metric(attempt.metrics, 'output_tokens')}<br />Cache read {metric(attempt.metrics, 'cache_read_tokens')} · write {metric(attempt.metrics, 'cache_write_tokens')}</div></> : '—'}</td>;
    })}
    <td>{left?.attempt_id && right?.attempt_id && <button type="button" className={styles.traceButton} onClick={() => openTrace([left.attempt_id, right.attempt_id])}>Traces</button>}</td>
  </tr>;
}

function Comparison({ids, openTrace, back}) {
  const {data, error, reload: dataReload} = useLoad(async () => {
    const [details, comparison] = await Promise.all([
      Promise.all(ids.map(runDetail)), benchmarkJson(`/compare?a=${encodeURIComponent(ids[0])}&b=${encodeURIComponent(ids[1])}`),
    ]);
    return {details, comparison};
  }, [ids.join(',')]);
  usePoll(dataReload, 3000, Boolean(data?.details.some(({run}) => ACTIVE.has(run.status))));
  if (error) return <><button className={styles.link} onClick={back}>← My Benchmarks</button><div className={market.error}>{error}</div><button type="button" className="button button--secondary" onClick={dataReload}>Retry</button></>;
  if (!data) return <p>Reading the runs…</p>;
  const {details, comparison} = data;
  const attempts = details.map(({run}) => latestAttempts(run));
  const rows = [...comparison.shared.map(row => [row.a, row.b]), ...comparison.only_a.map(side => [side, null]), ...comparison.only_b.map(side => [null, side])];
  return <>
    <button className={styles.link} onClick={back}>← My Benchmarks</button><h1>Compare runs</h1>
    <h2>Run totals</h2><div className={styles.scroll}><table className={styles.table}><thead><tr><th>Harness</th><th>Pass rate</th><th>Input tokens</th><th>Output tokens</th><th>Cache read</th><th>Cache write</th><th>Time</th></tr></thead><tbody>
      {details.map(({run}) => <tr key={run.run_id}><td><strong>{harnessLabel(run.harness.name)}</strong><div className={styles.secondary}>{run.model} · {run.benchmark.name}</div></td><td>{scoreText(run.score)}</td>{['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'].map(field => <td key={field}>{metric(run.metrics, field)}</td>)}<td>{metric(run.metrics, 'elapsed_ms', true)}</td></tr>)}
    </tbody></table></div>
    <h2 className={styles.tableTitle}>Cases</h2><div className={styles.scroll}><table className={styles.table}><thead><tr><th>Case</th>{details.map(({run}) => <th key={run.run_id}>{harnessLabel(run.harness.name)}<br /><span className={styles.meta}>{run.model}</span></th>)}<th></th></tr></thead><tbody>
      {rows.map((sides, index) => <ComparedCase key={`${sides[0]?.case_id ?? ''}:${sides[1]?.case_id ?? ''}:${index}`}
        sides={sides} ids={ids} attempts={attempts} openTrace={openTrace} />)}
    </tbody></table></div>
  </>;
}

function Filters({runs, plugins, setPlugins, pluginSearch, setPluginSearch, harnesses, setHarnesses}) {
  const options = [...new Map(runs.map(run => [run.plugin.id, run.plugin])).values()];
  const matching = options.filter(plugin => `${plugin.name ?? ''} ${plugin.id}`.toLowerCase().includes(pluginSearch.toLowerCase()));
  const names = [...new Set(harnessNames(runs).map(harnessLabel))];
  const clear = () => { setPlugins(new Set()); setPluginSearch(''); setHarnesses(new Set()); };
  return <div className={styles.filterPanel}><div className={styles.filters}>
    <div className={styles.filterField}><span className={styles.filterLabel}>Plugins</span>
      <details className={styles.pluginPicker}><summary>{plugins.size ? `${plugins.size} selected` : 'All plugins'}</summary>
        <div className={styles.pluginMenu}><input aria-label="Search plugins" value={pluginSearch} onChange={event => setPluginSearch(event.target.value)} placeholder="Search plugins" />
          <div className={styles.pluginOptions}>{matching.map(plugin => <label key={plugin.id}><input type="checkbox" checked={plugins.has(plugin.id)} onChange={() => setPlugins(toggled(plugins, plugin.id))} /><span>{plugin.name ?? plugin.id}</span></label>)}
            {!matching.length && <span className={styles.meta}>No plugins found.</span>}</div></div>
      </details>
    </div>
    <div className={styles.filterField}><span className={styles.filterLabel}>Harnesses</span>
      <details className={styles.pluginPicker}><summary>{harnesses.size ? `${harnesses.size} selected` : 'All harnesses'}</summary>
        <div className={styles.pluginMenu}><div className={styles.pluginOptions}>{names.map(name => <label key={name}><input type="checkbox" checked={harnesses.has(name)} onChange={() => setHarnesses(toggled(harnesses, name))} /><span>{name}</span></label>)}</div></div>
      </details>
    </div>
    {Boolean(plugins.size || pluginSearch || harnesses.size) && <button type="button" className={styles.clear} onClick={clear}>Clear filters</button>}
  </div>
  {(plugins.size > 0 || harnesses.size > 0) && <div className={styles.chips} aria-label="Selected filters">
    {options.filter(plugin => plugins.has(plugin.id)).map(plugin => <button type="button" key={plugin.id} className={styles.chip} onClick={() => setPlugins(toggled(plugins, plugin.id))}>{plugin.name ?? plugin.id} <span aria-hidden="true">×</span></button>)}
    {names.filter(name => harnesses.has(name)).map(name => <button type="button" key={name} className={styles.chip} onClick={() => setHarnesses(toggled(harnesses, name))}>{name} <span aria-hidden="true">×</span></button>)}
  </div>}</div>;
}

function RunTable({runs, selected, setSelected, open}) {
  return <div className={styles.scroll}><table className={styles.table}>
    <thead><tr><th>Compare</th><th>Harness</th><th>Plugin / benchmark</th><th>Status</th><th>Pass rate</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Time</th></tr></thead>
    <tbody>{runs.map(run => <tr key={run.run_id} className={styles.runRow} onClick={() => open(run.run_id)}>
      <td onClick={event => event.stopPropagation()}>
        <input type="checkbox" aria-label={`Compare ${harnessLabel(run.harness.name)} run ${run.run_id}`}
          checked={selected.includes(run.run_id)} disabled={selected.length === 2 && !selected.includes(run.run_id)}
          onChange={() => setSelected(toggleSelection(selected, run.run_id))} />
      </td>
      <td><button type="button" className={styles.link} onClick={event => { event.stopPropagation(); open(run.run_id); }}>{harnessLabel(run.harness.name)}</button></td>
      <td>{run.plugin.name ?? run.plugin.id} <span className={styles.secondary}>v{run.plugin.version}</span><div className={styles.secondary}>{run.benchmark.name}</div></td>
      <td><Pill word={run.status} /></td><td>{scoreText(run.score)}</td>
      {['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'].map(field => <td key={field}>{metric(run.metrics, field)}</td>)}<td>{metric(run.metrics, 'elapsed_ms', true)}</td>
    </tr>)}</tbody>
  </table></div>;
}

export default function MyBenchmarksView() {
  const history = useHistory();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const runId = params.get('run');
  const compareIds = params.get('compare')?.split(',') ?? [];
  const traceIds = params.get('trace')?.split(',') ?? [];
  const navigate = changes => {
    const next = new URLSearchParams(location.search);
    Object.entries(changes).forEach(([key, value]) => value == null ? next.delete(key) : next.set(key, value));
    history.push(`${location.pathname}?${next}`);
  };
  const [summaries, setSummaries] = useState(null);
  const [error, setError] = useState(null);
  const [plugins, setPlugins] = useState(new Set());
  const [pluginSearch, setPluginSearch] = useState('');
  const [harnesses, setHarnesses] = useState(new Set());
  const [selected, setSelected] = useState([]);
  const reload = useCallback(async () => {
    try { setSummaries(await allRuns()); setError(null); } catch (failure) { setError(failure.message); }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  usePoll(reload, 3000, Boolean(summaries?.some(run => ACTIVE.has(run.status))));
  if (traceIds.length) {
    const names = compareIds.map(id => { const name = summaries?.find(run => run.run_id === id)?.harness.name; return name && harnessLabel(name); });
    return <><button className={styles.link} onClick={() => navigate({trace: null})}>← Back to {compareIds.length ? 'comparison' : 'run'}</button>
      {traceIds.length === 2 ? <BenchmarkTraceCompare leftAttemptId={traceIds[0]} rightAttemptId={traceIds[1]} leftHarnessName={names[0]} rightHarnessName={names[1]} /> : <BenchmarkTrace attemptId={traceIds[0]} harnessName={(() => { const name = summaries?.find(run => run.run_id === runId)?.harness.name; return name && harnessLabel(name); })()} />}</>;
  }
  const back = () => navigate({run: null, compare: null, trace: null});
  if (runId) return <RunDetail id={runId} back={back} openTrace={id => navigate({trace: id})} />;
  if (compareIds.length) return compareIds.length === 2 && compareIds[0] !== compareIds[1]
    ? <Comparison ids={compareIds} back={back} openTrace={ids => navigate({trace: ids.join(',')})} /> : <div className={market.error}>Select two different runs to compare.</div>;
  const runs = (summaries ?? []).filter(isBenchmarkRun);
  const shown = historyRuns(runs, {plugins, harnesses});
  return <>
    <header className={styles.header}>
      <h1>My Benchmarks</h1>
    </header>
    {error && <div className={market.error}>{error}</div>}
    {summaries && runs.length > 0 && <Filters runs={runs} plugins={plugins} setPlugins={setPlugins} pluginSearch={pluginSearch}
      setPluginSearch={setPluginSearch} harnesses={harnesses} setHarnesses={setHarnesses} />}
    {!summaries ? (error ? null : <p className={styles.empty}>Reading runs…</p>)
      : !runs.length ? <p className={styles.empty}>You have no benchmark runs yet. Use Benchmark a Harness to make one.</p>
        : !shown.length ? <p className={styles.empty}>No runs match these filters.</p>
              : <RunTable runs={shown} selected={selected} setSelected={setSelected} open={id => navigate({run: id})} />}
    <div className={styles.compareFloat}>
      <button type="button" className="button button--primary" disabled={selected.length !== 2} onClick={() => navigate({compare: selected.join(',')})}>Compare</button>
    </div>
  </>;
}
