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

const finite = value => Number.isFinite(value) && value >= 0;
const tokens = value => finite(value) ? Math.round(value).toLocaleString() : '—';
const seconds = value => finite(value) ? `${value < 0.1 ? value.toFixed(3) : value.toFixed(1)}s` : '—';
const dollars = value => finite(value) ? `$${value < 0.01 ? value.toFixed(6) : value.toFixed(4)}` : '—';
const telemetryCost = telemetry => telemetry?.metrics?.cost ?? telemetry?.cost;

function Stat({label, value, detail, accent = false}) {
  return (
    <div className={`${styles.stat} ${accent ? styles.statAccent : ''}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
      {detail && <span>{detail}</span>}
    </div>
  );
}

function TokenBreakdown({usage, compact = false}) {
  const input = usage?.prompt_tokens;
  const cached = usage?.cached_tokens;
  const cacheWrite = usage?.cache_write_tokens;
  const reasoning = usage?.reasoning_tokens;
  const output = usage?.completion_tokens;
  const uncached = finite(input)
    ? Math.max(0, input - (finite(cached) ? cached : 0) - (finite(cacheWrite) ? cacheWrite : 0))
    : null;
  return (
    <dl className={`${styles.tokenGrid} ${compact ? styles.tokenGridCompact : ''}`}>
      <Stat label="Input" value={tokens(input)} accent />
      <Stat label="Uncached" value={tokens(uncached)} />
      <Stat label="Cache read" value={tokens(cached)} />
      <Stat label="Cache write" value={tokens(cacheWrite)} />
      <Stat label="Output" value={tokens(output)} />
      <Stat label="Reasoning" value={tokens(reasoning)} />
    </dl>
  );
}

function TimingBreakdown({metrics}) {
  return (
    <dl className={styles.statGrid}>
      <Stat label="Model" value={seconds(metrics.model_s)} detail="inference" accent />
      <Stat label="Tools" value={seconds(metrics.tools_s)} detail="execution" />
      <Stat label="Overhead" value={seconds(metrics.overhead_s)} detail="agent runtime" />
    </dl>
  );
}

/** One answer's accounting summary, with its model/tool passes available on demand. */
function MessageMetrics({telemetry, conversationCost = null, showConversationCost = false}) {
  if (!telemetry) return null;
  const metrics = telemetry.metrics;
  const usage = metrics?.usage || telemetry.usage;
  const cost = telemetryCost(telemetry);
  if (!usage && !finite(cost) && !metrics) return null;
  const stepRows = Array.isArray(metrics?.steps) ? metrics.steps : [];
  return (
    <details className={styles.metrics}>
      <summary className={styles.metricsSummary}>
        <span className={styles.metricsTitle}>Response metrics</span>
        <span className={styles.summaryStat}><small>Response</small><b>{dollars(cost)}</b></span>
        {showConversationCost && (
          <span className={`${styles.summaryStat} ${styles.summaryTotal}`}>
            <small>Conversation</small><b>{dollars(conversationCost)}</b>
          </span>
        )}
        <span className={styles.summaryStat}><small>Tokens</small><b>{tokens(usage?.total_tokens)}</b></span>
        <span className={styles.summaryStat}><small>Time</small><b>{seconds(metrics?.duration_s)}</b></span>
        <span className={styles.summaryChevron} aria-hidden="true" />
      </summary>

      <div className={styles.metricsBody}>
        <section className={styles.metricSection}>
          <h4>Token usage</h4>
          <TokenBreakdown usage={usage} />
        </section>

        {metrics && (
          <section className={styles.metricSection}>
            <h4>Time</h4>
            <TimingBreakdown metrics={metrics} />
          </section>
        )}

        {stepRows.length > 0 && (
          <section className={styles.metricSection}>
            <h4>
              Agent passes <span>{stepRows.length}</span>
              <small>Each pass is one model/tool cycle</small>
            </h4>
            <ol className={styles.metricSteps}>
              {stepRows.map((step, index) => (
                <li key={`${step.step ?? index}-${index}`}>
                  <div className={styles.stepSummary}>
                    <span className={styles.stepNumber}>{step.step ?? index + 1}</span>
                    <b>Pass {step.step ?? index + 1}</b>
                    <span className={styles.stepMeta}>{dollars(step.cost)}</span>
                    <span className={styles.stepMeta}>{seconds(step.duration_s)}</span>
                  </div>
                  {stepRows.length > 1 && <TokenBreakdown usage={step.usage} compact />}

                  <div className={styles.calls}>
                    {(step.model_calls || []).map((call, callIndex) => (
                      <div className={styles.callCard} key={`model-${callIndex}`}>
                        <div className={styles.callHead}>
                          <span className={styles.callKind}>Model</span>
                          <b>{call.kind === 'compaction' ? 'Compaction' : `Call ${callIndex + 1}`}</b>
                          <span className={styles.callCost}>{dollars(call.cost)}</span>
                        </div>
                        <dl className={styles.callMetrics}>
                          <Stat label="First token" value={seconds(call.ttft_s)} />
                          <Stat label="Generation" value={seconds(call.generation_s)} />
                          <Stat
                            label="Throughput"
                            value={finite(call.output_tokens_per_second) ? `${call.output_tokens_per_second.toFixed(1)} tok/s` : '—'}
                          />
                        </dl>
                      </div>
                    ))}
                    {(step.tool_calls || []).map((call, callIndex) => (
                      <div className={`${styles.callCard} ${call.is_error ? styles.callFailed : ''}`} key={`tool-${callIndex}`}>
                        <div className={styles.callHead}>
                          <span className={styles.callKind}>Tool</span>
                          <b>{call.name}</b>
                          <span className={styles.callCost}>{seconds(call.duration_s)}</span>
                          {call.is_error && <span className={styles.metricError}>Failed</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    </details>
  );
}

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
  hasChat = false,
  onStartChat,
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
  const accountingByEntry = new Map();
  let conversationCost = 0;
  let meteredResponses = 0;
  entries.forEach((entry) => {
    const cost = telemetryCost(entry.telemetry);
    if (!finite(cost)) return;
    conversationCost += cost;
    meteredResponses += 1;
    accountingByEntry.set(entry, {
      conversationCost,
      showConversationCost: meteredResponses > 1,
    });
  });

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
            <h3>{agent?.name || 'Choose a chat'}</h3>
            <p>{agent?.description || 'Open an existing chat from the sidebar, or explicitly start a new one with an agent.'}</p>
            {agent && hasChat ? (
              <span className={styles.welcomeHint}>
                Type below to start &middot; <span className={shared.slash}>/</span> for commands &middot;{' '}
                <kbd className={shared.kbd}>&#8984;D</kbd> split view
              </span>
            ) : onStartChat ? (
              <button type="button" className={styles.createAgent} onClick={onStartChat}>Start a new chat</button>
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
                  {!entry.pending && (
                    <MessageMetrics
                      telemetry={entry.telemetry}
                      {...accountingByEntry.get(entry)}
                    />
                  )}
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
