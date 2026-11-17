'use strict';

const {BenchmarkError} = require('./errors');

/**
 * The limits a run pins and the worker applies, each with its default (today's worker limits, made explicit) and
 * how it is checked. `capability` fields are the ones a worker advertises a maximum for; `internet_access` is a boolean
 * a worker advertises support for.
 */
const NUMBER_LIMITS = Object.freeze({
  wall_time_ms: {default: 600_000, integer: true, min: 1},
  max_model_calls: {default: 50, integer: true, min: 0},
  max_output_tokens_per_call: {default: 4096, integer: true, min: 1},
  max_cost_usd: {default: 1.5, integer: false, min: 0},
  cpus: {default: 1, integer: false, min: Number.MIN_VALUE},
  memory_mb: {default: 1024, integer: true, min: 1},
  pids: {default: 256, integer: true, min: 1},
  workspace_bytes: {default: 256 * 1024 * 1024, integer: true, min: 1},
  workspace_files: {default: 20_000, integer: true, min: 1},
  tmp_bytes: {default: 64 * 1024 * 1024, integer: true, min: 1},
  build_wall_ms: {default: 600_000, integer: true, min: 1},
  // The build's output volume and /tmp are tmpfs charged to the build's memory, so the build has its own memory, size, file and /tmp bounds.
  // The defaults fit every reference harness (the largest, dsh, builds 591 MiB in 44,506 files).
  build_memory_mb: {default: 3072, integer: true, min: 1},
  build_output_bytes: {default: 1024 * 1024 * 1024, integer: true, min: 1},
  build_files: {default: 100_000, integer: true, min: 1},
  // The build's /tmp is a tmpfs charged to the build's memory too; the go-1 toolchain compiles the standard library into it (about 400 MiB).
  build_tmp_bytes: {default: 512 * 1024 * 1024, integer: true, min: 1},
});
const DEFAULT_LIMITS = Object.freeze({
  ...Object.fromEntries(Object.entries(NUMBER_LIMITS).map(([name, {default: value}]) => [name, value])),
  internet_access: true,
});
const LIMIT_FIELDS = Object.freeze(Object.keys(DEFAULT_LIMITS));

/** How long a worker's advertised capabilities stand: an endpoint label with no claim within this window has no worker available. */
const CAPABILITY_WINDOW_S = 300;

const bad = (code, message, extra) => new BenchmarkError(400, code, message, extra);

function limitValue(name, value, what) {
  if (name === 'internet_access') {
    if (typeof value !== 'boolean') throw bad('invalid_request', `${what}.internet_access must be a boolean`);
    return value;
  }
  const rule = NUMBER_LIMITS[name];
  const ok = typeof value === 'number' && Number.isFinite(value) && value >= rule.min && (!rule.integer || Number.isSafeInteger(value));
  if (!ok) throw bad('invalid_request', `${what}.${name} must be ${rule.integer ? 'an integer' : 'a number'} of at least ${rule.min === Number.MIN_VALUE ? 'more than 0' : rule.min}`);
  return value;
}

/** The overrides a request gives (an object or null), checked: `{name: value}` for the limits it names. */
function limitOverrides(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw bad('invalid_request', 'limits must be an object');
  // A run has no concurrency of its own: how many attempts run at once is the runner's setting in RUSH Lab.
  if ('concurrency' in value) throw bad('invalid_request', 'limits.concurrency is not a limit: how many attempts run at once is the local runner\'s concurrency, set in RUSH Lab (Local Runner Health Check, Advanced settings)');
  const unknown = Object.keys(value).find(name => !LIMIT_FIELDS.includes(name));
  if (unknown) throw bad('invalid_request', `limits.${unknown} is not a limit; the limits are ${LIMIT_FIELDS.join(', ')}`);
  // A null field takes its default, as the CLI sends them.
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([name, v]) => [name, limitValue(name, v, 'limits')]));
}

