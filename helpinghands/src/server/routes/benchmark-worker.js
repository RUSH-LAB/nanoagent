'use strict';

/**
 * Uploaded harness benchmarks, the worker's side (docs/contracts/rush-benchmark-api.md in the
 * NanoAgent project), under /api/benchmark-worker/. The worker has no member session: it sends
 * Authorization: Bearer <credential>, a worker credential its member minted, and every route acts for that member
 * only. Each attempt route carries the lease's fence; a claim carries the worker's capabilities.
 */
const crypto = require('crypto');
const {BenchmarkError} = require('../benchmark/errors');
const {parseJson, stringifyJson} = require('../benchmark/json');
const {UUID, jsonBody, rawBody, sendFailure} = require('../benchmark/http');
const v = require('../benchmark/validate');
const {positiveSetting} = require('../benchmark/limits');
const {renderCase} = require('../benchmark/plan');
const {listen, wake} = require('../benchmark/wake');
const {PIN_TIMEOUT_MS, RUNNER_OFFLINE} = require('../ai');
const aiSettings = require('../ai-settings');
const {SESSION_ENDPOINT, openApp} = require('./benchmark');

const MAX_PAYLOAD_BYTES = positiveSetting('BENCHMARK_PAYLOAD_MAX_BYTES', 16 * 1024 * 1024);
// A session's watch waits this long for it to be canceled, its lease lost or it sealed, looking every WATCH_POLL_MS.
const WATCH_MS = 15_000;
const WATCH_POLL_MS = 100;
// A read of a session's case waits this long for its pin; a pin RUSH lost (it restarted while pinning) fails after PIN_TIMEOUT_MS.
const CASE_WAIT_MS = 20_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const REDACTIONS = ['none', 'redacted', 'truncated'];

