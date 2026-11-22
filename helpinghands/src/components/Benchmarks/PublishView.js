import React, {useEffect, useRef, useState} from 'react';
import market from '@site/src/pages/marketplace/styles.module.css';
import {workerNotice} from '../PluginFrame/worker.js';
import {appManifest, benchmarkJson, jsonPost, runnerStatus} from './api';
import {previewCaseFile, publishProblem, splitCaseFolder, validBenchmarkName} from './caseFolder';
import {CaseList, Step} from './Choice';
import CopyInstructions from './CopyInstructions';
import {countOf} from './runs';
import PluginCards, {PluginHeader, useBenchmarkPlugins} from './PluginCards';
import useLoad from './useLoad';
import useUrlParam from './useUrlParam';
import styles from './styles.module.css';
import publishStyles from './publish.module.css';

const readBase64 = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',', 2)[1]);
  reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
  reader.readAsDataURL(file);
});

/** Publish `files` (the picked case folder) as benchmark `name` of `plugin`: the benchmark with the cases RUSH kept. */
async function publish({plugin, name, files, split, caseText}) {
  const others = await Promise.all(split.others.map(async one => [one.path, await readBase64(files[one.index])]));
  // The server has the member's computer run the plugin's reference tool on each case, which takes a while.
  const {created, benchmark} = await benchmarkJson('/benchmarks/pinned', jsonPost({
    name, plugin_id: plugin.id, case_file: caseText, files: Object.fromEntries(others),
  }));
  return {created, benchmark: (await benchmarkJson(`/benchmarks/${benchmark.benchmark_id}`)).benchmark};
}

function PublishForm({plugin}) {
  const [name, setName] = useState('');
  const [files, setFiles] = useState([]);
  const [state, setState] = useState({busy: false, error: null, published: null});
  const [notice, setNotice] = useState(null);
  const [review, setReview] = useState(null);
  const reviewHeading = useRef(null);
  useEffect(() => { if (review) reviewHeading.current?.focus(); }, [review]);
  const split = files.length ? splitCaseFolder(files.map(file => file.webkitRelativePath)) : null;
  useEffect(() => { runnerStatus().then(status => setNotice(workerNotice(status))); }, []);

  const submit = async event => {
    event.preventDefault();
    if (!validBenchmarkName(name.trim())) return setState({busy: false, error: {text: 'Use a name of up to 128 lowercase letters, digits, dots, underscores or hyphens, starting with a letter or digit.'}, published: null});
    if (!split || split.error) return setState({busy: false, error: {text: split?.error ?? 'Pick the case folder first.'}, published: null});
    setState({busy: true, error: null, published: null});
    try {
      if (!review) {
        const caseText = await files[split.caseFile].text();
        const preview = previewCaseFile(caseText, plugin, split.others.map(one => one.path));
        setReview({caseText, ...preview});
        setState({busy: false, error: null, published: null});
      } else {
        const published = await publish({plugin, name: name.trim(), files, split, caseText: review.caseText});
        setState({busy: false, error: null, published});
      }
    } catch (failure) {
      setState({busy: false, error: publishProblem(failure.message), published: null});
    }
  };
  const {published} = state;
  return (
    <form className={styles.form} onSubmit={submit}>
      {notice && notice.tone !== 'ok' && <div className={market.notice}>{notice.text}</div>}
      {!review && <><label>
        Name
        <input type="text" required disabled={state.busy} placeholder="lowercase letters, digits, . _ -" value={name} onChange={event => setName(event.target.value)} />
      </label>
      <label>
        Case folder
        <input type="file" disabled={state.busy} webkitdirectory="" aria-label="Case folder" onChange={event => setFiles([...event.target.files])} />
        <span className={styles.muted}>
          {split && !split.error
            ? `${files[split.caseFile].name} and ${countOf(split.others.length, 'other file')}.`
            : 'The folder with the case file (.yaml) at its top level and its fixtures beside it.'}
        </span>
      </label>
      {split?.error && <div className={market.error}>{split.error}</div>}</>}
      {review && !published && <section className={publishStyles.review} aria-labelledby="review-heading">
        <h3 id="review-heading" ref={reviewHeading} tabIndex={-1}>Review cases</h3>
        <p>Check the cases before publishing. RUSH will validate them and pin the answers on your computer.</p>
        <dl className={publishStyles.summary}>
          <div><dt>Benchmark</dt><dd>{name.trim()}</dd></div>
          <div><dt>Task</dt><dd><code>{review.task}</code></dd></div>
          <div><dt>Case file</dt><dd>{files[split.caseFile].name}</dd></div>
          <div><dt>Cases</dt><dd>{review.cases.length} total · {review.cases.filter(one => one.kind === 'answer').length} answer · {review.cases.filter(one => one.kind === 'refuse').length} refuse</dd></div>
        </dl>
        {review.cases.map(one => <div className={publishStyles.reviewCase} key={one.case_id}>
          <strong>{one.case_id}</strong> · {one.kind}
          <pre>{one.prompt}</pre>
          <details><summary>Arguments</summary><pre>{JSON.stringify(one.arguments, null, 2)}</pre></details>
          <p>Fixtures: {one.fixturePath == null ? 'None' : one.fixturePath}</p>
          {one.fixtureFiles.length > 0 && <ul>{one.fixtureFiles.map(path => <li key={path}><code>{path}</code></li>)}</ul>}
          {one.expected_error && <p>Expected error: {one.expected_error}</p>}
        </div>)}
      </section>}
      {!published && <div className={publishStyles.actions}>
        {review && <button type="button" className="button button--secondary" disabled={state.busy} onClick={() => { setReview(null); setState({busy: false, error: null, published: null}); }}>Back to edit</button>}
        <button type="submit" className="button button--primary" disabled={state.busy}>
          {state.busy ? (review ? 'Pinning the cases on your computer…' : 'Reading the case folder…') : (review ? 'Publish' : 'Review cases')}
        </button>
      </div>}
      {state.error && (
        <div className={market.error} role="alert">
          {state.error.caseId && <strong>Case {state.error.caseId}: </strong>}
          {state.error.text}
        </div>
      )}
      {published && (
        <div role="status">
          <p>
            {published.created ? 'Published' : 'Already published'} <code>{published.benchmark.name}</code>, {countOf(published.benchmark.cases.length, 'case')}, for version {published.benchmark.plugin.version}. RUSH kept:
          </p>
          <CaseList cases={published.benchmark.cases} />
        </div>
      )}
    </form>
  );
}

