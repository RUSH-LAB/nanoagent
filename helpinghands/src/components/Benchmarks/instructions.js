/**
 * The instructions for writing a benchmark's case folder, for the chosen plugin: shown above the Publish form and copied for an AI.
 * The rules and their errors are the ones the publish checks (server/benchmark/validate.js and NanoAgent's uploaded/case_sets.py).
 */

const typeText = schema => {
  if (Array.isArray(schema.enum)) return `one of ${schema.enum.map(value => JSON.stringify(value)).join(', ')}`;
  const type = schema.type ?? (schema.anyOf ?? []).map(option => option.type).filter(Boolean);
  return Array.isArray(type) ? type.join(' or ') || 'any' : type;
};

/** A task's input fields, the keys of a case's `arguments`: `{name, type, required, description}` each, from its manifest's input schema. */
export function inputFields(task) {
  const required = task.inputSchema?.required ?? [];
  return Object.entries(task.inputSchema?.properties ?? {}).map(([name, schema]) => ({
    name, type: typeText(schema), required: required.includes(name), description: schema.description ?? '',
  }));
}

/** A value of `schema`'s type for the example, so the example's arguments fit the task. */
function exampleValue(name, schema) {
  if (Array.isArray(schema.enum)) return JSON.stringify(schema.enum[0]);
  switch (schema.type) {
    case 'boolean': return 'true';
    case 'integer': return '1';
    case 'number': return '0.5';
    case 'array': return '[]';
    case 'object': return '{}';
    default: return `<${name}>`;
  }
}

function taskLines(task) {
  const fields = inputFields(task);
  return [
    `- ${task.id}${task.description ? `: ${task.description}` : ''}`,
    ...(fields.length
      ? ['  input fields (the keys of `arguments`):', ...fields.map(field => `    - ${field.name} (${field.type}${field.required ? ', required' : ''})${field.description ? `: ${field.description}` : ''}`)]
      : ['  no input fields: `arguments` is {}']),
  ];
}

function example(plugin) {
  const task = plugin.tasks[0];
  const fields = inputFields(task);
  const values = fields.map(field => [field.name, exampleValue(field.name, task.inputSchema.properties[field.name])]);
  const stated = values.map(([name, value]) => `${name} ${value}`).join(', ');
  const prompt = `    Say what the agent is to do, and write every argument value in it${stated ? `: ${stated}` : ''}.`;
  const args = values.length ? values.map(([name, value]) => `      ${name}: ${value}`).join('\n') : '      {}';
  return `plugin: ${plugin.id}
task: ${task.id}
cases:
- prompt: |-
${prompt}
  arguments:
${args}
  fixtures: fixtures/scenario_a
refuse:
- prompt: |-
${prompt}
  arguments:
${args}
  reference_error: <text the plugin's error contains when it rejects this input>`;
}

/** The instructions for `plugin` (`{id, name, version, tasks}` as the installed app lists it). */
export function instructionsText(plugin) {
  return `PLUGIN
Plugin id: ${plugin.id} (${plugin.name}, version ${plugin.version}). Write it as \`plugin\` exactly as shown.
Tasks (write one task id as \`task\`):
${plugin.tasks.flatMap(taskLines).join('\n')}

THE FOLDER
Pick one folder. Its top level holds exactly one case file (a .yaml or .yml file). Every other file in it is a fixture that a case can name. .DS_Store is ignored.

my-benchmark/
  cases.yaml
  fixtures/
    scenario_a/
      inputs/data.csv
    scenario_b/
      inputs/data.csv

THE CASE FILE
A YAML mapping with these keys and no others:
- plugin: the plugin's id, as above.
- task: one of the plugin's task ids, as above.
- cases: the cases the agent must answer. Each has:
  - prompt: what the agent is told. Not empty, no leading or trailing whitespace.
  - arguments: the task's input. It must fit the task's input fields above.
  - fixtures (optional): a folder, relative to the case file, whose files are copied into the case's workspace before the agent starts.
- refuse: the cases the agent must refuse. Same keys, plus reference_error: text the plugin's error must contain when it rejects this input. Use refuse: [] for none.

${example(plugin)}

RULES THE PUBLISH CHECKS
- The name is lowercase letters, digits, ".", "_" or "-", starts with a letter or digit, and is at most 128 characters. Error: name is lowercase letters, digits, ".", "_" and "-".
- The name is unique for the plugin's version. Publishing the same benchmark again changes nothing; different content under a taken name is refused: a changed benchmark needs a new name.
- The case file is valid YAML with the keys above. Errors: the case file is not valid YAML at line N, column M: ...; the case file does not fit the case file shape: ...
- The case file's plugin is this plugin and its task is one of its tasks. Errors: the cases are for X, not ${plugin.id}; ${plugin.id} has an unknown task: T.
- There is at least one case across cases and refuse. Error: the cases file for ${plugin.id} <task> has no cases: both \`cases\` and \`refuse\` are empty.
- Each prompt is not empty and has no leading or trailing whitespace. Errors: case ${plugin.id}-01: the prompt is empty; case ${plugin.id}-01: the prompt starts or ends with whitespace.
- Each case's arguments fit the task's input fields. Error: case ${plugin.id}-01: its arguments do not fit the input of task T: ...
- Every string and number in arguments is written out in the prompt (whitespace runs count as one space; a number by its JSON text). The agent only sees the prompt, so anything it needs must be in it. Error: case ${plugin.id}-01: the prompt does not state argument NAME (VALUE).
- A fixtures folder is inside the case folder, holds only regular files (no symlinks), weighs at most 8 MB gzipped, and has no answer.json at its root (the platform writes that file). Errors: case ${plugin.id}-01: the fixtures F are not a folder of the uploaded case folder; ...the fixture X is a symlink; ...the fixtures weigh N bytes gzipped, over the 8388608 a case may have; ...the fixtures hold answer.json at its root, which the platform seeds.
- The plugin's reference tool answers every case in cases and rejects every case in refuse with an error containing its reference_error. Errors: case ${plugin.id}-01: <tool> could not answer {...}, a case to answer: ...; <tool> rejected {...} without 'TEXT': ...; <tool> answered {...}, a case to refuse.
- A task with no reference tool (an agent or decide task whose manifest declares none) cannot have cases to refuse. Error: case ${plugin.id}-NN: task T has no reference tool, so nothing can confirm that its input is to be refused ...

WHAT PUBLISHING DOES
Your installed plugin runs its reference tool on each case on your computer to pin the right answer, so RUSH Lab must be running. Case ids are given in order: ${plugin.id}-01, ${plugin.id}-02, ..., the cases to answer first. Anyone with the plugin can then run the benchmark.`;
}

/** The same instructions with a request to write the case folder, for pasting into an AI. */
export const aiInstructions = plugin => `${instructionsText(plugin)}

REQUEST
Write cases.yaml and the fixture folders it names for my goal, which I describe next. Follow every rule above: use plugin ${plugin.id}, one of its tasks, arguments that fit its input fields, and a prompt that states every argument value. Cover ordinary and edge inputs. Give each file with its path inside the folder, ready to save.`;
