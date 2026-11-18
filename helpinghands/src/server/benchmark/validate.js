'use strict';

const {BenchmarkError} = require('./errors');
const {isLosslessNumber, stringifyJson} = require('./json');
const {DEFAULT_CODING_TEMPLATE, MAX_BENCHMARK_PROMPT_CHARS, canonicalJson, normalizeInstructions, normalizeTemplate, renderCoding, renderTaskTools, sha256Hex} = require('./prompt');
const {
  effectiveLimits, limitOverrides, capabilitiesOf, MAX_EVENT_DATA_BYTES, MAX_SPAN_ATTRIBUTES_BYTES, MAX_LINK_ATTRIBUTES_BYTES, MAX_ACCOUNTING_RECORD_BYTES,
  MAX_RESULT_BYTES, MAX_ACCOUNTING_VERSION, MAX_USD, MAX_INTEGER, MAX_ATTEMPT_TERMINAL_BYTES, MAX_TERMINAL_CHUNK_BYTES,
} = require('./limits');
const {UUID} = require('./http');
const {nanoseconds} = require('../postgres/benchmark-context');

const bad = (code, message) => new BenchmarkError(400, code, message);
const SHA256 = /^[0-9a-f]{64}$/;
const BENCHMARK_NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const POLICIES = ['coding', 'task_tools'];
const TASK_KINDS = ['agent', 'decide', 'tool'];
const CASE_KINDS = ['answer', 'refuse'];
// The longest a claim waits for work (`wait_s`), well within a worker's request timeout.
const MAX_CLAIM_WAIT_S = 30;
const VERDICTS = ['pass', 'fail'];
// Why a case failed (nanoagent.plugin.verifier.TASK_VERIFIER_EXPLANATIONS); a failure by `verify_task` alone has none.
const EXPLANATIONS = ['invalid_answer', 'refused_answer_case', 'answered_refusal_case', 'execution_failed'];
const EXECUTION_STATUSES = ['answered', 'refused', 'execution_failed', 'build_failed', 'canceled'];
// What may carry a verdict: a result the plugin's verifier saw.
const SCORABLE = new Set(['answered', 'refused', 'execution_failed']);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && !isLosslessNumber(value);

// JavaScript lists keys such as "2" before the others, so an object holding one would print in another order than Python's.
const INDEX_KEY = /^(?:0|[1-9]\d*)$/;
/** `value`, which a prompt prints, unless an object in it has a key JavaScript would reorder. */
function printable(value, what) {
  const walk = item => {
    if (Array.isArray(item)) return item.forEach(walk);
    if (!isObject(item)) return;
    const key = Object.keys(item).find(name => INDEX_KEY.test(name));
    if (key !== undefined) throw bad('unsupported_key', `${what} has the object key "${key}": a prompt would print its keys in another order than Python does, so a key of digits only is not supported`);
    Object.values(item).forEach(walk);
  };
  walk(value);
  return value;
}

function object(value, what) {
  if (!isObject(value)) throw bad('invalid_request', `${what} must be an object`);
  return value;
}
function string(value, what, {max = 200, optional = false} = {}) {
  if (optional && (value === undefined || value === null)) return null;
  if (typeof value !== 'string' || !value || value.length > max) throw bad('invalid_request', `${what} must be a string of 1 to ${max} characters`);
  return value;
}
function integer(value, what, {min = 0, max = Number.MAX_SAFE_INTEGER} = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw bad('invalid_request', `${what} must be an integer from ${min} to ${max}`);
  return value;
}
/** A number from `min` to `max`, USD amounts being kept within their column's range. */
function finite(value, what, {min = 0, max = MAX_USD} = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw bad('invalid_request', `${what} must be a number from ${min} to ${max}`);
  return value;
}
/** `value` (an object) if its JSON text is at most `max` bytes and holds no NUL character, which PostgreSQL's jsonb cannot store. */
function bounded(value, what, max) {
  const text = stringifyJson(object(value, what));
  if (Buffer.byteLength(text) > max) throw new BenchmarkError(413, 'too_large', `${what} may be ${max} bytes at most`);
  // The text spells a NUL in a string as \u0000, and a backslash that is itself escaped as \\ must not count.
  if (/(?<!\\)(?:\\\\)*\\u0000/.test(text)) throw bad('invalid_request', `${what} may not contain the character \\u0000`);
  return value;
}
function array(value, what, {max = 1000, optional = false} = {}) {
  if (optional && (value === undefined || value === null)) return [];
  if (!Array.isArray(value) || value.length > max) throw bad('invalid_request', `${what} must be an array of at most ${max}`);
  return value;
}
const sha256 = (value, what) => {
  if (typeof value !== 'string' || !SHA256.test(value)) throw bad('invalid_request', `${what} must be a lowercase SHA-256 hex digest`);
  return value;
};
/** Nanoseconds as a JSON integer within 2^53 or a decimal string. */
function ns(value, what) {
  const parsed = nanoseconds(value);
  if (parsed === undefined) throw bad('invalid_request', `${what} must be a decimal integer string or a safe integer`);
  return parsed;
}

