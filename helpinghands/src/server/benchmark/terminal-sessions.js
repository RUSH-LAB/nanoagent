'use strict';

const {REFERENCE_LABELS} = require('./leaderboard');

/**
 * The agent CLIs a Terminal session installs, by what the member types: its package's path, or for Hermes and NanoAgent its module
 * (NanoAgent's `nanoagent` and `mgen` both run nanoagent.cli), appears in the argv of the process its wrapper execs (the shell
 * reference harness's bin/, nanoagent.uploaded.clis), and the wrapper itself runs as /harness/bin/<name> until it execs.
 */
const CLI_MARKERS = Object.freeze([
  ['claude', '@anthropic-ai/claude-code'], ['codex', '@openai/codex'], ['pi', '@earendil-works/pi-coding-agent'],
  ['hermes', 'hermes_cli'], ['dsh', '@deepseek-ai/dsh'], ['nanoagent', 'nanoagent.cli.'],
]);
const WRAPPER = /\/harness\/bin\/(claude|codex|pi|hermes|dsh|nanoagent)(?:\s|$)/;
// The Terminal's own processes (its bash's shell.py, `rush` and a CLI's install), which run no agent.
const HARNESS = /\/harness\/(?:shell|rush)\.py(?:\s|$)/;
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'fish', 'ash']);

const ns = value => (value === null || value === undefined ? null : Number(value));
const seconds = (start, end) => (start === null || end === null ? null : (end - start) / 1e9);
const figure = (sum, known) => ({sum: known ? sum : 0, count: known ? 1 : 0});

/** A run's agent: a reference harness's CLI command, a saved harness by its name. */
const harnessLabel = name => REFERENCE_LABELS[name] ?? name;

const PYTHON = /^python[0-9.]*$/;
const base = path => path.slice(path.lastIndexOf('/') + 1);

/**
 * The agent a process is, by its argv: one of the CLIs a Terminal session installs, by what the member types, or any other program
 * by its command (argv[0]'s name: aider, node), a module run with `python -m` by that module and a package run with `npx` by that
 * package's command (`npx @scope/tool@1` is tool); null for a shell or the Terminal's own processes, which run none.
 */
function agentOf(argv) {
  const line = argv.join(' ');
  const cli = CLI_MARKERS.find(([, marker]) => line.includes(marker))?.[0] ?? WRAPPER.exec(line)?.[1];
  if (cli) return cli;
  if (!argv.length || HARNESS.test(line)) return null;
  const name = base(argv[0]);
  const module = PYTHON.test(name) && argv.indexOf('-m') > 0 ? argv[argv.indexOf('-m') + 1] : undefined;
  if (module) return module;
  const pkg = name === 'npx' ? argv.slice(1).find(arg => !arg.startsWith('-')) : undefined;
  if (pkg) return base(pkg.replace(/(.)@[^/]*$/, '$1'));
  return SHELLS.has(name) ? null : name;
}

/** The processes with no agent above them in the process tree: what the member ran, leaving out what an agent itself starts. */
function outermost(processes) {
  const byId = new Map(processes.map(process => [process.id, process]));
  return processes.filter(process => {
    for (let up = byId.get(process.parent); up; up = byId.get(up.parent)) if (up.agent !== null) return false;
    return process.agent !== null;
  });
}

