import React, {useState} from 'react';
import LoadingSkeleton from '@site/src/components/LoadingSkeleton';
import {keepSelection} from './traceModel';
import Header from './Header';
import Timeline from './Timeline';
import TranscriptList from './TranscriptList';
import useTrace from './useTrace';
import styles from './trace.module.css';

const totalOf = model => model.window.end - model.window.start;

function Pane({attemptId, trace, total, selectedId, onSelect, harnessName, showProcesses, onProcesses, children}) {
  if (trace.error) return <p className={styles.warn} role="alert">{trace.error}</p>;
  if (trace.loading || !trace.attempt) return <LoadingSkeleton shape="block" height={160} />;
  return (
    <>
      <Header harnessName={harnessName} attemptId={attemptId} attempt={trace.attempt} accounting={trace.accounting} />
      {trace.truncated && <p className={styles.warn} role="status">This trace is too large to show whole: its later spans and links are left out.</p>}
      {trace.hasProcesses && <label className={styles.processToggle}><input type="checkbox" checked={showProcesses} onChange={event => onProcesses(event.target.checked)} /> Show process activity</label>}
      <Timeline model={trace.model} packed={trace.packed} total={total} selectedId={selectedId} onSelect={onSelect} label="Timeline" />
      {children}
    </>
  );
}

/** One attempt's trace: header, timeline and transcript sharing one selection. */
export default function BenchmarkTrace({attemptId, harnessName}) {
  const [showProcesses, setShowProcesses] = useState(true);
  const trace = useTrace(attemptId, showProcesses);
  const [chosen, setChosen] = useState(null);
  const selectedId = keepSelection(trace.model, chosen);
  return (
    <div className={styles.trace}>
      <Pane harnessName={harnessName} attemptId={attemptId} trace={trace} total={totalOf(trace.model)} selectedId={selectedId} onSelect={setChosen} showProcesses={showProcesses} onProcesses={setShowProcesses}>
        <TranscriptList attemptId={attemptId} model={trace.model} rows={trace.rows} selectedId={selectedId} onSelect={setChosen} />
      </Pane>
    </div>
  );
}

/** Two traces on a shared time scale, each with its own selection and scrollable transcript. */
export function BenchmarkTraceCompare({leftAttemptId, rightAttemptId, leftHarnessName, rightHarnessName}) {
  const [showProcesses, setShowProcesses] = useState({left: true, right: true});
  const left = useTrace(leftAttemptId, showProcesses.left);
  const right = useTrace(rightAttemptId, showProcesses.right);
  const [chosen, setChosen] = useState({left: null, right: null});
  const total = totalOf(left.model) > totalOf(right.model) ? totalOf(left.model) : totalOf(right.model);
  return (
    <div className={styles.sides}>
      {[
        ['left', leftAttemptId, left, leftHarnessName],
        ['right', rightAttemptId, right, rightHarnessName],
      ].map(([side, attemptId, trace, harnessName]) => {
        const selectedId = keepSelection(trace.model, chosen[side]);
        const select = id => setChosen(previous => ({...previous, [side]: id}));
        return (
          <section key={side} className={styles.tracePane} aria-label={`${harnessName || side} trace`}>
            <Pane harnessName={harnessName} attemptId={attemptId} trace={trace} total={total} selectedId={selectedId} onSelect={select} showProcesses={showProcesses[side]} onProcesses={value => setShowProcesses(previous => ({...previous, [side]: value}))}>
              <TranscriptList attemptId={attemptId} model={trace.model} rows={trace.rows} selectedId={selectedId} onSelect={select} />
            </Pane>
          </section>
        );
      })}
    </div>
  );
}
