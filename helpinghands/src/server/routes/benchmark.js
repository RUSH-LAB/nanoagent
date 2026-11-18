'use strict';

/**
 * Uploaded harness benchmarks, the member's side (docs/contracts/rush-benchmark-api.md in the
 * NanoAgent project). Under /api/workspaces/:id/benchmark/ (dispatched here as /api/benchmark/):
 * the setup defaults, published benchmarks, previews, source uploads, runs, and their saved or live
 * traces, and the comparison of two runs or of two attempts of one case. POST /api/benchmark/benchmarks, outside any workspace, is
 * how a member publishes a benchmark; POST benchmarks/pinned builds the body on the member's computer, where the plugin's reference
 * tool pins each case, and publishes it from NanoAgent's own text.
 */
const {PIN_TIMEOUT_MS, RUNNER_OFFLINE} = require('../ai');
const {BenchmarkError} = require('../benchmark/errors');
const {parseJson, stringifyJson} = require('../benchmark/json');
const {compareAttempts, compareRuns} = require('../benchmark/compare');
const {UUID, jsonBody, losslessBody, rawBody, segment, handle} = require('../benchmark/http');
const {checkReference, referenceHarnessOf, uploadedHarnessOf} = require('../benchmark/harness');
const {previewBody, runBody, benchmarkPublication, SHA256, isObject, object, string} = require('../benchmark/validate');
const {positiveSetting} = require('../benchmark/limits');

const MAX_SOURCE_BYTES = positiveSetting('BENCHMARK_SOURCE_MAX_BYTES', 50 * 1024 * 1024);
const STREAM_POLL_MS = 300;
const HEARTBEAT_MS = 15_000;
const PAGE = 1000;

const ROUTE = new RegExp([
  '^/api/benchmark/(?:',
  '(defaults|benchmarks|benchmarks/pinned|previews|sources|runs|compare|compare/attempts|worker-credentials)',
  '|worker-credentials/([^/]+)',
  '|benchmarks/([^/]+)(?:/(results))?',
  '|runs/([^/]+)(?:/(cancel)|/cases/([^/]+)/(rerun))?',
  '|attempts/([^/]+)(?:/(events|stream|spans|accounting)|/payloads/([^/]+))?',
  '|sources/references/([^/]+)(?:/(computer))?',
  ')$',
].join(''));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function limitOf(url, fallback, max) {
  const raw = url.searchParams.get('limit');
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > max) throw new BenchmarkError(400, 'invalid_request', `limit is an integer from 1 to ${max}`);
  return Number(raw);
}

/** The `before` cursor as the ISO timestamp SQL takes, null when absent: any date `Date.parse` reads is normalized, anything else is a 400. */
function beforeOf(url) {
  const raw = url.searchParams.get('before');
  if (raw === null) return null;
  const time = Date.parse(raw);
  if (Number.isNaN(time)) throw new BenchmarkError(400, 'invalid_request', 'before is a timestamp');
  return new Date(time).toISOString();
}

function cursorOf(value) {
  if (value === null || value === undefined) return 0;
  if (!/^\d{1,15}$/.test(value)) throw new BenchmarkError(400, 'invalid_request', 'after is a cursor, a non-negative integer');
  return Number(value);
}

