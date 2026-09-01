import React, {useEffect, useState} from 'react';
import Markdown from './Markdown';
import shared from './shared.module.css';
import styles from './assistant.module.css';

/**
 * A pane pointed at the assistant: what has been typed into it and what came
 * back.
 *
 * The same scroll box a conversation uses, drawn from the same primitives, so a
 * split window holding a channel beside the assistant reads as one window
 * rather than two. What differs is only what a row means: here a line is either
 * something the reader typed, an answer, a note from the CLI itself, or a
 * refusal, and the kind is the whole of the styling.
 *
 * An answer is the one row rendered as markdown, because it is the one row
 * written by something that speaks markdown. A typed line, a note and a refusal
 * stay literal text: the reader typed the first, and turning an error message
 * into headings and emphasis would be dressing up the least trustworthy string
 * on the screen.
 *
 * An answer arrives a piece at a time, so its row exists before its text does.
 * While the row is still empty the pane shows the wait instead, with the
 * seconds counted out: the local provider can take five seconds to say its
 * first word, and unexplained silence reads as a hang. Once text is arriving,
 * the caret at its end is the only thing that has to say so. Both belong to
 * this component and neither survives a reload, which is exactly right: a
 * restored transcript is a finished one.
 *
 * Stopping that answer is this pane's control and nowhere else's. The prompt
 * row talks to whichever pane has focus, but a split window can leave a
 * background pane answering, so a stop in the row would be offering to cancel
 * the wrong request exactly when it mattered. Escape still cancels the focused
 * pane, and the row says so while one is working; the button here is the one
 * that can say which pane it means.
 *
 * An empty pane is where the window explains itself. It is the only place the
 * keys are written down, so it is worth the four lines it costs.
 *
 * The scroll box is a log, named and announced exactly as a conversation's is,
 * because a reader who cannot see the split has no other way to tell the two
 * panes apart. An answer arriving a token at a time is the one thing that must
 * not be read out as it grows, so its row is marked busy while it is being
 * written: the reader hears the whole answer once, when it is finished, rather
 * than a word at a time. The wait says itself in its own status region, with
 * the seconds hidden from it, since a counter that announced every tick would
 * be the same noise by another route.
 */

/* The wait is counted in whole seconds; anything finer would be a stopwatch,
   which is not the question the reader is asking. */
const TICK_MS = 1000;

/**
 * Seconds since `running` became true, and zero whenever it is not.
 *
 * The clock is the transcript's own and is deliberately not state anybody else
 * holds: it describes this pane's view of a wait, it is worthless a moment
 * after the wait ends, and a hook that ticks once a second in a store would
 * re-render the whole window every second.
 */
function useElapsedSeconds(running) {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!running) {
      setSeconds(0);
      return undefined;
    }
    const startedAt = Date.now();
    const timer = setInterval(
      // Measured against the clock rather than counted up, so a throttled
      // background tab comes back with the true elapsed time.
      () => setSeconds(Math.floor((Date.now() - startedAt) / TICK_MS)),
      TICK_MS,
    );
    return () => clearInterval(timer);
  }, [running]);

  return seconds;
}

