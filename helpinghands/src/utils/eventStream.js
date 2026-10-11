export const SSE_CONTENT_TYPE = 'text/event-stream';

const FRAME_END = '\n\n';

export function takeEventFrames(buffer) {
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

export function parseEventFrame(frame) {
  let event = 'message';
  const data = [];
  for (const raw of frame.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
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

export async function readEvents(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const {value, done} = await reader.read();
    buffer += decoder.decode(value, {stream: !done});
    const taken = takeEventFrames(buffer);
    buffer = taken.rest;
    for (const frame of taken.frames) {
      const parsed = parseEventFrame(frame);
      if (parsed) onEvent(parsed);
    }
    if (done) return;
  }
}

export async function releaseBody(response) {
  try {
    await response.body?.cancel?.();
  } catch {
    // The stream already closed, which is the desired state.
  }
}
