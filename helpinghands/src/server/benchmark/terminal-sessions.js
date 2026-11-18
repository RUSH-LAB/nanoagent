'use strict';

const {REFERENCE_LABELS} = require('./leaderboard');

/**
 * Where each agent CLI a Terminal session installs runs from: its package's path, or for Hermes its module, appears in the argv of
 * the process its wrapper execs (the shell reference harness's bin/, nanoagent.uploaded.clis).
 */
const CLI_MARKERS = Object.freeze([
  ['claude-code', '@anthropic-ai/claude-code'], ['codex', '@openai/codex'], ['pi', '@earendil-works/pi-coding-agent'],
  ['hermes', 'hermes_cli'], ['dsh', '@deepseek-ai/dsh'],
]);
// What a Terminal session's argv patterns are in SQL (`ilike any`), to read only the processes of its CLIs.
const CLI_PATTERNS = CLI_MARKERS.map(([, marker]) => `%${marker}%`);
// A model call no process record places in one CLI's process.
const TERMINAL = REFERENCE_LABELS.shell;
const SEVERAL = `${TERMINAL} (several)`;

const ns = value => (value === null || value === undefined ? null : Number(value));
const seconds = (start, end) => (start === null || end === null ? null : (end - start) / 1e9);
const figure = (sum, known) => ({sum: known ? sum : 0, count: known ? 1 : 0});

/** What the member calls a run's harness: a reference harness by its label (NanoAgent's apart from RUSH's chats), a saved one by its name. */
function harnessLabel(name) {
  if (name === 'nanoagent') return `${REFERENCE_LABELS.nanoagent} (Harness)`;
  return REFERENCE_LABELS[name] ?? name;
}

/** The CLI whose process ran at `at` (ns), when the process record shows exactly one; otherwise the Terminal. */
function agentAt(processes, at) {
  if (at === null) return TERMINAL;
  const running = new Set(processes
    .filter(process => process.start !== null && process.start <= at && (process.end === null || process.end >= at))
    .map(process => process.agent));
  return running.size === 1 ? [...running][0] : TERMINAL;
}

/**
 * One of the member's Harness tab sessions (a `benchmark_run` with `session`, its attempt's row as `terminalRows` reads it), as the
 * Dashboard shows it beside the chats: its harness, and per harness that worked in it what its model calls took, read and cost (from
 * the gateway), in the figures a chat's usage has, each `{sum, count}` with count 1 when this session knows it and 0 when not. Tool
 * time is the plugin tools', which a terminal has none of, so it is never known; the End-to-End Latency (the profiler's) goes to the
 * session's one harness, and to none when several worked in it. In a free-form Terminal session each model call is the CLI's whose
 * process ran when it started, by the process record, or the Terminal's when none or several did. `calls` and `commands` are what
 * its recording shows.
 */
function terminalSession(row) {
  const shell = row.harness_name === 'shell';
  const processes = row.processes.map(process => {
    const argv = (process.argv ?? []).join(' ');
    const found = CLI_MARKERS.find(([, marker]) => argv.includes(marker));
    return {argv: process.argv ?? [], start: ns(process.start_ns), end: ns(process.end_ns), exitCode: process.exit_code ?? null, agent: found ? REFERENCE_LABELS[found[0]] : null};
  });
  const clis = processes.filter(process => process.agent !== null);
  const label = harnessLabel(row.harness_name);
  const calls = row.calls
    .filter(call => call.status !== 'rejected')
    .map(call => {
      const start = ns(call.start_ns);
      const end = ns(call.end_ns);
      return {
        callId: call.call_id, model: call.model, start, agent: shell ? agentAt(clis, start) : label, durationS: seconds(start, end),
        inputTokens: call.usage?.input ?? null, outputTokens: call.usage?.output ?? null,
        cost: typeof row.costs[call.call_id] === 'number' ? row.costs[call.call_id] : null,
        request: call.request_sha256 ?? null, response: call.response_sha256 ?? null,
      };
    })
    .sort((x, y) => (x.start ?? Infinity) - (y.start ?? Infinity));
  const final = row.state === 'final';
  const agents = [...new Set(calls.map(call => call.agent))];
  const harness = !shell ? label : agents.length > 1 ? SEVERAL : agents[0] ?? TERMINAL;
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
    title: `${harness} · ${row.task_id}`,
    createdAt: row.created_at,
    updatedAt: row.finalized_at ?? row.created_at,
    running: !final,
    harnesses,
    calls: calls.map(({start, ...call}) => ({...call, startS: seconds(begun, start)})),
    commands: processes.map(({argv, start, end, exitCode}) => ({argv, startS: seconds(begun, start), durationS: seconds(start, end), exitCode})),
  };
}

module.exports = {CLI_PATTERNS, terminalSession};
