/** The Create Plugin Benchmark form's logic: the plugins and tasks a benchmark can be published for, the case file, the run configuration, and the request that publishes it. */

/** The installed apps that have a task, ready to run. */
export const publishable = apps => apps.filter(app => app.status === 'ready' && (app.tasks ?? []).length > 0);

export const taskOf = (app, taskId) => (app?.tasks ?? []).find(task => task.id === taskId) ?? null;

/**
 * The case file checked as `{plugin, task, answer, refuse}`, or `{error}`. It is only read
 * here: what is sent is the file's own text (see `publishText`), so a number such as `1.0` keeps its spelling.
 */
export function parseCases(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return {error: 'The case file is not valid JSON'};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {error: 'The case file must be a JSON object'};
  if (typeof value.plugin !== 'string' || typeof value.task !== 'string') return {error: 'The case file names a plugin and a task'};
  if (typeof value.context !== 'string') return {error: 'Add a context string. Use an empty string if the cases need no shared background.'};
  const object = item => item && typeof item === 'object' && !Array.isArray(item);
  if (!Array.isArray(value.answer) || !value.answer.every(object)) return {error: 'The answer field must be an array of input objects.'};
  if (!Array.isArray(value.refuse) || !value.refuse.every(item => object(item) && object(item.arguments) && typeof item.reference_error === 'string' && item.reference_error.trim())) {
    return {error: 'The refuse field must be an array of objects with arguments and a nonempty reference_error.'};
  }
  if (!value.answer.length && !value.refuse.length) return {error: 'Add at least one answer or refusal case.'};
  return {plugin: value.plugin, task: value.task, answer: value.answer.length, refuse: value.refuse.length};
}

export const LIMIT_LABELS = {
  wall_time_ms: 'Wall time (ms)', max_model_calls: 'Model calls', max_output_tokens_per_call: 'Output tokens per call', max_cost_usd: 'Cost (USD)',
  cpus: 'CPUs', memory_mb: 'Memory (MB)', pids: 'Processes', workspace_bytes: 'Workspace (bytes)', workspace_files: 'Workspace files',
  tmp_bytes: 'Temporary space (bytes)', build_wall_ms: 'Build wall time (ms)', build_memory_mb: 'Build memory (MB)', build_output_bytes: 'Build output (bytes)',
  build_files: 'Build files', build_tmp_bytes: 'Build temporary space (bytes)', internet_access: 'Internet access',
};

// The limits that are not whole numbers.
const DECIMAL = new Set(['max_cost_usd', 'cpus']);

/** The numeric limits a benchmark edits, in the server's order. */
export const limitNames = defaults => Object.keys(defaults?.limits ?? {}).filter(name => name !== 'internet_access');

/** The limit fields as the form holds them: each default as text, and internet access as it defaults. */
export const limitsFormOf = defaults => ({
  values: Object.fromEntries(limitNames(defaults).map(name => [name, String(defaults.limits[name])])),
  internet: defaults.limits.internet_access,
});

/** The limits that differ from the defaults, as the overrides to send, or `{error}` naming the first field that is not a valid number. */
export function limitOverrides(form, defaults) {
  const overrides = {};
  for (const name of limitNames(defaults)) {
    const raw = String(form.values[name] ?? '').trim();
    const value = Number(raw);
    if (!raw || !Number.isFinite(value) || value < 0 || (name !== 'max_model_calls' && value === 0) || (!DECIMAL.has(name) && !Number.isInteger(value))) {
      return {error: `${LIMIT_LABELS[name] ?? name} must be a ${DECIMAL.has(name) ? '' : 'whole '}number${name === 'max_model_calls' ? ' of at least 0' : ' above 0'}`};
    }
    if (value !== defaults.limits[name]) overrides[name] = value;
  }
  if (form.internet !== defaults.limits.internet_access) overrides.internet_access = form.internet;
  return {overrides};
}

/** The prompt a policy starts from: the coding template, or the task's instructions. */
export const defaultPrompt = (policy, defaults, task) => (policy === 'coding' ? defaults?.coding_template : task?.instructions) ?? '';

/** The text the editor shows: the member's edit of this policy's prompt, else its default. */
export const promptText = (edits, policy, fallback) => edits[policy] ?? fallback;

/** An edit that returns to the default is no edit: Reset to default and typing the default back agree. */
export const withPromptEdit = (edits, policy, text, fallback) => ({...edits, [policy]: text === fallback ? null : text});

