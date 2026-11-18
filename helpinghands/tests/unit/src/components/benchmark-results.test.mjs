import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {benchmarksOf, pluginsOf, resultSections, versionsOf} from '../../../../src/components/Benchmark/results.js';

const benchmark = (id, pluginId, version) => ({benchmark_id: id, name: id, plugin: {id: pluginId, name: pluginId.toUpperCase(), version}});
const list = [benchmark('b1', 'p', '0.2.0'), benchmark('b2', 'q', '1.0.0'), benchmark('b3', 'p', '0.1.0'), benchmark('b4', 'p', '0.2.0')];

const run = (id, policy, user, name, version) => ({run_id: id, policy, user: {id: user, name: user.toUpperCase(), github: user === 'a' ? 'aa' : null}, harness: {name, version}});

describe('benchmark all results', () => {
  it('lists the plugins, then a plugin\'s versions, then a version\'s benchmarks, from every published benchmark', () => {
    assert.deepEqual(pluginsOf(list), [{id: 'p', name: 'P', count: 3}, {id: 'q', name: 'Q', count: 1}]);
    assert.deepEqual(versionsOf(list, 'p'), [{version: '0.2.0', count: 2}, {version: '0.1.0', count: 1}]);
    assert.deepEqual(versionsOf(list, 'none'), []);
    assert.deepEqual(benchmarksOf(list, 'p', '0.2.0').map(item => item.benchmark_id), ['b1', 'b4']);
    assert.deepEqual(benchmarksOf(list, 'p', '9'), []);
  });

  it('arranges the runs as a Coding section then a Task tools section, grouped by user and harness version', () => {
    const runs = [
      run('r1', 'coding', 'a', 'h', '1'), run('r2', 'task_tools', 'b', 'h', '1'), run('r3', 'coding', 'a', 'h', '1'),
      run('r4', 'coding', 'b', 'h', '1'), run('r5', 'coding', 'a', 'h', '2'),
    ];
    const sections = resultSections(runs);
    assert.deepEqual(sections.map(section => [section.policy, section.label]), [['coding', 'Coding'], ['task_tools', 'Task tools']]);
    assert.deepEqual(sections[0].groups.map(group => [group.label, group.runs.map(item => item.run_id)]), [
      ['A (@aa) · h@1', ['r1', 'r3']], ['B · h@1', ['r4']], ['A (@aa) · h@2', ['r5']],
    ]);
    assert.deepEqual(sections[1].groups.map(group => [group.label, group.runs.map(item => item.run_id)]), [['B · h@1', ['r2']]]);
  });

  it('keeps two members\' harnesses of the same name and version apart, and shows an empty policy as an empty section', () => {
    const sections = resultSections([run('r1', 'coding', 'a', 'h', '1'), run('r2', 'coding', 'b', 'h', '1')]);
    assert.equal(sections[0].groups.length, 2);
    assert.deepEqual(sections[1].groups, []);
    assert.deepEqual(resultSections([]).map(section => section.groups), [[], []]);
  });
});