/** Every limit, with the defaults under `overrides`, in the order of LIMIT_FIELDS. */
const effectiveLimits = overrides => Object.fromEntries(LIMIT_FIELDS.map(name => [name, overrides[name] ?? DEFAULT_LIMITS[name]]));

/** A worker's capabilities as it sends them: every limit, the maximum it applies (and `internet_access` whether it can), and the `models` it prices. */
function capabilitiesOf(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw bad('invalid_request', 'capabilities must be an object');
  const missing = LIMIT_FIELDS.filter(name => value[name] === undefined);
  if (missing.length) throw bad('invalid_request', `capabilities must give ${missing.join(', ')}`);
  const {models} = value;
  if (!Array.isArray(models) || models.length === 0 || models.some(model => typeof model !== 'string' || model.trim() === '')) {
    throw bad('invalid_request', 'capabilities.models must be a non-empty array of the model names the worker prices');
  }
  return {...Object.fromEntries(LIMIT_FIELDS.map(name => [name, limitValue(name, value[name], 'capabilities')])), models: [...new Set(models)]};
}

/** The limits of `limits` a worker with `capabilities` cannot give, as `[{field, limit, max}]` (`max` is the worker's). */
function exceeded(limits, capabilities) {
  return LIMIT_FIELDS.filter(name => (name === 'internet_access' ? limits.internet_access && !capabilities.internet_access : limits[name] > capabilities[name]))
    .map(field => ({field, limit: limits[field], max: capabilities[field]}));
}

/** What one member's stored source ZIPs and attempt payloads may total, across every workspace; an upload past it is refused. */
const MEMBER_STORAGE_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * What the worker API stores for one attempt, so a worker cannot fill the database or make a read unbounded: each item's bytes (JSON text),
 * each kind's count, and the bytes of the events one read returns. An attempt's model calls are already bounded by its max_model_calls.
 */
const MAX_EVENT_DATA_BYTES = 256 * 1024;
const MAX_SPAN_ATTRIBUTES_BYTES = 32 * 1024;
const MAX_LINK_ATTRIBUTES_BYTES = 8 * 1024;
const MAX_ACCOUNTING_RECORD_BYTES = 64 * 1024;
/** The metrics and the coverage an attempt is finalized with are a handful of counters and statuses. */
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_ATTEMPT_EVENTS = 100_000;
const MAX_ATTEMPT_SPANS = 10_000;
const MAX_ATTEMPT_LINKS = 20_000;
/** Versions of one call's accounting record. */
const MAX_ACCOUNTING_VERSION = 10;
const MAX_EVENT_PAGE_BYTES = 8 * 1024 * 1024;
/** The most USD one call may settle at beyond what it reserved: the reserve is the gateway's upper bound on the cost, so honest calls stay under it. */
const SETTLE_RESERVE_FACTOR = 2;
/** The columns' ranges: numeric(20,8) holds below 1e12, integer below 2^31, bigint below 2^63. */
const MAX_USD = 1e11;
const MAX_INTEGER = 2 ** 31 - 1;
const MAX_BIGINT = 2n ** 63n - 1n;

/** The server setting `name` from the environment, `fallback` when unset; a value that is not a positive number stops startup. */
function positiveSetting(name, fallback) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

module.exports = {
  CAPABILITY_WINDOW_S, MEMBER_STORAGE_BYTES, MAX_EVENT_DATA_BYTES, MAX_SPAN_ATTRIBUTES_BYTES, MAX_LINK_ATTRIBUTES_BYTES, MAX_ACCOUNTING_RECORD_BYTES,
  MAX_RESULT_BYTES, MAX_ATTEMPT_EVENTS, MAX_ATTEMPT_SPANS, MAX_ATTEMPT_LINKS, MAX_ACCOUNTING_VERSION, MAX_EVENT_PAGE_BYTES, SETTLE_RESERVE_FACTOR, MAX_USD,
  MAX_INTEGER, MAX_BIGINT, DEFAULT_LIMITS, LIMIT_FIELDS, limitOverrides, effectiveLimits, capabilitiesOf, exceeded, positiveSetting};
