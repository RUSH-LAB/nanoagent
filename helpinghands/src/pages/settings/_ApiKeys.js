import React, {useCallback, useEffect, useState} from 'react';
import {apiRequest} from '@site/src/utils/api';
import styles from './styles.module.css';
import ai from './ai.module.css';

// The one key members add: OpenRouter's, which reaches every model they choose from.
const KEY = {env: 'OPENROUTER_API_KEY', label: 'OpenRouter'};

/**
 * Settings → AI → API key: the OpenRouter key your AI runs with. While Mochi
 * Lab is connected it goes down Mochi Lab's connection (server/runner.js) and
 * is kept on your computer only; otherwise Mochi keeps it, encrypted
 * (postgres/member-keys.js), and runs your AI on its own NanoAgent with it.
 * This page learns whether it is set, never the key. Runs use it as soon as it
 * is saved; `onSaved` lets the pane show it.
 */
export default function ApiKeys({computer, onSaved}) {
  const connected = Boolean(computer?.connected);
  const [kept, setKept] = useState(null);
  const [value, setValue] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [state, setState] = useState(null);
  const loadKept = useCallback(() => apiRequest('/api/ai/keys')
    .then(value => setKept(value.keys))
    .catch(err => setState({error: err.message})), []);
  useEffect(() => { loadKept(); }, [loadKept]);
  const key = (connected ? computer.keys : kept)?.find(entry => entry.env === KEY.env);
  const saved = Boolean(key?.set);

  const save = async changes => {
    setState({saving: true});
    try {
      await apiRequest(connected ? '/api/runner/keys' : '/api/ai/keys', {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({changes}),
      });
      setValue('');
      setReplacing(false);
      await Promise.all([onSaved(), connected ? null : loadKept()]);
      setState(null);
    } catch (err) {
      setState({error: err.message});
    }
  };

  const busy = state?.saving;
  const editing = (connected || kept) && (!saved || replacing);
  // Under the row's name: what is happening to the key, or where it is kept.
  const note = state?.error ? <span className={styles.error} role="alert">{state.error}</span>
    : busy ? 'Saving…'
      : !saved ? 'Your AI runs with it.'
        : connected ? `Kept on ${computer.device ?? 'your computer'}`
          : 'Kept by Mochi, encrypted';
  return (
    <form
      className={styles.row}
      onSubmit={event => {
        event.preventDefault();
        if (value.trim()) save({[KEY.env]: value.trim()});
      }}
    >
      <label className={styles.rowLabel} htmlFor="ai-openrouter-key">
        <strong>{KEY.label} key</strong>
        <span role="status">{note}</span>
      </label>
      <div className={styles.rowControl}>
        {editing ? (
          <>
            <input
              id="ai-openrouter-key"
              className={`${styles.input} ${ai.keyInput}`}
              type="password"
              value={value}
              onChange={event => setValue(event.target.value)}
              placeholder={replacing ? 'Paste the new key' : 'Paste your key'}
              autoComplete="off"
              spellCheck={false}
              autoFocus={replacing}
              disabled={busy}
            />
            <button type="submit" className={styles.primaryButton} disabled={busy || !value.trim()}>Save</button>
            {replacing && (
              <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => { setReplacing(false); setValue(''); }}>
                Cancel
              </button>
            )}
          </>
        ) : saved && (
          <>
            <code className={ai.keyHint}>{key.hint ?? '…'}</code>
            <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => setReplacing(true)}>Replace</button>
            <button type="button" className={ai.linkButton} disabled={busy} onClick={() => save({[KEY.env]: null})}>Remove</button>
          </>
        )}
      </div>
    </form>
  );
}
