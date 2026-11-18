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
const aiSettings = require('../ai-settings');
const {BenchmarkError} = require('../benchmark/errors');
const {parseJson, stringifyJson} = require('../benchmark/json');
const {compareAttempts, compareRuns} = require('../benchmark/compare');
const {UUID, jsonBody, losslessBody, rawBody, sendFailure} = require('../benchmark/http');
const {REFERENCE_HARNESSES, checkReference, referenceHarnessOf, referencePolicy, uploadedHarnessOf} = require('../benchmark/harness');
const {previewBody, runBody, benchmarkPublication, terminalInputBody, SHA256, object, string} = require('../benchmark/validate');
const {MAX_SOURCE_BYTES} = require('../benchmark/limits');

// The endpoint profile of the worker RUSH Lab runs (nanoagent/deploy/worker/worker.openrouter.yaml), which a Harness tab session runs on.
const SESSION_ENDPOINT = 'openrouter';
// What a Harness tab session's request may hold: what a plugin page's prompt may (PluginFrame/protocol.js).
const SESSION_TEXT_LIMIT = 50_000;
const STREAM_POLL_MS = 300;
// A terminal's output is read this often while its harness runs, so typing echoes promptly.
const TERMINAL_POLL_MS = 50;
const HEARTBEAT_MS = 15_000;
const PAGE = 1000;