/** One plugin's screen: the instructions for its case folder, then the form. */
function PublishPlugin({plugin, onBack}) {
  // The plugin's tasks and their input schemas come from its manifest, which the app list does not carry.
  const manifest = useLoad(() => appManifest(plugin.id), [plugin.id]);
  return (
    <>
      <PluginHeader plugin={plugin} back="Publish Benchmark" onBack={onBack} />
      <Step title="Instructions">
        {manifest.error && <div className={market.error}>{manifest.error}</div>}
        {manifest.loading && <p>Reading the plugin&apos;s tasks…</p>}
        {manifest.data && !manifest.data.tasks.length && <p>{plugin.name} declares no task to benchmark.</p>}
        {manifest.data?.tasks.length > 0 && <CopyInstructions plugin={manifest.data} />}
      </Step>
      {manifest.data?.tasks.length > 0 && <Step title="Publish"><PublishForm plugin={manifest.data} /></Step>}
    </>
  );
}

/** Publish Benchmark: the plugin list, then the picked plugin's own screen (`?plugin=`). */
export default function PublishView() {
  const {apps, error} = useBenchmarkPlugins();
  const [pluginId, setPluginId] = useUrlParam('plugin');
  const plugin = apps?.find(app => app.id === pluginId);
  if (plugin) return <PublishPlugin key={plugin.id} plugin={plugin} onBack={() => setPluginId(null)} />;
  return (
    <>
      <header className={market.header}><h1>Publish Benchmark</h1></header>
      {error && <div className={market.error}>{error}</div>}
      <PluginCards apps={apps} onPick={app => setPluginId(app.id)} />
    </>
  );
}
