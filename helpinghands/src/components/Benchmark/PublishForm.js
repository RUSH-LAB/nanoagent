import React, {useRef, useState} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import {toast} from '@site/src/components/Toast/toast';
import LoadingSkeleton from '@site/src/components/LoadingSkeleton';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';
import {benchmarkApi} from './api';
import ChoiceList from './ChoiceList';
import CopyInstructions from './CopyInstructions';
import Failure from './Failure';
import {
  LIMIT_LABELS, caseFileExample, caseFileFields, caseInstructions, defaultPrompt, limitNames, limitOverrides, limitsFormOf, parseCases, promptText, publishText, publishable,
  publishedLines, taskOf, withPromptEdit,
} from './publish';
import {POLICIES} from './newRun';
import useLoad from './useLoad';
import styles from './styles.module.css';

function Published({result, go}) {
  const {headline, facts} = publishedLines(result);
  const {benchmark} = result;
  return (
    <section className={styles.section}>
      <h3>{headline}</h3>
      <dl className={styles.facts}>{facts.map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd><code>{value}</code></dd></React.Fragment>)}</dl>
      <button type="button" className={styles.primaryButton} onClick={() => go({view: 'new', plugin: benchmark.plugin.id, benchmark: benchmark.benchmark_id})}>Run this benchmark</button>
    </section>
  );
}

