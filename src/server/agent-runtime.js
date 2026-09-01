'use strict';

/**
 * Provider-neutral agent orchestration.
 *
 * HTTP routes call this runtime; the runtime calls the inference gateway in
 * ./ai.js. Providers perform exactly one model turn. This layer owns the loop,
 * tool authorization, and normalized lifecycle events, so adding an API-backed
 * provider later does not leak provider-specific protocol into routes or UI.
 */

const DEFAULT_MAX_STEPS = 8;

const failure = (error, status = 502) => ({error, status});

function normalizeTools(tools) {
  if (tools instanceof Map) return new Map(tools);
  return new Map(Object.entries(tools ?? {}));
}

function toolResultMessage(call, output) {
  return {
    role: 'tool',
    toolCallId: call.id ?? null,
    name: call.name,
    content: typeof output === 'string' ? output : JSON.stringify(output),
  };
}

function createAgentRuntime({inference, tools = {}, maxSteps = DEFAULT_MAX_STEPS} = {}) {
  if (!inference?.complete || !inference?.stream) throw new TypeError('An inference gateway with complete() and stream() is required');
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new TypeError('maxSteps must be a positive integer');
  const registry = normalizeTools(tools);

  async function run(request = {}, {streaming = false} = {}) {
    const allowed = new Set(request.allowedTools ?? []);
    const messages = Array.isArray(request.messages)
      ? [...request.messages]
      : [{role: 'user', content: String(request.prompt ?? '')}];
    const onEvent = typeof request.onEvent === 'function' ? request.onEvent : () => {};
    const invoke = streaming ? inference.stream : inference.complete;

    for (let step = 0; step < maxSteps; step += 1) {
      if (request.signal?.aborted) return failure('The AI request was cancelled.', 499);
      onEvent({type: 'turn.started', step});

      const result = await invoke({
        ...request,
        // Existing local providers read prompt; future API providers should
        // consume messages and previousResponseId for structured continuation.
        prompt: step === 0 ? request.prompt : '',
        messages,
        onDelta: streaming ? text => {
          request.onDelta?.(text);
          onEvent({type: 'output_text.delta', step, text});
        } : undefined,
      });
      if (result?.error) {
        onEvent({type: 'turn.failed', step, error: result.error});
        return result;
      }

      const calls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
      if (!calls.length) {
        onEvent({type: 'turn.completed', step, usage: result?.usage ?? null});
        return result ?? {text: ''};
      }

      messages.push({
        role: 'assistant',
        content: result.text ?? '',
        toolCalls: calls,
      });

      for (const call of calls) {
        if (!call?.name || !allowed.has(call.name)) {
          return failure(`Agent is not allowed to use tool: ${call?.name || 'unknown'}`, 403);
        }
        const tool = registry.get(call.name);
        if (!tool?.execute) return failure(`Agent tool is not registered: ${call.name}`, 502);
        if (tool.authorize && !await tool.authorize({call, context: request.runtimeContext})) {
          return failure(`Agent is not authorized to use tool: ${call.name}`, 403);
        }

        onEvent({type: 'tool.started', step, call});
        let output;
        try {
          output = await tool.execute({
            arguments: call.arguments ?? {},
            context: request.runtimeContext,
            signal: request.signal,
          });
        } catch (error) {
          onEvent({type: 'tool.failed', step, call, error: error?.message || 'Tool failed'});
          return failure(error?.message || `Agent tool failed: ${call.name}`, 502);
        }
        onEvent({type: 'tool.completed', step, call, output});
        messages.push(toolResultMessage(call, output));
      }
    }

    return failure(`Agent exceeded the ${maxSteps}-step limit`, 508);
  }

  return Object.freeze({
    complete: request => run(request, {streaming: false}),
    stream: request => run(request, {streaming: true}),
    describe: () => ({
      ...inference.describe(),
      runtime: {maxSteps, tools: [...registry.keys()]},
    }),
  });
}

module.exports = {DEFAULT_MAX_STEPS, createAgentRuntime, toolResultMessage};
