import React, {useMemo, useState} from 'react';
import clsx from 'clsx';
import LoadingSkeleton from '@site/src/components/LoadingSkeleton';
import {benchmarkApi} from './api';
import {harnessLabel} from './labels';
import {attemptsComparable, caseOutcomeChanged, configRows, diffChanged, diffLines, egressSides, orderedCases, pairedVerdicts, sideCells} from './runCompare';
import {POLICY_LABELS, outcomeText, scoreText, verdictText} from './runs';
import useLoad from './useLoad';
import styles from './styles.module.css';
import compareStyles from './run-compare.module.css';

const percent = new Intl.NumberFormat('en-US', {style: 'percent', maximumFractionDigits: 1});
const caseKey = item => JSON.stringify([item.a?.case_id, item.b?.case_id]);
const caseName = item => item.a && item.b && item.a.case_id !== item.b.case_id ? `${item.a.case_id} / ${item.b.case_id}` : (item.a ?? item.b).case_id;

function Diff({parts, label}) {
  if (!diffChanged(parts)) return <p className={styles.fieldHint}>{label} is unchanged.</p>;
  return (
    <pre className={styles.diff} aria-label={label}>
      {diffLines(parts).map((item, index) => <span key={index} className={styles[`diff_${item.type}`]}>{item.line}{'\n'}</span>)}
    </pre>
  );
}

function RunSummary({label, run, egress, onOpen}) {
  const score = run.score;
  return (
    <section className={compareStyles.summaryCard} aria-label={`${label} summary`}>
      <div className={compareStyles.cardTop}>
        <div><h3>{label}</h3><p className={styles.fieldHint}>{run.case_set_name} · <code>{run.run_id.slice(0, 8)}</code></p></div>
        <span className={styles.badge}>{run.status}</span>
      </div>
      <strong className={compareStyles.score}>{Number.isFinite(score?.value) ? percent.format(score.value) : 'Score unavailable'}</strong>
      <p className={styles.fieldHint}>{Number.isFinite(score?.value) ? <>{score.passed} of {score.scored} scored cases passed{!score.complete && ' · provisional'}{score.unscored > 0 && ` · ${score.unscored} unscored`}{score.verifier_errors > 0 && ` · ${score.verifier_errors} verifier errors`}</> : scoreText(score)}</p>
      <p className={compareStyles.runModel}>{run.model} · {POLICY_LABELS[run.policy] ?? run.policy}</p>
      <div className={compareStyles.cardFooter}>
        <button type="button" className={styles.link} onClick={onOpen}>Open {label} run</button>
        {egress && <span className={clsx(styles.badge, styles.unverified)}>Unverified internet access</span>}
      </div>
    </section>
  );
}

function CaseVerdict({side}) {
  if (!side) return <span className={styles.muted}>—</span>;
  const verdict = verdictText(side);
  const outcome = outcomeText(side.outcome);
  const label = verdict === '–' ? outcome === '–' ? 'No result' : outcome : verdict;
  return <span className={clsx(compareStyles.verdict, {[compareStyles.pass]: verdict === 'Pass', [compareStyles.fail]: verdict === 'Fail' || verdict === 'Verifier error'})}>{label}</span>;
}

function CaseSide({label, side, onTrace}) {
  const result = side && sideCells(side);
  return (
    <div className={compareStyles.caseSide}>
      <h4>{label}</h4>
      {!side ? <p className={styles.fieldHint}>This run did not include the case.</p> : (
        <>
          <CaseVerdict side={side} />
          <p className={styles.fieldHint}>{[result.outcome === '–' ? '' : result.outcome, side.execution_reason, result.explanation, side.verifier_error].filter(Boolean).join(' · ')}</p>
          <dl className={compareStyles.caseMetrics}>
            <dt>Elapsed</dt><dd>{result.latency}</dd>
            <dt>Tokens</dt><dd>{result.tokens}</dd>
            <dt>Cost</dt><dd>{result.cost}</dd>
          </dl>
          {side.attempt_id && <button type="button" className={styles.link} onClick={onTrace}>Trace {label}</button>}
        </>
      )}
    </div>
  );
}

