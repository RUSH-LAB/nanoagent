import React, {useEffect, useRef, useState} from 'react';
import {traceApi} from './api';
import {formatCost, formatMs, formatTokens} from './format';
import {replyPreview} from './transcriptRows';
import {ERROR_STATUSES} from './traceModel';
import Details from './Details';
import styles from './trace.module.css';

const ICONS = {model_call: 'M', proposal: 'P', tool: 'T', command: '$', process: '>'};
const previews = new Map();

/** A model call's reply as one line, read when its row first scrolls into view. */
function Preview({attemptId, span}) {
  const sha = span.attributes?.response_sha256;
  const key = `${attemptId}:${sha}`;
  const [text, setText] = useState(previews.get(key) ?? '');
  const [seen, setSeen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!sha || previews.has(key)) return undefined;
    const observer = new IntersectionObserver(([entry]) => entry.isIntersecting && setSeen(true));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [key, sha]);
  useEffect(() => {
    if (!seen || previews.has(key)) return;
    traceApi.payload(attemptId, sha).then(
      result => { previews.set(key, replyPreview(result.text, {dialect: span.attributes?.dialect, stream: Boolean(span.attributes?.frames_sha256)})); setText(previews.get(key)); },
      () => {},
    );
  }, [seen, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return <span ref={ref} className={styles.preview}>{text}</span>;
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
        {row.kind === 'model_call' ? <Preview attemptId={attemptId} span={span} /> : <span className={styles.preview} />}
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