/** A source ZIP's bytes from the request, which must declare Content-Type: application/zip. */
function zipBody(req) {
  if (!/^application\/zip(?:;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw new BenchmarkError(415, 'unsupported_media_type', 'Send the source as Content-Type: application/zip');
  }
  req.setTimeout(120_000);
  return rawBody(req, MAX_SOURCE_BYTES, 'source_too_large');
}

/** Server-sent events: each committed event after `after`, then `sealed`; a client resumes with the last id it saw. */
async function stream(req, res, repository, context, attemptId, after) {
  const first = await repository.events(context, attemptId, after, 1);
  if (!first) throw new BenchmarkError(404, 'unknown_attempt', 'No such attempt');
  let closed = false;
  res.on('close', () => { closed = true; });
  res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no'});
  req.setTimeout(0);
  let cursor = after;
  let quiet = 0;
  while (!closed) {
    const page = await repository.events(context, attemptId, cursor, 200);
    // The member left the workspace, or the attempt went.
    if (!page) break;
    for (const event of page.events) {
      res.write(`id: ${event.cursor}\nevent: event\ndata: ${JSON.stringify(event)}\n\n`);
      cursor = event.cursor;
    }
    if (page.has_more) continue;
    if (page.sealed && cursor >= page.final_cursor) {
      res.write(`event: sealed\ndata: ${JSON.stringify({final_cursor: page.final_cursor})}\n\n`);
      break;
    }
    quiet = page.events.length ? 0 : quiet + STREAM_POLL_MS;
    if (quiet >= HEARTBEAT_MS) { res.write(': heartbeat\n\n'); quiet = 0; }
    await sleep(STREAM_POLL_MS);
  }
  res.end();
}

module.exports = async function benchmark(req, res, url, pathname, ctx) {
  const match = ROUTE.exec(pathname);
  if (!match) return undefined;
  const {readBody, readRawBody, requireWorkspacePermission, ai} = ctx;
  const [, top, credentialId, benchmarkId, results, runId, cancel, caseId, rerun, attemptId, attemptPart, payload, referenceName, onComputer] = match;
  return handle(ctx, res, async (json, {repository, service, worker}) => {
    // Any member publishes a benchmark for a published plugin version; no workspace is involved.
    if (top === 'benchmarks' && !req.context) {
      if (req.method !== 'POST') return json(res, 405, {error: 'Method not allowed'});
      if (!req.auth?.userId) return json(res, 401, {error: 'Not signed in'});
      const published = await service.publish(req.auth.userId, benchmarkPublication(await losslessBody(req, readRawBody)));
      return json(res, published.created ? 201 : 200, published);
    }
    // A member's worker credentials, outside any workspace: the worker runs on the member's computer and acts only for the member.
    if (top === 'worker-credentials' || credentialId !== undefined) {
      if (!req.auth?.userId) return json(res, 401, {error: 'Not signed in'});
      if (credentialId !== undefined) {
        if (req.method !== 'DELETE') return json(res, 405, {error: 'Method not allowed', code: 'method_not_allowed'});
        const revoked = UUID.test(credentialId) ? await worker.revokeCredential(req.auth.userId, credentialId) : null;
        return revoked ? json(res, 200, revoked) : json(res, 404, {error: 'No such credential', code: 'unknown_credential'});
      }
      if (req.method === 'GET') return json(res, 200, {credentials: await worker.listCredentials(req.auth.userId)});
      if (req.method !== 'POST') return json(res, 405, {error: 'Method not allowed', code: 'method_not_allowed'});
      return json(res, 201, await worker.mintCredential(req.auth.userId, string(object(await jsonBody(req, readBody), 'The body').name, 'name', {max: 100})));
    }
    if (!req.context) return json(res, 404, {error: 'Workspace not found'});
    const {context} = req;
    // Refuse a request that is not `method`, then check the member's permission in the workspace.
    const allow = (method, permission) => {
      if (req.method !== method) throw new BenchmarkError(405, 'method_not_allowed', 'Method not allowed');
      requireWorkspacePermission(context, permission);
    };
    const notFound = (what = 'run') => json(res, 404, {error: `No such ${what}`, code: `unknown_${what}`});
    // A 200 of `body(found)`, or the 404 for a `what` that is not there.
    const orNotFound = (found, what, body = value => value) => (found ? json(res, 200, body(found)) : notFound(what));

    if (top === 'defaults') {
      allow('GET', 'content:read');
      return json(res, 200, await service.defaults(context.userId));
    }
    if (top === 'benchmarks' || benchmarkId !== undefined) {
      allow('GET', 'content:read');
      if (benchmarkId === undefined) {
        const pluginId = url.searchParams.get('plugin_id');
        const version = url.searchParams.get('version');
        if (version !== null && pluginId === null) throw new BenchmarkError(400, 'invalid_request', 'version needs plugin_id');
        return json(res, 200, {benchmarks: await repository.benchmarks(context, {pluginId, version, limit: limitOf(url, 50, 200), before: beforeOf(url)})});
      }
      if (!UUID.test(benchmarkId)) return notFound('benchmark');
      if (results) {
        return orNotFound(await repository.benchmarkResults(context, benchmarkId, {limit: limitOf(url, 50, 200), before: beforeOf(url)}), 'benchmark', runs => ({runs}));
      }
      return orNotFound(await repository.benchmark(context, benchmarkId), 'benchmark', found => ({benchmark: found}));
    }
    if (top === 'compare' || top === 'compare/attempts') {
      allow('GET', 'content:read');
      const [a, b] = ['a', 'b'].map(name => url.searchParams.get(name));
      if (![a, b].every(id => id && UUID.test(id))) throw new BenchmarkError(400, 'invalid_request', `a and b are ${top === 'compare' ? 'run' : 'attempt'} ids`);
      return json(res, 200, top === 'compare' ? await compareRuns({repository, context, a, b}) : await compareAttempts({repository, ai, context, a, b}));
    }
    if (top === 'benchmarks/pinned') {
      allow('POST', 'apps:use');
      if (!ctx.workspaceApps) return json(res, 409, {error: 'Apps need a workspace file store', code: 'fs-disabled'});
      // Pinning every case runs the plugin's reference tool on the member's computer, which takes longer than the dispatcher's 30 second socket timeout.
      req.setTimeout(PIN_TIMEOUT_MS);
      // The body is read with every number's spelling kept and sent to NanoAgent as text, so `1.0` in a case's arguments is pinned as `1.0`.
      const {plugin_id: pluginId, name, cases, model, endpoint_profile: endpointProfile, limits, coding_template: codingTemplate, task_instructions: taskInstructions} = object(await losslessBody(req, readRawBody), 'The body');
      // What a benchmark takes from the member rather than from the plugin is checked before the minutes it takes to pin.
      string(model, 'model');
      string(endpointProfile, 'endpoint_profile', {max: 100});
      const computer = ctx.runners.computer(context.userId);
      if (!computer) return json(res, 503, {error: RUNNER_OFFLINE, code: 'runner_offline'});
      // The app is installed on the member's computer first, which pins with the package it runs.
      const opened = await ctx.workspaceApps.open(context, string(pluginId, 'plugin_id'), computer);
      if (opened.error) return json(res, opened.status, {error: opened.error, code: 'app_unavailable'});
      if (opened.value.status !== 'ready') return json(res, 409, {error: `${opened.value.id} is not ready to run`, code: 'app_unavailable'});
      // The case file's `_` class tag is the file's, not part of the benchmark.
      const caseFile = isObject(cases) ? Object.fromEntries(Object.entries(cases).filter(([key]) => key !== '_')) : cases;
      const pinned = await computer.benchmarkCaseSet(opened.value.sha256, stringifyJson({name, cases: caseFile}));
      if (pinned.error) return json(res, pinned.status, {error: pinned.error, code: 'pin_failed'});
      // The pinned body, private references and all, is published here from NanoAgent's own text: it never reaches the browser.
      const publication = benchmarkPublication({
        ...parseJson(pinned.value), name, model, endpoint_profile: endpointProfile, limits, coding_template: codingTemplate, task_instructions: taskInstructions,
      });
      const published = await service.publish(context.userId, publication);
      return json(res, published.created ? 201 : 200, published);
    }
    if (top === 'previews') {
      allow('POST', 'apps:use');
      return json(res, 200, await service.preview(context, previewBody(await jsonBody(req, readBody))));
    }
    if (top === 'sources') {
      allow('POST', 'apps:use');
      const data = await zipBody(req);
      return json(res, 201, await repository.saveSource(context, data, uploadedHarnessOf(data)));
    }
    // A reference harness's ZIP, under its own name only (a member's own upload may not take it): sent here, or built by the member's computer.
    if (referenceName !== undefined) {
      allow('POST', 'apps:use');
      checkReference(referenceName);
      let data;
      if (onComputer) {
        const computer = ctx.runners.computer(context.userId);
        if (!computer) return json(res, 503, {error: RUNNER_OFFLINE, code: 'runner_offline'});
        const built = await computer.benchmarkReferenceHarness(referenceName);
        if (built.error) return json(res, built.status, {error: built.error, code: 'reference_unavailable'});
        data = built.value;
      } else {
        data = await zipBody(req);
      }
      return json(res, 201, await repository.saveSource(context, data, referenceHarnessOf(data, referenceName)));
    }
    if (top === 'runs') {
      if (req.method === 'GET') {
        requireWorkspacePermission(context, 'content:read');
        return json(res, 200, {runs: await repository.listRuns(context, {limit: limitOf(url, 50, 200), before: beforeOf(url)})});
      }
      allow('POST', 'apps:use');
      const {run_id: id, replayed} = await service.submit(context, runBody(await jsonBody(req, readBody)));
      return json(res, replayed ? 200 : 201, {replayed, run: await repository.run(context, id)});
    }

    if (runId !== undefined) {
      if (!UUID.test(runId)) return notFound();
      if (!cancel && !rerun) {
        allow('GET', 'content:read');
        return orNotFound(await repository.run(context, runId), 'run', run => ({run}));
      }
      allow('POST', 'apps:use');
      if (cancel) return json(res, 200, await repository.cancel(context, runId));
      return json(res, 201, await repository.rerun(context, runId, segment(caseId, 'The case id')));
    }

    if (!UUID.test(attemptId)) return notFound('attempt');
    allow('GET', 'content:read');
    if (!attemptPart && !payload) return orNotFound(await repository.attempt(context, attemptId), 'attempt', attempt => ({attempt}));
    if (attemptPart === 'events') {
      return orNotFound(await repository.events(context, attemptId, cursorOf(url.searchParams.get('after')), limitOf(url, 200, PAGE)), 'attempt');
    }
    if (attemptPart === 'stream') {
      const after = cursorOf(url.searchParams.get('after') ?? req.headers['last-event-id'] ?? null);
      return stream(req, res, repository, context, attemptId, after);
    }
    if (attemptPart === 'spans') {
      return orNotFound(await repository.spans(context, attemptId, {
        kind: url.searchParams.get('kind'), status: url.searchParams.get('status'), q: url.searchParams.get('q'), limit: limitOf(url, 1000, 5000),
      }), 'attempt');
    }
    if (attemptPart === 'accounting') {
      return orNotFound(await repository.accounting(context, attemptId), 'attempt', found => ({attempt_id: attemptId, ...found}));
    }
    if (!SHA256.test(payload)) return notFound('payload');
    const stored = await repository.payload(context, attemptId, payload);
    if (!stored) return notFound('payload');
    res.writeHead(200, {
      'Content-Type': stored.content_type, 'Content-Length': stored.size, 'X-Rush-Redaction': stored.redaction,
      'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'attachment', 'Cache-Control': 'private, no-store',
    });
    return res.end(stored.data);
  });
};
