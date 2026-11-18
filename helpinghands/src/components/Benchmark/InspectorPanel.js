import React, {useState} from 'react';
import {describeSpan} from './inspector';
import {formatMs} from './metrics';
import {causalFrom, parallelWith, spanTiming} from './traceModel';
import Payload from './Payload';
import styles from './styles.module.css';
import traceStyles from './trace.module.css';

const text = value => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));

function StoredEvidence({attemptId, item, initiallyOpen, transcript}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <details className={traceStyles.evidence} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>{item.label}</summary>
      {open && <Payload attemptId={attemptId} sha={item.sha} note={item.note} transcript={transcript} />}
    </details>
  );
}

function ActionDetails({model, span, waits, view, onSelect}) {
  const causal = causalFrom(model, span.id);
  const parallel = parallelWith(model, span.id);
  const overlap = waits.overlapping.get(span.id);
  return (
    <>
      {waits.upstream.has(span.id) && <p className={styles.note}>The harness was waiting for the model gateway.</p>}
      {overlap && <p className={styles.note}>Local work overlapping {overlap.length} model request{overlap.length === 1 ? '' : 's'}.</p>}
      <dl className={styles.facts}>
        {view.facts.map(fact => <React.Fragment key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></React.Fragment>)}
      </dl>
      {view.tokens.length > 0 && (
        <section className={traceStyles.metadata}>
          <h4>Tokens</h4>
          <dl className={styles.facts}>
            {view.tokens.map(row => <React.Fragment key={row.label}><dt>{row.label}</dt><dd>{row.value === null ? 'Unknown' : row.value.toLocaleString('en-US')}</dd></React.Fragment>)}
          </dl>
        </section>
      )}
      {causal.length > 0 && (
        <section className={traceStyles.metadata}>
          <h4>Related actions</h4>
          <ul className={styles.links}>
            {causal.map(({link, direction, otherId}) => (
              <li key={`${link.kind}:${link.from}:${link.to}`}>
                {direction === 'in' ? 'From' : 'To'} <button type="button" className={styles.link} onClick={() => onSelect(otherId)}>{model.byId.get(otherId).name}</button>
                {' '}<small>{link.kind.replaceAll('_', ' ')} via {link.method}</small>
              </li>
            ))}
          </ul>
        </section>
      )}
      {parallel.length > 0 && (
        <section className={traceStyles.metadata}>
          <h4>Ran in parallel</h4>
          <ul className={styles.links}>{parallel.map(other => <li key={other.id}><button type="button" className={styles.link} onClick={() => onSelect(other.id)}>{other.name}</button></li>)}</ul>
        </section>
      )}
    </>
  );
}

export default function Inspector({attemptId, model, span, waits, onSelect}) {
  const [tab, setTab] = useState('evidence');
  if (!span) return <aside className={traceStyles.inspector}><p className={traceStyles.empty}>Select an action to inspect its details.</p></aside>;
  const view = describeSpan(span);
  const timing = spanTiming(model, span);
  const hasEvidence = view.payloads.length > 0 || view.inline.length > 0;
  const active = hasEvidence ? tab : 'details';
  const primary = view.payloads.find(item => ['Response', 'Result', 'stdout'].includes(item.label)) ?? view.payloads[0];

  return (
    <aside className={traceStyles.inspector} aria-label="Selected action">
      <header className={traceStyles.inspectorHeader}>
        <h3 className={styles.sectionHeading}>{view.title}</h3>
        <p className={styles.fieldHint}>
          {span.status.replaceAll('_', ' ')}
          {timing && <> · Starts at +{formatMs(timing.offset)}{timing.duration != null && <> · {formatMs(timing.duration)} elapsed</>}</>}
        </p>
        {hasEvidence && (
          <div className={traceStyles.chips} role="group" aria-label="Action details view">
            <button type="button" className={styles.chip} aria-pressed={active === 'evidence'} onClick={() => setTab('evidence')}>Input and output</button>
            <button type="button" className={styles.chip} aria-pressed={active === 'details'} onClick={() => setTab('details')}>Details</button>
          </div>
        )}
      </header>
      <div className={traceStyles.inspectorBody}>
        {active === 'details' ? <ActionDetails model={model} span={span} waits={waits} view={view} onSelect={onSelect} /> : (
          <>
            {view.payloads.map(item => <StoredEvidence key={`${item.label}:${item.sha}`} attemptId={attemptId} item={item} initiallyOpen={item === primary}
              transcript={span.kind === 'model_call' && ['Effective request', 'Response'].includes(item.label) ? {
                dialect: span.attributes?.dialect, response: item.label === 'Response', stream: Boolean(span.attributes?.frames_sha256),
              } : null} />)}
            {view.inline.map(item => <details key={item.label} className={traceStyles.evidence} open={!primary ? true : undefined}><summary>{item.label}</summary><pre>{text(item.value)}</pre></details>)}
          </>
        )}
      </div>
    </aside>
  );
}
