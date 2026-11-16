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
  concurrency: {default: 4, integer: true, min: 1},
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

module.exports = {CAPABILITY_WINDOW_S, DEFAULT_LIMITS, LIMIT_FIELDS, limitOverrides, effectiveLimits, capabilitiesOf, exceeded};
