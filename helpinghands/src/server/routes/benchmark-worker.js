'use strict';

/**
 * Uploaded harness benchmarks, the worker's side (docs/contracts/rush-benchmark-api.md in the
 * NanoAgent project), under /api/benchmark-worker/. The worker has no member session: it sends
 * Authorization: Bearer <credential>, a worker credential its member minted, and every route acts for that member
 * only. Each attempt route carries the lease's fence; a claim carries the worker's capabilities.
 */
const crypto = require('crypto');
const {BenchmarkError} = require('../benchmark/errors');
const {stringifyJson} = require('../benchmark/json');
const {UUID, jsonBody, rawBody, sendFailure} = require('../benchmark/http');
const v = require('../benchmark/validate');
const {positiveSetting} = require('../benchmark/limits');

const MAX_PAYLOAD_BYTES = positiveSetting('BENCHMARK_PAYLOAD_MAX_BYTES', 16 * 1024 * 1024);
const REDACTIONS = ['none', 'redacted', 'truncated'];

const ROUTE = new RegExp([
  '^/api/benchmark-worker/(?:',
  '(claim)',
  '|attempts/([^/]+)/(renew|source|package|admissions|events|spans|finalize|accounting)',
  '|attempts/([^/]+)/admissions/([^/]+)/(settle)',
  '|attempts/([^/]+)/payloads/([^/]+)',
  ')$',
].join(''));

/** The fence a bytes request carries in X-Rush-Fence. */
function fenceHeader(req) {
  const raw = req.headers['x-rush-fence'];
  if (!/^\d{1,9}$/.test(raw ?? '') || Number(raw) < 1) throw new BenchmarkError(400, 'invalid_request', 'Send the lease\'s fence in X-Rush-Fence');
  return Number(raw);
}

function sendBytes(res, {data, sha256}) {
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream', 'Content-Length': data.length, 'X-Rush-Sha256': sha256,
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

module.exports = async function benchmarkWorker(req, res, url, pathname, ctx) {
  if (!pathname.startsWith('/api/benchmark-worker/')) return undefined;
  const {readBody, benchmark: services} = ctx;
  // A claim carries case arguments and references with the spelling of their numbers, so a response writes them with the same serializer.
  const json = (res, status, data, opts) => ctx.json(res, status, data, {...opts, stringify: stringifyJson});
  try {
    if (!services) return json(res, 503, {error: 'Benchmarks need PostgreSQL (DATABASE_URL)', code: 'benchmark_disabled'});
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    const userId = bearer ? await services.worker.authenticate(bearer) : null;
    if (!userId) return json(res, 401, {error: 'Send Authorization: Bearer <worker credential>, a credential you minted and have not revoked', code: 'unauthorized'});
    const match = ROUTE.exec(pathname);
    if (!match) return json(res, 404, {error: 'Not found', code: 'not_found'});
    const {worker} = services;
    const [, claim, jobId, jobPart, settleAttempt, callId, , payloadAttempt, sha256] = match;
    const body = () => jsonBody(req, readBody);
    const wanted = (method, id) => {
      if (req.method !== method) throw new BenchmarkError(405, 'method_not_allowed', 'Method not allowed');
      if (id !== undefined && !UUID.test(id)) throw new BenchmarkError(404, 'unknown_attempt', 'No such attempt');
    };

    if (claim) {
      wanted('POST');
      const {workerId, label, capabilities} = v.claimBody(await body());
      const job = await worker.claim(userId, workerId, label, capabilities);
      if (!job) {
        res.writeHead(204);
        return res.end();
      }
      return json(res, 200, job);
    }
    if (jobId !== undefined) {
      if (jobPart === 'source' || jobPart === 'package') {
        wanted('GET', jobId);
        return sendBytes(res, await worker.artifact(userId, jobId, fenceHeader(req), jobPart));
      }
      wanted('POST', jobId);
      const input = await body();
      if (jobPart === 'renew') return json(res, 200, await worker.renew(userId, jobId, v.fenceOf(v.object(input, 'The body'))));
      if (jobPart === 'admissions') {
        const {fence, callId: id, reserveUsd} = v.admissionBody(input);
        return json(res, 201, await worker.admit(userId, jobId, fence, id, reserveUsd));
      }
      if (jobPart === 'events') {
        const {fence, events} = v.eventsBody(input);
        return json(res, 200, await worker.appendEvents(userId, jobId, fence, events));
      }
      if (jobPart === 'spans') {
        const {fence, spans, links} = v.spansBody(input);
        return json(res, 200, await worker.putSpans(userId, jobId, fence, spans, links));
      }
      if (jobPart === 'finalize') {
        const {fence, final} = v.finalizeBody(input);
        return json(res, 200, await worker.finalize(userId, jobId, fence, final));
      }
      const {callId: id, version, record} = v.accountingBody(input);
      return json(res, 200, await worker.putAccounting(userId, jobId, id, version, record));
    }
    if (settleAttempt !== undefined) {
      wanted('POST', settleAttempt);
      let call;
      try {
        call = decodeURIComponent(callId);
      } catch {
        throw new BenchmarkError(400, 'invalid_request', 'The call id is not a valid URL path segment');
      }
      return json(res, 200, await worker.settle(userId, settleAttempt, call, v.settleBody(await body())));
    }
    if (payloadAttempt !== undefined) {
      wanted('PUT', payloadAttempt);
      const fence = fenceHeader(req);
      const redaction = req.headers['x-rush-redaction'];
      if (!REDACTIONS.includes(redaction)) throw new BenchmarkError(400, 'invalid_request', `Send X-Rush-Redaction: ${REDACTIONS.join(', ')}`);
      if (!v.SHA256.test(sha256)) throw new BenchmarkError(400, 'invalid_request', 'The path names the payload by its lowercase SHA-256');
      const data = await rawBody(req, MAX_PAYLOAD_BYTES, 'payload_too_large');
      if (crypto.createHash('sha256').update(data).digest('hex') !== sha256) throw new BenchmarkError(400, 'digest_mismatch', 'The bytes do not hash to the digest in the path');
      const contentType = (req.headers['content-type'] ?? 'application/octet-stream').slice(0, 200);
      return json(res, 200, await worker.putPayload(userId, payloadAttempt, fence, {sha256, data, redaction, contentType}));
    }
    return json(res, 404, {error: 'Not found', code: 'not_found'});
  } catch (error) {
    return sendFailure(json, res, error);
  }
};
