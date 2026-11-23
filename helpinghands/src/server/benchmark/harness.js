'use strict';

const {BenchmarkError} = require('./errors');

// The agent CLIs the shell harness installs (nanoagent/src/nanoagent/uploaded/reference_harnesses/shell/harnesses.yaml). A run names its harness by one
// of these, or by `rush <command>`, a member's own agent.
const AGENTS = Object.freeze(['claude', 'codex', 'dsh', 'hermes', 'nanoagent', 'pi']);
// A member's own agent's headless command: `rush`, its program (one word of a CLI name's characters, which a kept Terminal session ran as
// `rush <program>`), then the arguments the case's prompt follows as the last one (`rush aider --yes --message`), each a word of characters
// that need no quoting. `forget` and `help` are rush's own.
const RUSH_COMMAND = /^rush ((?!(?:forget|help)(?: |$))[a-z0-9][a-z0-9._-]{0,63})((?: [A-Za-z0-9._=:/,@+%-]+){0,32})$/;

/** `name` if it names a harness a run may use (an agent of the shell harness or `rush <command>`), else 400 `unknown_harness`. */
function checkHarness(name) {
  if (typeof name === 'string' && (AGENTS.includes(name) || (name.length <= 512 && RUSH_COMMAND.test(name)))) return name;
  throw new BenchmarkError(400, 'unknown_harness', `harness must be one of ${AGENTS.join(', ')}, or rush <program> [<argument>…] for your own agent, the case's prompt following as the last argument`);
}

/** The program of a member's own agent that `harness` runs (`aider` of `rush aider --message`), or null for an agent of the shell harness. */
const rushProgram = harness => RUSH_COMMAND.exec(harness)?.[1] ?? null;

module.exports = {AGENTS, checkHarness, rushProgram};
