'use strict';

const crypto = require('crypto');
const {BenchmarkError} = require('./errors');
const {parseJson} = require('./json');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The request's JSON body, or a 400 invalid_json. */
async function jsonBody(req, readBody) {
  try {
    return await readBody(req);
  } catch (error) {
    throw new BenchmarkError(error.message === 'Body too large' ? 413 : 400, error.message === 'Body too large' ? 'body_too_large' : 'invalid_json', error.message);
  }
}

/** The request's JSON body with every number's spelling kept (see parseJson), or a 400 invalid_json. */
async function losslessBody(req, readRawBody) {
  try {
    return parseJson((await readRawBody(req)).toString());
  } catch (error) {
    throw new BenchmarkError(error.message === 'Body too large' ? 413 : 400, error.message === 'Body too large' ? 'body_too_large' : 'invalid_json', error.message);
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

/** Whether `header` is `Bearer <token>`, compared in constant time. */
function bearerIs(header, token) {
  const digest = value => crypto.createHash('sha256').update(String(value)).digest();
  return crypto.timingSafeEqual(digest(header ?? ''), digest(`Bearer ${token}`));
}

/** Answer a BenchmarkError as `{error, code, ...extra}`, or rethrow anything else. */
function sendFailure(json, res, error) {
  if (!(error instanceof BenchmarkError)) throw error;
  return json(res, error.status, {error: error.message, code: error.code, ...error.extra});
}

module.exports = {UUID, jsonBody, losslessBody, rawBody, bearerIs, sendFailure};
