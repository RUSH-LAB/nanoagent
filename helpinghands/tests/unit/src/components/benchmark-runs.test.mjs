import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {attemptStatus, explanationText, liveAttempts, outcomeText, runIsActive, runPairProblem, runSummary, personLabel, scoreText, toggleRun, verdictText} from '../../../../src/components/Benchmark/runs.js';
import {screenOf, searchFor} from '../../../../src/components/Benchmark/location.js';

const attempt = (id, state, extra = {}) => ({attempt_id: id, state, sealed: state === 'final', execution: state === 'final' ? {status: 'answered', reason: null} : null, cancel_requested: false, ...extra});
const run = {
  status: 'running',
  cases: [
    {case_id: 'c1', latest_attempt_id: 'a2', attempts: [attempt('a1', 'final'), attempt('a2', 'final')]},
    {case_id: 'c2', latest_attempt_id: 'b1', attempts: [attempt('b1', 'leased')]},
    {case_id: 'c3', latest_attempt_id: 'c1', attempts: [attempt('c1', 'queued')]},
  ],
};
const ID = n => `${String(n).repeat(8)}-1111-4111-8111-${String(n).repeat(12)}`;

describe('benchmark run view', () => {
  it('says what each attempt is doing', () => {
    assert.deepEqual([attempt('x', 'queued'), attempt('x', 'leased'), attempt('x', 'leased', {cancel_requested: true}), attempt('x', 'final'),
      attempt('x', 'final', {execution: {status: 'build_failed'}})].map(attemptStatus), ['Queued', 'Running', 'Canceling', 'Answered', 'Build failed']);
  });

  it('streams only the attempts a worker holds, and keeps reading a run until it is done', () => {
    assert.deepEqual(liveAttempts(run), ['b1']);
    assert.equal(runIsActive(run), true);
    assert.equal(runIsActive({...run, status: 'complete'}), false);
    assert.equal(runIsActive({...run, status: 'canceled'}), false);
  });

  it('writes a run\'s score object, with what it covers, or why it is unavailable', () => {
    const score = {value: 0.5, passed: 1, scored: 2, total: 3, unscored: 1, verifier_errors: 1, complete: false, unavailable_reason: null};
    assert.equal(scoreText(score), '0.5 (1 of 2 scored passed, 1 unscored (1 verifier error), provisional)');
    assert.equal(scoreText({...score, value: 1 / 3, passed: 1, scored: 3, unscored: 0, verifier_errors: 0, complete: true}), '0.3333 (1 of 3 scored passed)');
    assert.equal(scoreText({value: null, unavailable_reason: 'scoring_pending'}), 'Unavailable: scoring is pending');
    assert.equal(scoreText({value: null, unavailable_reason: 'verifier_error'}), 'Unavailable: the verifier reported an error');
    assert.equal(scoreText({value: null, unavailable_reason: 'no_scored_cases'}), 'Unavailable: no case has a verdict');
    assert.equal(scoreText(undefined), 'Unavailable');
  });

  it('labels a case\'s verdict, its explanation code and its outcome for people', () => {
    assert.deepEqual([{verdict: 'pass'}, {verdict: 'fail'}, {verdict: null, verifier_error: 'crash'}, {verdict: null}].map(verdictText), ['Pass', 'Fail', 'Verifier error', '–']);
    assert.equal(explanationText('answered_refusal_case'), 'The harness answered a case it should have refused.');
    assert.equal(explanationText('refused_answer_case'), 'The harness refused a case that has an answer.');
    assert.equal(explanationText('invalid_answer'), 'The answer does not have the shape the task requires.');
    assert.equal(explanationText('execution_failed'), 'The harness did not produce a result.');
    assert.equal(explanationText('novel_code'), 'novel_code');
    assert.equal(explanationText(null), '');
    assert.deepEqual(['answered', 'build_failed', 'queued', null].map(outcomeText), ['Answered', 'Build failed', 'Queued', '–']);
  });

  it('ticks at most two runs, the newest replacing the oldest, and offers to compare runs of one plugin', () => {
    const runs = [{run_id: 'r1', plugin: {id: 'p'}}, {run_id: 'r2', plugin: {id: 'p'}}, {run_id: 'r3', plugin: {id: 'q'}}];
    assert.deepEqual(toggleRun(toggleRun(toggleRun([], 'r1', runs), 'r2', runs), 'r3', runs), ['r2', 'r3']);
    assert.deepEqual(toggleRun(['r1', 'gone'], 'r2', runs), ['r1', 'r2']);
    assert.deepEqual(toggleRun(['r1'], 'r1', runs), []);
    assert.equal(runPairProblem(['r1', 'r2'], runs), null);
    assert.match(runPairProblem(['r1'], runs), /Tick two runs/);
    assert.match(runPairProblem(['r1', 'r3'], runs), /same plugin/);
  });
});

