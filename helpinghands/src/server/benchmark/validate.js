'use strict';

const {BenchmarkError} = require('./errors');
const {isLosslessNumber, stringifyJson} = require('./json');
const {canonicalJson, sha256Hex} = require('./prompt');
const {checkHarness} = require('./harness');
const {
  RUN_ENDPOINT, RUN_MODEL, effectiveLimits, limitOverrides, capabilitiesOf, MAX_EVENT_DATA_BYTES, MAX_SPAN_ATTRIBUTES_BYTES, MAX_LINK_ATTRIBUTES_BYTES, MAX_ACCOUNTING_RECORD_BYTES,
  MAX_RESULT_BYTES, MAX_ACCOUNTING_VERSION, MAX_USD, MAX_INTEGER, MAX_ATTEMPT_TERMINAL_BYTES, MAX_TERMINAL_CHUNK_BYTES, MAX_TERMINALS,
} = require('./limits');
const {UUID} = require('./http');
const {nanoseconds} = require('../postgres/benchmark-context');

const bad = (code, message) => new BenchmarkError(400, code, message);
const SHA256 = /^[0-9a-f]{64}$/;
const BENCHMARK_NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const TASK_KINDS = ['agent', 'decide', 'tool'];
const CASE_KINDS = ['answer', 'refuse'];
// The longest a claim waits for work (`wait_s`), well within a worker's request timeout.
const MAX_CLAIM_WAIT_S = 30;
const VERDICTS = ['pass', 'fail'];
// Why a case failed (nanoagent.plugin.verifier.TASK_VERIFIER_EXPLANATIONS); a failure by `verify_task` alone has none.
const EXPLANATIONS = ['invalid_answer', 'refused_answer_case', 'answered_refusal_case', 'execution_failed'];
// `ended`: a free-form Terminal session the member left, which had no case to answer.
// `worker_error`: the worker itself failed on a case (its reason says how), so no verifier saw the attempt; RUSH queues the case again.
const EXECUTION_STATUSES = ['answered', 'refused', 'execution_failed', 'canceled', 'ended', 'worker_error'];
// A verifier's named checks (nanoagent.plugin tasks' `details.checks`) as an attempt's verdict keeps them: their names and statuses, never their messages or values.
const CHECK_STATUSES = ['passed', 'failed', 'skipped'];
const MAX_CHECKS = 100;
// What one case's fixtures archive (gzipped tar) may be, decoded, and what one case's prompt may hold.
const MAX_FIXTURES_BYTES = 8 * 1024 * 1024;
const MAX_PROMPT_CHARS = 1_000_000;
// What may carry a verdict: a result the plugin's verifier saw.
const SCORABLE = new Set(['answered', 'refused', 'execution_failed']);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && !isLosslessNumber(value);

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