/**
 * The body of POST benchmarks/pinned as text, or `{error}` naming what is missing. The case file is embedded as it was read: the server
 * parses the request losslessly and sends NanoAgent the same text. A prompt left at its default is sent as null.
 */
export function publishText({app, taskId, caseText, cases, name, model, endpoint, limits, edits}) {
  if (!app) return {error: 'Choose a plugin'};
  const task = taskOf(app, taskId);
  if (!task) return {error: 'Choose a task'};
  if (!cases) return {error: 'Upload a case file'};
  if (cases.plugin !== app.id || cases.task !== task.id) return {error: `The case file is for ${cases.plugin} ${cases.task}, not ${app.id} ${task.id}`};
  if (!model.trim()) return {error: 'Name the model'};
  if (!endpoint) return {error: 'Choose an endpoint'};
  if (limits.error) return limits;
  if (!name.trim()) return {error: 'Name the benchmark'};
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(name.trim())) return {error: 'Enter a benchmark name using the format above.'};
  const json = value => JSON.stringify(value ?? null);
  return {body: `{"plugin_id":${json(app.id)},"name":${json(name.trim())},"cases":${caseText.trim()},"model":${json(model.trim())},"endpoint_profile":${json(endpoint)},`
    + `"limits":${json(limits.overrides)},"coding_template":${json(edits.coding)},"task_instructions":${json(edits.task_tools)}}`};
}

/** What the member sees of a published benchmark: the answer of POST benchmarks/pinned. */
export function publishedLines({created, benchmark}) {
  return {
    headline: created ? 'Benchmark published' : 'This benchmark was already published, unchanged',
    facts: [
      ['Benchmark', benchmark.name],
      ['Plugin', `${benchmark.plugin.name ?? benchmark.plugin.id} v${benchmark.plugin.version}`],
      ['Task', `${benchmark.task_id} (${benchmark.task_kind})`],
      ['Cases', `${benchmark.case_count} (${benchmark.answer_count} to answer, ${benchmark.refuse_count} to refuse)`],
      ['Model', benchmark.model],
      ['Endpoint', benchmark.endpoint_profile],
      ['Internet access', benchmark.limits.internet_access ? 'on' : 'off'],
      ['Digest', benchmark.digest],
    ],
  };
}

/** The server's refusal as `{message, lines}`: its own message, and the detail a code carries (the limits over a worker's, a name already taken, a harness version already uploaded). */
export function describeError(error) {
  const details = error?.details ?? {};
  const lines = [];
  if (details.code === 'limit_exceeds_worker') {
    for (const item of details.exceeded ?? []) lines.push(`${LIMIT_LABELS[item.field] ?? item.field}: ${item.limit} is above the worker's ${item.max}`);
  }
  if (details.code === 'benchmark_name_taken') lines.push('A published benchmark never changes. Use a new name for changed cases, model, limits or prompts.');
  if (details.code === 'harness_version_taken') {
    lines.push(`${details.harness.name}@${details.harness.version} was uploaded before with different content. Raise the version in harness.yaml.`);
  }
  return {message: error?.message ?? '', lines};
}

