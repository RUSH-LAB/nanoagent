import React, {useEffect, useMemo, useRef, useState} from 'react';
import clsx from 'clsx';
import {toast} from '@site/src/components/Toast/toast';
import LoadingSkeleton from '@site/src/components/LoadingSkeleton';
import {benchmarkApi} from './api';
import {POLICIES, benchmarkGroups, egressText, harnessFacts, keyFor, previewBody, runBody, staleReport} from './newRun';
import {LIMIT_LABELS, publishable} from './publish';
import useLoad from './useLoad';
import BenchmarkCards from './BenchmarkCards';
import CaseSetView from './CaseSetView';
import ChoiceList from './ChoiceList';
import Failure from './Failure';
import PrepareHarness from './PrepareHarness';
import styles from './styles.module.css';

/** One case's rendered prompt: its system and user text exactly as the harness gets them. */
function Rendered({item}) {
  return (
    <details>
      <summary>{item.case_id} <small className={styles.muted}>{item.kind}</small> <code>{item.prompt.sha256.slice(0, 12)}</code></summary>
      {item.prompt.system !== null && <><h5>System</h5><pre>{item.prompt.system}</pre></>}
      {item.prompt.user !== null && <><h5>User</h5><pre>{item.prompt.user}</pre></>}
    </details>
  );
}

/** What a preview resolved: the benchmark's configuration under the policy, and what a worker cannot give. */
function Preview({preview}) {
  const {benchmark} = preview;
  const effective = preview.limits.effective;
  return (
    <section className={styles.task} aria-label="Preview">
      <h4>{benchmark.name} · {benchmark.plugin.name} v{benchmark.plugin.version} · {benchmark.task_id}</h4>
      <dl className={styles.facts}>
        <dt>Cases</dt><dd>{preview.cases.map(item => item.case_id).join(', ')}</dd>
        <dt>Policy</dt><dd>{preview.policy}</dd>
        <dt>Model</dt><dd>{preview.model} · {preview.renderer_version}</dd>
        <dt>Endpoint</dt><dd>{preview.endpoint_profile}</dd>
        <dt>Internet access</dt><dd>{effective.internet_access ? 'on' : 'off'}{preview.unverified_egress && <span className={clsx(styles.badge, styles.unverified)} title="Model calls that bypass the gateway cannot be detected">unverified egress</span>}</dd>
        <dt>Egress hosts</dt><dd>{egressText(preview)}</dd>
      </dl>
      <details>
        <summary>Limits</summary>
        <table className={styles.table}>
          <thead><tr><th>Limit</th><th>Value</th><th>Worker maximum</th></tr></thead>
          <tbody>{Object.keys(effective).map(name => (
            <tr key={name}><td>{LIMIT_LABELS[name] ?? name}</td><td>{String(effective[name])}</td><td>{String(preview.limits.capabilities[name])}</td></tr>
          ))}</tbody>
        </table>
      </details>
      <details>
        <summary>Prompt {preview.policy === 'coding' ? 'template' : 'instructions'}</summary>
        <pre>{preview.prompt.text}</pre>
      </details>
      <details>
        <summary>{preview.cases.length} rendered prompt{preview.cases.length === 1 ? '' : 's'}</summary>
        {preview.cases.map(item => <Rendered key={item.case_id} item={item} />)}
      </details>
    </section>
  );
}

