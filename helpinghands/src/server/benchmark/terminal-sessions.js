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
// A model call no process the record shows was running when it started, or that two agents running then could have made.
const UNKNOWN = 'unknown';

const ns = value => (value === null || value === undefined ? null : Number(value));
const seconds = (start, end) => (start === null || end === null ? null : (end - start) / 1e9);
const figure = (sum, known) => ({sum: known ? sum : 0, count: known ? 1 : 0});

/** What the member calls a run's harness: a reference harness by its label (NanoAgent's apart from RUSH's chats), a saved one by its name. */
function harnessLabel(name) {
  if (name === 'nanoagent') return `${REFERENCE_LABELS.nanoagent} (Harness)`;
  return REFERENCE_LABELS[name] ?? name;
}

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

/** The agent whose process ran at `at` (ns), when the outermost agent processes running then are all one agent; otherwise unknown. */
function agentAt(processes, at) {
  if (at === null) return UNKNOWN;
  const running = processes.filter(process => process.start !== null && process.start <= at && (process.end === null || process.end >= at));
  const agents = new Set(outermost(running).map(process => process.agent));
  return agents.size === 1 ? [...agents][0] : UNKNOWN;
}

/**
 * One of the member's Harness tab sessions (a `benchmark_run` with `session`, its attempt's row as `terminalRows` reads it), as the
 * Dashboard shows it beside the chats: its harness, and per harness that worked in it what its model calls took, read and cost (from
 * the gateway), in the figures a chat's usage has, each `{sum, count}` with count 1 when this session knows it and 0 when not. Tool
 * time is the plugin tools', which a terminal has none of, so it is never known; the End-to-End Latency (the profiler's) goes to the
 * session's one harness, and to none when several worked in it. In a free-form Terminal session each model call is the agent's whose
 * process ran when it started (agentAt), and the session is named by its agents in the order they first called a model ("claude,
 * codex"), or with none by its main command (its longest-running outermost process), or "shell" when it ran none. `calls` and
 * `commands` are what its recording shows.
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
  const agents = [...new Set(calls.map(call => call.agent))];
  const lasted = process => (process.start === null ? 0 : (process.end ?? Infinity) - process.start);
  const main = outermost(processes).sort((x, y) => lasted(y) - lasted(x))[0];
  const harness = !shell ? label : agents.length ? agents.join(', ') : main?.agent ?? 'shell';
  const groups = agents.length ? agents : [harness];
  const elapsed = typeof row.elapsed_ms === 'number' ? row.elapsed_ms / 1000 : null;
  const harnesses = groups.map(agent => {
    const mine = calls.filter(call => call.agent === agent);
    // A session's calls are known once it is final and the gateway's evidence is in; a session with none made none.
    const all = pick => final && mine.every(call => pick(call) !== null);
    const some = pick => (final && !mine.length) || mine.some(call => pick(call) !== null);
    const sum = pick => mine.reduce((total, call) => total + (pick(call) ?? 0), 0);
    return {
      harness: agent,
      usage: {
        durationS: figure(elapsed ?? 0, groups.length === 1 && elapsed !== null),
        modelS: figure(sum(call => call.durationS), all(call => call.durationS)),
        toolsS: figure(0, false),
        inputTokens: figure(sum(call => call.inputTokens), some(call => call.inputTokens)),
        outputTokens: figure(sum(call => call.outputTokens), some(call => call.outputTokens)),
        cost: figure(sum(call => call.cost), all(call => call.cost)),
      },
    };
  });
  // The recording's clock starts at the first thing it recorded.
  const starts = [...calls, ...processes].map(one => one.start).filter(start => start !== null);
  const begun = starts.length ? Math.min(...starts) : null;
  return {
    id: row.attempt_id,
    harness,
    title: harness,
    createdAt: row.created_at,
    updatedAt: row.finalized_at ?? row.created_at,
    running: !final,
    harnesses,
    calls: calls.map(({start, ...call}) => ({...call, startS: seconds(begun, start)})),
    commands: processes.map(({argv, start, end, exitCode}) => ({argv, startS: seconds(begun, start), durationS: seconds(start, end), exitCode})),
  };
}

module.exports = {terminalSession};