const ROUTE = new RegExp([
  '^/api/benchmark/(?:',
  '(defaults|benchmarks|benchmarks/pinned|sessions|previews|sources|runs|compare|compare/attempts|worker-credentials)',
  '|worker-credentials/([^/]+)',
  '|benchmarks/([^/]+)(?:/(results))?',
  '|runs/([^/]+)(?:/(cancel)|/cases/([^/]+)/(rerun))?',
  '|attempts/([^/]+)(?:/(events|stream|terminal|spans|accounting)|/payloads/([^/]+))?',
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

/** A path segment, decoded; a malformed escape is the request's fault, not a 500. */
function segment(raw, what) {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new BenchmarkError(400, 'invalid_request', `${what} is not a valid URL path segment`);
  }
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

/**
 * Server-sent events: the attempt's terminal output from byte `start`, each chunk an `output` event (`{offset, data}`, data in
 * base64), then `sealed` once the attempt is sealed and every chunk is sent.
 */
async function terminalStream(req, res, repository, context, attemptId, start) {
  if (!(await repository.terminal(context, attemptId, start))) throw new BenchmarkError(404, 'unknown_attempt', 'No such attempt');
  let closed = false;
  res.on('close', () => { closed = true; });
  res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no'});
  req.setTimeout(0);
  let offset = start;
  let quiet = 0;
  while (!closed) {
    const page = await repository.terminal(context, attemptId, offset);
    if (!page) break;
    for (const chunk of page.chunks) {
      res.write(`event: output\ndata: ${JSON.stringify({offset: chunk.offset, data: chunk.data.toString('base64')})}\n\n`);
      offset = chunk.offset + chunk.data.length;
    }
    if (page.chunks.length) { quiet = 0; continue; }
    if (page.sealed) {
      res.write('event: sealed\ndata: {}\n\n');
      break;
    }
    quiet += TERMINAL_POLL_MS;
    if (quiet >= HEARTBEAT_MS) { res.write(': heartbeat\n\n'); quiet = 0; }
    await sleep(TERMINAL_POLL_MS);
  }
  res.end();
}

module.exports = async function benchmark(req, res, url, pathname, ctx) {
  const match = ROUTE.exec(pathname);
  if (!match) return undefined;
  const {readBody, readRawBody, requireWorkspacePermission, benchmark: services, ai} = ctx;
  // Case arguments, tasks and references keep the spelling of their numbers, so a response writes them with the same serializer.
  const json = (res, status, data, opts) => ctx.json(res, status, data, {...opts, stringify: stringifyJson});
  const [, top, credentialId, benchmarkId, results, runId, cancel, caseId, rerun, attemptId, attemptPart, payload, referenceName, onComputer] = match;
  try {
    if (!services) return json(res, 503, {error: 'Benchmarks need PostgreSQL (DATABASE_URL)', code: 'benchmark_disabled'});
    const {repository, service} = services;

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
      const {worker} = services;
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
    const write = () => requireWorkspacePermission(context, 'apps:use');
    const read = () => requireWorkspacePermission(context, 'content:read');
    const wrongMethod = () => json(res, 405, {error: 'Method not allowed', code: 'method_not_allowed'});
    const notFound = (what = 'run') => json(res, 404, {error: `No such ${what}`, code: `unknown_${what}`});

    if (top === 'defaults') {
      if (req.method !== 'GET') return wrongMethod();
      read();
      return json(res, 200, await service.defaults(context.userId));
    }
    if (top === 'benchmarks' || benchmarkId !== undefined) {
      if (req.method !== 'GET') return wrongMethod();
      read();
      if (benchmarkId === undefined) {
        const pluginId = url.searchParams.get('plugin_id');
        const version = url.searchParams.get('version');
        if (version !== null && pluginId === null) throw new BenchmarkError(400, 'invalid_request', 'version needs plugin_id');
        return json(res, 200, {benchmarks: await repository.benchmarks(context, {pluginId, version, limit: limitOf(url, 50, 200), before: beforeOf(url)})});
      }
      if (!UUID.test(benchmarkId)) return notFound('benchmark');
      if (results) {
        const runs = await repository.benchmarkResults(context, benchmarkId, {limit: limitOf(url, 50, 200), before: beforeOf(url)});
        return runs ? json(res, 200, {runs}) : notFound('benchmark');
      }
      const found = await repository.benchmark(context, benchmarkId);
      return found ? json(res, 200, {benchmark: found}) : notFound('benchmark');
    }
    if (top === 'compare' || top === 'compare/attempts') {
      if (req.method !== 'GET') return wrongMethod();
      read();
      const [a, b] = ['a', 'b'].map(name => url.searchParams.get(name));
      if (![a, b].every(id => id && UUID.test(id))) throw new BenchmarkError(400, 'invalid_request', `a and b are ${top === 'compare' ? 'run' : 'attempt'} ids`);
      return json(res, 200, top === 'compare' ? await compareRuns({repository, context, a, b}) : await compareAttempts({repository, ai, context, a, b}));
    }
    if (top === 'benchmarks/pinned') {
      if (req.method !== 'POST') return wrongMethod();
      write();
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
      const caseFile = cases && typeof cases === 'object' && !Array.isArray(cases) ? Object.fromEntries(Object.entries(cases).filter(([key]) => key !== '_')) : cases;
      const pinned = await computer.benchmarkCaseSet(opened.value.sha256, stringifyJson({name, cases: caseFile}));
      if (pinned.error) return json(res, pinned.status, {error: pinned.error, code: 'pin_failed'});
      // The pinned body, private references and all, is published here from NanoAgent's own text: it never reaches the browser.
      const publication = benchmarkPublication({
        ...parseJson(pinned.value), name, model, endpoint_profile: endpointProfile, limits, coding_template: codingTemplate, task_instructions: taskInstructions,
      });
      const published = await service.publish(context.userId, publication);
      return json(res, published.created ? 201 : 200, published);
    }
    // One session of a plugin page's Harness tab, or of `nanoagent harness`: the member's request to one task of their installed app,
    // worked once by a reference harness, or by a harness of theirs that a Terminal session saved (`rush save`), which works the
    // coding prompt like any harness but NanoAgent's. The member's computer fills the task's input from the request with the model every plugin run
    // uses and pins the case, as it pins a benchmark's, and builds the harness; the run is queued like a benchmark run, on the endpoint
    // RUSH Lab's worker serves. `interactive` says whether the member is at the harness's terminal (the
    // tab, the command without a prompt); `model`, when given, is the harness's model in place of the one every run uses.
    if (top === 'sessions') {
      if (req.method !== 'POST') return wrongMethod();
      write();
      if (!ctx.workspaceApps) return json(res, 409, {error: 'Apps need a workspace file store', code: 'fs-disabled'});
      req.setTimeout(PIN_TIMEOUT_MS);
      const body = object(await jsonBody(req, readBody), 'The body');
      const [pluginId, taskId, harness] = ['plugin_id', 'task_id', 'harness'].map(name => string(body[name], name));
      const text = string(body.text, 'text', {max: SESSION_TEXT_LIMIT});
      if (typeof body.interactive !== 'boolean') throw new BenchmarkError(400, 'invalid_request', 'interactive must be a boolean');
      const model = string(body.model, 'model', {optional: true}) ?? aiSettings.MODEL.model;
      const reference = REFERENCE_HARNESSES.includes(harness);
      const saved = reference ? null : await repository.savedHarness(context, harness);
      if (!reference && !saved) {
        throw new BenchmarkError(400, 'unknown_harness', `${harness} is neither a reference harness (${REFERENCE_HARNESSES.join(', ')}) nor one you saved from a Terminal session in this workspace`);
      }
      const computer = ctx.runners.computer(context.userId);
      if (!computer) return json(res, 503, {error: RUNNER_OFFLINE, code: 'runner_offline'});
      const opened = await ctx.workspaceApps.open(context, pluginId, computer);
      if (opened.error) return json(res, opened.status, {error: opened.error, code: 'app_unavailable'});
      if (opened.value.status !== 'ready') return json(res, 409, {error: `${opened.value.id} is not ready to run`, code: 'app_unavailable'});
      const pinned = await computer.benchmarkSession(opened.value.sha256, JSON.stringify({task: taskId, text, model: aiSettings.MODEL}));
      if (pinned.error) return json(res, pinned.status, {error: pinned.error, code: 'pin_failed'});
      const publication = benchmarkPublication({...parseJson(pinned.value), model, endpoint_profile: SESSION_ENDPOINT});
      let source = saved;
      if (reference) {
        const built = await computer.benchmarkReferenceHarness(harness);
        if (built.error) return json(res, built.status, {error: built.error, code: 'reference_unavailable'});
        source = await repository.saveSource(context, built.value, referenceHarnessOf(built.value, harness));
      }
      const policy = reference ? referencePolicy(harness) : 'coding';
      const {run_id: id} = await service.session(context, publication, source, policy, {interactive: body.interactive});
      return json(res, 201, {run: await repository.run(context, id)});
    }
    if (top === 'previews') {
      if (req.method !== 'POST') return wrongMethod();
      write();
      return json(res, 200, await service.preview(context, previewBody(await jsonBody(req, readBody))));
    }
    if (top === 'sources') {
      if (req.method !== 'POST') return wrongMethod();
      write();
      if (!/^application\/zip(?:;|$)/i.test(req.headers['content-type'] ?? '')) {
        throw new BenchmarkError(415, 'unsupported_media_type', 'Send the source as Content-Type: application/zip');
      }
      req.setTimeout(120_000);
      const data = await rawBody(req, MAX_SOURCE_BYTES, 'source_too_large');
      return json(res, 201, await repository.saveSource(context, data, uploadedHarnessOf(data)));
    }
    // A reference harness's ZIP, under its own name only (a member's own upload may not take it): sent here, or built by the member's computer.
    if (referenceName !== undefined) {
      if (req.method !== 'POST') return wrongMethod();
      write();
      checkReference(referenceName);
      let data;
      if (onComputer) {
        const computer = ctx.runners.computer(context.userId);
        if (!computer) return json(res, 503, {error: RUNNER_OFFLINE, code: 'runner_offline'});
        const built = await computer.benchmarkReferenceHarness(referenceName);
        if (built.error) return json(res, built.status, {error: built.error, code: 'reference_unavailable'});
        data = built.value;
      } else {
        if (!/^application\/zip(?:;|$)/i.test(req.headers['content-type'] ?? '')) {
          throw new BenchmarkError(415, 'unsupported_media_type', 'Send the source as Content-Type: application/zip');
        }
        req.setTimeout(120_000);
        data = await rawBody(req, MAX_SOURCE_BYTES, 'source_too_large');
      }
      return json(res, 201, await repository.saveSource(context, data, referenceHarnessOf(data, referenceName)));
    }
    if (top === 'runs') {
      if (req.method === 'GET') {
        read();
        return json(res, 200, {runs: await repository.listRuns(context, {limit: limitOf(url, 50, 200), before: beforeOf(url)})});
      }
      if (req.method !== 'POST') return wrongMethod();
      write();
      const {run_id: id, replayed} = await service.submit(context, runBody(await jsonBody(req, readBody)));
      return json(res, replayed ? 200 : 201, {replayed, run: await repository.run(context, id)});
    }

    if (runId !== undefined) {
      if (!UUID.test(runId)) return notFound();
      if (!cancel && !rerun) {
        if (req.method !== 'GET') return wrongMethod();
        read();
        const run = await repository.run(context, runId);
        return run ? json(res, 200, {run}) : notFound();
      }
      if (req.method !== 'POST') return wrongMethod();
      write();
      if (cancel) return json(res, 200, await repository.cancel(context, runId));
      return json(res, 201, await repository.rerun(context, runId, segment(caseId, 'The case id')));
    }

    if (!UUID.test(attemptId)) return notFound('attempt');
    if (attemptPart === 'terminal' && req.method === 'POST') {
      write();
      const sent = await repository.terminalInput(context, attemptId, terminalInputBody(await jsonBody(req, readBody)));
      return sent ? json(res, 200, {sent: true}) : json(res, 409, {error: 'The session has ended', code: 'session_ended'});
    }
    if (req.method !== 'GET') return wrongMethod();
    read();
    if (!attemptPart && !payload) {
      const attempt = await repository.attempt(context, attemptId);
      return attempt ? json(res, 200, {attempt}) : notFound('attempt');
    }
    if (attemptPart === 'events') {
      const page = await repository.events(context, attemptId, cursorOf(url.searchParams.get('after')), limitOf(url, 200, PAGE));
      return page ? json(res, 200, page) : notFound('attempt');
    }
    if (attemptPart === 'stream') {
      const after = cursorOf(url.searchParams.get('after') ?? req.headers['last-event-id'] ?? null);
      return await stream(req, res, repository, context, attemptId, after);
    }
    if (attemptPart === 'terminal') {
      return await terminalStream(req, res, repository, context, attemptId, cursorOf(url.searchParams.get('from')));
    }
    if (attemptPart === 'spans') {
      const found = await repository.spans(context, attemptId, {
        kind: url.searchParams.get('kind'), status: url.searchParams.get('status'), q: url.searchParams.get('q'), limit: limitOf(url, 1000, 5000),
      });
      return found ? json(res, 200, found) : notFound('attempt');
    }
    if (attemptPart === 'accounting') {
      const found = await repository.accounting(context, attemptId);
      return found ? json(res, 200, {attempt_id: attemptId, ...found}) : notFound('attempt');
    }
    if (!SHA256.test(payload)) return notFound('payload');
    const stored = await repository.payload(context, attemptId, payload);
    if (!stored) return notFound('payload');
    res.writeHead(200, {
      'Content-Type': stored.content_type, 'Content-Length': stored.size, 'X-Rush-Redaction': stored.redaction,
      'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'attachment', 'Cache-Control': 'private, no-store',
    });
    return res.end(stored.data);
  } catch (error) {
    return sendFailure(json, res, error);
  }
};