/** Instructions can be copied into an assistant; runtime validation remains authoritative. */
export function caseInstructions(app, task) {
  const selection = app ? `Selected plugin ${app.id} (version ${app.version}).${task ? ` Selected task ${task.id}.` : ''}` : 'No plugin or task is selected yet.';
  const description = task?.description ? `\nTask description from RUSH Lab: ${task.description}` : '';
  return `Help me prepare a RUSH Lab benchmark. Deliver a UTF-8 cases.json for one plugin task and, if the task does not exist yet, the plugin source. A plugin defines the task and checks its results. A case set supplies the inputs. A harness is the program being tested on those inputs.

${selection}${description}
For an existing task, use its manifest, contract and verifier from the plugin source I provide. Ask for the source or the exact input/output schemas and task rules if you lack them. Keep its published IDs and schemas. For a new task, first agree with me on its inputs, output, correctness rules, and which inputs it should refuse.

CASE FILE
Use one JSON object with these fields.
${caseFileFields.map(([field, meaning]) => `- ${field} — ${meaning}`).join('\n')}
Keep both arrays and use [] for an unused category. Include at least one case. Add ordinary and boundary inputs. Include the rules, units, and data a solver needs in the task description or context. Include the same essential rules in the task's instructions for Task tools mode. RUSH supplies case inputs to the harness and keeps the reference answer and case category private.

Example task: add two nonnegative integers a and b and return {"sum": 42} for a=19 and b=23. Both input fields are typed as integers, so a negative integer passes the schema and the reference tool can reject it with the error below. Replace the example IDs and inputs with those of your actual task.

${caseFileExample()}

IF CREATING A PLUGIN
Use Python 3.12+ and uv. Start from the public nanoagent.plugin/v0001 example at https://github.com/zeyuyang8/arxiv-source (clone or download it). Reuse its package structure and MCP adapter. No NanoAgent checkout is needed. Replace its tools, tasks, permissions, tests and product copy. Use a unique kebab-case plugin ID and update the manifest, project name (nanoagent-<id>), README title and license holder. Keep the tagged YAML keys and use matching versions in nanoagent.yaml and pyproject.toml.

- contract.py defines Tool and Task enums and slimconfig Output dataclasses. Use snake_case tool names, kebab-case task IDs, classes ending in Input or Output, and Annotated field descriptions. For the example use AddInput with a: int and b: int, AddOutput with sum: int, and map both Tool.ADD ("add") and Task.ADD ("add-nonnegative") to (AddInput, AddOutput) in TOOLS and TASKS respectively.
- nanoagent.yaml declares each tool and task. For the example declare tool add and a task add-nonnegative with description, runner: tool, tools: [add], reference: null and instructions. A tool task uses its one tool's schemas and, with reference: null, that tool also runs during publication. An agent task lets a model call the listed tools and submit its output. A decide task lets a model pick enum/bool values or copy existing typed values, then NanoAgent does the tool calls. For agent or decide, set reference to a separate tool outside the task's tools when the verifier needs a reference or the case file has refusals. Its input and output must fit the task and it runs privately during publication.
- src/plugin/ implements each tool and registers it in the MCP server's IMPLEMENTATIONS table. It receives the typed input and returns the typed output. For add, raise ValueError("operands must be nonnegative") if either operand is negative, otherwise return AddOutput(sum=a+b). The server runs via [uv, run, --frozen, python, -m, plugin]. Use NANOAGENT_WORKSPACE for tool files and declare only the permissions you need.
- verifier/__init__.py exports verify_input(tool, value), verify_output(tool, input_value, output_value, workspace) and verify_task(task, arguments, output, reference, workspace). The entry points receive names and typed values, and reference is the typed expected output or None. Each returns {"valid": true, "score": 1, "message": "sum is correct", "details": {}} on success, or valid=false and score=0 with a specific explanation on failure. Register all tools and tasks and check every rule with deterministic code. For add, validate nonnegative operands and check output.sum == arguments.a + arguments.b. Read any required artifacts from the supplied workspace. Use pure Python checks with no model, network, randomness, clock, subprocesses or writes.
- Keep the example's layout, including product/ and ui/. For default rendering use export default {}; in ui/renderers.js and an empty ui/renderers.css. Update product copy and set status: ready when the plugin is ready. Keep cases.json outside the plugin folder. Run uv lock, uv sync --extra dev, uv run pytest and uv run ruff check . from the plugin folder. Test correct, wrong and boundary answers, the actual reference error for refusals, and missing or malformed evidence when required.

PUBLISH IN RUSH LAB
For a new plugin, provide its public GitHub repository or folder URL for Marketplace → Publish a Plugin, then install the published plugin. In Benchmark → Create Plugin Benchmark, select the installed plugin and task, upload cases.json, choose the model, endpoint, prompts and limits, enter a benchmark name and click Publish benchmark. The benchmark is pinned to the installed plugin version. Use 1–128 lowercase letters, digits, periods, underscores or hyphens, starting with a letter or digit. RUSH validates the inputs and pins any references. A published benchmark never changes: use a new name for changed cases, model, limits or prompts.`;
}

export const caseFileFields = [
  ['plugin', 'The installed plugin ID from nanoagent.yaml.'],
  ['task', 'The ID of one task declared by that plugin.'],
  ['context', 'Shared background the solver needs, such as units or data sources. Use "" if there is none.'],
  ['answer', 'An array of input objects. Each object is the task arguments. RUSH obtains any expected output from the plugin.'],
  ['refuse', 'An array of objects with arguments (the task inputs) and reference_error (nonblank, case-sensitive text found in the reference tool’s actual error). The reference tool must reject these inputs. All inputs, including refusals, must match the task’s input schema.'],
];

export const caseFileExample = () => JSON.stringify({
  plugin: 'bounded-sum',
  task: 'add-nonnegative',
  context: '',
  answer: [{a: 19, b: 23}, {a: 0, b: 0}],
  refuse: [{arguments: {a: -1, b: 3}, reference_error: 'operands must be nonnegative'}],
}, null, 2);
