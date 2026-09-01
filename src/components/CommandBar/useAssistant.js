/**
 * The assistant turn: asking, watching the answer arrive, and being able to
 * stop watching.
 *
 * Everything about how an answer arrives is behind this hook, and nothing
 * outside it knows the endpoint, the wire format, the context window or the
 * abort controller. The pane only ever sees entries appear and grow, which is
 * what let the transport change from one buffered POST to a stream without a
 * line moving in Shell.js.
 *
 * The answer is streamed from /api/ai/stream as server-sent events, because a
 * local provider can take five seconds to produce its first token and a window
 * that says nothing for five seconds reads as a broken one. TCP hands us bytes,
 * not frames: a chunk can end in the middle of a JSON payload, so the decoded
 * text is buffered and only whole frames, the ones terminated by a blank line,
 * are parsed. Assuming a chunk is a frame works on a laptop and fails over a
 * real network.
 *
 * A server that predates the streaming endpoint answers 404, and a proxy that
 * has swallowed the event stream answers something that is not
 * text/event-stream. Both fall back to the buffered /api/ai/complete, so an old
 * deployment keeps working and only loses the typing effect.
 *
 * A request belongs to the pane it was asked in, not to the window, so the
 * controllers are keyed by session id. A split window can have three answers in
 * flight, and cancelling one must not touch the other two. Cancelling keeps
 * what had already arrived and marks it: half an answer is usually still worth
 * reading, and throwing it away punishes the reader for being impatient.
 */
import {useCallback, useEffect, useRef} from 'react';
import API_BASE, {apiFetch} from '@site/src/utils/api';

/* How much transcript rides along as context on a turn. The server sanitizes
   both prompt and context with sanitizeText, which truncates at 10000
   characters, so raising CONTEXT_CHARS past that would only pay to send bytes
   the server drops. */
const CONTEXT_TURNS = 12;
const CONTEXT_CHARS = 8000;

/** What a cancelled answer is marked with, rather than being thrown away. */
const INTERRUPTED = '(interrupted)';

/* The event stream's own grammar: a blank line ends a frame, and a line
   beginning with a colon is a comment, which is what the server's heartbeat
   is. */
const FRAME_END = '\n\n';
const SSE_CONTENT_TYPE = 'text/event-stream';

/* What a pane says when the provider answered with nothing at all. */
const EMPTY_ANSWER = 'no response generated';

/* ── The wire ───────────────────────────────────────────────────── */

/**
 * Cut whole frames out of the decoded buffer, and hand back what is left.
 *
 * The remainder is the point of this function: it is the half frame that the
 * next chunk completes. Callers must keep it and prepend it to the next decode.
 */
function takeFrames(buffer) {
  const frames = [];
  let rest = buffer;
  let end = rest.indexOf(FRAME_END);
  while (end !== -1) {
    frames.push(rest.slice(0, end));
    rest = rest.slice(end + FRAME_END.length);
    end = rest.indexOf(FRAME_END);
  }
  return {frames, rest};
}

/**
 * One frame as `{event, data}`, or null when there is nothing in it to act on.
 *
 * Comments (the heartbeat) and fields we do not use are skipped rather than
 * treated as an error, which is what the format asks of a client. A `data:`
 * payload that is not JSON is dropped for the same reason: a frame the client
 * cannot read must not end the answer that the following frames carry.
 */
function parseFrame(frame) {
  let event = 'message';
  const data = [];
  for (const raw of frame.split('\n')) {
    // Tolerate CRLF: the server writes bare newlines, but the format allows
    // either and a proxy may rewrite them.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // One optional space after the colon belongs to the framing, not the value.
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length) return null;
  try {
    return {event, data: JSON.parse(data.join('\n'))};
  } catch {
    return null;
  }
}

/** Read a response body to its end, calling `onEvent` for every whole frame. */
async function readEvents(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const {value, done} = await reader.read();
    // `stream` keeps a multi-byte character that straddles two chunks whole
    // instead of decoding half of it into a replacement character.
    buffer += decoder.decode(value, {stream: !done});
    const taken = takeFrames(buffer);
    buffer = taken.rest;
    for (const frame of taken.frames) {
      const parsed = parseFrame(frame);
      if (parsed) onEvent(parsed);
    }
    if (done) return;
  }
}

/** Let go of a body we will not read: a stream nobody reads holds its socket. */
async function releaseBody(res) {
  try {
    await res.body?.cancel?.();
  } catch {
    /* already closed, which is the state we wanted it in */
  }
}

/** The buffered endpoint, as `{text}` or `{error}`. */
async function postComplete(payload, signal) {
  const res = await apiFetch(`${API_BASE}/api/ai/complete`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
    signal,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) return {error: data?.error || `request failed (${res.status})`};
  return {text: data?.text || ''};
}

/* ── The hook ───────────────────────────────────────────────────── */

/**
 * @param sessions the object returned by useSessions; every line this hook
 *                 writes goes through it, so the panes stay the one store.
 */
