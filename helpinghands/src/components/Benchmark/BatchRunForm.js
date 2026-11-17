import React, {useEffect, useMemo, useRef, useState} from 'react';
import LoadingSkeleton from '@site/src/components/LoadingSkeleton';
import {benchmarkApi} from './api';
import {defaultPolicy, maximumCost, submitBatch} from './batch';
import {comparableScore} from './harnessComparison';
import {POLICIES, harnessFacts} from './newRun';
import {POLICY_LABELS, scoreText} from './runs';
import useLoad from './useLoad';
import PrepareHarness from './PrepareHarness';
import CaseSetView from './CaseSetView';
import ChoiceList from './ChoiceList';
import {LIMIT_LABELS} from './publish';
import Failure from './Failure';
import styles from './styles.module.css';

const storageKey = userId => `rush-benchmark-batches:${window.location.pathname}:${userId}`;
const readBatches = key => JSON.parse(window.localStorage.getItem(key) || '[]');
const putBatch = (key, batch) => {
  const previous = readBatches(key);
  window.localStorage.setItem(key, JSON.stringify([batch, ...previous.filter(item => item.id !== batch.id)]));
};

async function load() {
  const [benchmarks, defaults, account] = await Promise.all([benchmarkApi.allBenchmarks(), benchmarkApi.defaults(), benchmarkApi.account()]);
  const key = storageKey(account.userId);
  return {benchmarks, defaults, key, batches: readBatches(key)};
}

function ReviewItem({item}) {
  const [open, setOpen] = useState(false);
  const detail = useLoad(() => open ? benchmarkApi.benchmark(item.benchmark.benchmark_id) : Promise.resolve(null), [open, item.benchmark.benchmark_id]);
  return <details className={styles.reviewItem} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><strong>{item.benchmark.plugin.name}</strong> · {item.benchmark.name} · {item.error ? 'Needs attention' : 'Ready'}</summary>
    {item.error ? <p className={styles.warn}>{item.error}</p> : <>
      <p className={styles.fieldHint}>{item.preview.model} · {item.preview.endpoint_profile} · {item.preview.cases.length} cases · maximum ${item.preview.limits.effective.max_cost_usd} per case · internet {item.preview.limits.effective.internet_access ? 'on' : 'off'}</p>
      {detail.error && <p className={styles.error}>{detail.error}</p>}
      {open && !detail.data && !detail.error && <p className={styles.fieldHint}>Loading case details…</p>}
      {detail.data && <CaseSetView benchmark={detail.data} />}
      <details><summary>Limits</summary><dl className={styles.facts}>{Object.entries(item.preview.limits.effective).map(([name, value]) => <React.Fragment key={name}><dt>{LIMIT_LABELS[name] ?? name}</dt><dd>{String(value)}</dd></React.Fragment>)}</dl></details>
      <details><summary>Prompt and rendered cases</summary><pre>{item.preview.prompt.text}</pre>{item.preview.cases.map(c => <details key={c.case_id}><summary>{c.case_id}</summary>{c.prompt.system !== null && <><h5>System</h5><pre>{c.prompt.system}</pre></>}{c.prompt.user !== null && <><h5>User</h5><pre>{c.prompt.user}</pre></>}</details>)}</details>
    </>}
  </details>;
}

