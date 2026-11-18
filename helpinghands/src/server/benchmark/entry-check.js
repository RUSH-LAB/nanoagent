'use strict';

const {BenchmarkError} = require('./errors');

/**
 * Check a publication's task against the catalog entry the server stored for that plugin version (market_plugin_version.entry,
 * NanoAgent's `Manifest.public()`), as NanoAgent derived it (`derive_case_set`): the plugin's name, the task's kind, description and
 * instructions, its tools (less the reference tool) and egress hosts. The entry keeps schemas only as class names, so the schemas are not checked.
 */
function checkTaskAgainstEntry(entry, benchmark) {
  const {task} = benchmark;
  const declared = entry.tasks?.find(candidate => candidate.id === benchmark.task_id);
  const writes = (entry.permissions?.filesystem?.write ?? []).length > 0;
  const tools = (declared?.tools ?? []).filter(name => name !== declared.reference).map(name => {
    const tool = entry.tools?.find(candidate => candidate.name === name);
    return {name, description: tool?.description, writes};
  });
  const expected = declared && {
    plugin_name: entry.name, kind: declared.runner, description: declared.description, instructions: declared.instructions,
    egress_hosts: [...new Set(entry.permissions?.network?.hosts ?? [])].sort(), tools,
  };
  const given = {
    plugin_name: benchmark.plugin_name, kind: task.kind, description: task.description, instructions: task.instructions, egress_hosts: task.egress_hosts,
    tools: task.tools.map(({name, description, writes: toolWrites}) => ({name, description, writes: toolWrites})),
  };
  const differing = expected ? Object.keys(expected).filter(key => JSON.stringify(expected[key]) !== JSON.stringify(given[key])) : ['task_id'];
  if (differing.length) {
    throw new BenchmarkError(422, 'task_mismatch', `The task does not match ${benchmark.plugin_id} ${benchmark.version}'s package: ${differing.join(', ')} differ`, {differing});
  }
}

module.exports = {checkTaskAgainstEntry};
