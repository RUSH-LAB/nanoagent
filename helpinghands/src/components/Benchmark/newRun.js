/** Labels shared by benchmark publication, results, and harness setup. */
import {personLabel} from './runs.js';
import {plural} from './labels.js';

export const POLICIES = [
  ['coding', 'Coding', 'Use this for a coding agent or standalone solver. It receives a prompt with the case inputs and schemas, uses its own tools such as scripts or shell commands, and writes answer.json in the case workspace. Plugin tools are unavailable.'],
  ['task_tools', 'Task tools', 'Use this to test a harness with the plugin’s task instructions and tools. The harness can call the approved plugin tools through RUSH and writes its answer or refusal to the RUSH_RESULT path.'],
];

/** A benchmark's card: name, task, creator, cases, model, runs and runners. */
export const benchmarkCard = benchmark => ({
  id: benchmark.benchmark_id,
  name: benchmark.name,
  task: benchmark.task_id,
  creator: personLabel(benchmark.publisher),
  cases: `${plural(benchmark.case_count, 'case')} (${benchmark.answer_count} answer, ${benchmark.refuse_count} refuse)`,
  model: benchmark.model,
  runs: plural(benchmark.run_count, 'run'),
  runners: plural(benchmark.runner_count, 'runner'),
});

/** The harness identity the uploaded manifest declared, as the labelled facts the form echoes. */
export const harnessFacts = ({harness}) => [['Name', harness.name], ['Version', harness.version], ['Dialects', harness.dialects.join(', ')]];
