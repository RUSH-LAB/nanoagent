'use strict';

const {REFERENCE_LABELS} = require('./leaderboard');

/**
 * The agent CLIs a Terminal session installs, by what the member types: its package's path, or for Hermes its module, appears in
 * the argv of the process its wrapper execs (the shell reference harness's bin/, nanoagent.uploaded.clis), and the wrapper itself
 * runs as /harness/bin/<name> until it execs.
 */
const CLI_MARKERS = Object.freeze([
  ['claude', '@anthropic-ai/claude-code'], ['codex', '@openai/codex'], ['pi', '@earendil-works/pi-coding-agent'],
  ['hermes', 'hermes_cli'], ['dsh', '@deepseek-ai/dsh'],
]);
const WRAPPER = /\/harness\/bin\/(claude|codex|pi|hermes|dsh)(?:\s|$)/;
// The Terminal's own processes (its bash's shell.py, `rush` and a CLI's install), which run no agent.
const HARNESS = /\/harness\/(?:shell|rush)\.py(?:\s|$)/;
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'fish', 'ash']);

const ns = value => (value === null || value === undefined ? null : Number(value));
const seconds = (start, end) => (start === null || end === null ? null : (end - start) / 1e9);
const figure = (sum, known) => ({sum: known ? sum : 0, count: known ? 1 : 0});

/** A run's agent: a reference harness's CLI command, a saved harness by its name. */
const harnessLabel = name => REFERENCE_LABELS[name] ?? name;

/**
 * The agent a process is, by its argv: one of the CLIs a Terminal session installs, by what the member types, or any other program
 * by its executable's name (aider, python, node); null for a shell or the Terminal's own processes, which run none.
 */
function agentOf(argv) {
  const line = argv.join(' ');
  const cli = CLI_MARKERS.find(([, marker]) => line.includes(marker))?.[0] ?? WRAPPER.exec(line)?.[1];
  if (cli) return cli;
  if (!argv.length || HARNESS.test(line)) return null;
  const name = argv[0].slice(argv[0].lastIndexOf('/') + 1);
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

/**
 * The agent whose process ran at `at` (ns), when the outermost agent processes running then are all one agent; otherwise null (no
 * process the record shows ran then, as in a session recorded before process records, or two agents could have made the call).
 */
function agentAt(processes, at) {
  if (at === null) return null;
  const running = processes.filter(process => process.start !== null && process.start <= at && (process.end === null || process.end >= at));
  const agents = new Set(outermost(running).map(process => process.agent));
  return agents.size === 1 ? [...agents][0] : null;
}

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
 * outermost process) or its calls ("3 model calls"), or "no agent". `calls` and `commands` are what its recording shows.
 */
function terminalSession(row) {
  const shell = row.harness_name === 'shell';
  const processes = row.processes.map(process => ({
    id: process.span_id, parent: process.parent_id, argv: process.argv ?? [], start: ns(process.start_ns), end: ns(process.end_ns),
    exitCode: process.exit_code ?? null, agent: agentOf(process.argv ?? []),
  }));
  const label = harnessLabel(row.harness_name);
  const calls = row.calls
    .filter(call => call.status !== 'rejected')
    .map(call => {
      const start = ns(call.start_ns);
      const end = ns(call.end_ns);
      return {
        callId: call.call_id, model: call.model, start, agent: shell ? agentAt(processes, start) : label, durationS: seconds(start, end),
        inputTokens: call.usage?.input ?? null, outputTokens: call.usage?.output ?? null,
        cost: typeof row.costs[call.call_id] === 'number' ? row.costs[call.call_id] : null,
        request: call.request_sha256 ?? null, response: call.response_sha256 ?? null,
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
  // The recording's clock starts at the first thing it recorded.
  const starts = [...calls, ...processes].map(one => one.start).filter(start => start !== null);
  const begun = starts.length ? Math.min(...starts) : null;
  return {
    id: row.attempt_id,
    title: agents.length ? agents.join(', ') : did,
    createdAt: row.created_at,
    updatedAt: row.finalized_at ?? row.created_at,
    running: !final,
    // A free-form Terminal session resumes from the Dashboard (whether its worker kept it is checked there); `resumedFrom` is the one it resumed.
    freeForm: shell && row.task_id === null,
    resumable: row.resumable === true,
    resumedFrom: row.resumed_from ?? null,
    harnesses,
    usage: usageOf(calls.filter(call => call.agent === null), final, agents.length ? null : elapsed),
    calls: calls.map(({start, ...call}) => ({...call, startS: seconds(begun, start)})),
    commands: processes.map(({argv, start, end, exitCode}) => ({argv, startS: seconds(begun, start), durationS: seconds(start, end), exitCode})),
  };
}

module.exports = {terminalSession};
