import React, {useEffect, useRef} from 'react';
import {icons} from '@site/src/components/commands';
import styles from './completions.module.css';

/**
 * The slash menu: every command the typed verb could mean, best first.
 *
 * It is drawn as a table rather than as a list, because the reader is looking
 * for one of two things (a name they half remember, or a description of what
 * they want to do) and fixed columns let the eye run down whichever of them it
 * is. The usage column is the third thing worth knowing before pressing Tab:
 * whether the command wants an argument, and what kind. The list sits under the
 * panes and above the prompt, so it can never push the prompt out of the window.
 *
 * An icon arrives either as an element, from the site's own page commands, or
 * as a name, from a plugin or from the CLI's verbs. Naming is what lets those
 * two live in modules that must not contain JSX, so resolving the name is this
 * component's job.
 *
 * The rows are a listbox owned by the prompt input rather than by this element:
 * focus never leaves the input while the menu is open, so a screen reader is
 * told which row is current through the input's aria-activedescendant. That is
 * why the two ids below are literals. The composer writes the same two strings
 * into aria-controls and aria-activedescendant, and a different spelling in
 * either file silently breaks the announcement without breaking the layout.
 */

/** The listbox's id, which the composer names in aria-controls. */
export const LISTBOX_ID = 'cli-completions';

/** One row's id, which the composer names in aria-activedescendant. */
export const optionId = (index) => `cli-completion-${index}`;

const iconOf = (cmd) => (typeof cmd.icon === 'string' ? icons[cmd.icon] ?? icons.search : cmd.icon);

export default function Completions({matches, selected, query, dragging, onHover, onRun}) {
  const choice = matches[selected] ?? null;
  const listRef = useRef(null);

  // A bare '/' ranks every command the site has, and the list is capped and
  // scrolls. Focus never leaves the prompt, so nothing moves the scrollport on
  // the reader's behalf: without this, the arrows walk the highlight straight
  // out of sight and the row the input is naming to a screen reader is one
  // nobody can see. 'nearest' scrolls only when the row is actually outside.
  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({block: 'nearest'});
  }, [selected, matches]);

  return (
    <div className={`${styles.completions} ${dragging ? styles.completionsDragging : ''}`}>
      {matches.length > 0 ? (
        <div className={styles.list} ref={listRef} id={LISTBOX_ID} role="listbox" aria-label="Commands and choices">
          {matches.map((cmd, i) => (
            <button
              key={cmd.id}
              id={optionId(i)}
              type="button"
              role="option"
              aria-selected={i === selected}
              className={`${styles.item} ${i === selected ? styles.itemActive : ''}`}
              onClick={() => onRun(cmd)}
              onMouseEnter={() => onHover(i)}
            >
              <span className={styles.itemIcon}>{iconOf(cmd)}</span>
              <span className={styles.itemName}>{cmd.kind === 'argument' ? cmd.name : `/${cmd.name}`}</span>
              <span className={styles.itemUsage}>{cmd.kind === 'argument' && cmd.current ? '✓ current' : cmd.usage}</span>
              <span className={styles.itemDescription}>{cmd.description}</span>
              <span className={styles.itemCategory}>{cmd.category}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className={styles.empty}>
          no command matches <span className={styles.emptyQuery}>{query}</span>
        </div>
      )}

      {/* Pinned under the scrolling rows, so what the highlighted command
          expects stays readable however far down the list the cursor is. */}
      {choice && (
        <div className={styles.hint}>
          <span className={styles.hintCall}>
            {choice.kind === 'argument'
              ? choice.commandLine
              : `/${choice.name}${choice.usage ? ` ${choice.usage}` : ''}`}
          </span>
          <span className={styles.hintText}>
            {[choice.description, choice.available === false ? 'currently unavailable' : null]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
      )}
    </div>
  );
}
