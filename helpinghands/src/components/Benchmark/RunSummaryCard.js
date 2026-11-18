import React from 'react';
import clsx from 'clsx';
import {runSummary} from './runs';
import styles from './styles.module.css';
import cardStyles from './run-compare.module.css';

/**
 * One run summary (GET runs, GET benchmarks/{id}/results) as a card: harness and version, status and score, plugin and benchmark, model,
 * total tokens, elapsed time and who ran it. `ticked` and `onToggle` add the Select box of run comparison, `onOpen` the Open run button.
 */
export default function RunSummaryCard({run, ticked, onToggle, onOpen}) {
  const card = runSummary(run, ticked);
  return (
    <article className={clsx(cardStyles.runCard, {[cardStyles.picked]: card.select.checked})}>
      <div className={cardStyles.cardTop}>
        <div>
          <h3>{card.title}</h3>
          <p className={styles.muted}>{card.subtitle}</p>
        </div>
        <div className={cardStyles.cardSide}>
          <span className={clsx(cardStyles.status, cardStyles[`tone_${card.tone}`])}>&#9679; {card.status}</span>
          {onToggle && <label className={cardStyles.pick}><input type="checkbox" aria-label={`Compare run ${run.run_id.slice(0, 8)}`} checked={card.select.checked} onChange={() => onToggle(run.run_id)} /> {card.select.label}</label>}
        </div>
      </div>
      <p className={cardStyles.runModel}><strong>{card.model}</strong> · {card.tokens} · {card.elapsed} · {card.user}</p>
      {onOpen && <div className={cardStyles.cardFooter}><span /><button type="button" className={styles.secondaryButton} onClick={() => onOpen(run.run_id)}>Open run</button></div>}
    </article>
  );
}