export default function NewRun({go, initialSelection}) {
  const apps = useLoad(() => benchmarkApi.apps().then(publishable), []);
  const [pluginId, setPluginId] = useState(initialSelection?.plugin ?? '');
  const [benchmarkId, setBenchmarkId] = useState(initialSelection?.benchmark ?? '');
  const [prefillNotice, setPrefillNotice] = useState('');
  const defaults = useLoad(() => benchmarkApi.defaults(), []);
  const [reference, setReference] = useState('');
  const benchmarks = useLoad(() => (pluginId ? benchmarkApi.benchmarks(pluginId) : Promise.resolve([])), [pluginId]);
  const detail = useLoad(() => (benchmarkId ? benchmarkApi.benchmark(benchmarkId) : Promise.resolve(null)), [benchmarkId]);
  const [policy, setPolicy] = useState('task_tools');
  const [source, setSource] = useState(null);
  const [sourceError, setSourceError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [tick, setTick] = useState(0);
  const [stale, setStale] = useState(null);
  const [submitError, setSubmitError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const keyRef = useRef(null);

  // A published selection can become unavailable before this page loads. Keep the form usable.
  useEffect(() => {
    if (!initialSelection || apps.loading || apps.error) return;
    if (pluginId && !(apps.data ?? []).some(item => item.id === pluginId)) {
      setPrefillNotice('The published plugin is no longer available. Choose another plugin.');
      setPluginId(''); setBenchmarkId('');
    }
  }, [initialSelection, apps.loading, apps.error, apps.data, pluginId]);
  useEffect(() => {
    if (!initialSelection || benchmarks.loading || benchmarks.error || !benchmarkId) return;
    if (!(benchmarks.data ?? []).some(item => item.benchmark_id === benchmarkId)) {
      setPrefillNotice('The published benchmark is no longer available. Choose another benchmark.');
      setBenchmarkId('');
    }
  }, [initialSelection, benchmarks.loading, benchmarks.error, benchmarks.data, benchmarkId]);

  const app = (apps.data ?? []).find(item => item.id === pluginId) ?? null;
  const groups = useMemo(() => benchmarkGroups(benchmarks.data ?? [], app?.version), [benchmarks.data, app?.version]);
  const benchmark = detail.data;
  const request = useMemo(() => previewBody({benchmarkId: benchmark?.benchmark_id, policy}), [benchmark, policy]);
  const stamp = request.body ? JSON.stringify(request.body) : '';

  // The preview follows the setup; a late answer to an earlier one is dropped.
  useEffect(() => {
    if (!request.body) { setPreview(null); setPreviewError(null); return undefined; }
    let live = true;
    const timer = setTimeout(() => {
      benchmarkApi.preview(request.body).then(
        result => { if (live) { setPreview({...result, stamp}); setPreviewError(null); } },
        error => { if (live) { setPreview(null); setPreviewError(error); } },
      );
    }, 350);
    return () => { live = false; clearTimeout(timer); };
  }, [stamp, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = preview && preview.stamp === stamp ? preview : null;

  // The harness source is a ZIP the member uploads, or a reference harness their own NanoAgent builds.
  const take = async (save, label) => {
    setSource(null);
    setSourceError(null);
    setUploading(true);
    try {
      setSource({...await save(), name: label});
    } catch (error) {
      setSourceError(error);
    } finally { setUploading(false); }
  };
  const upload = file => {
    if (!file) return undefined;
    setReference('');
    return take(() => benchmarkApi.uploadSource(file), file.name);
  };
  const chooseReference = name => {
    setReference(name);
    if (!name) {
      setSource(null);  // no harness chosen: Run must not send the one built before
      return undefined;
    }
    return take(() => benchmarkApi.referenceSource(name), `Reference harness ${name}`);
  };

  const run = runBody({key: 'pending', preview: current?.preview_id, setup: request.body, source: source?.source_sha256});
  const submit = async () => {
    keyRef.current = keyFor(keyRef.current, run.body, () => crypto.randomUUID());
    setSubmitting(true);
    setSubmitError(null);
    try {
      const {run: created} = await benchmarkApi.submit({...run.body, idempotency_key: keyRef.current.key});
      toast.success('Run queued');
      go({run: created.run_id});
    } catch (error) {
      const report = staleReport(error);
      if (report) setStale(report);
      else setSubmitError(error);
    } finally { setSubmitting(false); }
  };
  // The setup reviewed after a stale answer: a new preview is made.
  const reviewSetup = () => {
    setStale(null);
    setPreview(null);  // the stale one's preview_id would be refused again
    setPreviewError(null);
    setTick(count => count + 1);
  };

  const pickPlugin = value => { setPrefillNotice(''); setPluginId(value); setBenchmarkId(''); };
  const pickBenchmark = value => { setPrefillNotice(''); setBenchmarkId(value); };

  return (
    <div className={styles.newRun}>
      <h2>Benchmark Your Harness</h2>
      <p className={styles.fieldHint}>Choose a benchmark and upload the harness you want to test. The benchmark fixes the cases, model, endpoint, limits and prompts.</p>
      <section className={styles.section}>
        <h3 className={styles.sectionHeading}>Choose a benchmark</h3>
        {prefillNotice && <p className={styles.warn} role="alert">{prefillNotice}</p>}
        {apps.error && <p className={styles.error}>{apps.error}</p>}
        {apps.loading && !apps.data ? <LoadingSkeleton shape="block" height={60} /> : !(apps.data ?? []).length ? <p className={styles.emptyState}>No installed plugin has a benchmark task. Install a plugin from the Marketplace to get started.</p> : (
          <ChoiceList label="Plugin" description="The installed plugin whose benchmarks you want to run." options={apps.data.map(item => ({value: item.id, label: item.name ?? item.id, detail: `Installed version ${item.version}`}))} value={pluginId} onChange={pickPlugin} searchPlaceholder="Search plugins" />
        )}
        {benchmarks.error && <p className={styles.error}>{benchmarks.error}</p>}
        {pluginId && benchmarks.loading && <LoadingSkeleton shape="block" height={60} />}
        {pluginId && !benchmarks.loading && !benchmarks.error && !groups.length && <p className={styles.emptyState}>No benchmark is published for this plugin. <button type="button" className={styles.link} onClick={() => go({view: 'publish'})}>Create a benchmark</button></p>}
        <BenchmarkCards groups={groups} selectedId={benchmarkId} onSelect={pickBenchmark} />
        {detail.error && <p className={styles.error}>{detail.error}</p>}
      </section>
      <PrepareHarness benchmark={benchmark} />

      {benchmark && (
        <>
          <CaseSetView benchmark={benchmark} />

          <section className={styles.section}>
            <h3 className={styles.sectionHeading}>Harness</h3>
            <ChoiceList label="Harness mode" description="Choose the mode your harness supports. Both modes run the same cases and use the plugin’s verifier to score answers." options={POLICIES.map(([value, label, detail]) => ({value, label, detail}))} value={policy} onChange={setPolicy} />
            <p className={styles.fieldHint}>The harness is the program you’re testing. Upload its source ZIP with a <code>harness.yaml</code> at the root declaring its name, version and dialects.</p>
            <div className={styles.form}>
              <label>Harness source ZIP <input type="file" accept=".zip,application/zip" disabled={uploading || submitting} onChange={event => upload(event.target.files[0])} />
                <small aria-live="polite">{uploading ? 'Uploading…' : source ? `${source.name} · ${source.size.toLocaleString('en-US')} bytes` : ''}</small>
              </label>
              <label>Use a reference harness <select value={reference} disabled={uploading || submitting || !defaults.data} onChange={event => chooseReference(event.target.value)}>
                <option value="">Choose a reference harness</option>
                {(defaults.data?.reference_harnesses ?? []).map(name => <option key={name} value={name}>{name}</option>)}
              </select>
                <small>Built by NanoAgent on your computer, under its own name; its version follows its content.</small>
              </label>
            </div>
            {defaults.error && <p className={styles.error}>{defaults.error}</p>}
            {source && <dl className={styles.facts}>{harnessFacts(source).map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{value}</dd></React.Fragment>)}</dl>}
            {sourceError && <Failure failure={sourceError} />}
          </section>

          <h3>Run preview</h3>
          {previewError && <Failure failure={previewError} />}
          {previewError && <button type="button" className={styles.secondaryButton} onClick={() => setTick(count => count + 1)}>Retry preview</button>}
          {request.body && !current && !previewError && <p className={styles.muted}>Rendering the preview…</p>}
          {current && <Preview preview={current} />}
        </>
      )}

      {stale && (
        <section className={styles.stale} role="alert">
          <h4>The benchmark changed since the preview</h4>
          <ul>{stale.stale.map(item => <li key={item.name}>{item.text} (<code>{item.name}</code>)</li>)}</ul>
          {stale.current && <p className={styles.muted}>Now it resolves to {stale.current.cases.length} case{stale.current.cases.length === 1 ? '' : 's'} on {stale.current.endpoint_profile}, {stale.current.policy} policy.</p>}
          <p><button type="button" onClick={reviewSetup}>Review and preview again</button> Then run again: nothing was submitted.</p>
        </section>
      )}
      {submitError && <Failure failure={submitError} />}

      <div className={styles.actionBar}>
        <button type="button" className={styles.primaryButton} disabled={Boolean(run.error) || submitting || uploading} onClick={submit}>{submitting ? 'Starting benchmark…' : 'Run benchmark'}</button>
        {run.error && <span className={styles.muted}> {run.error}</span>}
      </div>
    </div>
  );
}