function boolean(value, what) {
  if (typeof value !== 'boolean') throw bad('invalid_request', `${what} must be a boolean`);
  return value;
}

/** What a case set's task gives a harness: its kind, description, instructions, schemas and tools (the reference tool is not one). */
function taskOf(value) {
  const task = object(value, 'task');
  if (!TASK_KINDS.includes(task.kind)) throw bad('invalid_request', `task.kind must be one of ${TASK_KINDS.join(', ')}`);
  if (typeof task.instructions !== 'string' || task.instructions.length > 100_000) throw bad('invalid_request', 'task.instructions must be a string of at most 100000 characters');
  const names = new Set();
  const hosts = array(task.egress_hosts, 'task.egress_hosts', {max: 200}).map(host => string(host, 'an egress host', {max: 253}));
  if (hosts.some((host, index) => index > 0 && hosts[index - 1] >= host)) throw bad('invalid_request', 'task.egress_hosts must be sorted, without repeats');
  return {
    kind: task.kind,
    egress_hosts: hosts,
    description: string(task.description, 'task.description', {max: 10_000}),
    instructions: task.instructions,
    input_schema: printable(object(task.input_schema, 'task.input_schema'), 'task.input_schema'),
    output_schema: printable(object(task.output_schema, 'task.output_schema'), 'task.output_schema'),
    tools: array(task.tools, 'task.tools', {max: 200}).map(raw => {
      const tool = object(raw, 'A task tool');
      const name = string(tool.name, 'a tool name');
      if (names.has(name)) throw bad('invalid_request', `task.tools lists ${name} twice`);
      names.add(name);
      return {
        name, description: typeof tool.description === 'string' ? tool.description : '',
        input_schema: object(tool.input_schema, `Tool ${name}'s input_schema`), output_schema: object(tool.output_schema, `Tool ${name}'s output_schema`),
        writes: boolean(tool.writes, `Tool ${name}'s writes`),
      };
    }),
  };
}

/** The digest of what one case pins: its kind, arguments, expected error and the digest of its private reference. */
const caseDigests = (c, reference) => {
  const referenceSha256 = sha256Hex(canonicalJson(reference));
  return {reference_sha256: referenceSha256, content_digest: sha256Hex(canonicalJson({
    kind: c.kind, arguments: c.arguments, expected_error: c.expected_error, reference_sha256: referenceSha256,
  }))};
};

/**
 * A benchmark publication, what POST /api/benchmark/benchmarks stores: the case set's cases with their per-case and whole digests
 * (the case set is made from them), the run configuration (model, endpoint, the effective limits, the coding template and the
 * task instructions as pinned text) and the benchmark's own digest. Whether the endpoint's workers can give the limits is the service's to check.
 */
