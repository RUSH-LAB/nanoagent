/**
 * Turning a typed line into something that happens.
 *
 * Splitting the line into a verb and the rest of it lets `/model model-id` and
 * `/harness harness-name` share one small parser and completion path.
 *
 * This module has no JSX and no React, on purpose. It is the part of the CLI
 * worth unit testing, and `node --test` can only load it if nothing in its
 * import graph needs a JSX transform. That is also why the search haystack is
 * built here instead of being imported from src/components/commands.js: that
 * module holds the icons, and the icons are elements.
 */
import {fuzzyMatch} from '../../utils/fuzzyMatch.js';

/**
 * Split a typed line into the verb and its arguments.
 *
 * Returns null when the line is not a command at all, which is how the caller
 * tells "run something" from "say something".
 */
export function parseCommand(line) {
  if (typeof line !== 'string' || !line.startsWith('/')) return null;
  const [, verb, argLine] = /^\s*(\S*)\s*([\s\S]*?)\s*$/.exec(line.slice(1));
  return {verb, args: argLine ? argLine.split(/\s+/) : [], argLine};
}

/**
 * The fields a fuzzy match runs against.
 *
 * Every field is optional, because a plugin supplies them and a verb may not
 * need all of them. A missing one is dropped rather than interpolated, or the
 * literal string "undefined" would end up in the haystack and a query of "und"
 * would match everything.
 */
function haystack(cmd) {
  return [cmd?.name, cmd?.title, cmd?.description, cmd?.category].filter(Boolean).join(' ');
}

/** Commands worth offering for a verb, best first. An empty verb offers all. */
export function rankCommands(commands, verb) {
  const list = Array.isArray(commands) ? commands : [];
  if (!verb) return list;
  return list
    .map((cmd) => ({...cmd, ...fuzzyMatch(verb, haystack(cmd))}))
    .filter((cmd) => cmd.match)
    .sort((a, b) => b.score - a.score);
}

/**
 * The one command a verb names, or null.
 *
 * An exact name wins outright, so a command can never be shadowed by a longer
 * one that happens to start with it. Failing that, a prefix resolves only when
 * it is unambiguous: guessing between two commands is how a `/de` meant for
 * `/delete` runs `/deploy`.
 */
export function resolveCommand(commands, verb) {
  const list = Array.isArray(commands) ? commands : [];
  if (!verb) return null;
  const wanted = verb.toLowerCase();
  const exact = list.find((cmd) => String(cmd?.name).toLowerCase() === wanted);
  if (exact) return exact;
  const prefixed = list.filter((cmd) => String(cmd?.name).toLowerCase().startsWith(wanted));
  return prefixed.length === 1 ? prefixed[0] : null;
}

/** Turn a command's dynamic choices into rows the completion menu can run. */
export function rankCommandOptions(command, ctx, query = '') {
  if (typeof command?.options !== 'function') return [];
  const options = command.options(ctx).map(option => ({
    ...option,
    kind: 'argument',
    commandName: command.name,
    commandLine: `/${command.name} ${option.value}`,
    argument: option.value,
    title: option.value,
    icon: option.icon ?? command.icon,
    run: runtimeCtx => command.run(runtimeCtx, option.value),
  }));
  return rankCommands(options, query);
}

/**
 * Run a resolved command.
 *
 * A command is handed the context and the raw argument line. Every failure is caught
 * and reported into the pane, because a verb that throws would take the React
 * tree down with it and lose the transcript that explains what went wrong.
 *
 * `ctx` carries the active chat, profile catalog, session store, and ways to
 * report success or failure into the transcript.
 */
export async function runCommand(command, argLine, ctx) {
  if (!command) return;
  try {
    if (typeof command.run === 'function') {
      await command.run(ctx, argLine ?? '');
      return;
    }
    ctx.fail(`/${command.name} has nothing to do`);
  } catch (err) {
    ctx.fail(err?.message || `/${command.name} failed`);
  }
}