const ROUTE = new RegExp([
  '^/api/benchmark-worker/(?:',
  '(claim|started)',
  '|attempts/([^/]+)/(renew|source|package|case|admissions|events|terminal|terminal-link|watch|score|tools|spans|finalize|accounting)',
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

/** The plugin whose page opened Terminal session `attemptId`, opened on the member's computer: its first task and its frame. */
async function terminalPlugin(ctx, worker, userId, attemptId, fence) {
  const {workspaceId, pluginId} = await worker.terminalSession(userId, attemptId, fence);
  const computer = ctx.runners.computer(userId);
  if (!computer) throw new BenchmarkError(503, 'runner_offline', RUNNER_OFFLINE);
  const {sha256, tasks: [first]} = await openApp(ctx, {userId, workspaceId}, pluginId, computer);
  const framed = await computer.benchmarkSessionFrame(sha256, JSON.stringify({task: first.id, text: first.description}));
  if (framed.error) throw new BenchmarkError(framed.status, 'app_unavailable', framed.error);
  return {computer, frame: parseJson(framed.value), sha256, first};
}

/** The plugin and first task of `frame` with the package installed on the member's `computer`, whose bytes must be its sha256. */
async function installedPlugin(computer, frame) {
  const installed = await computer.installedPackage(frame.package_sha256);
  if (installed.error) throw new BenchmarkError(installed.status, 'package_unavailable', `${frame.plugin_id}'s installed package could not be read: ${installed.error}`);
  const data = installed.value;
  if (crypto.createHash('sha256').update(data).digest('hex') !== frame.package_sha256) {
    throw new BenchmarkError(502, 'package_unavailable', `${frame.plugin_id}'s installed package is not the version installed (${frame.package_sha256})`);
  }
  return {
    plugin: {id: frame.plugin_id, name: frame.plugin_name, version: frame.version, sha256: frame.package_sha256},
    task: {id: frame.task_id, plugin_name: frame.plugin_name, ...frame.task},
    package: data.toString('base64'),
  };
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

    // A worker that has just started: what it leased before runs no more.
    if (claim === 'started') {
      wanted('POST');
      return json(res, 200, {interrupted: await worker.started(userId, v.string(v.object(await body(), 'The body').worker_id, 'worker_id', {max: 200}))});
    }
    if (claim) {
      wanted('POST');
      const {workerId, label, capabilities, interactive, waitMs} = v.claimBody(await body());
      // With nothing to lease, a claim waits up to `wait_s` for the member's work to be queued (a wake-up, not a poll), and never
      // leases to a worker that has gone.
      let closed = false;
      req.on('close', () => { closed = true; });
      for (const until = Date.now() + waitMs; ;) {
        const queued = listen(`claim:${userId}`);
        try {
          const job = await worker.claim(userId, workerId, label, capabilities, interactive);
          if (job) return json(res, 200, job);
          if (closed || Date.now() >= until) {
            res.writeHead(204);
            return res.end();
          }
          await queued.woken(until - Date.now());
        } finally {
          queued.stop();
        }
        if (closed) return res.end();
      }
    }
    if (jobId !== undefined) {
      if (jobPart === 'source' || jobPart === 'package') {
        wanted('GET', jobId);
        return sendBytes(res, await worker.artifact(userId, jobId, fenceHeader(req), jobPart));
      }
      // The case of a job claimed while its session's case was being pinned: 200 once pinned, 204 if it still is after CASE_WAIT_MS,
      // 422 case_failed with why it could not be.
      if (jobPart === 'case') {
        wanted('GET', jobId);
        const fence = fenceHeader(req);
        const {run_id: runId} = await worker.pinnedCase(userId, jobId, fence);
        for (const until = Date.now() + CASE_WAIT_MS; ;) {
          const pinning = listen(`case:${runId}`);
          try {
            const {created_at: createdAt, pin_error: pinError, run_id: _, ...pinned} = await worker.pinnedCase(userId, jobId, fence);
            if (pinned.case) return json(res, 200, pinned);
            const lost = Date.now() - new Date(createdAt).getTime() > PIN_TIMEOUT_MS;
            if (pinError || lost) {
              throw new BenchmarkError(422, 'case_failed', pinError ?? `RUSH lost run ${runId}'s case while pinning it`);
            }
            if (Date.now() >= until) {
              res.writeHead(204);
              return res.end();
            }
            await pinning.woken(until - Date.now());
          } finally {
            pinning.stop();
          }
        }
      }
      // A session's watch: answered 409 as soon as it is canceled (its member left its page or opened another), its lease lost or it
      // sealed, so its worker frees the slot at once; 204 when none was within WATCH_MS.
      if (jobPart === 'watch') {
        wanted('GET', jobId);
        const fence = fenceHeader(req);
        let closed = false;
        req.on('close', () => { closed = true; });
        for (const until = Date.now() + WATCH_MS; !closed && Date.now() < until;) {
          await worker.watch(userId, jobId, fence);
          await sleep(WATCH_POLL_MS);
        }
        res.writeHead(204);
        return res.end();
      }
      // The case a scored `rush <command>` in the attempt's Terminal session works (its "$RUSH_PROMPT"): the first task of the plugin
      // whose page opened the session, its case filled from the task's description and pinned on the member's computer as a one-shot
      // session's is; the case with its private reference, the coding prompt rendered for it, and the package installed there, with
      // which the worker verifies the run.
      if (jobPart === 'score') {
        wanted('POST', jobId);
        const {computer, frame, sha256, first} = await terminalPlugin(ctx, worker, userId, jobId, v.fenceOf(v.object(await body(), 'The body')));
        const pinned = await computer.benchmarkSession(sha256, JSON.stringify({task: first.id, text: first.description, model: aiSettings.MODEL}));
        if (pinned.error) throw new BenchmarkError(pinned.status, 'pin_failed', pinned.error);
        const publication = v.benchmarkPublication({...parseJson(pinned.value), model: aiSettings.MODEL.model, endpoint_profile: SESSION_ENDPOINT});
        const [c] = publication.cases;
        const prompt = renderCase({
          benchmark: {task: publication.task, context: publication.context, plugin: {name: publication.plugin_name}}, policy: 'coding', text: publication.coding_template, c,
        });
        return json(res, 200, {
          ...await installedPlugin(computer, frame), case: {...c, reference: publication.private[c.case_id]}, prompt: prompt.user,
        });
      }
      // The plugin's tools a Terminal session's `nanoagent` asks for (the worker starts them then, for it alone): the first task of the
      // plugin whose page opened the session, opened on the member's computer as a scored `rush` run's is, and the package installed there
      // (as the Session tab's agent runs it), whose bytes must be the sha256 it is installed as.
      if (jobPart === 'tools') {
        wanted('POST', jobId);
        const {computer, frame} = await terminalPlugin(ctx, worker, userId, jobId, v.fenceOf(v.object(await body(), 'The body')));
        return json(res, 200, await installedPlugin(computer, frame));
      }
      wanted('POST', jobId);
      const input = await body();
      if (jobPart === 'renew') return json(res, 200, await worker.renew(userId, jobId, v.fenceOf(v.object(input, 'The body'))));
      if (jobPart === 'admissions') {
        const {fence, callId: id, reserveUsd} = v.admissionBody(input);
        return json(res, 201, await worker.admit(userId, jobId, fence, id, reserveUsd));
      }
      // Where the session's member reaches its terminals on their computer, which RUSH hands only to them (GET attempts/{id}/terminal-link).
      if (jobPart === 'terminal-link') {
        const {fence, port, token} = v.terminalLinkBody(input);
        await worker.terminalLink(userId, jobId, fence, port, token);
        wake(`link:${jobId}`);
        return json(res, 200, {linked: true});
      }
      if (jobPart === 'terminal') {
        const {fence, terminal, offset, data, closed} = v.terminalBody(input);
        if (closed) return json(res, 200, await worker.closeTerminal(userId, jobId, fence, terminal));
        return json(res, 200, await worker.appendTerminal(userId, jobId, fence, terminal, offset, data));
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
