import React from 'react';
import {describeSpan} from './inspector';
import {causalFrom} from './traceModel';
import Payload from './Payload';
import styles from './trace.module.css';

const text = value => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));

/** What a selected row opens in place: facts, token classes, request and response as messages, raw payloads, and causal links to follow. */
export default function Details({attemptId, model, span, onSelect}) {
  const view = describeSpan(span);
  const causal = causalFrom(model, span.id);
  const primary = view.payloads.find(item => ['Response', 'Result', 'stdout'].includes(item.label)) ?? view.payloads[0];
  return (
    <div className={styles.details}>
      <dl className={styles.facts}>
        {view.facts.map(fact => <React.Fragment key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></React.Fragment>)}
        {view.tokens.map(row => <React.Fragment key={row.label}><dt>{row.label} tokens</dt><dd>{row.value === null ? 'Unknown' : row.value.toLocaleString('en-US')}</dd></React.Fragment>)}
      </dl>
      {view.payloads.map(item => (
        <details key={`${item.label}:${item.sha}`} className={styles.evidence} open={item === primary}>
          <summary>{item.label}</summary>
          <Payload attemptId={attemptId} sha={item.sha} note={item.note} transcript={span.kind === 'model_call' && ['Effective request', 'Response'].includes(item.label)
            ? {dialect: span.attributes?.dialect, response: item.label === 'Response', stream: Boolean(span.attributes?.frames_sha256)} : null} />
        </details>
      ))}
      {view.inline.map(item => <details key={item.label} className={styles.evidence}><summary>{item.label}</summary><pre>{text(item.value)}</pre></details>)}
      {causal.length > 0 && (
        <ul className={styles.links} aria-label="Related actions">
          {causal.map(({link, direction, otherId}) => (
            <li key={`${link.kind}:${link.from}:${link.to}`}>
              {direction === 'in' ? 'From' : 'To'} <button type="button" onClick={() => onSelect(otherId)}>{model.byId.get(otherId).name}</button>
              {' '}<small>{link.kind.replaceAll('_', ' ')}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