function benchmarkPublication(body) {
  const frame = publicationFrame(body);
  const {task, context, coding_template: codingTemplate, task_instructions: taskInstructions} = frame;
  const caseList = array(body.cases, 'cases', {max: 5000});
  if (!caseList.length) throw bad('invalid_request', 'A benchmark needs at least one case');
  const privateReferences = object(body.private, 'private');
  const seen = new Set();
  const cases = caseList.map(raw => {
    const c = object(raw, 'A case');
    const caseId = string(c.case_id, 'case_id');
    if (seen.has(caseId)) throw bad('invalid_request', `case_id ${caseId} appears twice`);
    seen.add(caseId);
    if (!CASE_KINDS.includes(c.kind)) throw bad('invalid_request', `Case ${caseId}'s kind must be one of ${CASE_KINDS.join(', ')}`);
    printable(object(c.arguments, `Case ${caseId}'s arguments`), `Case ${caseId}'s arguments`);
    if (!Object.hasOwn(privateReferences, caseId)) throw bad('invalid_request', `private has no reference for case ${caseId}`);
    const reference = privateReferences[caseId];
    let expectedError = null;
    if (c.kind === 'refuse') {
      expectedError = string(c.expected_error, `Case ${caseId}'s expected_error`, {max: 10_000});
      if (typeof reference !== 'string') throw bad('invalid_request', `private's reference for refusal case ${caseId} must be the pinned error string`);
    } else {
      if (c.expected_error !== undefined && c.expected_error !== null) throw bad('invalid_request', `Case ${caseId} is an answer case and takes no expected_error`);
      if (reference !== null && !isObject(reference)) throw bad('invalid_request', `private's reference for answer case ${caseId} must be an object, or null for a task judged without one`);
    }
    const published = {case_id: caseId, kind: c.kind, arguments: c.arguments, expected_error: expectedError};
    return {...published, ...caseDigests(published, reference)};
  });
  const extra = Object.keys(privateReferences).find(id => !seen.has(id));
  if (extra) throw bad('invalid_request', `private has a reference for ${extra}, which is no case`);
  // The identity of the case set, to which its package is bound.
  const caseSetDigest = sha256Hex(canonicalJson({
    package_sha256: frame.package_sha256, task_id: frame.task_id, task, context, cases: cases.map(({case_id: id, content_digest: contentDigest}) => ({case_id: id, content_digest: contentDigest})),
  }));
  // Every case renders under both policies here, so a template that does not render, or amplifies the arguments, fails now and not at every run.
  let renderedChars = 0;
  for (const c of cases) {
    const prompts = [renderCoding(codingTemplate, {task, context, args: c.arguments}), renderTaskTools({pluginName: frame.plugin_name, task, instructions: taskInstructions, args: c.arguments})];
    renderedChars += prompts.reduce((sum, prompt) => sum + (prompt.system?.length ?? 0) + (prompt.user?.length ?? 0), 0);
    if (renderedChars > MAX_BENCHMARK_PROMPT_CHARS) {
      throw bad('prompts_too_long', `The cases' rendered prompts may total ${MAX_BENCHMARK_PROMPT_CHARS} characters at most under both policies`);
    }
  }
  return {
    ...frame, cases, private: privateReferences, case_set_digest: caseSetDigest,
    digest: sha256Hex(canonicalJson({
      case_set_digest: caseSetDigest, model: frame.model, endpoint_profile: frame.endpoint_profile, limits: frame.limits, coding_template: codingTemplate, task_instructions: taskInstructions,
    })),
  };
}

/**
 * What a publication says but its cases (and their digests): the plugin, the task, the context and the run configuration. A Harness
 * tab session's run is queued on this frame of its case set while its one case is pinned.
 */
function publicationFrame(body) {
  object(body, 'The body');
  const name = string(body.name, 'name', {max: 128});
  if (!BENCHMARK_NAME.test(name)) throw bad('invalid_request', 'name is lowercase letters, digits, ".", "_" and "-"');
  const task = taskOf(body.task);
  if (typeof body.context !== 'string') throw bad('invalid_request', 'context must be a string');
  return {
    name, plugin_id: string(body.plugin_id, 'plugin_id'), plugin_name: string(body.plugin_name, 'plugin_name'), version: string(body.version, 'version', {max: 64}),
    package_sha256: sha256(body.package_sha256, 'package_sha256'), task_id: string(body.task_id, 'task_id'), task, context: body.context,
    model: string(body.model, 'model'), endpoint_profile: string(body.endpoint_profile, 'endpoint_profile', {max: 100}),
    // The body is read with every number's spelling kept; a limit is a plain number.
    limits: effectiveLimits(limitOverrides(body.limits === undefined ? undefined : JSON.parse(stringifyJson(body.limits)))),
    // Both prompts are pinned as text, because the runner picks the policy.
    coding_template: body.coding_template === undefined || body.coding_template === null ? DEFAULT_CODING_TEMPLATE : normalizeTemplate(body.coding_template),
    task_instructions: body.task_instructions === undefined || body.task_instructions === null ? task.instructions : normalizeInstructions(body.task_instructions),
  };
}

/** Exactly `keys` of `body`: anything else is `invalid_request`. */
function only(body, keys) {
  object(body, 'The body');
  const extra = Object.keys(body).find(key => !keys.includes(key));
  if (extra) throw bad('invalid_request', `${extra} is not a field of this request; it takes ${keys.join(', ')}`);
}

