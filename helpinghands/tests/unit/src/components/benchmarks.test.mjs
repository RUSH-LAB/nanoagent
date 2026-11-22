import {describe, it} from 'node:test';
import {oneAtATime} from '../../../../src/components/Benchmarks/useLoad.js';
import assert from 'node:assert/strict';
import {publishProblem, splitCaseFolder} from '../../../../src/components/Benchmarks/caseFolder.js';
import {filterPlugins} from '../../../../src/components/Benchmarks/filterPlugins.js';
import {aiInstructions, inputFields, instructionsText} from '../../../../src/components/Benchmarks/instructions.js';
import {
  benchmarksOf, compareTable, isBenchmarkRun, filterRuns, harnessNames, historyRuns, installedFirst, scoreText, selectedIn, toggled, toggleSelection, verdictOf,
} from '../../../../src/components/Benchmarks/runs.js';

const PLUGIN = {
  id: 'ab-test', name: 'A/B Test', version: '1.2.0',
  tasks: [{
    id: 'compare-versions', description: 'Compare two versions',
    inputSchema: {
      type: 'object', required: ['csv_path', 'tolerance'],
      properties: {csv_path: {type: 'string', description: 'The data file'}, tolerance: {type: 'number'}, mode: {enum: ['fast', 'slow']}},
    },
  }, {id: 'other-task'}],
};

describe('the instructions for a case folder', () => {
  const text = instructionsText(PLUGIN);

  it('names the plugin id, version and every task', () => {
    assert.match(text, /Plugin id: ab-test \(A\/B Test, version 1\.2\.0\)/);
    assert.match(text, /- compare-versions: Compare two versions/);
    assert.match(text, /- other-task\n {2}no input fields/);
  });

  it('lists each task\'s input fields with their type, whether required, and description', () => {
    assert.deepEqual(inputFields(PLUGIN.tasks[0]).map(field => [field.name, field.type, field.required]), [
      ['csv_path', 'string', true], ['tolerance', 'number', true], ['mode', 'one of "fast", "slow"', false],
    ]);
    assert.match(text, /- csv_path \(string, required\): The data file/);
    assert.match(text, /- mode \(one of "fast", "slow"\)/);
  });

  it('fills the example case file with the plugin, its first task and arguments that fit', () => {
    assert.match(text, /plugin: ab-test\ntask: compare-versions\ncases:/);
    assert.match(text, /arguments:\n {6}csv_path: <csv_path>\n {6}tolerance: 0\.5\n {6}mode: "fast"/);
    assert.match(text, /reference_error:/);
  });

  it('states the folder layout and the rules with the errors the publish gives', () => {
    assert.match(text, /my-benchmark\/\n {2}cases\.yaml/);
    assert.match(text, /the prompt does not state argument/);
    assert.match(text, /the fixtures hold answer\.json at its root, which the platform seeds/);
    assert.match(text, /over the 8388608 a case may have/);
    assert.match(text, /ab-test-01, ab-test-02/);
  });

  it('is copied for an AI as the same text ending with the request to write the case folder', () => {
    const copied = aiInstructions(PLUGIN);
    assert.ok(copied.startsWith(text));
    assert.match(copied.split('REQUEST\n')[1], /^Write cases\.yaml and the fixture folders/);
  });
});

describe('a picked case folder', () => {
  it('takes the one YAML file at the top level as the case file and every other file by its path inside the folder', () => {
    const split = splitCaseFolder(['c/p.yaml', 'c/fixtures/a/x.csv', 'c/notes.txt', 'c/.DS_Store']);
    assert.equal(split.caseFile, 0);
    assert.deepEqual(split.others, [{index: 1, path: 'fixtures/a/x.csv'}, {index: 2, path: 'notes.txt'}]);
  });

  it('is an error unless the top level holds exactly one YAML file', () => {
    assert.match(splitCaseFolder(['c/fixtures/other.yaml']).error, /no YAML case file/);
    assert.match(splitCaseFolder(['c/a.yaml', 'c/b.yml']).error, /2 YAML files \(a\.yaml, b\.yml\)/);
  });

  it('splits a publish error that names its case', () => {
    assert.deepEqual(publishProblem('case p-02: the prompt is empty'), {caseId: 'p-02', text: 'the prompt is empty'});
    assert.deepEqual(publishProblem('the case file is not valid YAML'), {caseId: null, text: 'the case file is not valid YAML'});
  });
});

