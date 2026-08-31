/**
 * What the slash menu shows for the line being typed.
 *
 * Derived state only: this hook holds nothing but the cursor into the ranked
 * list, and every other value is recomputed from the draft. That is what lets
 * the composer stay a controlled input with one source of truth for the text.
 *
 * The ranking runs against the verb, never against the whole line, which is the
 * difference between `/dm alice` resolving `dm` and `/dm alice` matching
 * nothing at all. The ghost is the other half of the same idea: while the verb
 * is being typed it completes the name, and once the verb is whole it shows
 * what the command expects, so the row reads `/dm @person` before a name has
 * been chosen.
 *
 * `moved` is the difference between a suggestion and an instruction. The ranked
 * list is fuzzy and admits a typo: `/tpoic` ranks `split` first, and running it
 * because it happened to be highlighted would run a command nobody named. So
 * the shell only treats the highlighted row as the reader's choice once the
 * reader has made one, with the arrows or with the pointer, and otherwise
 * resolves the verb that was actually typed.
 */
import {useEffect, useMemo, useState} from 'react';
import {parseCommand, rankCommands} from './commandRuntime.js';

export default function useCompletion(draft, commands) {
  const [selected, setSelected] = useState(0);
  const [moved, setMoved] = useState(false);

  // Parsed from the trimmed draft so that this hook and the shell agree on what
  // a line is: the shell trims before it parses, so ` /help` is a command
  // there, and a menu that stayed closed for it would leave Enter running a
  // command with nothing on screen to say which one.
  const parsed = useMemo(() => parseCommand(draft.trim()), [draft]);
  const isCommand = parsed !== null;
  const verb = parsed?.verb ?? '';
  const argLine = parsed?.argLine ?? '';

  const matches = useMemo(
    () => (isCommand ? rankCommands(commands, verb) : []),
    [isCommand, commands, verb],
  );

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
    // Nothing to suggest before a verb has been started, and nothing useful to
    // suggest once its arguments are being typed.
    if (!choice || !verb || argLine) return '';
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
   * line Tab would install is the line without them: `/topic Release notes`
   * would become `/topic `. Returning null instead lets Tab fall through to
   * cycling panes, which is what the blank ghost has already promised.
   */
  const accept = () => {
    if (!choice || argLine) return null;
    return choice.usage ? `/${choice.name} ` : `/${choice.name}`;
  };

  return {isCommand, matches, selected, setSelected: choose, move, moved, ghost, accept, verb};
}