export default function useAssistant(sessions) {
  const {sessions: list, append, patch, updateEntry} = sessions;

  // Read at call time rather than captured, so `ask` does not have to be
  // rebuilt every time a pane changes.
  const listRef = useRef(list);
  listRef.current = list;

  const controllers = useRef({});

  // The window can go away with answers still arriving: a route change, a sign
  // out, a closed tab. Nothing else lets go of those requests, and the server
  // only stops working when the client hangs up (routes/ai.js aborts on the
  // response closing), so a window that leaves without aborting leaves a
  // provider running for nobody.
  useEffect(() => () => {
    for (const controller of Object.values(controllers.current)) controller.abort();
    controllers.current = {};
  }, []);

  const busy = useCallback(
    (sessionId) => Boolean(listRef.current.find((s) => s.id === sessionId)?.busy),
    [],
  );

  const cancel = useCallback((sessionId) => {
    const controller = controllers.current[sessionId];
    if (!controller) return;
    delete controllers.current[sessionId];
    controller.abort();
  }, []);

  const ask = useCallback(async (sessionId, text, agent = null) => {
    // Prior turns ride as `context` and the new line as `prompt`, which is the
    // shape the endpoint already composes into a single message. Read before
    // the line is appended, or the question would be in its own context.
    const priorEntries = listRef.current.find((s) => s.id === sessionId)?.entries ?? [];
    const context = priorEntries
      .slice(-CONTEXT_TURNS)
      .map((e) => `${e.kind === 'input' ? 'User' : 'Assistant'}: ${e.text}`)
      .join('\n\n')
      .slice(-CONTEXT_CHARS);

    append(sessionId, 'input', text);
    // The answer's row is opened empty and marked pending, and every delta is
    // written into that one row. The transcript draws a caret on a pending row
    // and shows the wait in place of an empty one; nothing else has to know
    // that an answer is arriving in pieces.
    const entryId = append(sessionId, 'output', '', agent ? {
      agent: {id: agent.id, name: agent.name, color: agent.color},
    } : {});
    updateEntry(sessionId, entryId, {pending: true});
    patch(sessionId, {busy: true});

    const controller = new AbortController();
    controllers.current[sessionId] = controller;

    const payload = context ? {prompt: text, context} : {prompt: text};
    if (agent?.instructions) {
      payload.agent = {name: agent.name, instructions: agent.instructions};
    }
    let answer = '';
    let failure = null;
    let interrupted = false;

    const write = (next) => {
      answer = next;
      updateEntry(sessionId, entryId, {text: answer});
    };

    try {
      const res = await apiFetch(`${API_BASE}/api/ai/stream`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const contentType = res.headers?.get?.('content-type') ?? '';

      // A readable body is part of the question: a browser without streaming
      // responses has to take the buffered path too, and asking for a reader
      // that is not there would surface as a network failure.
      const streamed = res.ok
        && contentType.includes(SSE_CONTENT_TYPE)
        && typeof res.body?.getReader === 'function';

      if (streamed) {
        let closed = false;
        await readEvents(res, ({event, data}) => {
          if (event === 'delta') {
            if (typeof data?.text === 'string') write(answer + data.text);
          } else if (event === 'done') {
            // The done frame carries the whole answer, which is the authority:
            // a provider that never emitted a delta still answers here.
            closed = true;
            if (typeof data?.text === 'string' && data.text) write(data.text);
          } else if (event === 'error') {
            closed = true;
            failure = data?.error || `request failed (${data?.status ?? 502})`;
          }
        });
        // A stream that simply stopped is a dropped connection, not an answer,
        // and saying so is the difference between a truncated reply and a
        // reply the reader believes is complete.
        if (!closed && !failure) {
          failure = answer
            ? 'the connection closed before the answer finished'
            : 'the assistant closed the connection without answering';
        }
      } else if (res.status === 404 || res.ok) {
        // Either a server from before this endpoint existed, or something in
        // front of it that does not pass an event stream through. The buffered
        // endpoint takes exactly the same body and gives the same answer, one
        // piece at the end. A refusal (a 401, a 429, a 400) is the server
        // answering rather than the server lacking the route, so it is
        // reported below instead of being asked twice.
        //
        // The unread body is released first: an event stream nobody reads
        // stays open, and the socket with it.
        await releaseBody(res);
        const result = await postComplete(payload, controller.signal);
        if (result.error) failure = result.error;
        else write(result.text);
      } else {
        const data = await res.json().catch(() => null);
        failure = data?.error || `request failed (${res.status})`;
      }
    } catch (err) {
      // Being cancelled is not a failure, and saying so where the reason for
      // the silence goes is how the pane stays honest about what happened.
      if (err?.name === 'AbortError') interrupted = true;
      else failure = 'could not reach the API server';
    } finally {
      if (controllers.current[sessionId] === controller) delete controllers.current[sessionId];

      if (interrupted) {
        // The marker goes into the answer itself so it survives the reload
        // that useSessions gives it for free. With nothing to mark, the row
        // becomes the note it would otherwise be: an empty answer is not one.
        if (answer) updateEntry(sessionId, entryId, {text: `${answer}\n\n${INTERRUPTED}`, pending: false});
        else updateEntry(sessionId, entryId, {kind: 'system', text: INTERRUPTED, pending: false});
      } else if (failure) {
        // A failure after some of the answer arrived is a second line, not a
        // rewrite: what did arrive is still worth reading.
        if (answer) {
          updateEntry(sessionId, entryId, {pending: false});
          append(sessionId, 'error', failure);
        } else {
          updateEntry(sessionId, entryId, {kind: 'error', text: failure, pending: false});
        }
      } else {
        updateEntry(sessionId, entryId, {text: answer || EMPTY_ANSWER, pending: false});
      }

      patch(sessionId, {busy: false});
    }
  }, [append, patch, updateEntry]);

  return {ask, cancel, busy};
}
