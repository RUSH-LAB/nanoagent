import React, {useMemo} from 'react';
import styles from './styles.module.css';

/* ── Shared line-number gutter for the raw and split editors ──
   Both editors render an identical gutter beside their textarea. This module
   owns that one implementation so the logic lives in a single place. */

// Returns the memoized line-number array [1, 2, ..., n], where n is the number
// of newline separated lines in `value`. The count is memoized first and the
// array second, so the array identity changes only when the line count does.
export function useLineNumbers(value) {
  const lineCount = useMemo(() => value.split('\n').length, [value]);

  const lineNumbers = useMemo(
    () => Array.from({length: lineCount}, (_, i) => i + 1),
    [lineCount],
  );

  return lineNumbers;
}

// Renders the line-number gutter. `gutterRef` is attached to the scroll
// container so each editor can keep the gutter's scrollTop in sync with its
// textarea.
export function LineNumberGutter({numbers, gutterRef}) {
  return (
    <div
      ref={gutterRef}
      className={styles.lineNumbers}
      aria-hidden="true"
    >
      {numbers.map((num) => (
        <div key={num} className={styles.lineNumber}>{num}</div>
      ))}
    </div>
  );
}
