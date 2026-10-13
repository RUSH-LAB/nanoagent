import React from 'react';
import styles from './styles.module.css';

/** `text` with the characters at `indices` (from fuzzyMatch) marked. */
export default function Highlight({text, indices}) {
  const marked = new Set(indices);
  const parts = [];
  for (let start = 0; start < text.length;) {
    const hit = marked.has(start);
    let end = start + 1;
    while (end < text.length && marked.has(end) === hit) end++;
    const part = text.slice(start, end);
    parts.push(hit ? <mark key={start} className={styles.mark}>{part}</mark> : part);
    start = end;
  }
  return <>{parts}</>;
}
