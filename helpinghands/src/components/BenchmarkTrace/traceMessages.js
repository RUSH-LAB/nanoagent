/** Readable messages from the model gateway. The raw payload keeps every recorded field. */
const contentText = content => typeof content === 'string' ? content : Array.isArray(content) ? content
  .filter(part => ['text', 'input_text', 'output_text'].includes(part?.type))
  .map(part => part.text).filter(text => typeof text === 'string').join('\n') : '';

function json(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function inputMessages(payload, dialect) {
  const messages = [];
  const append = (role, content) => {
    const text = contentText(content);
    if (text) messages.push({role, text});
  };
  if (dialect === 'anthropic_messages') append('system', payload.system);
  if (dialect === 'responses') {
    append('instructions', payload.instructions);
    if (typeof payload.input === 'string') append('user', payload.input);
  }
  const items = dialect === 'responses' ? payload.input : payload.messages;
  if (Array.isArray(items)) {
    for (const item of items) {
      if (typeof item?.role === 'string') append(item.role, item.content);
    }
  }
  return messages;
}

function outputMessages(payload, dialect) {
  const assistant = content => {
    const text = contentText(content);
    return text ? [{role: 'assistant', text}] : [];
  };
  const tool = (name, input) => typeof name === 'string' && input != null
    ? [{role: `Tool call · ${name}`, text: typeof input === 'string' ? input : JSON.stringify(input, null, 2)}] : [];
  if (dialect === 'anthropic_messages') return Array.isArray(payload.content) ? payload.content.flatMap(part => part?.type === 'tool_use'
    ? tool(part.name, part.input) : assistant([part])) : [];
  if (dialect === 'responses') return Array.isArray(payload.output) ? payload.output.flatMap(item => {
    if (item?.type === 'function_call') return tool(item.name, item.arguments);
    return item?.type === 'message' ? assistant(item.content) : [];
  }) : [];
  return Array.isArray(payload.choices) ? payload.choices.flatMap(choice => {
    const message = choice?.message;
    return [...assistant(message?.content), ...(Array.isArray(message?.tool_calls)
      ? message.tool_calls.flatMap(call => tool(call?.function?.name, call?.function?.arguments)) : [])];
  }) : [];
}

function streamMessages(text, dialect) {
  // Blocks in the order they began: assistant text, and tool calls with the name and the argument text accumulated from their deltas.
  const blocks = new Map();
  const block = (key, type, name) => {
    if (!blocks.has(key)) blocks.set(key, {type, name, parts: []});
    const found = blocks.get(key);
    if (name && !found.name) found.name = name;
    return found;
  };
  const appendText = (key, content) => {
    if (typeof content === 'string' && content) block(`text:${key}`, 'text').parts.push(content);
  };
  const appendTool = (key, name, args) => {
    const found = block(`tool:${key}`, 'tool', name);
    if (typeof args === 'string') found.parts.push(args);
  };
  let completed = null;
  for (const frame of text.replace(/\r\n?/g, '\n').split('\n\n')) {
    const payload = json(frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n'));
    if (!payload) continue;
    if (dialect === 'anthropic_messages') {
      if (payload.type === 'content_block_start' && payload.content_block?.type === 'text') appendText(payload.index, payload.content_block.text);
      if (payload.type === 'content_block_start' && payload.content_block?.type === 'tool_use') appendTool(payload.index, payload.content_block.name);
      if (payload.type === 'content_block_delta' && payload.delta?.type === 'text_delta') appendText(payload.index, payload.delta.text);
      if (payload.type === 'content_block_delta' && payload.delta?.type === 'input_json_delta') appendTool(payload.index, null, payload.delta.partial_json);
    } else if (dialect === 'responses') {
      if (payload.type === 'response.output_text.delta') appendText(payload.output_index, payload.delta);
      if (payload.type === 'response.completed' && payload.response) completed = payload.response;
    } else if (Array.isArray(payload.choices)) {
      for (const choice of payload.choices) {
        appendText(choice?.index, choice?.delta?.content);
        for (const call of Array.isArray(choice?.delta?.tool_calls) ? choice.delta.tool_calls : []) appendTool(`${choice.index}:${call.index}`, call.function?.name, call.function?.arguments);
      }
    }
  }
  // The final response event holds the whole output, tool calls included, so it wins over the text deltas.
  if (completed && outputMessages(completed, dialect).length) return outputMessages(completed, dialect);
  return [...blocks.values()].map(({type, name, parts}) => (type === 'text' ? {role: 'assistant', text: parts.join('')}
    : {role: `Tool call · ${name}`, text: parts.join('')}));
}

// A streamed response is stored as the raw event stream; its `data:` or `event:` lines say so whatever the caller knew.
const isStream = text => /^\s*(data|event):/.test(text);

const DIALECTS = new Set(['chat_completions', 'responses', 'anthropic_messages']);

export function traceMessages(text, {dialect, response, stream}) {
  if (!DIALECTS.has(dialect)) return [];
  if (response && (stream || isStream(text))) return streamMessages(text, dialect);
  const payload = json(text);
  if (!payload || typeof payload !== 'object') return [];
  if (!response) return inputMessages(payload, dialect);
  return outputMessages(payload, dialect);
}
