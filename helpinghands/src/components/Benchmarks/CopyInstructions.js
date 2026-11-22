import React, {useState} from 'react';
import {ANSWER_FILE_TEXT, CASE_FILE_FIELDS, FOLDER_LAYOUT, aiInstructions, exampleCaseFile, inputFields, publishEffect, publishRules} from './instructions';
import styles from './publish.module.css';
import tableStyles from './styles.module.css';

/** A View Docs button that shows the docs for the case folder, and a Copy Docs button that copies them for an AI. */
export default function CopyInstructions({plugin}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({plugin: null, error: null});
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(aiInstructions(plugin));
      setState({plugin: plugin.id, error: null});
    } catch (failure) {
      setState({plugin: null, error: `Could not copy the instructions: ${failure.message}`});
    }
  };
  return (
    <div className={styles.instructions}>
      <p>Use the documentation to create a YAML case file and any fixtures. You can also copy it to ask an AI for help.</p>
      <div className={styles.actions}>
        <button type="button" className="button button--secondary" aria-expanded={open} aria-controls="case-docs" onClick={() => setOpen(!open)}>{open ? 'Hide Docs' : 'View Docs'}</button>
      </div>
      {open && <div id="case-docs" className={styles.docsPanel}>
        <div className={styles.docsToolbar}>
          <span>Case folder documentation</span>
          <button type="button" className={styles.copyDocs} onClick={copy} aria-label="Copy docs" title="Copy docs">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
          </button>
        </div>
        {state.plugin === plugin.id && <p className={styles.copyStatus} role="status">Docs copied</p>}
        {state.error && <p className={styles.copyStatus} role="alert">{state.error}</p>}
        <div className={styles.docs} tabIndex={0} aria-label="Case folder documentation"><Docs plugin={plugin} /></div>
      </div>}
    </div>
  );
}

/** The case folder's layout, the case file's keys, the answer, each task's arguments, an example and the rules. */
function Docs({plugin}) {
  return (
    <>
      <h3>Folder</h3>
      <p>The top level holds exactly one case file (<code>.yaml</code> or <code>.yml</code>). Every other file is a fixture a case can name. <code>.DS_Store</code> is ignored.</p>
      <pre className={styles.layout}>{FOLDER_LAYOUT}</pre>

      <h3>Case file</h3>
      <p>A YAML mapping with these keys and no others.</p>
      <div className={styles.scroll}>
        <table className={tableStyles.table}>
          <thead><tr><th>Key</th><th>Required</th><th>What it is</th></tr></thead>
          <tbody>
            {CASE_FILE_FIELDS.map(field => <tr key={field.key}><td><code>{field.key}</code></td><td>{field.required}</td><td>{field.text}</td></tr>)}
            <tr><td colSpan={3}><code>plugin</code> is <code>{plugin.id}</code> ({plugin.name}, version {plugin.version}).</td></tr>
          </tbody>
        </table>
      </div>

      <h3>Answer</h3>
      <p>{ANSWER_FILE_TEXT}</p>

      <h3>Tasks and their arguments</h3>
      <p>Pick one task id for <code>task</code>. Each case&apos;s <code>arguments</code> takes that task&apos;s input fields.</p>
      {plugin.tasks.map(task => {
        const fields = inputFields(task);
        return (
          <div key={task.id}>
            <p><code>{task.id}</code>{task.description && `: ${task.description}`}</p>
            {fields.length
              ? <div className={styles.scroll}>
                <table className={tableStyles.table}>
                  <thead><tr><th>Argument</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
                  <tbody>{fields.map(field => <tr key={field.name}><td><code>{field.name}</code></td><td>{field.type}</td><td>{field.required ? 'required' : 'optional'}</td><td>{field.description}</td></tr>)}</tbody>
                </table>
              </div>
              : <p className={tableStyles.muted}>No input fields: <code>arguments</code> is <code>{'{}'}</code>.</p>}
          </div>
        );
      })}

      <h3>Example</h3>
      <pre className={styles.layout}>{exampleCaseFile(plugin)}</pre>

      <details>
        <summary>Rules the publish checks</summary>
        <ul>{publishRules(plugin).map(rule => <li key={rule}>{rule}</li>)}</ul>
      </details>
      <p>{publishEffect(plugin)}</p>
    </>
  );
}
