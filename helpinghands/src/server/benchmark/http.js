'use strict';

const {BenchmarkError} = require('./errors');
const {parseJson, stringifyJson} = require('./json');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The refusal a body that could not be read or parsed is answered with: 413 body_too_large, else 400 invalid_json. */
function bodyError(error) {
  const tooBig = error.message === 'Body too large';
  return new BenchmarkError(tooBig ? 413 : 400, tooBig ? 'body_too_large' : 'invalid_json', error.message);
}

/** The request's JSON body, or a 400 invalid_json. */
async function jsonBody(req, readBody) {
  try {
    return await readBody(req);
  } catch (error) {
    throw bodyError(error);
  }
}

/** The request's JSON body with every number's spelling kept (see parseJson), or a 400 invalid_json. */
async function losslessBody(req, readRawBody) {
  try {
    return parseJson((await readRawBody(req)).toString());
  } catch (error) {
    throw bodyError(error);
  }
}

/** A path segment, decoded; a malformed escape is the request's fault, not a 500. */
function segment(raw, what) {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new BenchmarkError(400, 'invalid_request', `${what} is not a valid URL path segment`);
  }
}

/** The request's bytes, refusing more than `max` with 413 `code` without reading the rest. */
function rawBody(req, max, code) {
  return new Promise((resolve, reject) => {
    const tooBig = () => new BenchmarkError(413, code, `The body may be ${max} bytes at most`);
    if (Number(req.headers['content-length']) > max) return reject(tooBig());
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > max) {
        req.pause();
        reject(tooBig());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    return undefined;
  });
}

/**
 * Run `route(json, services)` for a benchmark route, answering a BenchmarkError as `{error, code, ...extra}` and rethrowing anything else.
 * Case arguments, tasks and references keep the spelling of their numbers, so `json` writes a response with the lossless serializer.
 */
async function handle(ctx, res, route) {
  const json = (response, status, data, opts) => ctx.json(response, status, data, {...opts, stringify: stringifyJson});
  try {
    if (!ctx.benchmark) return json(res, 503, {error: 'Benchmarks need PostgreSQL (DATABASE_URL)', code: 'benchmark_disabled'});
    return await route(json, ctx.benchmark);
  } catch (error) {
    if (!(error instanceof BenchmarkError)) throw error;
    return json(res, error.status, {error: error.message, code: error.code, ...error.extra});
  }
}

module.exports = {UUID, jsonBody, losslessBody, rawBody, segment, handle};