const summary = (run_id, harness, benchmark = 'b1', version = '1.0.0') => ({
  run_id, harness: {name: harness}, benchmark: {name: benchmark}, plugin: {id: 'p', version},
});
const attempt = (attempt_id, attempt_no, extra = {}) => ({attempt_id, attempt_no, state: 'sealed', ...extra});
const detail = (run_id, harness, cases) => ({run_id, harness: {name: harness}, cases: cases.map(([case_id, attempts]) => ({case_id, attempts}))});

describe('the runs list', () => {
  const runs = [summary('r3', 'claude'), summary('r2', 'codex'), summary('r1', 'claude'), summary('r0', 'pi', 'b2')];

  it('groups runs into the benchmarks they are of, by plugin version and name', () => {
    assert.deepEqual(benchmarksOf(runs).map(one => [one.name, one.runs.length]), [['b1', 3], ['b2', 1]]);
    assert.equal(benchmarksOf([summary('a', 'x', 'b1', '1'), summary('b', 'x', 'b1', '2')]).length, 2);
  });

  it('leaves out Terminal sessions, whose runs are kept under the session case set name', () => {
    const session = {...summary('s1', 'shell'), benchmark: {name: 'harness-session'}};
    assert.equal(isBenchmarkRun(session), false);
    assert.equal(isBenchmarkRun({...session, benchmark: {name: null}}), false);
    assert.equal(isBenchmarkRun(summary('r', 'claude')), true);
    assert.deepEqual(benchmarksOf([session, summary('r', 'claude')]).map(one => one.name), ['b1']);
  });

  it('filters by the picked harnesses, and shows every run when none is picked', () => {
    assert.deepEqual(harnessNames(runs), ['claude', 'codex', 'pi']);
    assert.deepEqual(filterRuns(runs, new Set(['claude'])).map(run => run.run_id), ['r3', 'r1']);
    assert.equal(filterRuns(runs, new Set()).length, 4);
    assert.deepEqual([...toggled(new Set(['a']), 'b')], ['a', 'b']);
    assert.deepEqual([...toggled(new Set(['a']), 'a')], []);
  });

  it('keeps at most two runs selected, a third replacing the oldest, and drops those out of view', () => {
    assert.deepEqual(toggleSelection(['a', 'b'], 'c'), ['b', 'c']);
    assert.deepEqual(toggleSelection(['a', 'b'], 'a'), ['b']);
    assert.deepEqual(selectedIn(['r3', 'zz'], runs), ['r3']);
  });

  it('puts the installed version\'s benchmarks first', () => {
    const list = [
      {plugin: {version: '1'}, published_at: '2026-02', name: 'old-newest'}, {plugin: {version: '2'}, published_at: '2026-01', name: 'installed'},
    ];
    assert.deepEqual(installedFirst(list, '2').map(one => one.name), ['installed', 'old-newest']);
  });
});

