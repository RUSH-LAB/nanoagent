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
const {previewBody, runBody, benchmarkPublication, importBody, publicationFrame, SHA256, object, string, CLI_COMMAND, CONVERSATION_ID} = require('../benchmark/validate');
const {checkTaskAgainstEntry} = require('../benchmark/entry-check');
const {leaderboard} = require('../benchmark/leaderboard');
const {terminalSession, terminalChats, memberChats} = require('../benchmark/terminal-sessions');
const {listen, wake} = require('../benchmark/wake');
const {MAX_SOURCE_BYTES, TERMINAL_LIMITS} = require('../benchmark/limits');

// The endpoint profile of the worker RUSH Lab runs (nanoagent/deploy/worker/worker.openrouter.yaml), which a Harness tab session runs on.
const SESSION_ENDPOINT = 'openrouter';
// The case set name of a Harness tab session (nanoagent.uploaded.case_sets.SESSION), which a Terminal session's run is kept under too.
const SESSION_NAME = 'harness-session';
// What a Harness tab session's request may hold: what a plugin page's prompt may (PluginFrame/protocol.js).
const SESSION_TEXT_LIMIT = 50_000;
const STREAM_POLL_MS = 300;
// A read of a session's terminal link waits this long for its worker to start it.
const LINK_WAIT_MS = 20_000;
const HEARTBEAT_MS = 15_000;
const PAGE = 1000;