const summary = (over = {}) => ({
  run_id: 'r1', harness: {name: 'my-harness', version: '1.3'}, benchmark: {name: 'acceptance-probe'}, plugin: {id: 'classroom', name: 'classroom', version: '0.1.0'},
  model: 'deepseek/deepseek-v4-flash', policy: 'coding', user: {id: 'u1', name: 'Jane Doe', github: 'jdoe'},
  metrics: {total_tokens: {total: 48210, missing_attempts: 0}, elapsed_ms: {total: 134000, missing_attempts: 0}},
  status: 'complete', score: {value: 0.8, passed: 8, scored: 10, total: 10, unscored: 0, verifier_errors: 0, complete: true, unavailable_reason: null},
  created_at: '2026-01-01T00:00:00Z', ...over,
});

describe('benchmark run summary card', () => {
  it('labels a finished run: harness, plugin and benchmark, status, model, tokens, elapsed time and user', () => {
    assert.deepEqual(runSummary(summary()), {
      title: 'my-harness v1.3', subtitle: 'classroom · acceptance-probe v0.1.0', status: 'Passed 8/10', tone: 'partial', model: 'deepseek/deepseek-v4-flash',
      tokens: '48,210 tokens', elapsed: '2 m 14 s', user: 'Jane Doe (@jdoe)', select: {checked: false, label: 'Select'},
    });
    assert.equal(runSummary(summary({score: {value: 1, passed: 10, scored: 10, total: 10, complete: true}})).tone, 'good');
    assert.equal(runSummary(summary({score: {value: 0, passed: 0, scored: 10, total: 10, complete: true}})).status, 'Passed 0/10');
    assert.equal(runSummary(summary({score: {value: 0, passed: 0, scored: 10, total: 10, complete: true}})).tone, 'bad');
  });

  it('says so far while a run is live, whatever its status line', () => {
    const live = runSummary(summary({status: 'running', score: {value: 0.5, passed: 3, scored: 6, total: 10, complete: false}}));
    assert.equal(live.status, 'Running · 3/10 passed so far');
    assert.equal(live.tokens, '48,210 tokens so far');
    assert.equal(live.elapsed, '2 m 14 s so far');
    assert.equal(runSummary(summary({status: 'queued', score: {value: null, unavailable_reason: 'scoring_pending'}, metrics: {}})).status, 'Queued');
    assert.equal(runSummary(summary({status: 'running', score: {value: null, unavailable_reason: 'scoring_pending'}})).status, 'Running');
  });

  it('shows a metric some attempts did not report as partial with the count, and one nobody reported as unknown', () => {
    const partial = runSummary(summary({metrics: {total_tokens: {total: 900, missing_attempts: 1}, elapsed_ms: {total: 2000, missing_attempts: 2}}}));
    assert.equal(partial.tokens, '900 tokens (partial: 1 attempt without it)');
    assert.equal(partial.elapsed, '2.00 s (partial: 2 attempts without it)');
    const none = runSummary(summary({metrics: {total_tokens: {total: null, missing_attempts: 3}, elapsed_ms: {total: null, missing_attempts: 3}}}));
    assert.equal(none.tokens, 'tokens unknown (partial: 3 attempts without it)');
    assert.equal(none.elapsed, 'unknown (partial: 3 attempts without it)');
  });

  it('names a user without a GitHub login by name alone', () => {
    assert.equal(runSummary(summary({user: {id: 'u2', name: 'Vic', github: null}})).user, 'Vic');
    assert.equal(personLabel({id: 'u1', name: 'Una', github: 'una'}), 'Una (@una)');
    assert.equal(personLabel(null), '');
  });

  it('reports a canceled run and a final run without a score', () => {
    assert.equal(runSummary(summary({status: 'canceled'})).status, 'Canceled');
    assert.equal(runSummary(summary({score: {value: null, unavailable_reason: 'verifier_error'}})).status, 'Score unavailable');
  });

  it('shows the Select state: the box unticked, or ticked as run A or run B in the order ticked', () => {
    assert.deepEqual(runSummary(summary(), []).select, {checked: false, label: 'Select'});
    assert.deepEqual(runSummary(summary(), ['r1']).select, {checked: true, label: 'Run A'});
    assert.deepEqual(runSummary(summary(), ['r2', 'r1']).select, {checked: true, label: 'Run B'});
    assert.deepEqual(runSummary(summary(), ['r2']).select, {checked: false, label: 'Select'});
  });
});

