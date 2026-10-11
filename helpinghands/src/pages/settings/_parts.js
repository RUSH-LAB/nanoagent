import React from 'react';
import styles from './styles.module.css';

/** The title of the settings pane on show, with room on the right for a status. */
export function PaneHeading({title, description, aside}) {
  return (
    <div className={styles.paneHeading}>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {aside}
    </div>
  );
}

/** Grey bars standing in for rows that are still loading; `bare` for inside an existing group. */
export function Skeleton({rows, bare = false}) {
  const bars = Array.from({length: rows}, (_, index) => (
    <div className={styles.row} key={index}><span className={styles.skeletonBar} /></div>
  ));
  return bare ? bars : <section className={styles.group} aria-busy="true">{bars}</section>;
}
