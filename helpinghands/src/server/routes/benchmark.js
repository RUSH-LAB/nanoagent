'use strict';

/**
 * Uploaded harness benchmarks, the member's side (docs/contracts/rush-benchmark-api.md in the
 * NanoAgent project). Under /api/workspaces/:id/benchmark/ (dispatched here as /api/benchmark/):
 * the setup defaults, published benchmarks (visible to every member who has the plugin), runs (a member's own and no one else's: no route lists or
 * reads another member's runs or attempts, which answer 404), and their saved or live
 * traces, and the comparison of two runs or of two attempts of one case. POST /api/benchmark/benchmarks, outside any workspace, is
 * how a member publishes a benchmark; POST benchmarks/pinned builds the body on the member's computer, where the plugin's reference
 * tool pins each case, and publishes it from NanoAgent's own text.
 */
const {PIN_TIMEOUT_MS, RUNNER_OFFLINE} = require('../ai');
const aiSettings = require('../ai-settings');
const {BenchmarkError} = require('../benchmark/errors');
const {parseJson, stringifyJson} = require('../benchmark/json');
const {compareAttempts, compareRuns} = require('../benchmark/compare');
const {UUID, jsonBody, losslessBody, sendFailure} = require('../benchmark/http');
const {runBody, benchmarkPublication, pinnedBody, SHA256, object, string, CLI_COMMAND, CONVERSATION_ID} = require('../benchmark/validate');
const {terminalSession, terminalChats, memberChats} = require('../benchmark/terminal-sessions');
const {listen, wake} = require('../benchmark/wake');
const {MAX_PUBLISH_BYTES, TERMINAL_LIMITS} = require('../benchmark/limits');

// The endpoint profile of the worker RUSH Lab runs (nanoagent/deploy/worker/worker.openrouter.yaml), which a Harness tab session runs on.
const SESSION_ENDPOINT = 'openrouter';
// The case set name of a Harness tab session (nanoagent.uploaded.case_sets.SESSION), which a Terminal session's run is kept under too.
const SESSION_NAME = 'harness-session';
const STREAM_POLL_MS = 300;
// A read of a session's terminal link waits this long for its worker to start it.
const LINK_WAIT_MS = 20_000;
const HEARTBEAT_MS = 15_000;
const PAGE = 1000;

