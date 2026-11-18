/** The All Benchmark Results logic: choosing plugin, plugin version and benchmark from every published benchmark, and arranging a benchmark's run summaries. */
import {POLICY_LABELS, personLabel} from './runs.js';

/** The plugins the benchmarks are for, in order of first appearance: `{id, name, count}`. */
export function pluginsOf(benchmarks) {
  const plugins = new Map();
  for (const {plugin} of benchmarks) plugins.set(plugin.id, {id: plugin.id, name: plugin.name ?? plugin.id, count: (plugins.get(plugin.id)?.count ?? 0) + 1});
  return [...plugins.values()];
}

/** The versions of one plugin that have benchmarks, in order of first appearance, each with how many: `{version, count}`. */
export function versionsOf(benchmarks, pluginId) {
  const versions = new Map();
  for (const {plugin} of benchmarks) if (plugin.id === pluginId) versions.set(plugin.version, (versions.get(plugin.version) ?? 0) + 1);
  return [...versions].map(([version, count]) => ({version, count}));
}

/** The benchmarks of one plugin version. */
export const benchmarksOf = (benchmarks, pluginId, version) => benchmarks.filter(item => item.plugin.id === pluginId && item.plugin.version === version);

/**
 * A benchmark's run summaries as the Coding section then the Task tools section, each `{policy, label, groups}`: the runs of one member's
 * harness version together (`user.id` + `harness.name@version`), a group's runs and the groups in the order given (newest first).
 */
export function resultSections(runs) {
  return Object.keys(POLICY_LABELS).map(policy => {
    const groups = new Map();
    for (const run of runs.filter(item => item.policy === policy)) {
      const key = `${run.user.id}\n${run.harness.name}@${run.harness.version}`;
      if (!groups.has(key)) groups.set(key, {key, label: `${personLabel(run.user)} · ${run.harness.name}@${run.harness.version}`, runs: []});
      groups.get(key).runs.push(run);
    }
    return {policy, label: POLICY_LABELS[policy], groups: [...groups.values()]};
  });
}
