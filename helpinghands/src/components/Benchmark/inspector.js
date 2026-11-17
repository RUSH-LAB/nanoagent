/**
 * What the inspector shows for one span (a record of the stored span index): facts, token classes, values recorded inline, and
 * the payloads to fetch only once the span is selected (GET attempts/{id}/payloads/{sha256}). Every value is shown as text.
 */

const present = value => value !== null && value !== undefined && value !== '';

const USAGE = [['input', 'Input'], ['output', 'Output'], ['total', 'Total'], ['cache_read', 'Cache read'], ['cache_write', 'Cache write'], ['reasoning', 'Reasoning']];

/** Token classes of a model call: `{label, value}` with a null value for what the call did not report. */
export const tokenClasses = usage => (usage ? USAGE.map(([key, label]) => ({label, value: Number.isFinite(usage[key]) ? usage[key] : null})) : []);

const facts = (...pairs) => pairs.filter(([, value]) => present(value)).map(([label, value]) => ({label, value: typeof value === 'object' ? JSON.stringify(value) : String(value)}));
const payloads = (...pairs) => pairs.filter(([, sha]) => present(sha)).map(([label, sha, note]) => ({label, sha, note: note ?? null}));
const inline = (...pairs) => pairs.filter(([, value]) => present(value)).map(([label, value]) => ({label, value}));

/**
 * `{title, facts, tokens, inline, payloads}` for `span`. A tool call shows its proposal and its observed invocation apart:
 * `adapted` marks arguments the broker changed from what the model proposed. A command shows argv, cwd and exit evidence.
 */
export function describeSpan(span) {
  const a = span.attributes ?? {};
  const provenance = span.provenance === 'harness_reported' ? 'harness_reported (the harness said so; RUSH did not observe it)' : span.provenance;
  const common = facts(['Kind', span.kind], ['Scope', span.scope], ['Status', span.status], ['Provenance', provenance]);
  const head = {title: span.name, tokens: [], inline: [], payloads: []};
  switch (span.kind) {
    case 'model_call':
      return {
        ...head,
        facts: [...common, ...facts(['Dialect', a.dialect], ['Outcome', a.terminal], ['HTTP status', a.http_status], ['Streamed', a.stream], ['Provider', a.provider], ['Resolved model', a.resolved_model],
          ['Finish reason', a.finish_reason], ['Generation', a.generation_id], ['Response', a.response_id], ['Error', a.error], ['Rejected', a.rejected])],
        tokens: tokenClasses(a.usage),
        payloads: payloads(['Submitted request', a.submitted_request_sha256], ['Effective request', a.effective_request_sha256], ['Response', a.response_sha256], ['Stream frames', a.frames_sha256]),
      };
    case 'proposal':
      return {
        ...head, title: `Proposal: ${span.name}`,
        facts: [...common, ...facts(['Tool call', a.tool_call_id], ['Proposed before the stream ended', a.early], ['Arguments error', a.arguments_error])],
        inline: inline(['Proposed arguments', a.arguments], ['Raw arguments', a.raw_arguments]),
      };
    case 'tool':
      return {
        ...head, title: `Invocation: ${span.name}`,
        facts: [...common, ...facts(['Call', a.call_id], ['Writes workspace', a.writes], ['Adapted from its proposal', a.adapted], ['Error', a.error], ['Rejected', a.rejected])],
        inline: inline(['Cause', a.cause], ['Adaptation', a.adaptation]),
        payloads: payloads(['Observed arguments', a.arguments_sha256], ['Result', a.output_sha256]),
      };
    case 'command':
      return {
        ...head, title: `Command: ${Array.isArray(a.argv) ? a.argv.join(' ') : span.name}`,
        facts: [...common, ...facts(['Request', a.request_id], ['Launch', a.launch_id], ['Working directory', a.cwd], ['Error', a.error], ['Rejected', a.rejected])],
        inline: inline(['argv', a.argv], ['Exit', a.termination]),
        payloads: payloads(['stdout', a.stdout_sha256, a.stdout_truncated ? 'truncated' : null], ['stderr', a.stderr_sha256, a.stderr_truncated ? 'truncated' : null]),
      };
    default:
      return {...head, facts: [...common, ...facts(['Target', span.target])], inline: inline(['Attributes', a])};
  }
}

const DISPLAY_LIMIT = 200_000;

/** A fetched payload as text to show, as recorded (re-serializing JSON would round integers past 2^53), cut at a display limit. */
export function payloadView(text, redaction = 'none') {
  const cut = text.length > DISPLAY_LIMIT;
  return {text: cut ? text.slice(0, DISPLAY_LIMIT) : text, redaction, cut, length: text.length};
}

/** A note about what a payload's redaction status means. */
export const redactionNote = redaction => (redaction === 'redacted' ? 'Credentials or private material were removed before it was stored.' : redaction === 'truncated' ? 'Stored cut short; the rest was not kept.' : null);