function CaseResults({data, pair, initialCaseKey, go, names}) {
  const [group, setGroup] = useState('all');
  const [query, setQuery] = useState('');
  const [selectedKey, select] = useState(initialCaseKey);
  const groups = useMemo(() => ({
    shared: orderedCases(data.shared),
    changed: data.shared.filter(caseOutcomeChanged),
    onlyA: data.only_a.map(item => ({...item, a: item, b: null})),
    onlyB: data.only_b.map(item => ({...item, a: null, b: item})),
  }), [data]);
  const candidates = group === 'all' ? [...groups.shared, ...groups.onlyA, ...groups.onlyB] : groups[group];
  const term = query.trim().toLowerCase();
  const visible = candidates.filter(item => [item.a, item.b].some(side => side?.case_id.toLowerCase().includes(term)));
  const selected = visible.find(item => caseKey(item) === selectedKey) ?? visible[0];
  const verdicts = pairedVerdicts(data.shared);
  return (
    <section className={compareStyles.results} aria-label="Case results">
      <div className={compareStyles.pairSummary}>
        <h3 className={styles.sectionHeading}>Shared case verdicts</h3>
        <dl className={compareStyles.verdictStats}>
          {[
            ['Both passed', verdicts.bothPassed], [`Only ${names.a} passed`, verdicts.onlyAPassed],
            [`Only ${names.b} passed`, verdicts.onlyBPassed], ['Both failed', verdicts.bothFailed], ['Missing paired verdicts', verdicts.unpaired],
          ].map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{count}</dd></div>)}
        </dl>
      </div>
      <div className={compareStyles.filters}>
        <input type="search" className={styles.searchInput} placeholder="Search case IDs" aria-label="Search case IDs" value={query} onChange={event => setQuery(event.target.value)} />
        <div role="group" aria-label="Filter cases" className={compareStyles.caseActions}>
          {[
            ['all', 'All', groups.shared.length + groups.onlyA.length + groups.onlyB.length],
            ['shared', 'Shared', groups.shared.length], ['changed', 'Changed', groups.changed.length],
            ['onlyA', `Only ${names.a}`, groups.onlyA.length], ['onlyB', `Only ${names.b}`, groups.onlyB.length],
          ].map(([id, label, count]) => <button key={id} type="button" className={styles.chip} aria-pressed={group === id} onClick={() => setGroup(id)}>{label} · {count}</button>)}
        </div>
      </div>
      {!visible.length ? <p className={styles.emptyState}>No cases match these filters.</p> : (
        <div className={compareStyles.resultsGrid}>
          <div className={compareStyles.caseTable}>
            <table aria-label="Cases and verdicts">
              <thead><tr><th scope="col">Case</th><th scope="col">{names.a}</th><th scope="col">{names.b}</th></tr></thead>
              <tbody>
                {visible.map(item => {
                  const key = caseKey(item);
                  const current = key === caseKey(selected);
                  return <tr key={key} className={clsx({[compareStyles.currentCase]: current})}>
                    <th scope="row">
                      <button type="button" aria-pressed={current} className={compareStyles.casePick} onClick={() => select(key)}>
                        {caseName(item)}
                        {item.a && item.b && caseOutcomeChanged(item) && <small>Changed</small>}
                      </button>
                    </th>
                    <td><CaseVerdict side={item.a} /></td><td><CaseVerdict side={item.b} /></td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
          <section className={compareStyles.caseCard} aria-label="Selected case details">
            <h3 className={styles.sectionHeading}>{caseName(selected)}</h3>
            <p className={styles.fieldHint}>{selected.kind === 'refuse' ? 'Refusal case' : 'Answer case'} · <code>{selected.content_digest.slice(0, 12)}</code></p>
            <div className={compareStyles.caseSides}>
              <CaseSide label={names.a} side={selected.a} onTrace={() => go({attempt: selected.a.attempt_id, runs: pair, caseKey: caseKey(selected)})} />
              <CaseSide label={names.b} side={selected.b} onTrace={() => go({attempt: selected.b.attempt_id, runs: pair, caseKey: caseKey(selected)})} />
            </div>
            {selected.a && selected.b && (
              <button type="button" className={styles.primaryButton} disabled={!attemptsComparable(selected)}
                title={attemptsComparable(selected) ? undefined : 'Both attempts must be finished'}
                onClick={() => go({compare: `${selected.a.attempt_id},${selected.b.attempt_id}`, runs: pair, caseKey: caseKey(selected)})}>Compare attempts</button>
            )}
          </section>
        </div>
      )}
    </section>
  );
}

function Settings({data, names}) {
  const [showAll, setShowAll] = useState(false);
  const rows = configRows(data.config, !showAll);
  return (
    <section className={compareStyles.details} aria-label="Run settings">
      <div className={styles.toolbar}><label><input type="checkbox" checked={showAll} onChange={event => setShowAll(event.target.checked)} /> Show matching settings</label></div>
      {rows.length === 0 ? <p className={styles.fieldHint}>The recorded settings match.</p> : (
        <div className={compareStyles.tableScroll}><table className={styles.table}>
          <thead><tr><th scope="col">Setting</th><th scope="col">{names.a}</th><th scope="col">{names.b}</th></tr></thead>
          <tbody>{rows.map(row => (
            <tr key={row.field} className={clsx({[styles.differs]: row.differs && showAll})}><th scope="row">{row.label}</th><td>{row.a}</td><td>{row.b}</td></tr>
          ))}</tbody>
        </table></div>
      )}
      <dl className={styles.facts}>
        <dt>Verifier package</dt><dd><code>{data.verifier.package_sha256.slice(0, 12)}</code></dd>
        {[[data.a, names.a], [data.b, names.b]].map(([run, label]) => <React.Fragment key={label}>
          <dt>{label} source</dt><dd><code>{run.source.sha256.slice(0, 12)}</code> · {new Date(run.created_at).toLocaleString()}</dd>
        </React.Fragment>)}
      </dl>
    </section>
  );
}

function Prompts({prompt, names}) {
  return (
    <section className={compareStyles.details} aria-label="Prompt differences">
      <h3 className={styles.sectionHeading}>Run prompt</h3>
      <p className={styles.fieldHint}>{names.a} {prompt.a_kind} · {names.b} {prompt.b_kind}</p>
      <Diff parts={prompt.text} label="Run prompt" />
      <h3>Rendered prompts</h3>
      <p className={styles.fieldHint}>{prompt.rendered.filter(item => !item.identical).length} of {prompt.rendered.length} shared cases have prompt differences.</p>
      {prompt.rendered.map(item => (
        <details key={JSON.stringify([item.a_case_id, item.b_case_id])} className={styles.advanced}>
          <summary>{caseName({a: {case_id: item.a_case_id}, b: {case_id: item.b_case_id}})} · {item.identical ? 'Same' : 'Changed'}</summary>
          {item.identical ? <p className={styles.fieldHint}>The system and user prompts match.</p> : (
            <><h4>System</h4><Diff parts={item.system} label="System prompt" /><h4>User</h4><Diff parts={item.user} label="User prompt" /></>
          )}
        </details>
      ))}
    </section>
  );
}

export default function CompareRuns({a, b, initialCaseKey, go, onBack}) {
  const result = useLoad(async () => {
    const [comparison, first, second] = await Promise.all([benchmarkApi.compareRuns(a, b), benchmarkApi.run(a), benchmarkApi.run(b)]);
    return {comparison, names: {a: harnessLabel(first.run.harness), b: harnessLabel(second.run.harness)}};
  }, [a, b]);
  const [view, setView] = useState('cases');
  const data = result.data?.comparison;
  const names = result.data?.names;
  if (result.error) return <div><button type="button" className={styles.link} onClick={onBack ?? (() => go({}))}>← {onBack ? 'Harness comparison' : 'All runs'}</button><p className={styles.error} role="alert">{result.error}</p></div>;
  if (!data) return <LoadingSkeleton shape="block" height={200} />;
  const egress = egressSides(data.unverified_egress);
  return (
    <div>
      <header className={styles.header}>
        <button type="button" className={styles.link} onClick={onBack ?? (() => go({}))}>← {onBack ? 'Harness comparison' : 'All runs'}</button>
        <h2>Compare runs</h2>
        <p className={styles.fieldHint}>{data.verifier.task_id}</p>
        <div className={styles.twin}>
          <RunSummary label={names.a} run={data.a} egress={data.unverified_egress.a} onOpen={() => go({run: a})} />
          <RunSummary label={names.b} run={data.b} egress={data.unverified_egress.b} onOpen={() => go({run: b})} />
        </div>
        {egress.length > 0 && <p className={compareStyles.egress}>{egress.map(side => names[side.toLowerCase()]).join(' and ')} allowed internet access. Calls outside the model gateway are unverified.</p>}
      </header>
      <div className={styles.toolbar} role="group" aria-label="Comparison view">
        {[
          ['cases', 'Cases'],
          ['settings', `Settings · ${data.differences.length} changed`],
          ['prompts', 'Prompts'],
        ].map(([id, label]) => <button type="button" className={styles.chip} aria-pressed={view === id} key={id} onClick={() => setView(id)}>{label}</button>)}
      </div>
      <div hidden={view !== 'cases'}><CaseResults data={data} pair={`${a},${b}`} initialCaseKey={initialCaseKey} go={go} names={names} /></div>
      {view === 'settings' && <Settings data={data} names={names} />}
      {view === 'prompts' && <Prompts prompt={data.prompt_diff} names={names} />}
    </div>
  );
}
