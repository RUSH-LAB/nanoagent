import React from 'react';
import {describeError} from './publish';
import styles from './styles.module.css';

/** A refusal as the server worded it, with what its code carries (the limits over a worker's, a name taken, a harness version taken). */
export default function Failure({failure}) {
  const {message, lines} = describeError(failure);
  return <div className={styles.error} role="alert"><pre>{message}</pre>{lines.length > 0 && <ul>{lines.map(line => <li key={line}>{line}</li>)}</ul>}</div>;
}
