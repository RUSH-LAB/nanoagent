import React from 'react';
import clsx from 'clsx';
import market from '@site/src/pages/marketplace/styles.module.css';
import styles from './styles.module.css';

/** A titled part of a screen. */
export function Step({title, children}) {
  return (
    <section className={styles.step}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

/** A chip, pressed or not: one choice among others, or one of several. */
export function Chip({pressed, onClick, children}) {
  return (
    <button type="button" aria-pressed={pressed} className={clsx(market.chip, styles.chipButton)} onClick={onClick}>
      {children}
    </button>
  );
}

/** A Marketplace card that is a choice: pressing it picks it. */
export function ChoiceCard({pressed, onClick, children}) {
  return (
    <button type="button" aria-pressed={pressed} className={clsx(market.card, styles.choice)} onClick={onClick}>
      {children}
    </button>
  );
}

/** A verdict, run status or case kind as a pill, green for a pass and red for a fail. */
export function Pill({word}) {
  return <span className={clsx(styles.pill, word === 'pass' && styles.pass, word === 'fail' && styles.fail)}>{word}</span>;
}

/** The cases of a benchmark, read-only: `benchmark.cases` of GET benchmarks/{id}. */
export function CaseList({cases}) {
  return (
    <div className={styles.cases}>
      {cases.map(one => (
        <div className={styles.case} key={one.case_id}>
          <div className={styles.row}>
            <code>{one.case_id}</code>
            <Pill word={one.kind} />
            {one.fixtures && <span className={styles.muted}>{Object.keys(one.fixtures.files).length} fixtures</span>}
          </div>
          <pre className={styles.pre}>{one.prompt}</pre>
          {one.expected_error && <p className={styles.muted}>Refused with: {one.expected_error}</p>}
        </div>
      ))}
    </div>
  );
}
