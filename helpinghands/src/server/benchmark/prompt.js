'use strict';

const crypto = require('crypto');
const {BenchmarkError} = require('./errors');
const {isLosslessNumber} = require('./json');

/** The prompt renderer: the coding template and the task prompts of uploaded-harness-v1.md, "Prompt contract". */
const RENDERER_VERSION = 'rush.prompt.v1';
const MAX_INSTRUCTIONS_LENGTH = 100_000;
/**
 * What one rendered prompt (system or user text) may hold, and what all of a benchmark's rendered prompts, under both policies, may
 * hold together. A template that repeats {arguments} multiplies the case's arguments, so the renderer stops at the first.
 */
const MAX_PROMPT_CHARS = 1_000_000;
const MAX_BENCHMARK_PROMPT_CHARS = 64_000_000;
/** The workspace path a coding harness is told to write answer.json in. */
const WORKSPACE = '/rush/workspace';
/** The tool a task's agent calls with its result (nanoagent.plugin.manifest.SUBMIT). */
const SUBMIT = 'submit';

/**
 * The coding prompt of `prompt` in nanoagent/examples/benchmark/configs/step2_single_run.yaml, which a test keeps equal.
 * Placeholders: {description}, {context}, {arguments}, {input_schema}, {output_schema} and {workspace}.
 */
const DEFAULT_CODING_TEMPLATE = `Task: {description}.

{context}

The task's input:
{arguments}

The input's JSON Schema:
{input_schema}

Write your answer to {workspace}/answer.json: one JSON object following this JSON Schema.
{output_schema}

Keep temporary files in the workspace or the directory named by TMPDIR.

If the input cannot be answered (the day or window has not ended, the market was closed, or no data covers it), write {{"refused": "<why>"}} to answer.json instead.`;
const PLACEHOLDERS = ['description', 'context', 'arguments', 'input_schema', 'output_schema', 'workspace'];

const sha256Hex = value => crypto.createHash('sha256').update(value).digest('hex');

/** Order by Unicode code point, as Python's sort_keys does, not by UTF-16 unit. */
function compareCodePoints(a, b) {
  const left = Array.from(a);
  const right = Array.from(b);
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = left[index].codePointAt(0) - right[index].codePointAt(0);
    if (difference) return difference;
  }
  return left.length - right.length;
}

function text(value) {
  if (!value.isWellFormed()) throw new BenchmarkError(400, 'invalid_json_value', 'A string holds an unpaired surrogate');
  return JSON.stringify(value);
}

/**
 * `value` as JSON with its keys sorted by code point at every depth and Unicode left as it is:
 * indented by `indent` spaces, or compact (`{"a":1}`) for none. Rejects what JSON cannot hold.
 * Objects are walked by hand, because JavaScript lists integer-like keys first whatever their order.
 */
function canonicalJson(value, indent = 0, level = 0) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (isLosslessNumber(value)) {
    if (!Number.isFinite(Number(value.value))) throw new BenchmarkError(400, 'invalid_json_value', 'A number is not finite');
    return value.value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new BenchmarkError(400, 'invalid_json_value', 'A number is not finite');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return text(value);
  const pad = depth => (indent ? `\n${' '.repeat(indent * depth)}` : '');
  const join = items => (items.length === 0 ? null : items.map(item => `${pad(level + 1)}${item}`).join(',') + pad(level));
  if (Array.isArray(value)) {
    const body = join(value.map(item => canonicalJson(item, indent, level + 1)));
    return body === null ? '[]' : `[${body}]`;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const body = join(Object.keys(value).sort(compareCodePoints)
      .map(key => `${text(key)}:${indent ? ' ' : ''}${canonicalJson(value[key], indent, level + 1)}`));
    return body === null ? '{}' : `{${body}}`;
  }
  throw new BenchmarkError(400, 'invalid_json_value', `A ${typeof value} is not JSON`);
}

