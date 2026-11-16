import React from 'react';
import clsx from 'clsx';
import CopyInstructions from './CopyInstructions';
import {HARNESS_EXAMPLE, harnessInstructions} from './harnessInstructions';
import styles from './styles.module.css';

export default function PrepareHarness({benchmark}) {
  return (
    <details className={clsx(styles.section, styles.advanced)}>
      <summary>Prepare a harness</summary>
      <p className={styles.fieldHint}>The harness is the program you test. Put <code>harness.yaml</code> at the root of its source ZIP and declare how RUSH builds and starts it.</p>
      <ul>
        <li>Open the request file at <code>RUSH_REQUEST</code> for the inputs, schemas and prompt. If you call a model, use the supplied gateway, model and API format.</li>
        <li>Choose <strong>Task tools</strong> to test a harness with the plugin’s task prompt and approved tools. Write to the <code>RUSH_RESULT</code> path.</li>
        <li>Choose <strong>Coding</strong> for a coding agent or standalone solver that uses its own tools. Write <code>answer.json</code> in the case workspace.</li>
      </ul>
      <details className={styles.advanced}>
        <summary>Example harness configuration</summary>
        <p className={styles.fieldHint}>A dialect is the model API format your harness uses to send requests through the RUSH gateway. List the formats it supports: <code>chat_completions</code> (OpenAI Chat Completions), <code>responses</code> (OpenAI Responses), or <code>anthropic_messages</code> (Anthropic Messages). At least one is required, even if the harness makes no model calls.</p>
        <pre>{HARNESS_EXAMPLE}</pre>
      </details>
      <CopyInstructions subject="harness" text={harnessInstructions(benchmark)} />
    </details>
  );
}