/** What a case set's task gives a worker: its kind, description, schemas and tools (the reference tool is not one). */
function taskOf(value) {
  const task = object(value, 'task');
  if (!TASK_KINDS.includes(task.kind)) throw bad('invalid_request', `task.kind must be one of ${TASK_KINDS.join(', ')}`);
  if (task.instructions !== undefined) throw bad('invalid_request', 'task.instructions is no longer a field of a publication: the prompt of each case says everything its harness is told');
  const names = new Set();
  const hosts = array(task.egress_hosts, 'task.egress_hosts', {max: 200}).map(host => string(host, 'an egress host', {max: 253}));
  if (hosts.some((host, index) => index > 0 && hosts[index - 1] >= host)) throw bad('invalid_request', 'task.egress_hosts must be sorted, without repeats');
  return {
    kind: task.kind,
    egress_hosts: hosts,
    description: string(task.description, 'task.description', {max: 10_000}),
    input_schema: object(task.input_schema, 'task.input_schema'),
    output_schema: object(task.output_schema, 'task.output_schema'),
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

/**
 * The digests of what one case pins: its reference's, and the case's own over its kind, prompt, arguments, fixtures (the archive's digest and
 * its file list, which the worker checks the unpacked archive against), expected error and reference. Case sets are shared by that digest, so a
 * publication whose file list differs never reuses another's.
 */
const caseDigests = (c, reference) => {
  const referenceSha256 = sha256Hex(canonicalJson(reference));
  return {reference_sha256: referenceSha256, content_digest: sha256Hex(canonicalJson({
    kind: c.kind, prompt: c.prompt, arguments: c.arguments, fixtures_sha256: c.fixtures?.sha256 ?? null, fixtures_files: c.fixtures?.files ?? null,
    expected_error: c.expected_error, reference_sha256: referenceSha256,
  }))};
};

// A path inside a case's fixtures: relative, POSIX, without empty, `.` or `..` segments.
const fixturePath = path => typeof path === 'string' && path.length > 0 && path.length <= 1024 && !path.includes('\0') && !path.includes('\\')
  && !path.startsWith('/') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
const BASE64_TEXT = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * A case's fixtures as a publication gives them: null, or `{sha256, files, archive}` (the digest of the gzipped tar, each file's path
 * with the digest of its bytes, and the archive as base64). Resolves to `{sha256, files, archive}` with the archive as a Buffer, once
 * its size is within MAX_FIXTURES_BYTES and its bytes hash to `sha256`.
 */
function fixturesOf(value, caseId) {
  if (value === null) return null;
  const what = `Case ${caseId}'s fixtures`;
  if (!isObject(value)) throw bad('invalid_request', `${what} must be an object or null`);
  const extra = Object.keys(value).find(key => !['sha256', 'files', 'archive'].includes(key));
  if (extra) throw bad('invalid_request', `${what} has ${extra}, which is no field of it; it takes sha256, files, archive`);
  const digest = sha256(value.sha256, `${what}'s sha256`);
  const files = object(value.files, `${what}'s files`);
  for (const [path, fileDigest] of Object.entries(files)) {
    if (!fixturePath(path)) throw bad('invalid_request', `${what}'s file path ${JSON.stringify(path)} must be a relative POSIX path with no empty, "." or ".." part`);
    sha256(fileDigest, `${what}'s digest of ${path}`);
  }
  if (typeof value.archive !== 'string' || value.archive.length % 4 !== 0 || !BASE64_TEXT.test(value.archive)) {
    throw bad('invalid_request', `${what}'s archive must be the .tar.gz as base64`);
  }
  const padding = value.archive.endsWith('==') ? 2 : value.archive.endsWith('=') ? 1 : 0;
  if (value.archive.length / 4 * 3 - padding > MAX_FIXTURES_BYTES) throw bad('fixtures_too_large', `${what} may be ${MAX_FIXTURES_BYTES} bytes at most`);
  const archive = Buffer.from(value.archive, 'base64');
  if (!archive.length) throw bad('invalid_request', `${what}'s archive is empty`);
  if (sha256Hex(archive) !== digest) throw bad('invalid_request', `${what}'s archive does not hash to its sha256`);
  return {sha256: digest, files: {...files}, archive};
}

// What a case of a publication holds; anything else (the old shape's `context` among it) is refused by name.
const CASE_FIELDS = ['case_id', 'kind', 'prompt', 'arguments', 'fixtures', 'expected_error'];

/**
 * Case `c` (its id, kind, prompt, arguments, fixtures and expected error) with its private reference, checked: what it publishes, the
 * digests of what it pins and the sha256 of its prompt.
 */
function pinnedCase(c, reference) {
  const caseId = c.case_id;
  const extra = Object.keys(c).find(key => !CASE_FIELDS.includes(key));
  if (extra) throw bad('invalid_request', `Case ${caseId} has ${extra}, which is no field of a case; it takes ${CASE_FIELDS.join(', ')}`);
  if (!CASE_KINDS.includes(c.kind)) throw bad('invalid_request', `Case ${caseId}'s kind must be one of ${CASE_KINDS.join(', ')}`);
  if (typeof c.prompt !== 'string' || !c.prompt.trim() || c.prompt.length > MAX_PROMPT_CHARS || !c.prompt.isWellFormed() || c.prompt.includes('\0')) {
    throw bad('invalid_request', `Case ${caseId}'s prompt must be a string of 1 to ${MAX_PROMPT_CHARS} characters, not blank`);
  }
  // An agent (hermes) strips its input, and prompt_bound pins the first request byte for byte: never trimmed silently.
  if (c.prompt !== c.prompt.trim()) throw bad('invalid_request', `Case ${caseId}'s prompt must not start or end with whitespace`);
  object(c.arguments, `Case ${caseId}'s arguments`);
  if (c.fixtures === undefined) throw bad('invalid_request', `Case ${caseId}'s fixtures must be an object or null`);
  const fixtures = fixturesOf(c.fixtures, caseId);
  let expectedError = null;
  if (c.kind === 'refuse') {
    expectedError = string(c.expected_error, `Case ${caseId}'s expected_error`, {max: 10_000});
    if (typeof reference !== 'string') throw bad('invalid_request', `private's reference for refusal case ${caseId} must be the pinned error string`);
  } else {
    if (c.expected_error !== undefined && c.expected_error !== null) throw bad('invalid_request', `Case ${caseId} is an answer case and takes no expected_error`);
    if (reference !== null && !isObject(reference)) throw bad('invalid_request', `private's reference for answer case ${caseId} must be an object, or null for a task judged without one`);
  }
  const published = {case_id: caseId, kind: c.kind, prompt: c.prompt, arguments: c.arguments, fixtures, expected_error: expectedError};
  return {...published, prompt_sha256: sha256Hex(c.prompt), ...caseDigests(published, reference)};
}

/** The fields the previous publication shape had, which a publication may no longer carry. */
const REMOVED_FIELDS = ['context', 'coding_template', 'task_instructions'];
/** The run configuration the server pins on every benchmark (RUN_ENDPOINT, RUN_MODEL): a request may not name it. */
const PINNED_FIELDS = ['model', 'endpoint_profile'];
const noPinnedFields = body => {
  const field = PINNED_FIELDS.find(name => body[name] !== undefined);
  if (field) throw bad('invalid_request', `${field} is not a field of a publication: every benchmark runs on ${RUN_MODEL} through ${RUN_ENDPOINT}`);
};

/**
 * A benchmark publication, what POST /api/benchmark/benchmarks stores: the case set's cases with their per-case and whole digests
 * (the case set is made from them), the run configuration (model, endpoint, the effective limits) and the benchmark's own digest.
 * Whether the endpoint's workers can give the limits is the service's to check.
 */
function benchmarkPublication(body) {
  const frame = publicationFrame(body);
  const {task} = frame;
  const caseList = array(body.cases, 'cases', {max: 5000});
  if (!caseList.length) throw bad('invalid_request', 'A benchmark needs at least one case');
  const privateReferences = object(body.private, 'private');
  const seen = new Set();
  const cases = caseList.map(raw => {
    const c = object(raw, 'A case');
    const caseId = string(c.case_id, 'case_id');
    if (seen.has(caseId)) throw bad('invalid_request', `case_id ${caseId} appears twice`);
    seen.add(caseId);
    if (!Object.hasOwn(privateReferences, caseId)) throw bad('invalid_request', `private has no reference for case ${caseId}`);
    return pinnedCase({...c, case_id: caseId}, privateReferences[caseId]);
  });
  const extra = Object.keys(privateReferences).find(id => !seen.has(id));
  if (extra) throw bad('invalid_request', `private has a reference for ${extra}, which is no case`);
  // The identity of the case set, to which its package is bound.
  const caseSetDigest = sha256Hex(canonicalJson({
    package_sha256: frame.package_sha256, task_id: frame.task_id, task, cases: cases.map(({case_id: id, content_digest: contentDigest}) => ({case_id: id, content_digest: contentDigest})),
  }));
  return {
    ...frame, cases, private: privateReferences, case_set_digest: caseSetDigest,
    digest: sha256Hex(canonicalJson({case_set_digest: caseSetDigest, model: frame.model, endpoint_profile: frame.endpoint_profile, limits: frame.limits})),
  };
}

/** What a publication says but its cases (and their digests): the plugin, the task and the run configuration. */
function publicationFrame(body) {
  object(body, 'The body');
  const removed = REMOVED_FIELDS.find(field => body[field] !== undefined);
  if (removed) throw bad('invalid_request', `${removed} is no longer a field of a publication: the prompt of each case says everything its harness is told`);
  noPinnedFields(body);
  const name = string(body.name, 'name', {max: 128});
  if (!BENCHMARK_NAME.test(name)) throw bad('invalid_request', 'name is lowercase letters, digits, ".", "_" and "-"');
  const task = taskOf(body.task);
  return {
    name, plugin_id: string(body.plugin_id, 'plugin_id'), plugin_name: string(body.plugin_name, 'plugin_name'), version: string(body.version, 'version', {max: 64}),
    package_sha256: sha256(body.package_sha256, 'package_sha256'), task_id: string(body.task_id, 'task_id'), task,
    model: RUN_MODEL, endpoint_profile: RUN_ENDPOINT,
    // The body is read with every number's spelling kept; a limit is a plain number.
    limits: effectiveLimits(limitOverrides(body.limits === undefined ? undefined : JSON.parse(stringifyJson(body.limits)))),
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

/** A run request, `{benchmark_id, harness, idempotency_key}`: one harness on a published benchmark, all its cases. The benchmark fixes everything else. */
function runBody(body) {
  only(body, ['benchmark_id', 'harness', 'idempotency_key']);
  const request = {
    benchmark_id: uuid(body.benchmark_id, 'benchmark_id'),
    harness: checkHarness(body.harness),
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

/** Which of a session's terminals a body names: `terminal`, 0 (the first) to MAX_TERMINALS - 1. */
const terminalOf = body => integer(body.terminal, 'terminal', {max: MAX_TERMINALS - 1});

/**
 * A worker's terminal output: `{fence, terminal, offset, data}`, `data` the bytes terminal `terminal` wrote from byte `offset`, sent as
 * base64; or `{fence, terminal, closed: true}`, that the terminal ended, after its last output.
 */
function terminalBody(body) {
  object(body, 'The body');
  const head = {fence: fenceOf(body), terminal: terminalOf(body)};
  if (body.closed !== undefined) {
    if (body.closed !== true) throw bad('invalid_request', 'closed is true when given');
    return {...head, closed: true};
  }
  const encoded = string(body.data, 'data', {max: Math.ceil(MAX_TERMINAL_CHUNK_BYTES / 3) * 4});
  if (!encoded || !BASE64.test(encoded)) throw bad('invalid_request', 'data is the bytes as non-empty base64');
  return {...head, offset: integer(body.offset, 'offset', {min: 0, max: MAX_ATTEMPT_TERMINAL_BYTES}), data: Buffer.from(encoded, 'base64')};
}

/** Where a session's member reaches its terminals on their computer: `{fence, port, token}`, `port` on 127.0.0.1. */
function terminalLinkBody(body) {
  object(body, 'The body');
  return {fence: fenceOf(body), port: integer(body.port, 'port', {min: 1, max: 65535}), token: string(body.token, 'token', {max: 200})};
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

// An agent's CLI command (a harness name's characters) and its conversation id, which a resumed session's terminal runs as one word.
const CLI_COMMAND = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;

/** One chat a worker read from an agent CLI's state (`finalize`'s `chats`). */
function chatOf(value) {
  const chat = object(value, 'a chat');
  if (typeof chat.agent !== 'string' || !CLI_COMMAND.test(chat.agent)) throw bad('invalid_request', "a chat's agent must be a CLI command");
  if (typeof chat.id !== 'string' || !CONVERSATION_ID.test(chat.id)) throw bad('invalid_request', "a chat's id must be its CLI's conversation id");
  const at = what => {
    const text = string(chat[what], `a chat's ${what}`, {max: 40});
    if (Number.isNaN(Date.parse(text))) throw bad('invalid_request', `a chat's ${what} must be an ISO 8601 time`);
    return text;
  };
  return {
    agent: chat.agent, id: chat.id, title: string(chat.title, "a chat's title", {max: 200}), started_at: at('started_at'), ended_at: at('ended_at'),
    started_ns: String(ns(chat.started_ns, "a chat's started_ns")), ended_ns: String(ns(chat.ended_ns, "a chat's ended_ns")),
  };
}

/**
 * A Terminal session's files as finalize names them (nanoagent.uploaded.workspace_upload): `{sha256, bytes, chunks}`, a tar.zst the
 * attempt's payloads `chunks` hold in order, or `{error}`, why the worker uploaded none.
 */
function workspaceOf(workspace) {
  object(workspace, 'workspace');
  if (workspace.error !== undefined) return {error: string(workspace.error, 'workspace.error', {max: 500})};
  return {
    sha256: sha256(workspace.sha256, 'workspace.sha256'), bytes: integer(workspace.bytes, 'workspace.bytes', {min: 1}),
    chunks: array(workspace.chunks, 'workspace.chunks', {max: 1000}).map(chunk => sha256(chunk, 'A workspace chunk')),
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
  // The verifier's named checks, which come only with the verdict they explain.
  const checks = body.checks === undefined ? null : array(body.checks, 'checks', {max: MAX_CHECKS}).map(raw => {
    const check = object(raw, 'A check');
    const extra = Object.keys(check).find(key => key !== 'name' && key !== 'status');
    if (extra) throw bad('invalid_request', `A check has ${extra}, which is no field of it; it takes name, status`);
    if (!CHECK_STATUSES.includes(check.status)) throw bad('invalid_request', `A check's status is one of ${CHECK_STATUSES.join(', ')}`);
    return {name: string(check.name, "a check's name", {max: 200}), status: check.status};
  });
  if (checks !== null && verdict === null) throw bad('invalid_request', 'checks come only with a verdict');
  // Whether the worker kept a free-form Terminal session on the member's computer to resume (null: it says nothing of it).
  if (body.resumable !== undefined && typeof body.resumable !== 'boolean') throw bad('invalid_request', 'resumable must be a boolean');
  // The chats it held (each conversation of an agent CLI, by the CLI's own id, its times also on the records' clock), and the older
  // sessions the worker removed from the member's computer to keep this one.
  const chats = body.chats === undefined ? null : array(body.chats, 'chats', {max: 500}).map(chatOf);
  const evicted = array(body.evicted, 'evicted', {optional: true, max: 10_000}).map(id => {
    if (typeof id !== 'string' || !UUID.test(id)) throw bad('invalid_request', 'evicted holds attempt ids');
    return id;
  });
  return {
    fence: fenceOf(body),
    final: {
      execution: {status: execution.status, reason: string(execution.reason, 'execution.reason', {optional: true, max: 200})},
      verdict, explanation, verifier_error: verifierError, checks,
      coverage: bounded(body.coverage, 'coverage', MAX_RESULT_BYTES), metrics: bounded(body.metrics, 'metrics', MAX_RESULT_BYTES),
      final_cursor_expected: integer(body.final_cursor_expected, 'final_cursor_expected'),
      resumable: body.resumable ?? null, chats, evicted, workspace: body.workspace === undefined ? null : workspaceOf(body.workspace),
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
    // Whether the claim is the worker's slot kept for an interactive session (the Terminal) or one of its run slots, which take the rest.
    interactive: boolean(body.interactive, 'interactive'),
    // How long a claim with nothing to lease waits for work to be queued: none unless the worker asks.
    waitMs: body.wait_s === undefined ? 0 : Math.round(finite(body.wait_s, 'wait_s', {min: 0, max: MAX_CLAIM_WAIT_S}) * 1000),
  };
}

/**
 * What a member's Publish upload carries (`POST benchmarks/pinned`): the benchmark's name, the YAML case file's text and every other file of
 * the uploaded case folder by its path in the folder (base64), plus the plugin and limits. The size is bounded by the body's
 * read (MAX_PUBLISH_BYTES); the case file's own shape is NanoAgent's to judge, line by line.
 */
function pinnedBody(body) {
  const {plugin_id: pluginId, name, case_file: caseFile, files, limits} = object(body, 'The body');
  noPinnedFields(body);
  const checkedName = string(name, 'name', {max: 128});
  if (!BENCHMARK_NAME.test(checkedName)) throw bad('invalid_request', 'name is lowercase letters, digits, ".", "_" and "-"');
  const uploaded = object(files, 'files');
  for (const [path, data] of Object.entries(uploaded)) {
    if (typeof data !== 'string') throw bad('invalid_request', `files ${path} must be a base64 string`);
  }
  return {
    pluginId: string(pluginId, 'plugin_id'), name: checkedName, caseFile: string(caseFile, 'case_file', {max: 1 << 20}), files: uploaded,
    limits,
  };
}

module.exports = {
  benchmarkPublication, pinnedBody, runBody, eventsBody, terminalBody, terminalLinkBody, spansBody, finalizeBody, admissionBody, settleBody, accountingBody,
  claimBody, SHA256, fenceOf, object, string, CLI_COMMAND, CONVERSATION_ID,
};
