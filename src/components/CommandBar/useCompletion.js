/**
 * What the slash menu shows for the line being typed.
 *
 * Derived state only: this hook holds nothing but the cursor into the ranked
 * list, and every other value is recomputed from the draft. That is what lets
 * the composer stay a controlled input with one source of truth for the text.
 *
 * The first level ranks the two verbs. Once either verb is complete, its
 * `options` function supplies the second level of concrete harnesses or models.
 * The same selected index then drives arrows, Tab, Enter, pointer choice, and
 * aria-activedescendant without creating a second popup state machine.
 *
 * `moved` is the difference between a suggestion and an instruction. The ranked
 * list is fuzzy and admits a typo: `/modle` can rank `model` first, and running it
 * because it happened to be highlighted would run a command nobody named. So
 * the shell only treats the highlighted row as the reader's choice once the
 * reader has made one, with the arrows or with the pointer, and otherwise
 * resolves the verb that was actually typed.
 */
import {useEffect, useMemo, useState} from 'react';
import {
  parseCommand,
  rankCommandOptions,
  rankCommands,
  resolveCommand,
} from './commandRuntime.js';

export default function useCompletion(draft, commands, context = null) {
  const [selected, setSelected] = useState(0);
  const [moved, setMoved] = useState(false);

  // Parsed from the trimmed draft so that this hook and the shell agree on what
  // a line is: the shell trims before it parses, so ` /model` is a command
  // there, and a menu that stayed closed for it would leave Enter running a
  // command with nothing on screen to say which one.
  const parsed = useMemo(() => parseCommand(draft.trim()), [draft]);
  const isCommand = parsed !== null;
  const verb = parsed?.verb ?? '';
  const argLine = parsed?.argLine ?? '';

  const resolved = useMemo(
    () => resolveCommand(commands, verb),
    [commands, verb],
  );
  const selectingArgument = Boolean(
    resolved
    && String(resolved.name).toLowerCase() === verb.toLowerCase()
    && typeof resolved.options === 'function',
  );
  const matches = useMemo(() => {
    if (!isCommand) return [];
    if (!selectingArgument) return rankCommands(commands, verb);
    return rankCommandOptions(resolved, context, argLine);
  }, [isCommand, selectingArgument, commands, verb, resolved, context, argLine]);

  // Any edit re-ranks the list, so put the cursor back on the best match, and
  // with it back to being a guess rather than a choice.
  useEffect(() => {
    setSelected(0);
    setMoved(false);
  }, [draft]);

  const move = (delta) => {
    setMoved(true);
    setSelected((i) => {
      const next = i + delta;
      if (next < 0) return 0;
      return next > matches.length - 1 ? Math.max(matches.length - 1, 0) : next;
    });
  };

  /** Put the highlight on a row deliberately, which is what hovering one is. */
  const choose = (index) => {
    setMoved(true);
    setSelected(index);
  };

  const choice = matches[selected] ?? null;

  /**
   * The tail drawn under the input, in the same monospace box, so the hidden
   * copy of what was typed reserves the exact width whatever the casing.
   */
  const ghost = (() => {
    if (!choice || !verb) return '';
    if (selectingArgument) {
      const value = String(choice.value);
      if (argLine && !value.toLowerCase().startsWith(argLine.toLowerCase())) return '';
      const separator = argLine || draft.endsWith(' ') ? '' : ' ';
      return separator + value.slice(argLine.length);
    }
    // Once a command's arguments are being typed, its option list owns completion.
    if (argLine) return '';
    const name = String(choice.name);
    if (verb.toLowerCase() !== name.toLowerCase()) {
      return name.toLowerCase().startsWith(verb.toLowerCase()) ? name.slice(verb.length) : '';
    }
    if (!choice.usage) return '';
    return draft.endsWith(' ') ? choice.usage : ` ${choice.usage}`;
  })();

  /**
   * The line Tab installs, or null when there is nothing to accept. A command
   * that takes arguments gets the trailing space, because the next thing typed
   * is one of them.
   *
   * Once arguments have been typed there is nothing left to complete, and the
   * line Tab would install is the line without them: `/model provider/name`
   * would become `/model `. Returning null instead lets Tab fall through to
   * cycling panes, which is what the blank ghost has already promised.
   */
  const accept = () => {
    if (!choice) return null;
    if (selectingArgument) return choice.commandLine;
    if (argLine) return null;
    return choice.usage ? `/${choice.name} ` : `/${choice.name}`;
  };

  return {
    isCommand,
    selectingArgument,
    choice,
    matches,
    selected,
    setSelected: choose,
    move,
    moved,
    ghost,
    accept,
    verb,
  };
}
