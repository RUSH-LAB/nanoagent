import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  caseFileExample, defaultPrompt, describeError, limitOverrides, limitsFormOf, parseCases, promptText, publishText, publishable, publishedLines, taskOf, withPromptEdit,
} from '../../../../src/components/Benchmark/publish.js';
import {screenOf, searchFor} from '../../../../src/components/Benchmark/location.js';

const app = {
  id: 'p', name: 'P', version: '1.0.0', sha256: 'a'.repeat(64), status: 'ready',
  tasks: [{id: 'sum', tools: ['read'], instructions: 'Add them up.'}, {id: 'other', tools: [], instructions: null}],
};
const defaults = {
  limits: {wall_time_ms: 600000, max_model_calls: 50, max_output_tokens_per_call: 4096, max_cost_usd: 1.5, cpus: 1, internet_access: true},
  coding_template: 'Do {description}', placeholders: ['description'], endpoints: [{label: 'mock'}],
};
const caseFile = '{"_": "step2_single_run.Cases", "plugin": "p", "task": "sum", "context": "ctx", "answer": [{"x": 1.0}, {"x": 2}], "refuse": [{"arguments": {"x": "bad"}, "reference_error": "not a number"}]}';
const cases = parseCases(caseFile);
const form = (over = {}) => ({
  app, taskId: 'sum', caseText: caseFile, cases, name: ' sum-v1 ', model: ' vendor/m ', endpoint: 'mock', limits: limitOverrides(limitsFormOf(defaults), defaults), edits: {}, ...over,
});