describe('verdicts and the compare table', () => {
  it('reads a verdict, or why there is none', () => {
    assert.equal(verdictOf(attempt('a', 1, {verdict: 'pass'})), 'pass');
    assert.equal(verdictOf(attempt('a', 1, {execution: {status: 'worker_error'}})), 'worker error');
    assert.equal(verdictOf(attempt('a', 1, {execution: {status: 'refused', reason: 'x'}})), 'refused:x');
    assert.equal(scoreText({value: null, passed: 0, scored: 0, total: 2, unavailable_reason: 'worker_error'}), 'worker error');
    assert.equal(scoreText({value: 0.5, passed: 1, scored: 2, total: 2, unscored: 0, complete: true}), '0.50 (1/2)');
    // The fraction is the rate's own: passed of the scored cases, with the unscored ones named and a live run marked.
    assert.equal(scoreText({value: 0.75, passed: 3, scored: 4, total: 5, unscored: 1, complete: true}), '0.75 (3/4), 1 unscored');
    assert.equal(scoreText({value: 1, passed: 2, scored: 2, total: 5, unscored: 3, complete: false}), '1.00 (2/2), 3 unscored so far');
    assert.equal(scoreText({value: null, passed: 0, scored: 0, total: 2, unscored: 2, complete: false, unavailable_reason: 'scoring_pending'}), 'unavailable');
  });

  it('tables cases by run with each case\'s newest attempt, and none for a case a run has not reached', () => {
    const table = compareTable([
      detail('r1', 'claude', [['p-01', [attempt('a1', 1, {verdict: 'fail'}), attempt('a2', 2, {verdict: 'pass'})]], ['p-02', [attempt('a3', 1, {verdict: 'pass'})]]]),
      detail('r2', 'codex', [['p-01', [attempt('b1', 1, {verdict: 'fail'})]], ['p-02', []]]),
    ]);
    assert.deepEqual(table.columns, [{runId: 'r1', harness: 'claude'}, {runId: 'r2', harness: 'codex'}]);
    assert.deepEqual(table.rows[0].cells, [{verdict: 'pass', attemptId: 'a2'}, {verdict: 'fail', attemptId: 'b1'}]);
    assert.deepEqual(table.rows[1].cells, [{verdict: 'pass', attemptId: 'a3'}, {verdict: null, attemptId: null}]);
  });
});

describe('searching the member\'s plugins', () => {
  const apps = [
    {id: 'ab-test', name: 'A/B Test', product: {tagline: 'Compare two versions'}},
    {id: 'csv-clean', name: 'Cleaner', product: {tagline: 'Tidy a data file', description: 'Drops EMPTY rows'}},
    {id: 'bare', name: 'Bare'},
  ];

  it('matches name, id and description without regard to case', () => {
    assert.deepEqual(filterPlugins(apps, 'a/b').map(app => app.id), ['ab-test']);
    assert.deepEqual(filterPlugins(apps, 'CSV-').map(app => app.id), ['csv-clean']);
    assert.deepEqual(filterPlugins(apps, 'empty rows').map(app => app.id), ['csv-clean']);
    assert.deepEqual(filterPlugins(apps, 'two VERSIONS').map(app => app.id), ['ab-test']);
  });

  it('keeps every plugin for a blank query and none for a miss', () => {
    assert.equal(filterPlugins(apps, '  ').length, 3);
    assert.deepEqual(filterPlugins(apps, 'zzz'), []);
  });
});


describe('run history', () => {
  it('sorts newest first and combines plugin and multiple harness filters', () => {
    const runs = [
      {...summary('old', 'codex'), created_at: '2026-01-01'},
      {...summary('new', 'codex'), created_at: '2026-03-01'},
      {...summary('other', 'claude'), created_at: '2026-02-01', plugin: {id: 'other'}},
    ];
    assert.deepEqual(historyRuns(runs, {plugins: new Set(), harnesses: new Set()}).map(r => r.run_id), ['new', 'other', 'old']);
    assert.deepEqual(historyRuns(runs, {plugins: new Set(['p']), harnesses: new Set(['codex'])}).map(r => r.run_id), ['new', 'old']);
    assert.deepEqual(historyRuns(runs, {plugins: new Set(), harnesses: new Set(['codex', 'claude'])}).map(r => r.run_id), ['new', 'other', 'old']);
  });
});

describe('polling', () => {
  it('starts no read while the one before it is still under way (a slow trace read was overtaken and thrown away every tick)', async () => {
    let started = 0;
    let finish;
    const tick = oneAtATime(() => { started += 1; return new Promise(resolve => { finish = resolve; }); });
    tick(); tick(); tick();
    assert.equal(started, 1);
    finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    tick();
    assert.equal(started, 2);
  });
});
