import React, {useEffect, useState} from 'react';
import {apiRequest} from '@site/src/utils/api';
import styles from './styles.module.css';
import ai from './ai.module.css';

// The one key members add: OpenRouter's, which reaches every model they choose from.
const KEY = {env: 'OPENROUTER_API_KEY', label: 'OpenRouter'};

/**
 * Settings → AI → API key: the OpenRouter key Mochi Lab runs your AI with on
 * your own computer. It goes down Mochi Lab's connection (server/runner.js)
 * and is kept there only; this page learns whether it is set, never the key.
 * Runs use it as soon as it is saved; `onSaved` lets the pane show it.
 */
export default function ApiKeys({computer, onSaved}) {
  const key = computer?.keys?.find(entry => entry.env === KEY.env);
  const saved = Boolean(key?.set);
  const [value, setValue] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [state, setState] = useState(null);
  // What the key on the computer has spent, as OpenRouter says; asked again when the key changes.
  const [credit, setCredit] = useState(null);
  const hint = saved ? key.hint : null;
  useEffect(() => {
    setCredit(null);
    if (!hint) return;
    apiRequest('/api/runner/credit').then(value => setCredit(value.credit)).catch(() => setCredit(null));
  }, [hint]);

  const save = async changes => {
    setState({saving: true});
    try {
      await apiRequest('/api/runner/keys', {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({changes}),
      });
      setValue('');
      setReplacing(false);
      await onSaved();
      setState(null);
    } catch (err) {
      setState({error: err.message});
    }
  };

  const connected = Boolean(computer?.connected);
  const busy = state?.saving;
  const editing = connected && (!saved || replacing);
  // Under the row's name: what is happening to the key; nothing once it is saved. A member whose
  // plugins run in RUSH Lab cloud runs them on the lab's key (server/cloud-runs.js).
  const note = !connected && computer?.runner === 'cloud' ? 'Your plugins run in RUSH Lab cloud, on the lab\'s own key, within your workspace\'s AI budget.'
    : !connected ? 'Install RUSH Lab on your computer to add it.'
    : state?.error ? <span className={styles.error} role="alert">{state.error}</span>
      : busy ? 'Saving…'
        : saved ? null
          : 'Your AI runs with it.';
  return (
    <form
      className={`${styles.row} ${ai.keyRow}`}
      onSubmit={event => {
        event.preventDefault();
        if (value.trim()) save({[KEY.env]: value.trim()});
      }}
    >
      <label className={styles.rowLabel} htmlFor="ai-openrouter-key">
        <strong>{KEY.label} key</strong>
        {note && <span role="status">{note}</span>}
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
        ) : saved ? (
          <>
            <code className={ai.keyHint}>{key.hint ?? '…'}</code>
            <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => setReplacing(true)}>Replace</button>
            <button type="button" className={ai.linkButton} disabled={busy} onClick={() => save({[KEY.env]: null})}>Remove</button>
          </>
        ) : (
          <input id="ai-openrouter-key" className={`${styles.input} ${ai.keyInput}`} placeholder="Paste your key" disabled />
        )}
      </div>
      {credit && !editing && <Spend {...credit} />}
    </form>
  );
}

const money = value => `$${value.toFixed(2)}`;

/**
 * What the key's spend is: the cap's bar, what everyone has spent filling it and the member's
 * own part of that marked in it; the amounts alone for a key without a cap.
 */
function Spend({you, total: {used, cap}}) {
  const line = `You: ${money(you)} · Total: ${money(used)}${cap == null ? '' : ` of ${money(cap)}`} used`;
  if (cap == null) return <div className={ai.credit}>{line}</div>;
  const share = value => `${cap > 0 ? (Math.min(value, cap) / cap) * 100 : 100}%`;
  return (
    <div className={ai.credit}>
      <div
        className={ai.creditBar}
        role="meter"
        aria-label="OpenRouter spend against the cap"
        aria-valuemin={0}
        aria-valuemax={cap}
        aria-valuenow={Math.min(used, cap)}
      >
        <div className={ai.creditUsed} style={{width: share(used)}}>
          <div className={ai.creditYours} style={{width: used > 0 ? `${(Math.min(you, used) / used) * 100}%` : '0%'}} />
        </div>
      </div>
      <span>{line}</span>
    </div>
  );
}