describe('benchmark screen address', () => {
  it('reads the screen from the query, the most specific first', () => {
    assert.equal(screenOf('').screen, 'runs');
    assert.equal(screenOf('?view=new').screen, 'new');
    assert.equal(screenOf('?view=all').screen, 'all');
    assert.deepEqual(screenOf(searchFor({view: 'new', plugin: 'p', benchmark: 'b1'})).initialSelection, {plugin: 'p', benchmark: 'b1'});
    assert.deepEqual(screenOf(`?run=${ID(1)}`), {screen: 'run', run: ID(1), runs: null, attempt: null, compare: null});
    assert.equal(screenOf(`?run=${ID(1)}&attempt=${ID(2)}`).screen, 'attempt');
    assert.deepEqual(screenOf(`?run=${ID(1)}&compare=${ID(2)},${ID(3)}`).compare, [ID(2), ID(3)]);
    assert.deepEqual(screenOf(`?runs=${ID(2)},${ID(3)}`), {screen: 'compare-runs', run: null, runs: [ID(2), ID(3)], attempt: null, compare: null});
  });

  it('keeps the run pair a trace or an attempt comparison was opened from, so Back returns to it', () => {
    const trace = screenOf(`?runs=${ID(2)},${ID(3)}&attempt=${ID(4)}`);
    assert.deepEqual([trace.screen, trace.runs, trace.attempt], ['attempt', [ID(2), ID(3)], ID(4)]);
    const attempts = screenOf(`?runs=${ID(2)},${ID(3)}&compare=${ID(4)},${ID(5)}`);
    assert.deepEqual([attempts.screen, attempts.runs, attempts.compare], ['compare', [ID(2), ID(3)], [ID(4), ID(5)]]);
  });

  it('ignores ids that are not UUIDs and a comparison of an attempt with itself', () => {
    assert.equal(screenOf('?run=../../x').screen, 'runs');
    assert.equal(screenOf(`?compare=${ID(2)},${ID(2)}`).screen, 'runs');
    assert.equal(screenOf(`?compare=${ID(2)}`).screen, 'runs');
    assert.equal(screenOf(`?runs=${ID(2)},${ID(2)}`).screen, 'runs');
  });

  it('keeps the selected case when opening and returning from a compared trace', () => {
    const runs = [ID(2), ID(3)];
    const caseKey = JSON.stringify(['case a', 'case/b']);
    const trace = screenOf(searchFor({runs, caseKey, attempt: ID(4)}));
    assert.equal(trace.caseKey, caseKey);
    const comparison = screenOf(searchFor({runs: trace.runs, caseKey: trace.caseKey}));
    assert.equal(comparison.screen, 'compare-runs');
    assert.equal(comparison.caseKey, caseKey);
    assert.equal(screenOf(searchFor({run: ID(2), caseKey})).caseKey, undefined);
  });

  it('writes the query for a screen and reads it back', () => {
    for (const target of [{}, {view: 'new'}, {run: ID(1)}, {run: ID(1), attempt: ID(2)}, {run: ID(1), compare: `${ID(2)},${ID(3)}`}, {runs: `${ID(2)},${ID(3)}`}, {runs: `${ID(2)},${ID(3)}`, attempt: ID(4)}]) {
      const back = screenOf(searchFor(target));
      assert.equal(searchFor({view: back.screen === 'new' ? 'new' : undefined, run: back.run, runs: back.runs?.join(','), attempt: back.attempt, compare: back.compare?.join(',')}), searchFor(target));
    }
  });
});