const uuid = (value, what) => {
  if (typeof value !== 'string' || !UUID.test(value)) throw bad('invalid_request', `${what} must be a UUID`);
  return value;
};

/** A preview or run's setup, `{benchmark_id, policy}`: the benchmark fixes everything else. */
function setupOf(body, keys) {
  only(body, keys);
  if (!POLICIES.includes(body.policy)) throw bad('invalid_request', `policy must be one of ${POLICIES.join(', ')}`);
  return {benchmark_id: uuid(body.benchmark_id, 'benchmark_id'), policy: body.policy};
}

const previewBody = body => setupOf(body, ['benchmark_id', 'policy']);

function runBody(body) {
  const request = {
    ...setupOf(body, ['benchmark_id', 'policy', 'preview_id', 'source_sha256', 'idempotency_key']),
    preview_id: uuid(body.preview_id, 'preview_id'),
    source_sha256: sha256(body.source_sha256, 'source_sha256'),
    idempotency_key: string(body.idempotency_key, 'idempotency_key'),
  };
  return {...request, request_digest: sha256Hex(canonicalJson(request))};
}

const fenceOf = body => integer(body.fence, 'fence', {min: 1, max: MAX_INTEGER});

function eventsBody(body) {
  object(body, 'The body');
  const events = array(body.events, 'events', {max: 500});
  if (!events.length) throw bad('invalid_request', 'Send at least one event');
  return {
    fence: fenceOf(body),
    events: events.map(raw => {
      const event = object(raw, 'An event');
      return {
        event_id: string(event.event_id, 'event_id'), source: string(event.source, 'source', {max: 100}), kind: string(event.kind, 'kind', {max: 100}),
        sequence: integer(event.sequence, 'sequence'), occurred_ns: ns(event.occurred_ns, 'occurred_ns'),
        data: bounded(event.data, 'data', MAX_EVENT_DATA_BYTES),
        payload_sha256s: array(event.payload_sha256s, 'payload_sha256s', {optional: true}).map(value => sha256(value, 'a payload digest')),
      };
    }),
  };
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** A worker's terminal output: `{fence, offset, data}`, `data` the bytes from byte `offset`, sent as base64. */
function terminalBody(body) {
  object(body, 'The body');
  const encoded = string(body.data, 'data', {max: Math.ceil(MAX_TERMINAL_CHUNK_BYTES / 3) * 4});
  if (!encoded || !BASE64.test(encoded)) throw bad('invalid_request', 'data is the bytes as non-empty base64');
  return {fence: fenceOf(body), offset: integer(body.offset, 'offset', {min: 0, max: MAX_ATTEMPT_TERMINAL_BYTES}), data: Buffer.from(encoded, 'base64')};
}

/** What a member sends their session's terminal: `{data}`, keystrokes as base64, or `{rows, cols}`, its new size. */
function terminalInputBody(body) {
  object(body, 'The body');
  if (body.data === undefined) return {rows: integer(body.rows, 'rows', {min: 1, max: 1000}), cols: integer(body.cols, 'cols', {min: 1, max: 1000})};
  const encoded = string(body.data, 'data', {max: 128 * 1024});
  if (!BASE64.test(encoded)) throw bad('invalid_request', 'data is the keystrokes as base64');
  return {data: Buffer.from(encoded, 'base64')};
}

function spansBody(body) {
  object(body, 'The body');
  return {
    fence: fenceOf(body),
    spans: array(body.spans, 'spans', {optional: true, max: 2000}).map(raw => {
      const span = object(raw, 'A span');
      return {
        id: string(span.id, 'id'), kind: string(span.kind, 'kind', {max: 100}), name: string(span.name, 'name', {max: 1000}),
        parent: string(span.parent, 'parent', {optional: true}), scope: string(span.scope, 'scope', {optional: true, max: 500}),
        status: string(span.status, 'status', {optional: true, max: 100}), start_ns: ns(span.start_ns, 'start_ns'), end_ns: ns(span.end_ns, 'end_ns'),
        provenance: string(span.provenance, 'provenance', {optional: true, max: 100}), target: string(span.target, 'target', {optional: true, max: 2000}),
        attributes: span.attributes === undefined ? {} : bounded(span.attributes, 'attributes', MAX_SPAN_ATTRIBUTES_BYTES),
      };
    }),
    links: array(body.links, 'links', {optional: true, max: 4000}).map(raw => {
      const link = object(raw, 'A link');
      return {
        kind: string(link.kind, 'kind', {max: 100}), from: string(link.from, 'from'), to: string(link.to, 'to'),
        method: string(link.method, 'method', {optional: true, max: 200}), attributes: link.attributes === undefined ? {} : bounded(link.attributes, 'attributes', MAX_LINK_ATTRIBUTES_BYTES),
      };
    }),
  };
}

function finalizeBody(body) {
  object(body, 'The body');
  const execution = object(body.execution, 'execution');
  if (!EXECUTION_STATUSES.includes(execution.status)) throw bad('invalid_request', `execution.status is one of ${EXECUTION_STATUSES.join(', ')}`);
  const verdict = string(body.verdict, 'verdict', {optional: true, max: 100});
  if (verdict !== null && !VERDICTS.includes(verdict)) throw bad('invalid_request', `verdict is one of ${VERDICTS.join(', ')}`);
  const explanation = string(body.explanation, 'explanation', {optional: true, max: 100});
  if (explanation !== null && !EXPLANATIONS.includes(explanation)) throw bad('invalid_request', `explanation is one of ${EXPLANATIONS.join(', ')}`);
  if (explanation !== null && verdict !== 'fail') throw bad('invalid_request', 'An explanation comes only with a fail verdict');
  const verifierError = string(body.verifier_error, 'verifier_error', {optional: true, max: 4000});
  if (verdict !== null && verifierError !== null) throw bad('invalid_request', 'Send a verdict or a verifier_error, not both');
  if (verdict !== null && !SCORABLE.has(execution.status)) throw bad('verdict_not_allowed', `A ${execution.status} attempt carries no verdict`);
  if (verifierError !== null && execution.status !== 'answered' && execution.status !== 'refused') {
    throw bad('verdict_not_allowed', `A ${execution.status} attempt reached no verifier`);
  }
  return {
    fence: fenceOf(body),
    final: {
      execution: {status: execution.status, reason: string(execution.reason, 'execution.reason', {optional: true, max: 200})},
      verdict, explanation, verifier_error: verifierError,
      coverage: bounded(body.coverage, 'coverage', MAX_RESULT_BYTES), metrics: bounded(body.metrics, 'metrics', MAX_RESULT_BYTES),
      final_cursor_expected: integer(body.final_cursor_expected, 'final_cursor_expected'),
    },
  };
}

const admissionBody = body => ({
  fence: fenceOf(object(body, 'The body')), callId: string(body.call_id, 'call_id'),
  reserveUsd: finite(body.reserve_usd, 'reserve_usd'),
});

function settleBody(body) {
  object(body, 'The body');
  if (body.outcome !== 'settled' && body.outcome !== 'uncertain') throw bad('invalid_request', 'outcome must be settled or uncertain');
  return {
    outcome: body.outcome,
    costUsd: body.outcome === 'settled' ? finite(body.cost_usd, 'cost_usd') : null,
    provenance: bounded(body.provenance, 'provenance', MAX_ACCOUNTING_RECORD_BYTES),
  };
}

function accountingBody(body) {
  object(body, 'The body');
  return {callId: string(body.call_id, 'call_id'), version: integer(body.version, 'version', {min: 1, max: MAX_ACCOUNTING_VERSION}), record: bounded(body.record, 'record', MAX_ACCOUNTING_RECORD_BYTES)};
}

function claimBody(body) {
  object(body, 'The body');
  const profile = object(body.endpoint_profile, 'endpoint_profile');
  string(profile.mode, 'endpoint_profile.mode', {max: 50});
  return {
    workerId: string(body.worker_id, 'worker_id', {max: 200}), label: string(profile.label, 'endpoint_profile.label', {max: 100}),
    capabilities: capabilitiesOf(body.capabilities),
    // How long a claim with nothing to lease waits for work to be queued: none unless the worker asks.
    waitMs: body.wait_s === undefined ? 0 : Math.round(finite(body.wait_s, 'wait_s', {min: 0, max: MAX_CLAIM_WAIT_S}) * 1000),
  };
}

module.exports = {
  benchmarkPublication, publicationFrame, previewBody, runBody, eventsBody, terminalBody, terminalInputBody, spansBody, finalizeBody, admissionBody, settleBody, accountingBody,
  claimBody, SHA256, fenceOf, object, string,
};