export default function AssistantTranscript({
  session,
  agent = null,
  onCreateAgent,
  scrollProps,
  atBottom = true,
  onJumpToNewest,
  onCancel,
}) {
  const {entries, busy} = session;

  // At most one row is ever pending: it is the answer currently being written.
  // A row restored from localStorage cannot be one, because useSessions leaves
  // an in-flight row out of the snapshot and does not read the flag back, so a
  // reloaded window never shows a caret or a wait.
  const streaming = entries.find((entry) => entry.pending) ?? null;
  const waiting = busy && !streaming?.text;
  const seconds = useElapsedSeconds(waiting);

  return (
    <div className={shared.viewport}>
      <div
        className={shared.transcript}
        {...scrollProps}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Assistant transcript"
      >
        {/* Cleared while an answer is in flight is still not an idle pane, and
            the window should not offer its introduction over a live request. */}
        {entries.length === 0 && !busy && (
          <div className={styles.welcome}>
            <div className={`${styles.agentAvatar} ${styles[`agent_${agent?.color || 'violet'}`]}`}>
              {agent ? agent.name.slice(0, 1).toUpperCase() : '+'}
            </div>
            <h3>{agent?.name || 'Choose an agent'}</h3>
            <p>{agent?.description || 'Agents have a defined role and instructions. Select one from the sidebar, or create one for the way you work.'}</p>
            {agent ? (
              <span className={styles.welcomeHint}>
                Type below to start &middot; <span className={shared.slash}>/</span> for commands &middot;{' '}
                <kbd className={shared.kbd}>&#8984;D</kbd> split view
              </span>
            ) : onCreateAgent ? (
              <button type="button" className={styles.createAgent} onClick={onCreateAgent}>Create an agent</button>
            ) : null}
          </div>
        )}

        {entries.map((entry) => {
          // An answer with nothing in it yet would be a blank row above the
          // line that already explains the wait.
          if (entry.pending && !entry.text) return null;

          if (entry.kind === 'output') {
            const speaker = entry.agent || agent;
            return (
              <div
                key={entry.id}
                className={`${shared.entry} ${shared.output} ${styles.answer} ${entry.pending ? styles.streaming : ''}`}
                // Busy rather than silenced: the deltas rebuild this subtree
                // many times a second, and the log around it would read every
                // one of them out. Holding the announcement until the row
                // settles keeps the answer audible, which switching the live
                // region off here would not.
                aria-busy={entry.pending ? true : undefined}
              >
                <span className={`${styles.messageAvatar} ${styles[`agent_${speaker?.color || 'violet'}`]}`} aria-hidden="true">
                  {speaker ? speaker.name.slice(0, 1).toUpperCase() : 'A'}
                </span>
                <div className={styles.answerBody}>
                  <span className={styles.speaker}>{speaker?.name || 'Agent'}</span>
                  <Markdown text={entry.text} />
                </div>
              </div>
            );
          }

          return (
            <div key={entry.id} className={`${shared.entry} ${shared[entry.kind]} ${entry.kind === 'input' ? styles.question : ''}`}>
              {entry.kind === 'input' && <span className={styles.you}>You</span>}
              <span className={shared.entryText}>{entry.text}</span>
            </div>
          );
        })}

        {/* The one stop control in the window, and it belongs here rather than
            in the prompt row: the row talks to the focused pane, while a split
            window can leave a background pane answering, and the reader has to
            be able to stop the one they mean. In the transcript there is no
            question which one that is. */}
        {busy && (
          <div className={styles.status} role="status">
            {waiting && (
              <span className={styles.waiting}>
                thinking&hellip;
                {/* Seen, not heard: the count exists to prove the pane is alive
                    to someone watching it, and announcing a new number every
                    second would bury the answer that follows. */}
                <span aria-hidden="true">{seconds > 0 ? ` ${seconds}s` : ''}</span>
              </span>
            )}
            {onCancel && (
              <button
                type="button"
                className={styles.stop}
                onClick={onCancel}
                title="Stop this answer (Esc)"
              >
                stop
              </button>
            )}
          </div>
        )}
      </div>

      {/* The same pill a conversation draws, in the same corner, floating over
          the pane rather than riding the end of the scrolled content: see
          shared.module.css for why that is the better of the two. The caption
          is shorter than a conversation's because there is no count to give;
          an assistant pane has turns, not unread messages. */}
      {!atBottom && entries.length > 0 && onJumpToNewest && (
        <button
          type="button"
          className={shared.jump}
          onClick={onJumpToNewest}
          aria-label="Jump to the newest message"
        >
          newest <span aria-hidden="true">&darr;</span>
        </button>
      )}
    </div>
  );
}