const ROUTE = new RegExp([
  '^/api/benchmark/(?:',
  '(defaults|benchmarks|benchmarks/pinned|sessions|previews|sources|runs|compare|compare/attempts|worker-credentials|leaderboard|terminal-sessions|imports)',
  '|worker-credentials/([^/]+)',
  '|benchmarks/([^/]+)(?:/(results))?',
  '|runs/([^/]+)(?:/(cancel)|/cases/([^/]+)/(rerun))?',
  '|attempts/([^/]+)(?:/(events|stream|terminal-link|spans|accounting|recording|archive)|/payloads/([^/]+))?',
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

/** The caller's app `pluginId`, installed and ready to run on their `computer`: its catalog entry, with its `sha256` and `tasks`. */
async function openApp(ctx, context, pluginId, computer) {
  if (!ctx.workspaceApps) throw new BenchmarkError(409, 'fs-disabled', 'Apps need a workspace file store');
  const opened = await ctx.workspaceApps.open(context, pluginId, computer);
  if (opened.error) throw new BenchmarkError(opened.status, 'app_unavailable', opened.error);
  if (opened.value.status !== 'ready') throw new BenchmarkError(409, 'app_unavailable', `${opened.value.id} is not ready to run`);
  return opened.value;
}

/**
 * One session of a plugin page's Harness tab, of `nanoagent harness`, or of `rush score` in a Terminal session (the worker's
 * attempts/{id}/score): the member's request `text` to task `taskId` of their installed app `pluginId`, worked once by a reference
 * harness, or by a harness of theirs that a Terminal session saved (`rush save`), which works the coding prompt like any harness but
 * NanoAgent's. Its run is queued at once, on its case set's frame (the plugin and the task, read from the member's computer) and the
 * endpoint RUSH Lab's worker serves, so the harness starts while the member's computer fills the task's input from the request with
 * the model every plugin run uses and pins the case, as it pins a benchmark's; the worker then reads the case (or why it could not be
 * pinned) from the attempt. `interactive` says whether the member is at the harness's terminal (the tab, the command without a
 * prompt); `model`, when given, is the harness's model in place of the one every run uses. The Terminal (`shell`) with someone at it
 * is free-form: an empty shell where they run any agent and prompt it themselves, the same whatever plugin's page opened it. It takes
 * no task and no text, and nothing of the plugin is opened, read or run for it: its run keeps `pluginId` only as the label of the page
 * it was opened from, runs under the Terminal's own limits (TERMINAL_LIMITS), and has no case set and no case, nothing filled, pinned
 * or scored; its one attempt records the model calls and commands. Given `resume`, an ended free-form session of the member's (its
 * attempt id), it resumes that one: its run is a new session linked to it (`resumed_from`), and the worker puts back what it kept of
 * it on the member's computer before the shell starts, or says it has nothing kept. Given `start` instead, an agent's CLI command
 * (`claude`), its first terminal runs it at its first prompt (`start_cli`), as a resumed one runs its agent's resume command. Given
 * `chat` with `resume`, one of that session's chats (`{agent, id}`, the Dashboard's chat row, its CLI's conversation id or null for a
 * run of an agent), its first terminal reopens that conversation (`resume_chat`). Given neither, while the member's free-form session on
 * that plugin still runs, it is that session's run, not a new one; given `join` (true, with `resume` or `start`: a chat clicked on the
 * Dashboard), so is it, answered with `joined`, and the page opens the chat in a new terminal of it. `{run, attempt_id, joined?}`.
 */
async function startSession(ctx, context, {pluginId, taskId, harness, interactive, text, model, resume, start, chat, join}) {
  const {repository, service} = ctx.benchmark;
  const free = harness === 'shell' && interactive;
  if (free && (text !== undefined || taskId !== undefined)) {
    throw new BenchmarkError(400, 'invalid_request', 'A Terminal session someone is at is free-form: it takes no task and no text');
  }
  const request = free ? null : string(text, 'text', {max: SESSION_TEXT_LIMIT});
  if (join !== undefined && (join !== true || !free || (resume === undefined && start === undefined))) {
    throw new BenchmarkError(400, 'invalid_request', 'join is true, on a Terminal session someone is at that resumes one or starts an agent\'s CLI');
  }
  // A chat clicked on the Dashboard (`join`) while the member's free-form session on the plugin runs opens in a new terminal of that
  // one, which the page asks its worker for: the session is not ended, and no second one starts.
  if (join) {
    const live = await repository.liveTerminal(context, pluginId);
    if (live) return {run: await repository.run(context, live.run_id), attempt_id: live.attempt_id, joined: true};
  }
  const resumedFrom = resume === undefined ? null : await resumable(repository, context, free, resume);
  const resumeChat = chat === undefined ? null : await chatOf(repository, context, resumedFrom, chat);
  const startCli = start === undefined ? null : cliCommand(free, resumedFrom, start);
  // A new free-form session on a plugin where the member's last one still runs is that one, which the page links to again (the
  // Harness tab shown again, the plugin opened again): only `exit`, its time limit or another start (resume, start, without join) ends it.
  if (free && resumedFrom === null && startCli === null) {
    const live = await repository.liveTerminal(context, pluginId);
    if (live) return {run: await repository.run(context, live.run_id), attempt_id: live.attempt_id};
  }
  const harnessModel = string(model, 'model', {optional: true}) ?? aiSettings.MODEL.model;
  const reference = REFERENCE_HARNESSES.includes(harness);
  const saved = reference ? null : await repository.savedHarness(context, harness);
  if (!reference && !saved) {
    throw new BenchmarkError(400, 'unknown_harness', `${harness} is neither a reference harness (${REFERENCE_HARNESSES.join(', ')}) nor one you saved from a Terminal session in this workspace`);
  }
  const computer = ctx.runners.computer(context.userId);
  if (!computer) throw new BenchmarkError(503, 'runner_offline', RUNNER_OFFLINE);
  let sha256, frame;
  if (free) {
    frame = {
      name: SESSION_NAME, plugin_id: pluginId, plugin_name: null, version: null, package_sha256: null, task_id: null, task: null, context: '',
      model: harnessModel, endpoint_profile: SESSION_ENDPOINT, limits: TERMINAL_LIMITS, coding_template: '', task_instructions: '', case_id: null,
    };
  } else {
    ({sha256} = await openApp(ctx, context, pluginId, computer));
    const framed = await computer.benchmarkSessionFrame(sha256, JSON.stringify({task: string(taskId, 'task_id'), text: request}));
    if (framed.error) throw new BenchmarkError(framed.status, 'pin_failed', framed.error);
    const parsed = parseJson(framed.value);
    frame = {...publicationFrame({...parsed, model: harnessModel, endpoint_profile: SESSION_ENDPOINT}), case_id: string(parsed.case_id, 'case_id')};
  }
  let source = saved;
  if (reference) {
    const built = await computer.benchmarkReferenceHarness(harness);
    if (built.error) throw new BenchmarkError(built.status, 'reference_unavailable', built.error);
    source = await repository.saveSource(context, built.value, referenceHarnessOf(built.value, harness));
  }
  const policy = reference ? referencePolicy(harness) : 'coding';
  const {run_id: id, attempt_id: attemptId, session} = await service.session(context, frame, source, policy, {interactive, resumedFrom, startCli, resumeChat});
  wake(`claim:${context.userId}`);
  if (!free) {
    const pinning = async () => {
      const pinned = await computer.benchmarkSession(sha256, JSON.stringify({task: taskId, text: request, model: aiSettings.MODEL}));
      if (pinned.error) throw new BenchmarkError(pinned.status, 'pin_failed', pinned.error);
      await service.pinSession(context, session, benchmarkPublication({...parseJson(pinned.value), model: harnessModel, endpoint_profile: SESSION_ENDPOINT}));
    };
    pinning()
      .catch(error => repository.failSessionCase(context, id, frame.case_id, error instanceof BenchmarkError ? error.message : `Pinning the case failed: ${error.message}`))
      .catch(error => console.error(`[benchmark] session ${id}: recording its pin's failure failed:`, error))
      .finally(() => wake(`case:${id}`));
  }
  return {run: await repository.run(context, id), attempt_id: attemptId};
}

/** The attempt id `resume` names, an ended free-form Terminal session of the member's that a new one (`free`) may resume. */
async function resumable(repository, context, free, resume) {
  if (!free) throw new BenchmarkError(400, 'invalid_request', 'Only a Terminal session someone is at resumes another');
  const id = string(resume, 'resume');
  const [old] = UUID.test(id) ? await repository.terminalRows(context, {attemptId: id}) : [];
  if (!old || old.harness_name !== 'shell' || old.task_id !== null) throw new BenchmarkError(404, 'unknown_session', 'No Terminal session of yours to resume has that id');
  if (old.state !== 'final') throw new BenchmarkError(409, 'session_running', 'That session is still running: leave its shell (exit) to end it, then resume it');
  return id;
}

/** The chat `chat` of the session `resumedFrom` resumes, which its first terminal reopens: `{agent, id}`. */
async function chatOf(repository, context, resumedFrom, chat) {
  if (resumedFrom === null) throw new BenchmarkError(400, 'invalid_request', 'A chat is reopened by resuming the session that holds it');
  const {agent, id} = object(chat, 'chat');
  if (typeof agent !== 'string' || !CLI_COMMAND.test(agent) || !(id === null || (typeof id === 'string' && CONVERSATION_ID.test(id)))) {
    throw new BenchmarkError(400, 'invalid_request', "chat is {agent, id}: an agent's CLI command and its conversation id, or null");
  }
  const [row] = await repository.terminalRows(context, {attemptId: resumedFrom, atCalls: true});
  if (!terminalChats(row).some(one => one.agent === agent && one.conversation === id)) throw new BenchmarkError(404, 'unknown_chat', 'That session is not one RUSH kept from that terminal session');
  return {agent, id};
}

/** The agent CLI command `start` names, which a new free-form session runs first. */
function cliCommand(free, resumedFrom, start) {
  if (!free || resumedFrom !== null) throw new BenchmarkError(400, 'invalid_request', 'Only a new Terminal session someone is at starts an agent\'s CLI');
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
    // One session of a plugin page's Harness tab, or of `nanoagent harness` (startSession).
    if (top === 'sessions') {
      if (req.method !== 'POST') return wrongMethod();
      write();
      const body = object(await jsonBody(req, readBody), 'The body');
      const [pluginId, harness] = ['plugin_id', 'harness'].map(name => string(body[name], name));
      if (typeof body.interactive !== 'boolean') throw new BenchmarkError(400, 'invalid_request', 'interactive must be a boolean');
      return json(res, 201, await startSession(ctx, context, {pluginId, taskId: body.task_id, harness, interactive: body.interactive, text: body.text, model: body.model, resume: body.resume, start: body.start, chat: body.chat, join: body.join}));
    }
    // A plugin page's Leaderboard tab: the harnesses run on the plugin, whatever task, ranked from every member's scored runs.
    if (top === 'leaderboard') {
      if (req.method !== 'GET') return wrongMethod();
      read();
      const pluginId = string(url.searchParams.get('plugin_id'), 'plugin_id');
      return json(res, 200, leaderboard(await repository.leaderboard(context, pluginId), context.userId));
    }
    // A plugin page's Dashboard: the chats the member's own Harness tab sessions on the plugin held, by agent, beside their own chats.
    if (top === 'terminal-sessions') {
      if (req.method !== 'GET') return wrongMethod();
      read();
      const pluginId = string(url.searchParams.get('plugin_id'), 'plugin_id');
      const rows = await repository.terminalRows(context, {pluginId, atCalls: true});
      return json(res, 200, {chats: memberChats(rows.map(terminalChats))});
    }
    // A run of a reference harness made outside RUSH (examples/benchmark in the NanoAgent project), kept as the member's scored run, on
    // the package of its plugin version as published: its task must be that version's.
    if (top === 'imports') {
      if (req.method !== 'POST') return wrongMethod();
      write();
      const record = importBody(await jsonBody(req, readBody));
      const {plugin_id: pluginId, version} = record.frame;
      const published = await repository.marketVersion(context, string(pluginId, 'frame.plugin_id'), string(version, 'frame.version', {max: 64}));
      if (!published) throw new BenchmarkError(404, 'unknown_plugin_version', `${pluginId} ${version} is not published`);
      const frame = publicationFrame({...record.frame, package_sha256: published.sha256});
      checkTaskAgainstEntry(published.entry, frame);
      const kept = await repository.importRun(context, frame, record);
      return json(res, kept.created ? 201 : 200, kept);
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
      const page = await repository.events(context, attemptId, cursorOf(url.searchParams.get('after')), limitOf(url, 200, PAGE));
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

module.exports.startSession = startSession;
module.exports.openApp = openApp;