export default function PublishBenchmark({go}) {
  const {slug} = useWorkspaceSite();
  const marketplace = `/w/${encodeURIComponent(slug)}/marketplace`;
  const loaded = useLoad(() => benchmarkApi.apps().then(publishable), []);
  const defaults = useLoad(() => benchmarkApi.defaults(), []);
  const apps = loaded.data ?? [];
  const [pluginId, setPluginId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [caseText, setCaseText] = useState('');
  const [cases, setCases] = useState(null);
  const [casesName, setCasesName] = useState('');
  const [casesError, setCasesError] = useState(null);
  const [reading, setReading] = useState(false);
  const caseRead = useRef(0);
  const [model, setModel] = useState('deepseek/deepseek-v4-flash-0731');
  const [endpoint, setEndpoint] = useState('');
  const [edits, setEdits] = useState({});
  const [limitsForm, setLimitsForm] = useState(null);
  const [name, setName] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [failure, setFailure] = useState(null);
  const [published, setPublished] = useState(null);

  const base = defaults.data;
  const app = apps.find(candidate => candidate.id === pluginId) ?? null;
  const task = taskOf(app, taskId);
  const endpoints = base?.endpoints ?? [];
  // The first endpoint and server limits apply until the member changes them.
  const limits = limitsForm ?? (base ? limitsFormOf(base) : null);
  const effectiveEndpoint = endpoint || endpoints[0]?.label || '';
  const capabilities = endpoints.find(item => item.label === effectiveEndpoint)?.capabilities ?? null;

  const readCases = async file => {
    const read = ++caseRead.current;
    setPublished(null);
    setCases(null);
    setCaseText('');
    setCasesName('');
    setCasesError(null);
    setReading(Boolean(file));
    if (!file) return;
    try {
      const text = await file.text();
      if (caseRead.current !== read) return;
      const parsed = parseCases(text);
      setCaseText(text);
      setCases(parsed.error ? null : parsed);
      setCasesName(file.name);
      setCasesError(parsed.error ?? null);
    } catch (error) {
      if (caseRead.current === read) setCasesError(`Could not read the case file: ${error.message}`);
    } finally {
      if (caseRead.current === read) setReading(false);
    }
  };

  const request = !base ? {error: 'Loading the defaults'} : publishText({
    app, taskId, caseText, cases, name, model, endpoint: effectiveEndpoint, limits: limitOverrides(limits, base), edits,
  });
  const publish = async () => {
    setFailure(null);
    setPublished(null);
    setPublishing(true);
    try {
      const result = await benchmarkApi.publish(request.body);
      setPublished(result);
      toast.success(result.created ? 'Benchmark published' : 'Benchmark already published');
    } catch (error) { setFailure(error); }
    finally { setPublishing(false); }
  };
  const edited = () => setPublished(null);

  return (
    <div className={styles.newRun}>
      <h2>Create Plugin Benchmark</h2>
      <p className={styles.muted}>Choose an installed plugin task and publish a benchmark: its cases, model, endpoint, prompts and limits. Others run their harnesses on it and compare.</p>
      {loaded.error && <p className={styles.error} role="alert">{loaded.error}</p>}
      {defaults.error && <p className={styles.error} role="alert">{defaults.error}</p>}

      <section className={styles.section}>
        <h3 className={styles.sectionHeading}>Choose a plugin and task</h3>
        <p>Choose a task from an installed plugin. If you're making your own, use the instructions below, then <Link to={`${marketplace}?view=publish`}>publish your plugin</Link> and <Link to={marketplace}>install it</Link> in the Marketplace.</p>
        {loaded.loading && !loaded.data ? <LoadingSkeleton shape="block" height={60} /> : !apps.length ? <p className={styles.emptyState}>No installed plugins with tasks yet.</p> : <>
          <ChoiceList label="Plugin" options={apps.map(item => ({value: item.id, label: item.name ?? item.id, detail: `${item.id} · installed v${item.version}`}))} value={pluginId} onChange={value => { setPluginId(value); setTaskId(''); setEdits({}); edited(); }} searchPlaceholder="Search plugins" />
          {app && <p className={styles.fieldHint}>The benchmark is pinned to the installed version, v{app.version}. Benchmarks of other versions are separate.</p>}
          {app && <ChoiceList label="Task" options={app.tasks.map(item => ({value: item.id, label: item.id, detail: item.description}))} value={taskId} onChange={value => { setTaskId(value); setEdits({}); edited(); }} />}
        </>}
        <CopyInstructions subject="plugin and case file" text={caseInstructions(app, task)} />
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionHeading}>Add a case file</h3>
        <p>Upload a JSON file with examples the harness should answer or refuse. Include both arrays and at least one case.</p>
        <details className={styles.advanced}>
          <summary>Case file format</summary>
          <ul>
            {caseFileFields.map(([field, meaning]) => <li key={field}><code>{field}</code> — {meaning}</li>)}
          </ul>
          <p className={styles.fieldHint}>This example adds two nonnegative integers. A negative integer fits the input schema, then the reference tool rejects it. Replace the example IDs and inputs with your task’s.</p>
          <pre>{caseFileExample()}</pre>
        </details>
        <label>Case file <input type="file" accept=".json,application/json" disabled={publishing} onChange={event => readCases(event.target.files[0])} /></label>
        {reading && <p role="status">Reading the case file…</p>}
        {casesError && <p className={styles.error} role="alert">{casesError}</p>}
        {cases && <p className={styles.muted}>{casesName}: {cases.plugin} / {cases.task}, {cases.answer} to answer, {cases.refuse} to refuse</p>}
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionHeading}>Model, endpoint and prompts</h3>
        <p className={styles.fieldHint}>Every harness run of this benchmark uses these. The runner chooses only Coding or Task tools.</p>
        <div className={styles.form}>
          <label>Model <input value={model} placeholder="vendor/model" onChange={event => { setModel(event.target.value); edited(); }} /><small className={styles.fieldHint}>The model the harness calls. DeepSeek V4 Flash is the default.</small></label>
        </div>
        {base && !endpoints.length && <p className={styles.warn}>No benchmark worker is available right now.</p>}
        {endpoints.length > 0 && <ChoiceList label="Endpoint" description="The worker connection every run uses." options={endpoints.map(item => ({value: item.label, label: item.label}))} value={effectiveEndpoint} onChange={value => { setEndpoint(value); edited(); }} />}
        {POLICIES.map(([policy, label]) => {
          const fallback = defaultPrompt(policy, base, task);
          return (
            <section key={policy} className={styles.task}>
              <h4>{policy === 'coding' ? 'Coding template' : 'Task tools instructions'}</h4>
              <p className={styles.muted}>
                {policy === 'coding'
                  ? <>The prompt a {label} harness receives. Placeholders: {(base?.placeholders ?? []).map(item => <code key={item}>{`{${item}} `}</code>)}</>
                  : 'The instructions a Task tools harness receives. They start from the plugin’s.'}
                {edits[policy] != null && <span className={styles.badge}>Edited</span>}
              </p>
              <textarea rows={8} value={promptText(edits, policy, fallback)} onChange={event => { setEdits(withPromptEdit(edits, policy, event.target.value, fallback)); edited(); }} aria-label={policy === 'coding' ? 'Coding prompt template' : 'Task tools instructions'} />
              <button type="button" className={styles.secondaryButton} disabled={edits[policy] == null} onClick={() => { setEdits({...edits, [policy]: null}); edited(); }}>Reset to default</button>
            </section>
          );
        })}
      </section>

      <details className={clsx(styles.section, styles.advanced)}>
        <summary>Limits and internet access</summary>
        <p className={styles.muted}>Every limit is pinned with the benchmark and shown with its results. Defaults come from the server; a worker applies no more than its maximum.</p>
        <div className={styles.form}>
          {base && limitNames(base).map(item => (
            <label key={item} className={clsx({[styles.differs]: String(base.limits[item]) !== limits.values[item]})}>{LIMIT_LABELS[item]}
              <input inputMode="decimal" value={limits.values[item]} onChange={event => { setLimitsForm({...limits, values: {...limits.values, [item]: event.target.value}}); edited(); }} />
              <small className={styles.muted}>default {String(base.limits[item])}{capabilities ? `, worker maximum ${String(capabilities[item])}` : ''}</small>
            </label>
          ))}
          {limits && <label><input type="checkbox" checked={limits.internet} onChange={event => { setLimitsForm({...limits, internet: event.target.checked}); edited(); }} /> {LIMIT_LABELS.internet_access}
            <small className={styles.muted}> the harness container may reach the public internet; runs with it are marked unverified egress</small>
          </label>}
        </div>
      </details>

      <section className={styles.section}>
        <h3 className={styles.sectionHeading}>Name and publish</h3>
        <p className={styles.fieldHint}>Publishing checks your inputs and saves the private reference data. The plugin’s deterministic verifier scores each run. A published benchmark never changes.</p>
        <div className={styles.form}><label>Benchmark name <input value={name} placeholder="e.g. classroom-v1" onChange={event => { setName(event.target.value); edited(); }} /></label></div>
        <p className={styles.fieldHint}>Use up to 128 lowercase letters, digits, periods, underscores or hyphens. Start with a letter or digit. The name is unique per plugin version.</p>
        {failure && <Failure failure={failure} />}
        <div className={styles.actionBar}><button type="button" className={styles.primaryButton} disabled={Boolean(request.error) || publishing} onClick={publish}>Publish benchmark</button>
          {publishing ? <span className={styles.muted}>Checking and publishing cases…</span> : request.error && <span className={styles.muted}>{request.error}</span>}</div>
      </section>
      {published && <Published result={published} go={go} />}
    </div>
  );
}