/** Instructions with CRLF and CR as LF and every other byte kept; empty or blank ones are refused. */
function normalizeInstructions(value, what = 'instructions') {
  const label = what[0].toUpperCase() + what.slice(1);
  if (typeof value !== 'string') throw new BenchmarkError(400, `invalid_${what}`, `${label} is a string`);
  const normalized = value.replace(/\r\n?/g, '\n');
  if (!normalized.trim()) throw new BenchmarkError(400, `empty_${what}`, `${label} may not be empty or only whitespace`);
  if (normalized.length > MAX_INSTRUCTIONS_LENGTH) {
    throw new BenchmarkError(400, `${what}_too_long`, `${label} may be ${MAX_INSTRUCTIONS_LENGTH} characters at most`);
  }
  if (!normalized.isWellFormed()) throw new BenchmarkError(400, `invalid_${what}`, `${label} holds an unpaired surrogate`);
  return normalized;
}

/**
 * A number as Python's `json.dumps` writes it. A LosslessNumber is the spelling Python wrote when it published the value. A
 * JavaScript number cannot tell an int from a float, so a safe integer is an int and any other number is a float, in
 * Python's `repr`: the shortest digits that read back, in exponent form below 1e-4 and from 1e16 (`1e-05`, `1.5e+16`).
 */
function pythonNumber(value) {
  if (isLosslessNumber(value)) return value.value;
  if (Number.isSafeInteger(value)) return String(value);
  const [digits, exponent] = value.toExponential().split('e');
  const power = Number(exponent);
  if (power < -4 || power >= 16) return `${digits}e${power < 0 ? '-' : '+'}${String(Math.abs(power)).padStart(2, '0')}`;
  return String(value).includes('.') ? String(value) : `${value}.0`;
}

/** A string as Python writes it with `ensure_ascii`: every character outside space to `~` as a lowercase \uXXXX escape. */
const pythonString = value => JSON.stringify(value).replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * `value` as Python's `json.dumps(value, indent=2)` writes it: keys in the order given (the validator refuses the keys
 * JavaScript would reorder), `[]` and `{}` for the empty ones, numbers as in [pythonNumber], strings as in [pythonString].
 */
