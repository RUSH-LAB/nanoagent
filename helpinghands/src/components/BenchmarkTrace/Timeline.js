import React, {useState} from 'react';
import {ERROR_STATUSES, barOf} from './traceModel';
import {formatMs} from './format';
import styles from './trace.module.css';

const BAR_PX = 8;
const ROW_PX = 10;
const TICKS = [0, 25, 50, 75, 100];

/**
 * The thin tinted strip of bars, packed into rows. `total` is the elapsed time in ns the strip's width stands for (a comparison gives
 * both sides the longer one). Clicking a bar selects it and dims the rest; a needle follows the pointer.
 */
export default function Timeline({model, packed, total, selectedId, onSelect, label}) {
  const [needle, setNeedle] = useState(null);
  const totalMs = Number(total) / 1e6;
  const move = event => {
    const rect = event.currentTarget.getBoundingClientRect();
    setNeedle(Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1));
  };
  return (
    <div className={styles.timeline} role="group" aria-label={label}>
      <div className={styles.ticks} aria-hidden="true">
        {TICKS.map(tick => <span key={tick} style={{left: `${tick}%`}} data-edge={tick === 100 ? 'end' : undefined}>{formatMs(totalMs * tick / 100)}</span>)}
      </div>
      <div className={styles.strip} style={{height: `${Math.max(packed.rows, 1) * ROW_PX + 2}px`}} onMouseMove={move} onMouseLeave={() => setNeedle(null)}>
        {packed.bars.map(({span, row}) => {
          const bar = barOf(model, span, total);
          return (
            <button key={span.id} type="button" className={styles.bar} title={`${span.kind} ${span.name}`} aria-pressed={span.id === selectedId}
              data-kind={span.kind} data-error={ERROR_STATUSES.has(span.status)} data-unfinished={span.end_ns === null} data-dim={selectedId !== null && span.id !== selectedId}
              style={{left: `${Math.min(bar.left, 99.6)}%`, width: `${bar.width}%`, top: `${row * ROW_PX + 1}px`, height: `${BAR_PX}px`}}
              onClick={() => onSelect(span.id === selectedId ? null : span.id)} />
          );
        })}
        {needle !== null && <span className={styles.needle} style={{left: `${needle * 100}%`}}><span>{formatMs(totalMs * needle)}</span></span>}
      </div>
    </div>
  );
}
