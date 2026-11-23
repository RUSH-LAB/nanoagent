'use strict';

const crypto = require('crypto');
const {BenchmarkError} = require('./errors');
const {isLosslessNumber} = require('./json');

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

module.exports = {canonicalJson, sha256Hex};
