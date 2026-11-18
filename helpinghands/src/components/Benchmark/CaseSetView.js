import React from 'react';
import {caseSetView} from './caseSet';
import styles from './styles.module.css';

/** A benchmark's case set (GET benchmarks/{id}): the task, the shared context, and each case's kind, input and expected error. */
export default function CaseSetView({benchmark}) {
  const view = caseSetView(benchmark);
  return (
    <section className={styles.task} aria-label="Case set">
      <h4>{benchmark.name} <small className={styles.muted}>case set</small></h4>
      <dl className={styles.facts}>
        <dt>Task</dt><dd><code>{view.task.id}</code> ({view.task.kind}){view.task.description && <> {view.task.description}</>}</dd>
        <dt>Context</dt><dd>{view.context ? <pre>{view.context}</pre> : 'None'}</dd>
      </dl>
      <table className={styles.table}>
        <thead><tr><th>Case</th><th>Kind</th><th>Input</th><th>Expected error</th></tr></thead>
        <tbody>{view.cases.map(item => (
          <tr key={item.id}><td>{item.id}</td><td>{item.kind}</td><td><pre>{item.input}</pre></td><td>{item.expectedError ?? '–'}</td></tr>
        ))}</tbody>
      </table>
    </section>
  );
}