function pythonJson(value) {
  canonicalJson(value);
  const write = (item, level) => {
    const pad = depth => `\n${'  '.repeat(depth)}`;
    const lines = parts => `${parts.map(part => `${pad(level + 1)}${part}`).join(',')}${pad(level)}`;
    if (item === null || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' || isLosslessNumber(item)) return pythonNumber(item);
    if (typeof item === 'string') return pythonString(item);
    if (Array.isArray(item)) return item.length ? `[${lines(item.map(element => write(element, level + 1)))}]` : '[]';
    const keys = Object.keys(item);
    return keys.length ? `{${lines(keys.map(key => `${pythonString(key)}: ${write(item[key], level + 1)}`))}}` : '{}';
  };
  return write(value, 0);
}

/**
 * `template` with Python's `str.format(**values)` semantics for plain fields: `{{` and `}}` are braces, `{name}` is
 * `values.name`. An unknown or malformed field, a single brace, and what only matters to non-string values (positional
 * fields, attribute and index access, conversions and format specs) are errors.
 */
function pythonFormat(template, values) {
  let out = '';
  const tooLong = () => new BenchmarkError(400, 'prompt_too_long', `A rendered prompt may be ${MAX_PROMPT_CHARS} characters at most`);
  for (let i = 0; i < template.length; i += 1) {
    const char = template[i];
    if (char === '{') {
      if (template[i + 1] === '{') {
        out += '{';
        i += 1;
        continue;
      }
      const close = template.indexOf('}', i);
      if (close < 0) throw new BenchmarkError(400, 'invalid_template', "The template has a '{' with no closing '}'");
      const field = template.slice(i + 1, close);
      if (/[{!:.[]/.test(field)) throw new BenchmarkError(400, 'invalid_template', `The template field {${field}} is not a plain placeholder name`);
      if (!Object.hasOwn(values, field)) {
        throw new BenchmarkError(400, 'invalid_template', `The template names {${field}}, which is no placeholder; use ${PLACEHOLDERS.map(name => `{${name}}`).join(', ')}`);
      }
      out += values[field];
      if (out.length > MAX_PROMPT_CHARS) throw tooLong();
      i = close;
    } else if (char === '}') {
      if (template[i + 1] !== '}') throw new BenchmarkError(400, 'invalid_template', "The template has a single '}'; write '}}' for one");
      out += '}';
      i += 1;
    } else {
      out += char;
    }
  }
  if (out.length > MAX_PROMPT_CHARS) throw tooLong();
  return out;
}

/** Python's `str.strip()`: it removes what `str.isspace` holds, which is not what `trim` removes (it keeps U+FEFF, and takes U+001C to U+001F and U+0085). */
const PYTHON_SPACE = '[\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const pythonStrip = value => value.replace(new RegExp(`^${PYTHON_SPACE}+|${PYTHON_SPACE}+$`, 'g'), '');

const promptSha256 = ({system, user}) => sha256Hex(canonicalJson({system, user}));

/**
 * The coding policy's prompt for one case, as `other_work` in examples/benchmark/step2_single_run.py formats it:
 * `{system: null, user}`. `task` is the case set's task, `context` its context, `args` the case's arguments.
 */
function renderCoding(template, {task, context, args}) {
  const user = pythonFormat(template, {
    description: task.description,
    context: pythonStrip(context),
    arguments: pythonJson(args),
    input_schema: pythonJson(task.input_schema),
    output_schema: pythonJson(task.output_schema),
    workspace: WORKSPACE,
  });
  return {system: null, user, sha256: promptSha256({system: null, user})};
}

/**
 * The task tools policy's prompt for one case: `task_prompt` (agent and tool tasks: `{system, user}`) or `decide_prompt`
 * (decide tasks: `{system, user: null}`) of nanoagent/src/nanoagent/plugin/tasks.py, with `instructions` in
 * place of the task's own and `pluginName` for the manifest's name.
 */
function renderTaskTools({pluginName, task, instructions, args}) {
  if (task.kind === 'decide') {
    const system = `You decide one task worked with the ${pluginName} plugin's tools. NanoAgent calls the tools and `
      + "builds the task's output; you only choose. Each request gives the state so far, the task input and "
      + 'every tool call with its output, and a batch of questions. Answer each question with one of its '
      + 'options; never write a value of your own. An option such as calls[0].output.entries[2].key names '
      + 'the value at that path in the state, and null means no value.\n\n'
      + `Task: ${task.description}.\n${instructions}`;
    return {system, user: null, sha256: promptSha256({system, user: null})};
  }
  const system = `You work one task with the ${pluginName} plugin's tools. Every file a tool saves goes `
    + 'into your workspace; paths you pass to tools are relative to it.\n\n'
    + `Task: ${task.description}.\n${instructions}\n\n`
    + `When the task is done, call ${SUBMIT} with its result.`;
  const user = `Task input:\n${pythonJson(args)}`;
  if (system.length > MAX_PROMPT_CHARS || user.length > MAX_PROMPT_CHARS) {
    throw new BenchmarkError(400, 'prompt_too_long', `A rendered prompt may be ${MAX_PROMPT_CHARS} characters at most`);
  }
  return {system, user, sha256: promptSha256({system, user})};
}

/** A template with CRLF and CR as LF, refused if blank, too long or not well formed (see normalizeInstructions). */
const normalizeTemplate = value => normalizeInstructions(value, 'template');

module.exports = {
  RENDERER_VERSION, MAX_BENCHMARK_PROMPT_CHARS, DEFAULT_CODING_TEMPLATE, PLACEHOLDERS, canonicalJson, normalizeInstructions, normalizeTemplate,
  pythonFormat, pythonJson, renderCoding, renderTaskTools, sha256Hex,
};
