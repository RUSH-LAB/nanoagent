import React, {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {fuzzyMatch} from '@site/src/utils/fuzzyMatch';
import {LISTBOX_ID} from './Completions';
import styles from './composer.module.css';

/**
 * The prompt row: the one line of the CLI that is always on screen.
 *
 * Each pane owns one when the window is split, so every conversation remains a
 * complete column from header through transcript to input. The session number
 * and target label identify where a line will land before Enter is pressed.
 *
 * The field is a textarea, not an input, because a message worth sending is
 * often a paragraph: it grows from one line to six as it fills, Enter sends and
 * Shift+Enter breaks the line. Everything laid over that box (the ghost
 * completion) has to be the same box, same font, same padding, same wrapping,
 * or the two drift apart the moment a line wraps; composer.module.css declares
 * those properties once for the pair and this file must not override them
 * inline.
 *
 * Two different popups can be open over this row and they are deliberately kept
 * apart. The slash menu belongs to the line (Shell owns it, this file only
 * describes it to a screen reader through the ids Completions.js exports), and
 * mention completion belongs to the word under the caret. A line that starts
 * with '/' is the slash menu's, so mention completion stands down there, and
 * neither of them takes a key while it is closed.
 *
 * Minimised, the row is the whole bar and stays one line: focusing it, typing
 * and sending all happen without opening the window, which only its open
 * button does. The field scrolls rather than grows there, `lead` is who the
 * line talks to when the window's rail is hidden (TargetPicker.js), and `live`
 * is what the line shows beside it (LiveLine.js).
 *
 * The row also carries the window's chrome, because minimise, the rail toggle
 * and split have to stay reachable when the body is collapsed and the row is
 * all that is left. It deliberately does not carry a stop button. A row shared
 * by every pane can only ever stop the focused one, and a split window can
 * leave a background pane answering, so that control belongs to the transcript
 * that knows which request it is offering to abort (AssistantTranscript).
 * Escape remains the keyboard route for stopping the focused pane, while the
 * visible stop control stays beside the answer it affects.
 *
 * Working and stoppable are two different things, which is why `busy` and
 * `onCancel` are two props rather than one. A pane posting a message to a
 * channel is working, and `aria-busy` says so, but there is nothing to abort:
 * the message is already on screen. Promising Escape there, or letting it
 * swallow itself into a no-op, offers a way out that does nothing.
 */

/* How many people or channels a mention popup offers at once. Past this the
   list stops being a glance and starts being a directory, which is what the
   People settings pane and the /channels page are for. */
const MENTION_LIMIT = 8;

/* The word under the caret that mention completion works on: a sigil at the
   start of the line or after a space, then everything up to the caret that is
   not a space or another sigil. */
const MENTION_RE = /(?:^|\s)([@#])([^\s@#]*)$/;

/* ⌘1 to ⌘4 focus a pane, matching the four sessions useSessions allows. Some
   browsers keep these for their own tabs and never let the page see them; the
   pane is still reachable by clicking it or by cycling with Tab. */
const PANE_KEYS = ['1', '2', '3', '4'];

/* The mention popup is this file's own, so it names itself. The slash menu's
   ids are not: they are imported from Completions.js, which writes them onto
   the listbox and its rows, because two files spelling the same id apart would
   break the announcement silently and leave the layout perfect. */
const mentionListId = instanceId => `cli-mentions-${instanceId}`;
const mentionOptionId = (instanceId, index) => `cli-mention-${instanceId}-${index}`;

/* Stable empty defaults, so a Shell that has not wired a list yet does not hand
   this component a fresh array on every render and re-run every memo. */
const NO_ROWS = [];
const noop = () => {};

/**
 * The mention being typed, or null when there is none.
 *
 * Only the text before the caret counts: editing the middle of a line must not
 * reopen a popup for a name further along it. A line that begins with '/' is
 * the slash menu's, so nothing is offered there.
 */
function findMention(text, caret, isCommand) {
  if (isCommand) return null;
  const head = text.slice(0, caret);
  const lineStart = head.lastIndexOf('\n') + 1;
  if (text.slice(lineStart).startsWith('/')) return null;
  const found = MENTION_RE.exec(head.slice(lineStart));
  if (!found) return null;
  const [, sigil, query] = found;
  return {sigil, query, start: caret - query.length - sigil.length, end: caret};
}

/** How a person is written in a mention, and what is inserted when one is picked. */
const personName = (person) => person.username || person.name || person.email || '';

/**
 * The rows a mention popup shows: '@' offers people, '#' offers channels that
 * have a name to type (a direct message has none, it is a person).
 */
function rankMentions(mention, people, channels) {
  const pool = mention.sigil === '@'
    ? people.map((p) => {
      const key = personName(p);
      return {key, hint: p.name && p.name !== key ? p.name : p.email || ''};
    })
    : channels.filter((c) => c.kind !== 'dm').map((c) => ({key: c.name, hint: c.topic || ''}));

  return pool
    .filter((row) => row.key)
    .map((row) => ({row, hit: fuzzyMatch(mention.query, row.key)}))
    .filter(({hit}) => hit.match)
    // A prefix beats a word start beats a scattered match; ties keep directory
    // order, which is the order the rail already showed them in.
    .sort((a, b) => b.hit.score - a.hit.score)
    .slice(0, MENTION_LIMIT)
    .map(({row}) => row);
}

export default function Composer({
  inputRef,
  inputId = 'command-bar-input',
  instanceId = 'main',
  value,
  onChange,
  placeholder,
  ghost,
  isCommand,
  collapsed,
  onCollapsedChange,
  railOpen,
  onRailOpenChange,
  onSplit,
  splitDisabled,
  maxSessions,
  sessionNumber,
  targetLabel,
  rowRef,
  onSubmit,
  onClear,
  onTab,
  onVertical,
  onEscape,
  people = NO_ROWS,
  channels = NO_ROWS,
  busy = false,
  canSend = true,
  // Null rather than a no-op when the focused pane's work cannot be stopped.
  // Escape reads it to decide whether to keep its ordinary meaning.
  onCancel = null,
  onFocusPane = noop,
  listOpen = false,
  completionId = null,
  onActivate = noop,
  showChrome = true,
  lead = null,
  live = null,
}) {
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  // Escape closes the popup for the mention it was pressed on, not forever:
  // remembering where it was dismissed lets the next '@' open a new one.
  const [dismissedAt, setDismissedAt] = useState(-1);
  const listRef = useRef(null);
  // Where the caret must land after an accepted mention rewrites the line. It
  // can only be set once React has put the new value in the textarea.
  const pendingCaret = useRef(null);

  const mention = useMemo(() => findMention(value, caret, isCommand), [value, caret, isCommand]);
  const rows = useMemo(
    () => (mention ? rankMentions(mention, people, channels) : NO_ROWS),
    [mention, people, channels],
  );
  const menuOpen = Boolean(mention) && mention.start !== dismissedAt && rows.length > 0;

  /* ── The growing field ────────────────────────────────────────── */

  // Height follows the text: measured from nothing, then set to what the
  // content needs. The ceiling is a max-height in the stylesheet, so the number
  // of rows is decided in one place; all this has to notice is that the box
  // came out shorter than its content and therefore has something to scroll.
  useLayoutEffect(() => {
    const el = inputRef?.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
    el.style.overflowY = el.clientHeight < el.scrollHeight ? 'auto' : 'hidden';
  }, [value, inputRef]);

  useLayoutEffect(() => {
    const el = inputRef?.current;
    if (!el) return;
    if (pendingCaret.current !== null) {
      el.selectionStart = pendingCaret.current;
      el.selectionEnd = pendingCaret.current;
      pendingCaret.current = null;
    }
    // The line can also be replaced from outside this component (history
    // recall, a refused message handed back), which moves the caret with no
    // event to read it from. Left stale, the mention popup would go on
    // describing a word that is no longer in the line. Same value means no
    // re-render, so this costs nothing on an ordinary keystroke.
    setCaret((current) => (current === el.selectionStart ? current : el.selectionStart));
  }, [value, inputRef]);

  /* ── Mention completion ───────────────────────────────────────── */

  // A different word under the caret is a different list: the old highlight
  // would point at whoever happens to be first in the new one, and a popup
  // dismissed with Escape is dismissed for the word it was open on, not for
  // every word that ever starts at that position.
  useEffect(() => {
    setSelected(0);
    setDismissedAt(-1);
  }, [mention?.start, mention?.query, mention?.sigil]);

  useEffect(() => {
    if (!menuOpen) return;
    listRef.current?.children[selected]?.scrollIntoView({block: 'nearest'});
  }, [menuOpen, selected]);

  const accept = useCallback((index) => {
    const row = rows[index];
    if (!mention || !row) return;
    // A trailing space, because a name is finished and the next word is not
    // part of it: without one the popup reopens on the name just accepted.
    const insert = `${mention.sigil}${row.key} `;
    pendingCaret.current = mention.start + insert.length;
    onChange(value.slice(0, mention.start) + insert + value.slice(mention.end));
  }, [rows, mention, onChange, value]);

  const readCaret = useCallback((e) => setCaret(e.target.selectionStart ?? 0), []);

  /* ── Keys ─────────────────────────────────────────────────────── */

  const handleKeyDown = (e) => {
    // A keystroke that is driving an input method belongs to the input method.
    // Enter picks a candidate and the arrows move between them, so reading them
    // here would send half a composed word and shuffle the history doing it.
    if (e.nativeEvent?.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;

    // Escape means stop first. While an answer is arriving that is the only
    // thing it can usefully mean, and backing out of completion or minimising
    // the window would leave the request running unseen. With nothing to stop
    // it keeps its ordinary meaning rather than being eaten by a no-op.
    if (e.key === 'Escape' && busy && onCancel) {
      e.preventDefault();
      onCancel();
      return;
    }

    if (mod && PANE_KEYS.includes(e.key)) {
      e.preventDefault();
      onFocusPane(PANE_KEYS.indexOf(e.key));
      return;
    }

    if (mod && e.key === 'd') {
      e.preventDefault();
      onSplit();
      return;
    }

    if (mod && e.key === 'l') {
      e.preventDefault();
      onClear();
      return;
    }

    // The mention popup takes the arrows, Tab and Enter only while it is open,
    // and hands every one of them back the moment it closes.
    if (menuOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        setSelected((i) => (i + delta + rows.length) % rows.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        accept(selected);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissedAt(mention.start);
        return;
      }
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const up = e.key === 'ArrowUp';
      // In a draft that is one line, the arrows are history, as they have
      // always been. In a draft that is several, they move the caret between
      // them and only reach for history at the ends, which is what every shell
      // with a multiline prompt does.
      const at = e.target.selectionStart ?? 0;
      const leaving = up
        ? value.lastIndexOf('\n', at - 1) === -1
        : value.indexOf('\n', at) === -1;
      if (!isCommand && !leaving) return;
      e.preventDefault();
      onVertical(up ? -1 : 1);
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      onTab();
      return;
    }

    if (e.key === 'Enter') {
      // Shift+Enter is the newline, so it is the one key here that is left to
      // the textarea to handle itself.
      if (e.shiftKey) return;
      e.preventDefault();
      onSubmit();
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      onEscape();
    }
  };

  /* ── Layout ───────────────────────────────────────────────────── */

  // Every one of these attributes names an element by id, so all three follow
  // whether that element is on screen. `isCommand` is not that question: a line
  // like `/zzz` matches nothing and draws no listbox, and a minimised window
  // draws none either, and a combobox that claims to be expanded over a list
  // that is not in the document is a dangling reference an assistive
  // technology cannot follow. `listOpen` is the shell's answer to the real
  // question, which is whether the rows exist.
  const mentionsId = mentionListId(instanceId);
  const activeDescendant = menuOpen
    ? mentionOptionId(instanceId, selected)
    : (listOpen && completionId) || undefined;
  const expanded = Boolean(menuOpen || listOpen);
  const controls = menuOpen ? mentionsId : (listOpen ? LISTBOX_ID : undefined);
  return (
    <div className={`${styles.row} ${collapsed ? styles.rowCollapsed : ''}`} ref={rowRef} aria-busy={busy}>
      {showChrome && <><button
        type="button"
        className={styles.chrome}
        onClick={() => onCollapsedChange(!collapsed)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Restore the command bar' : 'Minimise the command bar'}
        title={collapsed ? 'Restore' : 'Minimise'}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          {collapsed ? <polyline points="6 15 12 9 18 15" /> : <polyline points="6 9 12 15 18 9" />}
        </svg>
      </button>

      <button
        type="button"
        className={`${styles.chrome} ${railOpen ? styles.chromeOn : ''}`}
        onClick={() => onRailOpenChange(!railOpen)}
        aria-pressed={railOpen}
        aria-label={railOpen ? 'Hide the conversations' : 'Show the conversations'}
        title={railOpen ? 'Hide conversations' : 'Show conversations'}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <line x1="9" y1="4" x2="9" y2="20" />
        </svg>
      </button>

      <button
        type="button"
        className={styles.chrome}
        onClick={onSplit}
        disabled={splitDisabled}
        aria-label="Split into another session"
        title={splitDisabled ? `Limit is ${maxSessions} sessions` : 'Split (⌘D)'}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <line x1="12" y1="4" x2="12" y2="20" />
        </svg>
      </button></>}

      {lead}

      <label className={styles.field} htmlFor={inputId}>
        <span className={styles.prompt} aria-hidden="true">
          {sessionNumber !== null && <span className={styles.promptSession}>{sessionNumber}</span>}
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </span>
        <span className={styles.inputWrap}>
          <textarea
            id={inputId}
            ref={inputRef}
            className={styles.fieldInput}
            rows={1}
            value={value}
            placeholder={placeholder}
            onChange={(e) => {
              setCaret(e.target.selectionStart ?? 0);
              onChange(e.target.value);
            }}
            onSelect={readCaret}
            onKeyDown={handleKeyDown}
            onFocus={onActivate}
            autoComplete="off"
            spellCheck={false}
            aria-label="Command bar"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={expanded}
            aria-controls={controls}
            aria-activedescendant={activeDescendant}
          />
          {/* Ghost text sits under the field showing what Tab would add. */}
          {ghost && (
            <span className={styles.completion} aria-hidden="true">
              <span className={styles.completionTyped}>{value}</span>
              {ghost}
            </span>
          )}

          {menuOpen && (
            <div
              className={styles.mentions}
              id={mentionsId}
              ref={listRef}
              role="listbox"
              aria-label={mention.sigil === '@' ? 'People' : 'Channels'}
            >
              {rows.map((row, i) => (
                <div
                  key={`${row.key}-${i}`}
                  id={mentionOptionId(instanceId, i)}
                  role="option"
                  aria-selected={i === selected}
                  className={`${styles.mention} ${i === selected ? styles.mentionActive : ''}`}
                  // Down rather than click, and prevented, so picking a name
                  // never takes focus off the line it is being typed into.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    accept(i);
                  }}
                  onMouseEnter={() => setSelected(i)}
                >
                  <span className={styles.mentionName}>{mention.sigil}{row.key}</span>
                  {row.hint && <span className={styles.mentionHint}>{row.hint}</span>}
                </div>
              ))}
            </div>
          )}
        </span>
      </label>

      {live}

      <button
        type="button"
        className={styles.send}
        onClick={onSubmit}
        disabled={!value.trim() || busy || (!canSend && !isCommand)}
        aria-label={`Send${targetLabel ? ` to ${targetLabel}` : ''}`}
        title="Send message"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 19V5M5 12l7-7 7 7" />
        </svg>
      </button>

    </div>
  );
}
