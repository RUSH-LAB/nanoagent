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

/** A case folder's layout, each part with what it is. */
export const FOLDER_LAYOUT = `my-benchmark/
  cases.yaml            the case file: the one .yaml or .yml file at the top level
  fixtures/             every other file is a fixture a case can name (any folder names)
    scenario_a/         named by a case as  fixtures: fixtures/scenario_a
      inputs/data.csv   copied into that case's workspace as inputs/data.csv
    scenario_b/
      inputs/data.csv`;

/** The case file's keys: `{key, required, text}` each, `required` as shown. */
export const CASE_FILE_FIELDS = [
  {key: 'plugin', required: 'required', text: "The plugin's id, exactly as shown."},
  {key: 'task', required: 'required', text: "One of the plugin's task ids. A benchmark covers one task."},
  {key: 'cases', required: 'required, [] for none', text: 'The cases the agent must answer: a list of mappings with prompt, arguments and fixtures.'},
  {key: 'cases[].prompt', required: 'required', text: 'What the agent is told. It states every argument value and tells the agent to write its result into answer.json. Not empty, no leading or trailing whitespace.'},
  {key: 'cases[].arguments', required: 'required', text: "The task's input: a mapping that fits the task's input fields, {} when it has none."},
  {key: 'cases[].fixtures', required: 'optional', text: "A folder relative to the case file. Its files are copied into the case's workspace before the agent starts, keeping their paths inside the folder."},
  {key: 'refuse', required: 'required, [] for none', text: 'The cases the agent must refuse: a list of mappings with the same keys as cases, plus reference_error.'},
  {key: 'refuse[].reference_error', required: 'required', text: "Text the plugin's error contains when it rejects this input."},
];

/** What the prompt must say about answer.json, the file the agent's answer is read from. */
export const ANSWER_FILE_TEXT = 'The agent answers by editing answer.json in its workspace, and nothing else is read. The platform puts the file there before the agent starts, holding every field of the task\'s answer, each unfilled. Each prompt must tell the agent to fill in every field of answer.json with its result, keeping the file\'s shape, and, for an input it cannot answer, to replace the whole file with {"refused": "<why>"}. An answer.json left unfilled scores as no answer.';

/** An example case file for `plugin`'s first task, with arguments that fit it. */
export function exampleCaseFile(plugin) {
  const task = plugin.tasks[0];
  const fields = inputFields(task);
  const values = fields.map(field => [field.name, exampleValue(field.name, task.inputSchema.properties[field.name])]);
  const stated = values.map(([name, value]) => `${name} ${value}`).join(', ');
  const prompt = `    Say what the agent is to do, and write every argument value in it${stated ? `: ${stated}` : ''}.
    Fill in every field of answer.json with the result. If the input cannot be answered, replace the whole file with {"refused": "<why>"}.`;
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

/** The rules the publish checks for `plugin`, each with the error it gives. */
export const publishRules = plugin => [
  'The name is lowercase letters, digits, ".", "_" or "-", starts with a letter or digit, and is at most 128 characters. Error: name is lowercase letters, digits, ".", "_" and "-".',
  "The name is unique for the plugin's version. Publishing the same benchmark again changes nothing; different content under a taken name is refused: a changed benchmark needs a new name.",
  'The case file is valid YAML with the keys above. Errors: the case file is not valid YAML at line N, column M: ...; the case file does not fit the case file shape: ...',
  `The case file's plugin is this plugin and its task is one of its tasks. Errors: the cases are for X, not ${plugin.id}; ${plugin.id} has an unknown task: T.`,
  `There is at least one case across cases and refuse. Error: the cases file for ${plugin.id} <task> has no cases: both \`cases\` and \`refuse\` are empty.`,
  `Each prompt is not empty and has no leading or trailing whitespace. Errors: case ${plugin.id}-01: the prompt is empty; case ${plugin.id}-01: the prompt starts or ends with whitespace.`,
  `Each case's arguments fit the task's input fields. Error: case ${plugin.id}-01: its arguments do not fit the input of task T: ...`,
  `Every string and number in arguments is written out in the prompt (whitespace runs count as one space; a number by its JSON text). The agent only sees the prompt, so anything it needs must be in it. Error: case ${plugin.id}-01: the prompt does not state argument NAME (VALUE).`,
  `A fixtures folder is inside the case folder, holds only regular files (no symlinks), weighs at most 8 MB gzipped, and has no answer.json at its root (the platform writes that file). Errors: case ${plugin.id}-01: the fixtures F are not a folder of the uploaded case folder; ...the fixture X is a symlink; ...the fixtures weigh N bytes gzipped, over the 8388608 a case may have; ...the fixtures hold answer.json at its root, which the platform seeds.`,
  `The plugin's reference tool answers every case in cases and rejects every case in refuse with an error containing its reference_error. Errors: case ${plugin.id}-01: <tool> could not answer {...}, a case to answer: ...; <tool> rejected {...} without 'TEXT': ...; <tool> answered {...}, a case to refuse.`,
  `A task with no reference tool (an agent or decide task whose manifest declares none) cannot have cases to refuse. Error: case ${plugin.id}-NN: task T has no reference tool, so nothing can confirm that its input is to be refused ...`,
];

/** What publishing does, for `plugin`. */
export const publishEffect = plugin => `Your installed plugin runs its reference tool on each case on your computer to pin the right answer, so RUSH Lab must be running. Case ids are given in order: ${plugin.id}-01, ${plugin.id}-02, ..., the cases to answer first. Anyone with the plugin can then run the benchmark.`;

/** The instructions for `plugin` (`{id, name, version, tasks}` as the installed app lists it). */
export function instructionsText(plugin) {
  return `PLUGIN
Plugin id: ${plugin.id} (${plugin.name}, version ${plugin.version}). Write it as \`plugin\` exactly as shown.
Tasks (write one task id as \`task\`):
${plugin.tasks.flatMap(taskLines).join('\n')}

THE FOLDER
Pick one folder. Its top level holds exactly one case file (a .yaml or .yml file). Every other file in it is a fixture that a case can name. .DS_Store is ignored.

${FOLDER_LAYOUT}

THE CASE FILE
A YAML mapping with these keys and no others:
${CASE_FILE_FIELDS.map(field => `- ${field.key} (${field.required}): ${field.text}`).join('\n')}

THE ANSWER
${ANSWER_FILE_TEXT}

${exampleCaseFile(plugin)}

RULES THE PUBLISH CHECKS
${publishRules(plugin).map(rule => `- ${rule}`).join('\n')}

WHAT PUBLISHING DOES
${publishEffect(plugin)}`;
}

/** The same instructions with a request to write the case folder, for pasting into an AI. */
export const aiInstructions = plugin => `${instructionsText(plugin)}

REQUEST
Write cases.yaml and the fixture folders it names for my goal, which I describe next. Follow every rule above: use plugin ${plugin.id}, one of its tasks, arguments that fit its input fields, and a prompt that states every argument value and tells the agent to fill in answer.json. Cover ordinary and edge inputs. Give each file with its path inside the folder, ready to save.`;
