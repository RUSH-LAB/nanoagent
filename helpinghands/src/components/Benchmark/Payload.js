import React, {useEffect, useState} from 'react';
import {benchmarkApi} from './api';
import {capMessages, payloadView, redactionNote} from './inspector';
import {traceMessages} from './traceMessages';
import styles from './styles.module.css';
import traceStyles from './trace.module.css';

/**
 * One stored payload, fetched when the span that holds it is selected and shown as text (never as markup). A payload that was
 * not stored, or that was redacted or cut short, says so.
 */
export default function Payload({attemptId, sha, label, note, transcript}) {
  const [state, setState] = useState({loading: true});
  const {dialect, response, stream} = transcript ?? {};
  useEffect(() => {
    let live = true;
    setState({loading: true});
    benchmarkApi.payload(attemptId, sha).then(
      result => live && setState({view: payloadView(result.text, result.redaction), ...capMessages(traceMessages(result.text, {dialect, response, stream}))}),
      error => live && setState({error: error.message}),
    );
    return () => { live = false; };
  }, [attemptId, sha, dialect, response, stream]);
  const {view, messages = [], cut: messagesCut} = state;
  return (
    <section className={styles.payload}>
      {label && <h4>{label}</h4>}
      <p className={styles.muted}><code>{sha.slice(0, 12)}</code>{note && <span className={styles.badge}>{note}</span>}{view && view.redaction !== 'none' && <span className={styles.badge}>{view.redaction}</span>}</p>
      {state.loading && <p className={styles.muted}>Loading…</p>}
      {state.error && <p className={styles.warn}>{state.error}</p>}
      {view && redactionNote(view.redaction) && <p className={styles.muted}>{redactionNote(view.redaction)}</p>}
      {messages.length > 0 && <div className={traceStyles.messages}>
        {messages.map(({role, text}, index) => <div key={index}><h5>{role}</h5><pre>{text}</pre></div>)}
      </div>}
      {messagesCut && <p className={styles.muted}>The messages are cut short; the raw view has the rest.</p>}
      {view && (messages.length > 0 ? (
        <details><summary>Raw payload</summary><pre>{view.text}</pre></details>
      ) : <pre>{view.text}</pre>)}
      {view?.cut && <p className={styles.muted}>The raw view shows the first part of {view.length.toLocaleString('en-US')} characters.</p>}
    </section>
  );
}