const ROUTE = new RegExp([
  '^/api/benchmark/(?:',
  '(defaults|benchmarks|benchmarks/pinned|sessions|runs|compare|compare/attempts|worker-credentials|terminal-sessions)',
  '|worker-credentials/([^/]+)',
  '|benchmarks/([^/]+)',
  '|runs/([^/]+)(?:/(cancel)|/cases/([^/]+)/(rerun))?',
  '|attempts/([^/]+)(?:/(events|stream|terminal-link|spans|accounting|recording|archive)|/payloads/([^/]+))?',
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

/** The event sources a read keeps (`source=worker,gateway`), or null for every source. */
function sourcesOf(value) {
  if (value === null) return null;
  if (!/^[a-z_]{1,30}(,[a-z_]{1,30}){0,9}$/.test(value)) throw new BenchmarkError(400, 'invalid_request', 'source is a comma-separated list of up to 10 event sources');
  return value.split(',');
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

/** The caller's app `pluginId`, installed and ready to run on their `computer`: its catalog entry, with its `sha256` and `tasks`. */
async function openApp(ctx, context, pluginId, computer) {
  if (!ctx.workspaceApps) throw new BenchmarkError(409, 'fs-disabled', 'Apps need a workspace file store');
  const opened = await ctx.workspaceApps.open(context, pluginId, computer);
  if (opened.error) throw new BenchmarkError(opened.status, 'app_unavailable', opened.error);
  if (opened.value.status !== 'ready') throw new BenchmarkError(409, 'app_unavailable', `${opened.value.id} is not ready to run`);
  return opened.value;
}

/**
 * One free-form session of the Terminal (`harness` `shell` with the member at it, from a plugin page's Harness tab or `nanoagent harness
 * harness=shell`): an empty shell where they run any agent and prompt it themselves, the same whatever plugin's page opened it. Nothing
 * of the plugin is opened, read or run for it: its run keeps `pluginId` only as the label of the page it was opened from, runs under
 * the Terminal's own limits (TERMINAL_LIMITS), and has no case set and no case, nothing filled, pinned or scored; its one attempt records
 * the model calls and commands. `model`, when given, is the model it runs on in place of the one every run uses. Given `resume`, an
 * ended free-form session of the member's (its attempt id), it resumes that one: its run is a new session linked to it (`resumed_from`),
 * and the worker puts back what it kept of it on the member's computer before the shell starts, or says it has nothing kept. Given
 * `start` instead, an agent's CLI command (`claude`), its first terminal runs it at its first prompt (`start_cli`), as a resumed one
 * runs its agent's resume command. Given `chat` with `resume`, one of that session's chats (`{agent, id, run}`, the Dashboard's chat row,
 * its CLI's conversation id or null for a run of a program, with that run), its first terminal reopens that conversation or reruns that
 * run (`resume_chat`). One session someone is at runs per member, on any plugin, and only its member ends it (exit, its time limit,
 * quitting RUSH Lab): while it runs, a start (the Harness tab shown again, New session, a chat clicked, another window,
 * `nanoagent harness harness=shell`) is that session, answered with `joined`, and what it asked for (`start`, `resume` with `chat`)
 * opens in a new terminal of it, which the page asks its worker for; a start that cannot be a terminal of it (a whole session resumed)
 * is refused (`session_running`), never ending the live one. `{run, attempt_id, joined?}`.
 */
async function startSession(ctx, context, {pluginId, harness, interactive, model, resume, start, chat}) {
  const {repository, service} = ctx.benchmark;
  if (harness !== 'shell' || !interactive) {
    throw new BenchmarkError(400, 'invalid_request', 'A session is the Terminal with its member at it: harness shell and interactive true. A benchmark case runs by POST /runs');
  }
  const resumedFrom = resume === undefined ? null : await resumable(repository, context, resume);
  const resumeChat = chat === undefined ? null : await chatOf(repository, context, resumedFrom, chat);
  const startCli = start === undefined ? null : cliCommand(resumedFrom, start);
  const live = await repository.liveSession(context);
  if (live) {
    if (resumedFrom !== null && resumeChat === null) {
      throw new BenchmarkError(409, 'session_running', 'Your Terminal session still runs: leave its shell (exit) to end it, then resume this one, or open one of its chats from the Dashboard in a new terminal of it');
    }
    return {run: await repository.run(context, live.run_id), attempt_id: live.attempt_id, joined: true};
  }
  const harnessModel = string(model, 'model', {optional: true}) ?? aiSettings.MODEL.model;
  if (!ctx.runners.computer(context.userId)) throw new BenchmarkError(503, 'runner_offline', RUNNER_OFFLINE);
  const frame = {name: SESSION_NAME, plugin_id: pluginId, model: harnessModel, endpoint_profile: SESSION_ENDPOINT, limits: TERMINAL_LIMITS};
  const {run_id: id, attempt_id: attemptId} = await service.session(context, frame, {interactive, resumedFrom, startCli, resumeChat});
  wake(`claim:${context.userId}`);
  return {run: await repository.run(context, id), attempt_id: attemptId};
}

/** The attempt id `resume` names, an ended free-form Terminal session of the member's that a new one may resume. */
async function resumable(repository, context, resume) {
  const id = string(resume, 'resume');
  const [old] = UUID.test(id) ? await repository.terminalRows(context, {attemptId: id}) : [];
  if (!old || old.harness_name !== 'shell' || old.task_id !== null) throw new BenchmarkError(404, 'unknown_session', 'No Terminal session of yours to resume has that id');
  if (old.state !== 'final') throw new BenchmarkError(409, 'session_running', 'That session is still running: leave its shell (exit) to end it, then resume it');
  return id;
}

/**
 * The chat `chat` of the session `resumedFrom` resumes, which its first terminal reopens: `{agent, id, run}`, its CLI's conversation id
 * or, for a run of a program, null and the run (`{argv, cwd}`), which it reruns.
 */
async function chatOf(repository, context, resumedFrom, chat) {
  if (resumedFrom === null) throw new BenchmarkError(400, 'invalid_request', 'A chat is reopened by resuming the session that holds it');
  const {agent, id, run} = object(chat, 'chat');
  if (typeof agent !== 'string' || !CLI_COMMAND.test(agent) || !(id === null || (typeof id === 'string' && CONVERSATION_ID.test(id))) || (id === null) === (run === null)) {
    throw new BenchmarkError(400, 'invalid_request', "chat is {agent, id, run}: an agent's CLI command and its conversation id, or null and the run it reruns");
  }
  const [row] = await repository.terminalRows(context, {attemptId: resumedFrom, atCalls: true});
  const same = one => one.agent === agent && one.conversation === id && JSON.stringify(one.run) === JSON.stringify(run);
  if (!terminalChats(row).some(same)) throw new BenchmarkError(404, 'unknown_chat', 'That session is not one RUSH kept from that terminal session');
  return {agent, id, run};
}

/** The agent CLI command `start` names, which a new free-form session runs first. */
function cliCommand(resumedFrom, start) {
  if (resumedFrom !== null) throw new BenchmarkError(400, 'invalid_request', 'Only a new Terminal session starts an agent\'s CLI');
  const command = string(start, 'start');
  if (!CLI_COMMAND.test(command)) throw new BenchmarkError(400, 'invalid_request', 'start must be an agent\'s CLI command, such as claude');
  return command;
}

module.exports = async function benchmark(req, res, url, pathname, ctx) {
  const match = ROUTE.exec(pathname);
  if (!match) return undefined;
  const {readBody, readRawBody, requireWorkspacePermission, benchmark: services, ai} = ctx;
  // Case arguments, tasks and references keep the spelling of their numbers, so a response writes them with the same serializer.
  const json = (res, status, data, opts) => ctx.json(res, status, data, {...opts, stringify: stringifyJson});
  const [, top, credentialId, benchmarkId, runId, cancel, caseId, rerun, attemptId, attemptPart, payload] = match;
  try {
    if (!services) return json(res, 503, {error: 'Benchmarks need PostgreSQL (DATABASE_URL)', code: 'benchmark_disabled'});
    const {repository, service} = services;

    // Any member publishes a benchmark for a published plugin version; no workspace is involved.
    if (top === 'benchmarks' && !req.context) {
      if (req.method !== 'POST') return json(res, 405, {error: 'Method not allowed'});
      if (!req.auth?.userId) return json(res, 401, {error: 'Not signed in'});
      // The body carries the cases' fixtures archives, so it may be larger than the other routes' bodies.
      const published = await service.publish(req.auth.userId, benchmarkPublication(await losslessBody(req, request => readRawBody(request, MAX_PUBLISH_BYTES))));
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
      // The body carries the uploaded case folder's fixture files, so it may be as large as a publication. Numbers keep their spelling (limits).
      const {pluginId, name, caseFile, files, limits} = pinnedBody(await losslessBody(req, request => readRawBody(request, MAX_PUBLISH_BYTES)));
      // What a benchmark takes from the member rather than from the plugin is checked before the minutes it takes to pin.
      const computer = ctx.runners.computer(context.userId);
      if (!computer) return json(res, 503, {error: RUNNER_OFFLINE, code: 'runner_offline'});
      // The app is installed on the member's computer first, which pins with the package it runs.
      const opened = await ctx.workspaceApps.open(context, pluginId, computer);
      if (opened.error) return json(res, opened.status, {error: opened.error, code: 'app_unavailable'});
      if (opened.value.status !== 'ready') return json(res, 409, {error: `${opened.value.id} is not ready to run`, code: 'app_unavailable'});
      // NanoAgent parses the YAML and resolves each case's fixtures folder against the files: nothing of the case file is read here.
      const pinned = await computer.benchmarkCaseSet(opened.value.sha256, stringifyJson({name, case_file: caseFile, files}));
      if (pinned.error) return json(res, pinned.status, {error: pinned.error, code: 'pin_failed'});
      // The pinned body, private references and all, is published here from NanoAgent's own text: it never reaches the browser.
      const publication = benchmarkPublication({
        ...parseJson(pinned.value), name, limits,
      });
      const published = await service.publish(context.userId, publication);
      return json(res, published.created ? 201 : 200, published);
    }
    // One Terminal session of a plugin page's Harness tab, or of `nanoagent harness harness=shell` (startSession).
    if (top === 'sessions') {
      if (req.method !== 'POST') return wrongMethod();
      write();
      const body = object(await jsonBody(req, readBody), 'The body');
      const [pluginId, harness] = ['plugin_id', 'harness'].map(name => string(body[name], name));
      if (typeof body.interactive !== 'boolean') throw new BenchmarkError(400, 'invalid_request', 'interactive must be a boolean');
      return json(res, 201, await startSession(ctx, context, {pluginId, harness, interactive: body.interactive, model: body.model, resume: body.resume, start: body.start, chat: body.chat}));
    }
    // A plugin page's Dashboard: the chats the member's own Harness tab sessions on the plugin held, by agent, beside their own chats.
    if (top === 'terminal-sessions') {
      if (req.method !== 'GET') return wrongMethod();
      read();
      const pluginId = string(url.searchParams.get('plugin_id'), 'plugin_id');
      const rows = await repository.terminalRows(context, {pluginId, atCalls: true});
      return json(res, 200, {chats: memberChats(rows.map(terminalChats))});
    }
    if (top === 'runs') {
      if (req.method === 'GET') {
        read();
        const before = beforeOf(url);
        const beforeId = url.searchParams.get('before_id');
        if (beforeId !== null && (!before || !UUID.test(beforeId))) throw new BenchmarkError(400, 'invalid_request', 'before_id is a run UUID and requires before');
        return json(res, 200, {runs: await repository.listRuns(context, {limit: limitOf(url, 50, 200), before, beforeId})});
      }
      if (req.method !== 'POST') return wrongMethod();
      write();
      const {run_id: id, replayed} = await service.submit(context, runBody(await jsonBody(req, readBody)));
      wake(`claim:${context.userId}`);
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
      const queued = await repository.rerun(context, runId, segment(caseId, 'The case id'));
      wake(`claim:${context.userId}`);
      return json(res, 201, queued);
    }

    if (!UUID.test(attemptId)) return notFound('attempt');
    // A chat of a Harness tab session (`chat`, its key), archived from the Dashboard on the session that last held it, leaves its agent's
    // list for that agent's Archived view, as a chat does; `archived` false restores it.
    if (attemptPart === 'archive') {
      if (req.method !== 'POST') return wrongMethod();
      write();
      const {archived, chat} = object(await jsonBody(req, readBody), 'The body');
      if (typeof archived !== 'boolean') throw new BenchmarkError(400, 'invalid_request', 'archived is true or false');
      string(chat, 'chat', {max: 500});
      return (await repository.archiveChat(context, attemptId, chat, archived)) ? json(res, 200, {archived}) : notFound('session');
    }
    if (req.method !== 'GET') return wrongMethod();
    read();
    if (!attemptPart && !payload) {
      const attempt = await repository.attempt(context, attemptId);
      return attempt ? json(res, 200, {attempt}) : notFound('attempt');
    }
    if (attemptPart === 'events') {
      const page = await repository.events(context, attemptId, cursorOf(url.searchParams.get('after')), limitOf(url, 200, PAGE), sourcesOf(url.searchParams.get('source')));
      return page ? json(res, 200, page) : notFound('attempt');
    }
    if (attemptPart === 'stream') {
      const after = cursorOf(url.searchParams.get('after') ?? req.headers['last-event-id'] ?? null);
      return await stream(req, res, repository, context, attemptId, after);
    }
    // Where the member reaches their session's terminals on their own computer (the worker's link, through RUSH Lab): `{port, token}`
    // once its worker has started it; 204 if it has not within LINK_WAIT_MS.
    if (attemptPart === 'terminal-link') {
      for (const until = Date.now() + LINK_WAIT_MS; ;) {
        const linking = listen(`link:${attemptId}`);
        try {
          const link = await repository.terminalLink(context, attemptId);
          if (link === null) return notFound('attempt');
          if (link.port) return json(res, 200, {port: link.port, token: link.token});
          if (Date.now() >= until) {
            res.writeHead(204);
            return res.end();
          }
          await linking.woken(until - Date.now());
        } finally {
          linking.stop();
        }
      }
    }
    if (attemptPart === 'spans') {
      const found = await repository.spans(context, attemptId, {
        kind: url.searchParams.get('kind'), status: url.searchParams.get('status'), q: url.searchParams.get('q'), limit: limitOf(url, 1000, 5000),
      });
      return found ? json(res, 200, found) : notFound('attempt');
    }
    // One of the member's Harness tab sessions, to replay (the CLI's `harness=shell`): what each terminal wrote, and its figures.
    if (attemptPart === 'recording') {
      const [row] = await repository.terminalRows(context, {attemptId});
      if (!row) return notFound('session');
      const transcripts = await repository.terminalTranscripts(context, attemptId);
      return json(res, 200, {
        session: terminalSession(row),
        terminals: transcripts.map(({terminal, data}) => ({terminal, data: data.toString('base64')})),
      });
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

module.exports.SESSION_ENDPOINT = SESSION_ENDPOINT;
module.exports.openApp = openApp;