// The agent CLIs a model call's client (the user-agent it came with) names: a call made while agents run in two terminals is the one's
// that made it.
const CLIENTS = Object.freeze([['claude', /^claude-cli\//], ['codex', /^codex[-_]/], ['pi', /^pi \(/]]);
const clientAgent = client => CLIENTS.find(([, pattern]) => pattern.test(client ?? ''))?.[0] ?? null;

/**
 * The outermost agent process running at `at` (ns) that made a call from `client`: of the agent that client names when it names one,
 * and those running then all one agent (the latest started of them); otherwise null (no process the record shows ran then, as in a
 * session recorded before process records, or two agents could have made the call).
 */
function processAt(processes, at, client) {
  if (at === null) return null;
  const named = clientAgent(client);
  const running = outermost(processes.filter(process => process.start !== null && process.start <= at && (process.end === null || process.end >= at)))
    .filter(process => named === null || process.agent === named);
  if (new Set(running.map(process => process.agent)).size !== 1) return null;
  return running.reduce((latest, process) => (process.start > latest.start ? process : latest));
}

/** The agent whose process made a call from `client` at `at` (processAt), or null. */
const agentAt = (processes, at, client) => processAt(processes, at, client)?.agent ?? null;

/** What `calls` took, read and cost, in the figures a chat's usage has, with `elapsed` (s) as its End-to-End Latency when it is its own. */
function usageOf(calls, final, elapsed) {
  // A session's calls are known once it is final and the gateway's evidence is in; a session with none made none.
  const all = pick => final && calls.every(call => pick(call) !== null);
  const some = pick => (final && !calls.length) || calls.some(call => pick(call) !== null);
  const sum = pick => calls.reduce((total, call) => total + (pick(call) ?? 0), 0);
  return {
    durationS: figure(elapsed ?? 0, elapsed !== null),
    modelS: figure(sum(call => call.durationS), all(call => call.durationS)),
    toolsS: figure(0, false),
    inputTokens: figure(sum(call => call.inputTokens), some(call => call.inputTokens)),
    outputTokens: figure(sum(call => call.outputTokens), some(call => call.outputTokens)),
    cost: figure(sum(call => call.cost), all(call => call.cost)),
  };
}

/**
 * One of the member's Harness tab sessions (a `benchmark_run` with `session`, its attempt's row as `terminalRows` reads it), as the
 * Dashboard shows it beside the chats. `harnesses` are the agents that made model calls in it, named by their CLI command, each with
 * what its calls took, read and cost (from the gateway), in the figures a chat's usage has, each `{sum, count}` with count 1 when this
 * session knows it and 0 when not. Tool time is the plugin tools', which a terminal has none of, so it is never known; the End-to-End
 * Latency (the profiler's) goes to the session's one agent, and to none when several worked in it. In a free-form Terminal session
 * each model call is the agent's whose process ran when it started (agentAt); a call tied to none is no agent's and counts only in
 * the session's own `usage`, which, for a session no agent made a call in, also has its latency. The session is titled by its agents
 * in the order they first called a model ("claude, codex"); with none, by what it did: its main command (its longest-running
 * outermost process) or its calls ("3 model calls"), or "no agent".
 */
function terminalSession(row) {
  const shell = row.harness_name === 'shell';
  const processes = row.processes.map(process => ({
    id: process.span_id, parent: process.parent_id, start: ns(process.start_ns), end: ns(process.end_ns), agent: agentOf(process.argv ?? []),
  }));
  const label = harnessLabel(row.harness_name);
  const calls = row.calls
    .filter(call => call.status !== 'rejected')
    .map(call => {
      const start = ns(call.start_ns);
      const end = ns(call.end_ns);
      return {
        start, agent: shell ? agentAt(processes, start, call.client) : label, durationS: seconds(start, end),
        inputTokens: call.usage?.input ?? null, outputTokens: call.usage?.output ?? null,
        cost: typeof row.costs[call.call_id] === 'number' ? row.costs[call.call_id] : null,
      };
    })
    .sort((x, y) => (x.start ?? Infinity) - (y.start ?? Infinity));
  const final = row.state === 'final';
  const agents = [...new Set(calls.map(call => call.agent).filter(agent => agent !== null))];
  const lasted = process => (process.start === null ? 0 : (process.end ?? Infinity) - process.start);
  const main = outermost(processes).sort((x, y) => lasted(y) - lasted(x))[0];
  const did = !shell ? label : main?.agent ?? (calls.length ? `${calls.length} model call${calls.length === 1 ? '' : 's'}` : 'no agent');
  const elapsed = typeof row.elapsed_ms === 'number' ? row.elapsed_ms / 1000 : null;
  const harnesses = agents.map(agent => ({
    harness: agent, usage: usageOf(calls.filter(call => call.agent === agent), final, agents.length === 1 ? elapsed : null),
  }));
  return {
    id: row.attempt_id,
    title: agents.length ? agents.join(', ') : did,
    createdAt: row.created_at,
    updatedAt: row.finalized_at ?? row.created_at,
    running: !final,
    resumedFrom: row.resumed_from ?? null,
    harnesses,
    usage: usageOf(calls.filter(call => call.agent === null), final, agents.length ? null : elapsed),
  };
}

const TITLE_CHARS = 120;

/** "claude -p say hi": what the member typed to run agent process `process`, from its argv after its program: a run's title when its
 * calls were recorded before the gateway kept their prompts. */
function typed(process) {
  const {argv, agent} = process;
  const line = argv.join(' ');
  const marker = CLI_MARKERS.find(([name]) => name === agent)?.[1];
  const at = argv.findIndex(arg => (marker && arg.includes(marker)) || WRAPPER.test(arg) || arg.endsWith(`/${agent}`) || arg === agent);
  const text = [agent, ...(at === -1 || !line ? [] : argv.slice(at + 1))].join(' ').replace(/\s+/g, ' ');
  return text.length <= TITLE_CHARS ? text : `${text.slice(0, TITLE_CHARS - 1)}…`;
}

/**
 * The chats of one of the member's Harness tab sessions (a `benchmark_run` with `session`, its attempt's row as `terminalRows` reads
 * it): each conversation of an agent CLI it held, which the Dashboard lists under that agent. A chat is one run of a program that
 * made model calls (an outermost agent process: what the member typed at the shell, named by its command, agentOf), titled by the
 * last user message of its first call's request (`prompt`, from the gateway), from that call on; it reruns as the member typed it
 * (`run`: its argv and the folder it ran in). An ended free-form Terminal session also holds the chats its worker read from the CLIs'
 * own state (claude, codex, pi, hermes; `row.chats`), each its CLI's conversation, titled by its first prompt and reopened by its id,
 * which take the calls of their agent's runs in place of those runs: each such call goes to the chat of its agent whose time holds
 * it, or the nearest. A session of a harness of its own is one chat of it. A call no process ties to one agent is no chat's. A chat
 * has `key` ("<agent>:<id>"), its `conversation` id (null for a run, which nothing reopens by id), its session's
 * `attemptId`, whether that one is `running`, `resumable` (kept on the member's computer) and `freeForm`, when it was archived, and its
 * figures (`usage`, as a chat's), its End-to-End Latency its own span.
 */
function terminalChats(row) {
  const final = row.state === 'final';
  const label = harnessLabel(row.harness_name);
  const session = {
    attemptId: row.attempt_id, running: !final, resumable: row.resumable === true, freeForm: row.harness_name === 'shell' && row.task_id === null,
    startedAt: row.created_at, updatedAt: row.finalized_at ?? row.created_at,
  };
  const archived = key => row.archived_chats?.[key] ?? null;
  const processes = row.processes.map(process => ({
    id: process.span_id, parent: process.parent_id, start: ns(process.start_ns), end: ns(process.end_ns), argv: process.argv ?? [], cwd: process.cwd ?? null,
    agent: agentOf(process.argv ?? []),
  }));
  const calls = row.calls.filter(call => call.status !== 'rejected').map(call => {
    const start = ns(call.start_ns);
    const end = ns(call.end_ns);
    return {
      start, prompt: call.prompt ?? null, process: row.harness_name === 'shell' ? processAt(processes, start, call.client) : null, durationS: seconds(start, end),
      inputTokens: call.usage?.input ?? null, outputTokens: call.usage?.output ?? null,
      cost: typeof row.costs[call.call_id] === 'number' ? row.costs[call.call_id] : null,
    };
  });
  if (row.harness_name !== 'shell') {
    const key = `${label}:${row.attempt_id}`;
    const elapsed = typeof row.elapsed_ms === 'number' ? row.elapsed_ms / 1000 : null;
    return [{...session, key, agent: label, conversation: null, run: null, title: label, archivedAt: archived(key), usage: usageOf(calls, final, elapsed)}];
  }
  const reported = final && Array.isArray(row.chats) ? row.chats : [];
  // How far call `call` started from `chat`'s span (0 within it): each call is the nearest chat's of its agent.
  const away = (chat, call) => Math.max(ns(chat.started_ns) - call.start, call.start - ns(chat.ended_ns), 0);
  const nearest = call => reported.filter(chat => chat.agent === call.process?.agent).reduce((best, chat) => (best && away(best, call) <= away(chat, call) ? best : chat), null);
  const owner = new Map(calls.filter(call => call.start !== null).map(call => [call, nearest(call)]));
  const chats = reported.map(chat => {
    const key = `${chat.agent}:${chat.id}`;
    return {
      ...session, key, agent: chat.agent, conversation: chat.id, run: null, title: chat.title, startedAt: chat.started_at, updatedAt: chat.ended_at,
      archivedAt: archived(key), usage: usageOf(calls.filter(call => owner.get(call) === chat), final, seconds(ns(chat.started_ns), ns(chat.ended_ns))),
    };
  });
  const runs = new Map();
  for (const call of calls) {
    if (call.process === null || owner.get(call)) continue;
    runs.set(call.process, [...(runs.get(call.process) ?? []), call]);
  }
  for (const [process, made] of runs) {
    const key = `${process.agent}:${row.attempt_id}/${process.id}`;
    const first = made.reduce((x, y) => ((y.start ?? Infinity) < (x.start ?? Infinity) ? y : x));
    chats.push({
      ...session, key, agent: process.agent, conversation: null, run: {argv: process.argv, cwd: process.cwd}, title: first.prompt ?? typed(process),
      archivedAt: archived(key), usage: usageOf(made, final, seconds(process.start, process.end)),
    });
  }
  return chats;
}

/** Add two of a chat's figures (`{sum, count}`), known when either is. */
const plus = (x, y) => ({sum: x.sum + y.sum, count: Math.max(x.count, y.count)});

/**
 * The member's chats across `sessions` (each `terminalChats`), one per conversation: a conversation resumed in a later session is one
 * chat, titled and started as it first was, its figures summed, and reopened from the session that last held it (whose `attemptId`,
 * `resumable` and `archivedAt` it takes, so talking in it again brings it back from the archive).
 */
function memberChats(sessions) {
  const byKey = new Map();
  for (const chat of sessions.flat().sort((x, y) => new Date(x.updatedAt) - new Date(y.updatedAt))) {
    const seen = byKey.get(chat.key);
    byKey.set(chat.key, seen ? {
      ...chat, title: seen.title, startedAt: seen.startedAt,
      usage: Object.fromEntries(Object.keys(chat.usage).map(figure => [figure, plus(seen.usage[figure], chat.usage[figure])])),
    } : chat);
  }
  return [...byKey.values()];
}

module.exports = {terminalSession, terminalChats, memberChats};
