import React, {useState} from 'react';
import {apiRequest} from '@site/src/utils/api';
import styles from './styles.module.css';
import ai from './ai.module.css';

// The engines a member's own server may run, by NanoAgent's name (server/ai-settings.js
// SERVER_PROVIDERS), with the keys RUSH Lab keeps for each on their computer (runner/lab.mjs).
export const SERVERS = [
  {id: 'vllm', name: 'vLLM', url: 'VLLM_BASE_URL', key: 'VLLM_API_KEY', example: 'http://127.0.0.1:8000/v1'},
  {id: 'sglang', name: 'SGLang', url: 'SGLANG_BASE_URL', key: 'SGLANG_API_KEY', example: 'http://127.0.0.1:30000/v1'},
];

/**
 * Settings → AI → Your servers: a vLLM or SGLang server of the member's own, its OpenAI-compatible
 * /v1 address and the key it was started with (--api-key), if any. Both go down RUSH Lab's
 * connection (server/runner.js) and are kept on their computer only; this page learns the address
 * and whether a key is set, never the key. `listing` (/api/ai/models) says what each server serves
 * now, or why it cannot say. Removing the server their model is on calls `onRemoved(engine)`.
 */
export default function Servers({computer, listing, onSaved, onRemoved}) {
  return SERVERS.map(server => (
    <Server key={server.id} server={server} computer={computer} listing={listing} onSaved={onSaved} onRemoved={onRemoved} />
  ));
}

function Server({server, computer, listing, onSaved, onRemoved}) {
  const keys = computer?.keys ?? [];
  const address = keys.find(entry => entry.env === server.url);
  const key = keys.find(entry => entry.env === server.key);
  const saved = Boolean(address?.set);
  const [replacing, setReplacing] = useState(false);
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [state, setState] = useState(null);
  const provider = listing?.providers?.find(entry => entry.id === server.id);
  const served = (listing?.models ?? []).filter(model => model.provider === server.id);

  const save = async changes => {
    setState({saving: true});
    try {
      await apiRequest('/api/runner/keys', {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({changes}),
      });
      setUrl('');
      setSecret('');
      setReplacing(false);
      if (changes[server.url] === null) await onRemoved(server.id);
      await onSaved();
      setState(null);
    } catch (err) {
      setState({error: err.message});
    }
  };

  const connected = Boolean(computer?.connected);
  // An older RUSH Lab holds no server's address.
  const held = Boolean(address && key);
  const busy = state?.saving;
  const editing = connected && held && (!saved || replacing);
  const id = `ai-server-${server.id}`;
  const status = !connected ? 'Install RUSH Lab on your computer to add one.'
    : !held ? 'Update RUSH Lab on your computer to add one: it updates itself once nothing runs.'
      : state?.error ? <span className={styles.error} role="alert">{state.error}</span>
        : busy ? 'Saving…'
          : !saved || replacing ? `Your own models, from its OpenAI-compatible /v1 address, and its key if it was started with --api-key.`
            : provider?.error ? <span className={styles.error} role="alert">{provider.error}</span>
              : served.length ? `Serves ${served.map(model => model.model).join(', ')}${provider?.tools === false ? '. Apps need it started with --tool-call-parser.' : ''}`
                : null;
  return (
    <form
      className={`${styles.row} ${ai.keyRow}`}
      onSubmit={event => {
        event.preventDefault();
        if (url.trim()) save({[server.url]: url.trim(), [server.key]: secret.trim() || null});
      }}
    >
      <label className={styles.rowLabel} htmlFor={id}>
        <strong>{server.name} server</strong>
        {status && <span role="status">{status}</span>}
      </label>
      <div className={`${styles.rowControl} ${ai.serverControl}`}>
        {editing ? (
          // Keyed apart from the saved server's buttons: React would otherwise keep Replace's button
          // as Save, a submit button by the time its click ends, which saves the address at once.
          <React.Fragment key="editing">
            <input
              id={id}
              className={`${styles.input} ${ai.serverInput}`}
              type="url"
              value={url}
              onChange={event => setUrl(event.target.value)}
              placeholder={server.example}
              autoComplete="off"
              spellCheck={false}
              autoFocus={replacing}
              disabled={busy}
            />
            <input
              className={`${styles.input} ${ai.keyInput}`}
              type="password"
              value={secret}
              onChange={event => setSecret(event.target.value)}
              placeholder={replacing && key?.set ? 'Its key: empty removes it' : 'Its key, if any'}
              aria-label={`${server.name} server key`}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
            <button type="submit" className={styles.primaryButton} disabled={busy || !url.trim()}>Save</button>
            {replacing && (
              <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => { setReplacing(false); setUrl(''); setSecret(''); }}>
                Cancel
              </button>
            )}
          </React.Fragment>
        ) : saved ? (
          <React.Fragment key="saved">
            <code className={`${ai.keyHint} ${ai.serverAddress}`} title={address.hint}>{address.hint}</code>
            {key?.set && <code className={ai.keyHint} title="Its key">{key.hint ?? '…'}</code>}
            <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => { setUrl(address.hint ?? ''); setReplacing(true); }}>
              Replace
            </button>
            <button type="button" className={ai.linkButton} disabled={busy} onClick={() => save({[server.url]: null, [server.key]: null})}>Remove</button>
          </React.Fragment>
        ) : (
          <input id={id} className={`${styles.input} ${ai.serverInput}`} placeholder={server.example} disabled />
        )}
      </div>
    </form>
  );
}