/** One client-side batch stores only the existing run requests and their results, so a retry reuses each idempotency key. */
export default function BatchRunForm({go, initialSelection}) {
  const loaded = useLoad(load, []);
  const [selected, setSelected] = useState(() => initialSelection?.benchmarks ?? (initialSelection?.benchmark ? [initialSelection.benchmark] : []));
  const [policy, setPolicy] = useState(initialSelection?.harness?.policy ?? defaultPolicy(null));
  const [source, setSource] = useState(null);
  const [reference, setReference] = useState('');
  const [sourceError, setSourceError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [query, setQuery] = useState('');
  const [review, setReview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [batch, setBatch] = useState(null);
  const [saved, setSaved] = useState(null);
  const [live, setLive] = useState({});
  const [refreshError, setRefreshError] = useState('');
  const batchRef = useRef(batch);
  batchRef.current = batch;
  const items = loaded.data?.benchmarks ?? [];
  const picked = useMemo(() => items.filter(item => selected.includes(item.benchmark_id)), [items, selected]);
  const expected = initialSelection?.harness;

  useEffect(() => { if (loaded.data) setSaved(loaded.data.batches); }, [loaded.data]);
  useEffect(() => {
    if (!batch?.id) return undefined;
    let active = true;
    let loading = false;
    async function refresh() {
      if (loading) return;
      loading = true;
      const entries = batchRef.current.entries.filter(item => item.runId);
      const pairs = new Array(entries.length);
      let next = 0;
      async function read() {
        while (next < entries.length) {
          const index = next++;
          pairs[index] = [entries[index].runId, (await benchmarkApi.run(entries[index].runId)).run];
        }
      }
      try {
        await Promise.all(Array.from({length: Math.min(6, entries.length)}, read));
        if (active) { setLive(Object.fromEntries(pairs)); setRefreshError(''); }
      } catch (error) { if (active) setRefreshError(`Could not refresh run progress: ${error.message}`); }
      finally { loading = false; }
    }
    refresh();
    const timer = setInterval(refresh, 8000);
    return () => { active = false; clearInterval(timer); };
  }, [batch?.id]);

  if (loaded.error) return <p className={styles.error} role="alert">Could not open the run setup: {loaded.error}</p>;
  if (!loaded.data) return <LoadingSkeleton shape="block" height={160} />;
  const {defaults, key} = loaded.data;
  const matches = items.filter(item => `${item.plugin.name} ${item.plugin.id} ${item.name} ${item.task_id}`.toLowerCase().includes(query.toLowerCase().trim())).sort((a, b) => `${a.plugin.name} ${a.name}`.localeCompare(`${b.plugin.name} ${b.name}`));
  const persist = value => { putBatch(key, value); setBatch(value); setSaved(readBatches(key)); };
  const choose = async (get, name) => {
    setSource(null); setSourceError(null); setUploading(true); setReview(null);
    try {
      const result = await get();
      if (expected && (result.harness.name !== expected.harness.name || result.harness.version !== expected.harness.version)) {
        throw new Error(`Choose ${expected.harness.name} v${expected.harness.version} to run the missing benchmarks.`);
      }
      setSource({...result, name});
    } catch (error) { setSourceError(error); } finally { setUploading(false); }
  };
  const updateSelection = ids => { setSelected(ids); setReview(null); };
  async function preview() {
    setBusy(true); setProblem('');
    try {
      if (picked.length !== selected.length) throw new Error('A selected benchmark is no longer available. Remove it before reviewing.');
      const entries = [];
      for (const item of picked) {
        try { entries.push({benchmark: item, preview: await benchmarkApi.preview({benchmark_id: item.benchmark_id, policy})}); }
        catch (error) { entries.push({benchmark: item, error: error.message}); }
      }
      setReview(entries);
    } catch (error) { setProblem(error.message); } finally { setBusy(false); }
  }
  async function submit(current) {
    setBusy(true); setProblem('');
    try {
      await submitBatch(current, {send: benchmarkApi.submit, persist});
    } catch (error) { setProblem(`Could not save batch progress: ${error.message}. Stop and check your browser storage before retrying.`); }
    finally { setBusy(false); }
  }
  const start = () => {
    const ready = review.filter(item => item.preview);
    const created = {id: crypto.randomUUID(), createdAt: new Date().toISOString(), source, policy, entries: ready.map(item => ({benchmark: {benchmark_id: item.benchmark.benchmark_id, name: item.benchmark.name, plugin: {name: item.benchmark.plugin.name, version: item.benchmark.plugin.version}}, previewId: item.preview.preview_id, key: crypto.randomUUID(), runId: null, error: null}))};
    submit(created);
  };

  if (batch) {
    const outstanding = batch.entries.filter(item => !item.runId);
    const finished = batch.entries.filter(item => live[item.runId]?.status === 'complete').length;
    const passed = batch.entries.filter(item => {const run = live[item.runId]; return run?.status === 'complete' && run.score?.complete && run.score.total > 0 && run.score.scored === run.score.total && run.score.passed === run.score.total;}).length;
    const running = batch.entries.filter(item => live[item.runId]?.status === 'running').length;
    const queued = batch.entries.filter(item => live[item.runId]?.status === 'queued').length;
    const stale = batch.entries.filter(item => !item.runId && ['stale_preview', 'unknown_preview'].includes(item.code));
    return <div className={styles.newRun}>
      <button type="button" className={styles.link} disabled={busy} onClick={() => {setBatch(null); setReview(null);}}>← Run another selection</button>
      <h2>{batch.source.harness.name} v{batch.source.harness.version}</h2>
      <p className={styles.fieldHint}>{POLICY_LABELS[batch.policy]} · {finished} of {batch.entries.length} complete · {passed} passed · {running} running · {queued} queued · started {new Date(batch.createdAt).toLocaleString()}</p>
      {problem && <p className={styles.error} role="alert">{problem}</p>}
      {refreshError && <p className={styles.error} role="alert">{refreshError}</p>}
      {outstanding.length > 0 && <div className={styles.actionBar}><button type="button" className={styles.primaryButton} disabled={busy} onClick={() => submit(batch)}>{busy ? 'Submitting…' : `Retry ${outstanding.length} not submitted`}</button><span className={styles.fieldHint}>Already submitted runs will not be duplicated.</span></div>}
      {stale.length > 0 && <p><button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => {setSelected(stale.map(item => item.benchmark.benchmark_id)); setSource(batch.source); setPolicy(batch.policy); setProblem(''); setReview(null); setBatch(null);}}>Review {stale.length} expired or changed previews</button></p>}
      <div className={styles.comparisonTable}><table className={styles.table}><thead><tr><th>Benchmark</th><th>Status</th><th /></tr></thead><tbody>{batch.entries.map(entry => {
        const run = live[entry.runId];
        return <tr key={entry.benchmark.benchmark_id}><th scope="row">{entry.benchmark.plugin.name}<small className={styles.comparisonMeta}>{entry.benchmark.name} · v{entry.benchmark.plugin.version}</small></th><td>{entry.error ? <span className={styles.warn}>{entry.error}</span> : !entry.runId ? 'Not submitted' : !run ? 'Submitted' : run.status === 'complete' ? comparableScore(run) ? `${run.score.passed} / ${run.score.total} passed` : scoreText(run.score) : run.status}</td><td>{entry.runId && <button type="button" className={styles.secondaryButton} onClick={() => go({run: entry.runId})}>View run</button>}</td></tr>;
      })}</tbody></table></div>
    </div>;
  }
  return <div className={styles.newRun}>
    <h2>Benchmark Your Harness</h2>
    <p className={styles.fieldHint}>Choose a harness once and run it across any number of published plugin benchmarks.</p>
    {expected && <p className={styles.note}>Running missing benchmarks for {expected.harness.name} v{expected.harness.version} · {POLICY_LABELS[expected.policy]}. Choose that same harness source below.</p>}
    <section className={styles.section}>
      <h3 className={styles.sectionHeading}>1. Choose a harness</h3>
      <div className={styles.form}><label>Harness source ZIP<input type="file" accept=".zip,application/zip" disabled={busy || uploading} onChange={event => {const file = event.target.files[0]; if (file) {setReference(''); if (!expected) setPolicy(defaultPolicy(null)); choose(() => benchmarkApi.uploadSource(file), file.name);}}} /></label></div>
      <ChoiceList label="Or use a reference harness" disabled={busy || uploading} options={defaults.reference_harnesses.map(name => ({value: name, label: name}))} value={reference} onChange={name => {setReference(name); if (!expected) setPolicy(defaultPolicy(name)); choose(() => benchmarkApi.referenceSource(name), `Reference harness ${name}`);}} />
      {uploading && <p className={styles.fieldHint}>Preparing harness…</p>}
      {sourceError && <Failure failure={sourceError} />}
      {source && <p className={styles.fieldHint}>Selected: {source.name}</p>}
      {source && <dl className={styles.facts}>{harnessFacts(source).map(([name, value]) => <React.Fragment key={name}><dt>{name}</dt><dd>{value}</dd></React.Fragment>)}</dl>}
      <ChoiceList label="Mode" disabled={Boolean(expected) || busy} options={POLICIES.map(([value, label, detail]) => ({value, label, detail}))} value={policy} onChange={value => {setPolicy(value); setReview(null);}} />
    </section>
    <PrepareHarness />
    <section className={styles.section}>
      <h3 className={styles.sectionHeading}>2. Choose benchmarks</h3>
      <p className={styles.fieldHint}>{selected.length} selected · {picked.reduce((n, item) => n + item.case_count, 0)} cases</p>
      <div className={styles.toolbar}><input className={styles.searchInput} type="search" disabled={busy} placeholder="Search plugins or benchmarks" aria-label="Search plugins or benchmarks" value={query} onChange={event => setQuery(event.target.value)} /><button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => updateSelection([...new Set([...selected, ...matches.map(item => item.benchmark_id)])])}>Select shown</button><button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => updateSelection(selected.filter(id => !matches.some(item => item.benchmark_id === id)))}>Clear shown</button></div>
      {picked.length !== selected.length && <p className={styles.warn}>Some selected benchmarks are no longer available. <button type="button" className={styles.link} onClick={() => updateSelection(picked.map(item => item.benchmark_id))}>Remove unavailable benchmarks</button></p>}
      <div className={styles.benchmarkList}>{matches.map(item => <label key={item.benchmark_id} className={styles.benchmarkOption}><input type="checkbox" disabled={busy} checked={selected.includes(item.benchmark_id)} onChange={event => updateSelection(event.target.checked ? [...selected, item.benchmark_id] : selected.filter(id => id !== item.benchmark_id))} /><span><strong>{item.plugin.name}</strong><small>{item.name} · v{item.plugin.version} · {item.task_id} · {item.case_count} case{item.case_count === 1 ? '' : 's'} · {item.model}</small></span></label>)}</div>
      {!matches.length && <p className={styles.fieldHint}>No benchmarks match this search.</p>}
      <div className={styles.actionBar}><button type="button" className={styles.primaryButton} disabled={!source || !selected.length || busy || uploading} onClick={preview}>{busy ? 'Checking benchmarks…' : `Review ${selected.length} benchmark${selected.length === 1 ? '' : 's'}`}</button></div>
    </section>
    {problem && <p className={styles.error} role="alert">{problem}</p>}
    {review && <section className={styles.section}>
      <h3 className={styles.sectionHeading}>3. Review and run</h3>
      <p>{review.filter(item => item.preview).length} ready · {review.filter(item => item.error).length} need attention · {review.filter(item => item.preview).reduce((n, item) => n + item.preview.cases.length, 0)} cases</p>
      <p className={styles.fieldHint}>Combined maximum cost: ${maximumCost(review.filter(item => item.preview).map(item => item.preview)).toFixed(2)}. This is a limit, not an estimate.</p>
      <div className={styles.benchmarkList}>{review.map(item => <ReviewItem key={item.benchmark.benchmark_id} item={item} />)}</div>
      <p className={styles.fieldHint}>Benchmarks needing attention will not be submitted. Review them again after resolving their errors.</p>
      <button type="button" className={styles.primaryButton} disabled={busy || !review.some(item => item.preview)} onClick={start}>{busy ? 'Submitting…' : `Run ${review.filter(item => item.preview).length} ready benchmarks`}</button>
    </section>}
    {saved?.length > 0 && <section className={styles.section}><h3 className={styles.sectionHeading}>Recent batches on this computer</h3>{saved.map(item => <p key={item.id}><button type="button" className={styles.link} onClick={() => {setProblem(''); setBatch(item);}}>{item.source.harness.name} v{item.source.harness.version} · {item.entries.length} benchmarks · {new Date(item.createdAt).toLocaleString()}</button></p>)}</section>}
  </div>;
}
