import React from 'react';
import clsx from 'clsx';
import styles from './styles.module.css';

/** The benchmark cards of benchmarkGroups(), a heading per plugin version (the installed one first); one card is selected. */
export default function BenchmarkCards({groups, selectedId, onSelect}) {
  return groups.map(group => (
    <fieldset key={group.version} className={styles.choices}>
      <legend>Version {group.version}{group.installed && <span className={styles.badge}>installed</span>}</legend>
      <div className={styles.cardGrid}>
        {group.cards.map(card => (
          <label key={card.id} className={clsx(styles.choice, styles.benchmarkCard)}>
            <input type="radio" name="benchmark" checked={card.id === selectedId} onChange={() => onSelect(card.id)} />
            <span>
              <strong>{card.name}</strong>
              <small>{card.task} · by {card.creator}</small>
              <small>{card.cases}</small>
              <small>{card.model}</small>
              <small>{card.runs} · {card.runners}</small>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  ));
}
