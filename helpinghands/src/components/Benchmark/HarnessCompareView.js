import React, {useEffect, useState} from 'react';
import LoadingSkeleton from '@site/src/components/LoadingSkeleton';
import {benchmarkApi} from './api';
import {comparisonRows, comparisonTotals, comparableScore, harnessesOf} from './harnessComparison';
import {POLICY_LABELS, personLabel, scoreText} from './runs';
import {primaryMetrics} from './metrics';
import ChoiceList from './ChoiceList';
import useLoad from './useLoad';
import styles from './styles.module.css';

const label = item => `${item.harness.name} v${item.harness.version}`;

async function loadResults() {
  const [benchmarks, account, ownRuns] = await Promise.all([benchmarkApi.allBenchmarks(), benchmarkApi.account(), benchmarkApi.allRuns()]);
  // A bounded pool avoids flooding the server when the marketplace has many benchmarks.
  const results = new Array(benchmarks.length);
  let next = 0;
  async function load() {
    while (next < benchmarks.length) {
      const index = next++;
      const benchmark = benchmarks[index];
      results[index] = {benchmark, runs: await benchmarkApi.allBenchmarkResults(benchmark.benchmark_id)};
    }
  }
  await Promise.all(Array.from({length: Math.min(6, benchmarks.length)}, load));
  return {results, userId: account.userId, ownRunIds: new Set(ownRuns.map(run => run.run_id))};
}

function RunCell({side, row, number, select}) {
  const run = side.run;
  if (!run) return <span className={styles.muted}>Skipped</span>;
  return <div>
    <strong>{comparableScore(run) ? `${run.score.passed} / ${run.score.total} passed` : run.status === 'complete' ? scoreText(run.score) : run.status}</strong>
    <small className={styles.comparisonMeta}>{run.model} · {new Date(run.created_at).toLocaleString()}</small>
    <small className={styles.comparisonMeta}>{primaryMetrics(run.metrics).filter(item => ['total_tokens', 'elapsed_ms'].includes(item.key)).map(item => `${item.text} ${item.key === 'total_tokens' ? 'tokens' : ''}${item.missing ? ' (partial)' : ''}`).join(' · ')}</small>
    {side.options.length > 1 && <details className={styles.runChoices}><summary>Choose a different run</summary><fieldset><legend>Run</legend>
      {side.options.map(item => <label key={item.run_id}><input type="radio" name={`${row.benchmark.benchmark_id}-${number}`} checked={item.run_id === run.run_id} onChange={() => select(`${row.benchmark.benchmark_id}:${number}`, item.run_id)} /> {new Date(item.created_at).toLocaleString()} · {item.status} · {item.run_id.slice(0, 8)}</label>)}
    </fieldset></details>}
  </div>;
}

