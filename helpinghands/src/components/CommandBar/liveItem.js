/**
 * What the minimised command bar shows beside its prompt (LiveLine.js draws it).
 *
 * Minimised, the bar is one line, and it stays one line while you type and
 * send: only its open button makes it a window. So the line itself has to say
 * what is going on, the way a touch strip shows the controls for what is in
 * front of you. It says one thing, the most pressing:
 *
 *   1. the focused pane's answer, while it streams: its latest sentence;
 *   2. what the focused pane said while the window was shut and has not been
 *      seen: the first sentence of an answer, or a refusal;
 *   3. the newest message in any channel with something unread;
 *
 * and otherwise nothing, leaving the line to the prompt.
 *
 * Pure, so that the choice is tested apart from the components that draw it.
 */
import {entriesForTarget} from './useSessions.js';

/** How much of a sentence the line holds before it is cut. */
const LONGEST = 160;

/** `text` as a line can show it: markdown's marks and code blocks gone, whitespace folded. */
export function plainText(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+\.|>)\s+/gm, '')
    .replace(/[*_~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sentencesOf(text) {
  return plainText(text).split(/(?<=[.!?])\s+/).filter(Boolean);
}

/** The first sentence of `text`, cut at its end if it runs on. */
export function firstSentence(text) {
  const first = sentencesOf(text)[0] ?? '';
  return first.length > LONGEST ? `${first.slice(0, LONGEST - 1).trimEnd()}…` : first;
}

/**
 * The sentence being written at the end of `text`, cut at its start if it runs
 * on, because while an answer streams its newest words are the ones to read.
 * A sentence only just begun brings the one before it, so the line is never a
 * word or two.
 */
export function latestSentence(text) {
  const sentences = sentencesOf(text);
  let latest = sentences.at(-1) ?? '';
  if (latest.length < 24 && sentences.length > 1) latest = `${sentences.at(-2)} ${latest}`;
  return latest.length > LONGEST ? `…${latest.slice(-(LONGEST - 1)).trimStart()}` : latest;
}

/** The newest entry id in a pane's current transcript, which is what "seen" is measured against. */
export function newestEntryId(session) {
  const entries = entriesForTarget(session?.entries ?? [], session?.target);
  return entries.length ? entries.at(-1).id : 0;
}

/**
 * The one thing the line shows, or null.
 *
 * @param session  the focused pane
 * @param label    what the pane is pointed at, as the bar names it
 * @param seenUpTo the newest entry id of that pane that the reader has seen
 * @param notices  useChat's unread channels, newest first, without the ones dismissed
 */
export function liveItem({session, label, seenUpTo, notices}) {
  const entries = entriesForTarget(session.entries, session.target);

  if (session.busy) {
    const answer = entries.findLast(entry => entry.kind === 'output' && entry.pending);
    return {kind: 'streaming', who: label, text: answer?.text ? latestSentence(answer.text) : null};
  }

  if (session.sendError) return {kind: 'error', who: label, text: session.sendError};

  const unseen = entries.findLast(entry => entry.kind !== 'input' && entry.id > seenUpTo);
  if (unseen) {
    return {
      kind: unseen.kind === 'error' ? 'error' : 'reply',
      who: label,
      text: unseen.kind === 'output' ? firstSentence(unseen.text) : plainText(unseen.text),
    };
  }

  const [notice, ...rest] = notices;
  if (notice) {
    return {
      kind: 'message',
      channel: notice.channel,
      seq: notice.seq,
      author: notice.author,
      text: firstSentence(notice.body),
      more: rest.length,
    };
  }
  return null;
}