describe('benchmark publish', () => {
  it('offers the ready apps that have a task', () => {
    assert.deepEqual(publishable([app, {...app, id: 'q', status: 'refused'}, {...app, id: 'r', tasks: []}]).map(item => item.id), ['p']);
    assert.equal(taskOf(app, 'sum').id, 'sum');
    assert.equal(taskOf(app, 'nope'), null);
  });

  it('reads the CLI\'s case file for its plugin, task and counts, and refuses what is not one', () => {
    assert.deepEqual(cases, {plugin: 'p', task: 'sum', answer: 2, refuse: 1});
    assert.match(parseCases('{nope').error, /not valid JSON/);
    assert.match(parseCases('[1]').error, /JSON object/);
    assert.match(parseCases('{"answer": []}').error, /names a plugin and a task/);
  });

  it('sends the case file as it was read, so 1.0 stays 1.0, with the run configuration beside it', () => {
    const {body} = publishText(form());
    assert.ok(body.includes('"x": 1.0'), 'the case file text is embedded untouched');
    assert.deepEqual(Object.keys(JSON.parse(body)), ['plugin_id', 'name', 'cases', 'model', 'endpoint_profile', 'limits', 'coding_template', 'task_instructions']);
    assert.deepEqual({...JSON.parse(body), cases: null}, {
      plugin_id: 'p', name: 'sum-v1', cases: null, model: 'vendor/m', endpoint_profile: 'mock', limits: {}, coding_template: null, task_instructions: null,
    });
  });

  it('sends only the limits and prompts that differ from the defaults', () => {
    const changed = limitOverrides({...limitsFormOf(defaults), values: {...limitsFormOf(defaults).values, max_model_calls: '20'}, internet: false}, defaults);
    const edits = withPromptEdit({}, 'task_tools', 'My instructions', defaultPrompt('task_tools', defaults, taskOf(app, 'sum')));
    const sent = JSON.parse(publishText(form({limits: changed, edits})).body);
    assert.deepEqual(sent.limits, {max_model_calls: 20, internet_access: false});
    assert.deepEqual([sent.coding_template, sent.task_instructions], [null, 'My instructions']);
  });

  it('pre-fills every limit from the defaults, and refuses one that is not a number', () => {
    const limitsForm = limitsFormOf(defaults);
    assert.deepEqual(limitsForm, {values: {wall_time_ms: '600000', max_model_calls: '50', max_output_tokens_per_call: '4096', max_cost_usd: '1.5', cpus: '1'}, internet: true});
    assert.deepEqual(limitOverrides(limitsForm, defaults), {overrides: {}});
    assert.deepEqual(limitOverrides({values: {...limitsForm.values, max_cost_usd: '0.10', max_model_calls: '20', cpus: '0.5'}, internet: false}, defaults),
      {overrides: {max_cost_usd: 0.1, max_model_calls: 20, cpus: 0.5, internet_access: false}});
    assert.deepEqual(limitOverrides({values: {...limitsForm.values, max_model_calls: '0'}, internet: true}, defaults), {overrides: {max_model_calls: 0}});
    assert.match(limitOverrides({values: {...limitsForm.values, wall_time_ms: '1.5'}, internet: true}, defaults).error, /Wall time \(ms\) must be a whole number above 0/);
    assert.match(limitOverrides({values: {...limitsForm.values, max_cost_usd: ''}, internet: true}, defaults).error, /Cost \(USD\) must be a number above 0/);
    assert.match(limitOverrides({values: {...limitsForm.values, cpus: '0'}, internet: true}, defaults).error, /CPUs/);
  });

  it('starts each policy\'s prompt from its default, and an edit that returns to the default is no edit', () => {
    const task = taskOf(app, 'sum');
    assert.equal(defaultPrompt('coding', defaults, task), 'Do {description}');
    assert.equal(defaultPrompt('task_tools', defaults, task), 'Add them up.');
    assert.equal(defaultPrompt('task_tools', defaults, taskOf(app, 'other')), '');
    const fallback = defaultPrompt('coding', defaults, task);
    let edits = withPromptEdit({}, 'coding', 'My template {description}', fallback);
    assert.equal(promptText(edits, 'coding', fallback), 'My template {description}');
    assert.equal(promptText(edits, 'task_tools', 'Add them up.'), 'Add them up.', 'the other policy keeps its own prompt');
    edits = withPromptEdit(edits, 'coding', fallback, fallback);
    assert.equal(edits.coding, null);
  });

  it('documents a case-file shape the form accepts and names malformed fields', () => {
    const example = caseFileExample();
    assert.deepEqual(parseCases(example), {plugin: 'bounded-sum', task: 'add-nonnegative', answer: 2, refuse: 1});
    const file = JSON.parse(example);
    assert.match(parseCases(JSON.stringify({...file, context: null})).error, /context string/);
    assert.match(parseCases(JSON.stringify({...file, answer: ['bad']})).error, /answer field/);
    assert.match(parseCases(JSON.stringify({...file, refuse: [{arguments: {}}]})).error, /refuse field/);
    assert.match(parseCases(JSON.stringify({...file, answer: [], refuse: []})).error, /at least one/);
  });

  it('names what is missing or wrong before anything is pinned', () => {
    for (const [over, message] of [
      [{app: null}, 'Choose a plugin'], [{taskId: ''}, 'Choose a task'], [{cases: null}, 'Upload a case file'],
      [{cases: {...cases, task: 'other'}}, 'The case file is for p other, not p sum'], [{model: ' '}, 'Name the model'], [{endpoint: ''}, 'Choose an endpoint'],
      [{limits: {error: 'Cost (USD) must be a number above 0'}}, 'Cost (USD) must be a number above 0'], [{name: ' '}, 'Name the benchmark'],
      [{name: 'Bad Name'}, 'Enter a benchmark name using the format above.'],
    ]) assert.equal(publishText(form(over)).error, message);
  });

  it('reports the published benchmark with its plugin version, and an unchanged republish as such', () => {
    const result = {created: true, benchmark: {
      benchmark_id: 'b1', name: 'sum-v1', plugin: {id: 'p', name: 'P', version: '1.0.0'}, task_id: 'sum', task_kind: 'agent', case_count: 3, answer_count: 2, refuse_count: 1,
      model: 'vendor/m', endpoint_profile: 'mock', limits: {internet_access: false}, digest: 'd'.repeat(64),
    }};
    assert.deepEqual(publishedLines(result), {headline: 'Benchmark published', facts: [
      ['Benchmark', 'sum-v1'], ['Plugin', 'P v1.0.0'], ['Task', 'sum (agent)'], ['Cases', '3 (2 to answer, 1 to refuse)'], ['Model', 'vendor/m'], ['Endpoint', 'mock'],
      ['Internet access', 'off'], ['Digest', 'd'.repeat(64)],
    ]});
    assert.match(publishedLines({...result, created: false}).headline, /already published/);
  });

  it('shows a taken name and the limits over a worker\'s clearly', () => {
    const taken = describeError(Object.assign(new Error('Benchmark sum-v1 is published for p 1.0.0 with different content'), {status: 409, details: {code: 'benchmark_name_taken'}}));
    assert.match(taken.message, /different content/);
    assert.deepEqual(taken.lines, ['A published benchmark never changes. Use a new name for changed cases, model, limits or prompts.']);
    const over = describeError(Object.assign(new Error('workers cannot'), {details: {code: 'limit_exceeds_worker', exceeded: [{field: 'max_cost_usd', limit: 2, max: 1}]}}));
    assert.deepEqual(over.lines, ['Cost (USD): 2 is above the worker\'s 1']);
  });

  it('opens Create Plugin Benchmark from the address, and Benchmark Your Harness on a published benchmark', () => {
    assert.equal(screenOf('?view=publish').screen, 'publish');
    assert.equal(searchFor({view: 'publish'}), '?view=publish');
    assert.equal(screenOf('?view=other').screen, 'runs');
    const result = screenOf(searchFor({view: 'new', plugin: 'p', benchmark: '1f0c0000-aaaa-4bbb-8ccc-dddddddddddd'}));
    assert.equal(result.screen, 'new');
    assert.deepEqual(result.initialSelection, {plugin: 'p', benchmark: '1f0c0000-aaaa-4bbb-8ccc-dddddddddddd'});
  });
});