export default function HarnessCompare({go}) {
  const {data, error, loading} = useLoad(loadResults, []);
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  const [choices, setChoices] = useState({});
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (!data) return;
    const key = `rush-harness-comparison:${window.location.pathname}:${data.userId}`;
    const prior = JSON.parse(window.sessionStorage.getItem(key) || '{}');
    setLeft(prior.left ?? ''); setRight(prior.right ?? ''); setChoices(prior.choices ?? {});
    setFilter(prior.filter ?? 'all'); setQuery(prior.query ?? ''); setRestored(true);
  }, [data]);
  useEffect(() => {
    if (!data || !restored) return;
    window.sessionStorage.setItem(`rush-harness-comparison:${window.location.pathname}:${data.userId}`, JSON.stringify({left, right, choices, filter, query}));
  }, [data, restored, left, right, choices, filter, query]);
  if (error) return <p className={styles.error} role="alert">Could not load all benchmark results: {error}</p>;
  if (loading && !data) return <LoadingSkeleton shape="block" height={160} />;
  const harnesses = harnessesOf(data.results);
  const a = harnesses.find(item => item.key === left), b = harnesses.find(item => item.key === right);
  const name = (item, other) => label(item) !== label(other) ? label(item) : `${label(item)} · ${personLabel(item.user)} · ${POLICY_LABELS[item.policy]}`;
  const rows = a && b ? comparisonRows(data.results, left, right, choices) : [];
  const totals = comparisonTotals(rows);
  const missingA = rows.filter(row => !row.a.run && row.b.run).map(row => row.benchmark.benchmark_id);
  const missingB = rows.filter(row => !row.b.run && row.a.run).map(row => row.benchmark.benchmark_id);
  const visible = rows.filter(row => {
    const both = row.a.run && row.b.run;
    if (filter === 'shared' && !both) return false;
    if (filter === 'missing' && both) return false;
    if (filter === 'different' && (!both || !comparableScore(row.a.run) || !comparableScore(row.b.run) || row.a.run.score.passed === row.b.run.score.passed)) return false;
    return `${row.benchmark.plugin.name} ${row.benchmark.name} ${row.benchmark.task_id}`.toLowerCase().includes(query.toLowerCase().trim());
  });
  const runMissing = (ids, item) => go({view: 'new', benchmarks: ids, harness: {harness: item.harness, policy: item.policy}});
  return <div>
    <h2>Compare harnesses</h2>
    <p className={styles.fieldHint}>Compare results on the same published benchmarks. Missing results are skipped, not scored.</p>
    {!harnesses.length && <p className={styles.emptyState}>No harness runs yet. Run a harness to start comparing.</p>}
    <div className={styles.harnessPicker}>
      {[[left, setLeft, 'First harness'], [right, setRight, 'Second harness']].map(([value, set, title]) => <ChoiceList key={title} label={title} searchPlaceholder={`Search ${title.toLowerCase()} choices`} options={harnesses.map(item => ({value: item.key, label: `${item.harness.name} v${item.harness.version}`, detail: `${personLabel(item.user)} · ${POLICY_LABELS[item.policy]}`}))} value={value} onChange={next => {set(next); setChoices({});}} />)}
    </div>
    {a && b && left === right && <p className={styles.warn}>Choose two different harness versions or modes.</p>}
    {a && b && left !== right && <>
      {a.policy !== b.policy && <p className={styles.warn}>These runs use different modes: {POLICY_LABELS[a.policy]} and {POLICY_LABELS[b.policy]}.</p>}
      <section className={styles.section} aria-label="Comparison summary">
        <h3 className={styles.sectionHeading}>Shared results</h3>
        <p>{totals.shared} of {rows.length} benchmarks have runs on both sides; {totals.paired} have complete, scored results on both sides.</p>
        {totals.paired > 0 ? <div className={styles.twin}>{[[a, totals.a], [b, totals.b]].map(([item, score]) => <div key={item.key}><strong>{name(item, item === a ? b : a)}: {score.benchmarks} / {totals.paired} benchmarks passed</strong><p className={styles.fieldHint}>{score.passed} / {score.cases} cases passed on those benchmarks</p></div>)}</div> : <p className={styles.fieldHint}>No fully scored pairs yet. Open a shared benchmark to inspect its cases.</p>}
        <p className={styles.fieldHint}>A benchmark passes when every case passes. Only fully scored pairs count in either summary.</p>
        <div className={styles.actionBar}>
          {[[a, missingA, 'A'], [b, missingB, 'B']].map(([item, missing, side]) => missing.length > 0 && (item.user.id === data.userId ? <button key={side} type="button" className={styles.secondaryButton} onClick={() => runMissing(missing, item)}>Run {missing.length} missing for {name(item, item === a ? b : a)}</button> : <span key={side} className={styles.fieldHint}>{name(item, item === a ? b : a)} belongs to another member; its source is not available here.</span>))}
        </div>
      </section>
      <div className={styles.toolbar}><input className={styles.searchInput} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search benchmarks" aria-label="Search benchmarks" />{[['all','All'],['shared','Shared'],['missing','Missing'],['different','Differences']].map(([id, text]) => <button type="button" className={styles.chip} key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{text}</button>)}</div>
      <div className={styles.comparisonTable}><table className={styles.table}><thead><tr><th>Plugin benchmark</th><th>{name(a, b)}</th><th>{name(b, a)}</th><th /></tr></thead><tbody>
        {visible.map(row => <tr key={row.benchmark.benchmark_id}><th scope="row">{row.benchmark.plugin.name}<small className={styles.comparisonMeta}>{row.benchmark.name} · v{row.benchmark.plugin.version} · {row.benchmark.task_id}</small></th><td><RunCell side={row.a} row={row} number={0} select={(key, value) => setChoices({...choices, [key]: value})} /></td><td><RunCell side={row.b} row={row} number={1} select={(key, value) => setChoices({...choices, [key]: value})} /></td><td>{row.a.run && row.b.run && (data.ownRunIds.has(row.a.run.run_id) && data.ownRunIds.has(row.b.run.run_id) ? <button type="button" className={styles.secondaryButton} onClick={() => go({runs: `${row.a.run.run_id},${row.b.run.run_id}`, fromHarness: true})}>Compare cases</button> : <span className={styles.fieldHint}>Summary only</span>)}{!row.a.run && row.b.run && a.user.id === data.userId && <button type="button" className={styles.secondaryButton} onClick={() => runMissing([row.benchmark.benchmark_id], a)}>Run for {name(a, b)}</button>}{!row.b.run && row.a.run && b.user.id === data.userId && <button type="button" className={styles.secondaryButton} onClick={() => runMissing([row.benchmark.benchmark_id], b)}>Run for {name(b, a)}</button>}</td></tr>)}
      </tbody></table>{!visible.length && <p className={styles.emptyState}>No benchmarks match this filter.</p>}</div>
    </>}
  </div>;
}
