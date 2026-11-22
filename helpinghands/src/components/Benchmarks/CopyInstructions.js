import React, {useState} from 'react';
import {aiInstructions} from './instructions';
import styles from './publish.module.css';

/** Brief directions and a button that copies the full instructions for an AI. */
export default function CopyInstructions({plugin}) {
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
      <button type="button" className={styles.copy} onClick={copy} aria-label="Copy instructions for AI" title="Copy instructions for AI">
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
      </button>
      <p>Create a folder with one YAML case file and any fixture files your cases need. Copy the instructions to ask an AI to help create it.</p>
      {state.plugin === plugin.id && <span role="status">Instructions copied</span>}
      {state.error && <p role="alert">{state.error}</p>}
    </div>
  );
}
