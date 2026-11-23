import React, {useEffect, useRef, useState} from 'react';
import {traceApi} from './api';
import {formatCost, formatMs, formatTokens} from './format';
import {replyPreview} from './transcriptRows';
import {ERROR_STATUSES} from './traceModel';
import Details from './Details';
import styles from './trace.module.css';

const ICONS = {model_call: 'M', proposal: 'P', tool: 'T', command: '$', process: '>'};

/** A model call's reply as one line, read when its row first scrolls into view. The row keys it by attempt and payload, so one instance never holds another's. */
function Preview({attemptId, span}) {
  const sha = span.attributes?.response_sha256;
  const [text, setText] = useState('');
  const [error, setError] = useState(null);
  const [seen, setSeen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!sha) return undefined;
    const observer = new IntersectionObserver(([entry]) => entry.isIntersecting && setSeen(true));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [sha]);
  useEffect(() => {
    if (!seen) return undefined;
    let live = true;
    traceApi.payload(attemptId, sha).then(
      result => live && setText(replyPreview(result.text, {dialect: span.attributes?.dialect, stream: Boolean(span.attributes?.frames_sha256)})),
      failure => live && setError(failure.message),
    );
    return () => { live = false; };
  }, [seen]); // eslint-disable-line react-hooks/exhaustive-deps
  return <span ref={ref} className={error ? `${styles.preview} ${styles.warn}` : styles.preview}>{error ? `The reply could not be read: ${error}` : text}</span>;
}

/** One transcript row; selecting it opens its details in place. */
export function TranscriptRow({attemptId, model, row, selected, onSelect}) {
  const ref = useRef(null);
  useEffect(() => {
    if (!selected || !ref.current) return;
    const scroller = ref.current.closest('[data-transcript-scroll]');
    const rowRect = ref.current.getBoundingClientRect();
    const scrollRect = scroller.getBoundingClientRect();
    if (rowRect.top < scrollRect.top || rowRect.bottom > scrollRect.bottom) scroller.scrollTop += rowRect.top - scrollRect.top;
  }, [selected]);
  const {span} = row;
  return (
    <li ref={ref} className={styles.row} data-selected={selected}>
      <button type="button" className={styles.rowButton} aria-expanded={selected} onClick={() => onSelect(selected ? null : row.id)}>
        <span className={styles.icon} data-kind={row.kind} data-error={ERROR_STATUSES.has(span.status)} aria-hidden="true">{ICONS[row.kind]}</span>
        <strong className={styles.name} title={row.name}>{row.name}</strong>
        {row.kind === 'model_call' ? <Preview key={`${attemptId}:${span.attributes?.response_sha256}`} attemptId={attemptId} span={span} /> : <span className={styles.preview} />}
        <span className={styles.figures}>{row.duration === null ? '–' : formatMs(row.duration)}</span>
        <span className={styles.figures}>{row.tokens === null ? '' : `${formatTokens(row.tokens)} tok`}</span>
        <span className={styles.figures}>{row.cost === null ? '' : formatCost(row.cost)}</span>
      </button>
      {selected && <Details attemptId={attemptId} model={model} span={span} onSelect={onSelect} />}
    </li>
  );
}

export default function Transcript({attemptId, model, rows, selectedId, onSelect}) {
  if (!rows.length) return <p className={styles.muted}>Nothing has been recorded.</p>;
  return (
    <div className={styles.transcriptScroll} data-transcript-scroll tabIndex={0} role="region" aria-label="Scrollable transcript">
      <ul className={styles.transcript} aria-label="Transcript">
        {rows.map(row => <TranscriptRow key={row.id} attemptId={attemptId} model={model} row={row} selected={row.id === selectedId} onSelect={onSelect} />)}
      </ul>
    </div>
  );
}
