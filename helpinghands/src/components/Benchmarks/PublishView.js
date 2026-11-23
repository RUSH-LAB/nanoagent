import React, {useEffect, useRef, useState} from 'react';
import market from '@site/src/pages/marketplace/styles.module.css';
import {jsonPost} from '../PluginFrame/host.js';
import {appManifest, benchmarkJson, runnerNotice} from './api';
import {previewCaseFile, publishProblem, splitCaseFolder, validBenchmarkName} from './caseFolder';
import {CaseList} from './Choice';
import CopyInstructions from './CopyInstructions';
import {countOf} from './runs';
import {useBenchmarkPlugins} from './PluginCards';
import useLoad from './useLoad';
import useUrlParam from './useUrlParam';
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
  useEffect(() => {
    let live = true;
    runnerNotice().then(next => live && setNotice(next));
    return () => { live = false; };
  }, []);

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
    <form className={publishStyles.form} onSubmit={submit}>
      {notice && notice.tone !== 'ok' && <div className={market.notice}>{notice.text}</div>}
      {!review && <>
        <div className={publishStyles.field}>
          <label htmlFor="benchmark-name">Benchmark name</label>
          <input id="benchmark-name" type="text" required disabled={state.busy} placeholder="e.g. my-benchmark" value={name} onChange={event => setName(event.target.value)} />
          <span>Use lowercase letters, numbers, dots, underscores, or hyphens.</span>
        </div>
        <div className={publishStyles.field}>
          <span className={publishStyles.fieldLabel}>Case folder</span>
          <label className={publishStyles.folderPicker}>
            <span className={publishStyles.folderIcon} aria-hidden="true">▱</span>
            <span className={publishStyles.folderText}><strong>{files.length ? 'Change folder' : 'Choose a folder'}</strong><span>{split && !split.error ? `${files[split.caseFile].name} · ${countOf(split.others.length, 'other file')}` : 'One YAML case file and any fixtures'}</span></span>
            <input type="file" disabled={state.busy} webkitdirectory="" aria-label="Case folder" onChange={event => setFiles([...event.target.files])} />
          </label>
        </div>
        {split?.error && <div className={market.error}>{split.error}</div>}
      </>}
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
          <div className={publishStyles.caseHeading}><strong>{one.case_id}</strong><span>{one.kind}</span></div>
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
            {published.created ? 'Published' : 'Already published'} <code>{published.benchmark.name}</code>, {countOf(published.benchmark.cases.length, 'case')}, for version {published.benchmark.plugin.version}.{' '}
            <a href={`?${new URLSearchParams({benchmark: published.benchmark.benchmark_id})}`}>Open it to run agents →</a>
          </p>
          <CaseList cases={published.benchmark.cases} />
        </div>
      )}
    </form>
  );
}

/** One plugin's screen: the instructions for its case folder, then the form. */
function PublishPlugin({plugin}) {
  // The plugin's tasks and their input schemas come from its manifest, which the app list does not carry.
  const manifest = useLoad(() => appManifest(plugin.id), [plugin.id]);
  return (
    <>
      <div className={publishStyles.page}>
      <section className={publishStyles.panel}>
        <div className={publishStyles.panelHeading}><span className={publishStyles.stepNumber}>1</span><div><h2>Prepare your cases</h2><p>Create a case folder for {plugin.name}.</p></div></div>
        {manifest.error && <div className={market.error}>{manifest.error}</div>}
        {manifest.loading && <p>Reading the plugin&apos;s tasks…</p>}
        {manifest.data && !manifest.data.tasks.length && <p>{plugin.name} declares no task to benchmark.</p>}
        {manifest.data?.tasks.length > 0 && <CopyInstructions plugin={manifest.data} />}
      </section>
      {manifest.data?.tasks.length > 0 && <section className={publishStyles.panel}><div className={publishStyles.panelHeading}><span className={publishStyles.stepNumber}>2</span><div><h2>Publish benchmark</h2><p>Name your benchmark and select its case folder.</p></div></div><PublishForm plugin={manifest.data} /></section>}
      </div>
    </>
  );
}

/** New benchmark: the plugin it is for (`?plugin=`), then that plugin's instructions and form. */
export default function PublishView() {
  const {apps, error} = useBenchmarkPlugins();
  const [pluginId, setPluginId] = useUrlParam('plugin');
  const plugin = apps?.find(app => app.id === pluginId);
  return (
    <>
      <header className={publishStyles.head}>
        <h1>New benchmark</h1>
        <p>A benchmark is a set of cases for one task of a plugin. Anyone with the plugin can then run agents on it.</p>
      </header>
      {error && <div className={market.error}>{error}</div>}
      {!apps ? <p>Reading your plugins…</p> : !apps.length ? <p>No installed plugin is ready to benchmark. Install one from the Marketplace.</p> : (
        <label className={publishStyles.pluginField}>
          <span>Plugin</span>
          <span className={publishStyles.pluginSelect}>
            {plugin && <img src={plugin.product.icon} alt="" />}
            <select value={plugin ? plugin.id : ''} onChange={event => setPluginId(event.target.value || null)}>
              <option value="">Choose a plugin</option>
              {apps.map(app => <option key={app.id} value={app.id}>{app.name} v{app.version}</option>)}
            </select>
          </span>
        </label>
      )}
      {pluginId && apps && !plugin && <div className={market.error} role="alert">The plugin &quot;{pluginId}&quot; in the address is not installed or not ready to publish for.</div>}
      {plugin && <PublishPlugin key={plugin.id} plugin={plugin} />}
    </>
  );
}
