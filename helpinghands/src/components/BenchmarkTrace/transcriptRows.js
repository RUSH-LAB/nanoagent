import {actionSpans, byStart, big} from './traceModel.js';
import {traceMessages} from './traceMessages.js';

const TRANSCRIPT_KINDS = new Set(['model_call', 'proposal', 'tool', 'command', 'process']);

/** What a row is called: a process's `title`, else an argv, else the span's name. */
export const spanLabel = span => span.attributes?.title ?? (Array.isArray(span.attributes?.argv) ? span.attributes.argv.join(' ') : span.name);

/** The transcript, one row per model call, proposal, tool, command and process in time order: `{id, kind, name, span, duration, tokens, cost}`. `costs` maps a call_id to its settled cost (from /accounting). */
export function transcriptRows(model, costs = new Map()) {
  return actionSpans(model).filter(span => TRANSCRIPT_KINDS.has(span.kind)).sort(byStart).map(span => {
    const start = big(span.start_ns);
    const end = big(span.end_ns);
    const usage = span.attributes?.usage;
    return {
      id: span.id, kind: span.kind, name: spanLabel(span), span,
      duration: start === null || end === null || end < start ? null : Number(end - start) / 1e6,
      tokens: Number.isFinite(usage?.total) ? usage.total : null,
      cost: costs.get(span.attributes?.call_id) ?? null,
    };
  });
}

/** The one-line preview of a model call: the first line of its reply, from the response payload's text. */
export function replyPreview(text, {dialect, stream}) {
  const messages = traceMessages(text, {dialect, response: true, stream});
  const reply = messages.find(message => message.role === 'assistant') ?? messages[0];
  return reply?.text.trim().split('\n')[0] ?? '';
}
