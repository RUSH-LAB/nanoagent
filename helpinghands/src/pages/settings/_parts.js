import React from 'react';
import styles from './styles.module.css';

/** The title of the settings pane on show, with room on the right for a status. */
export function PaneHeading({title, aside}) {
  return (
    <div className={styles.paneHeading}>
      <h3>{title}</h3>
      {aside}
    </div>
  );
}

/** Grey bars standing in for rows that are still loading. */
export function Skeleton({rows}) {
  return (
    <section className={styles.group} aria-busy="true">
      {Array.from({length: rows}, (_, index) => (
        <div className={styles.row} key={index}><span className={styles.skeletonBar} /></div>
      ))}
    </section>
  );
}
