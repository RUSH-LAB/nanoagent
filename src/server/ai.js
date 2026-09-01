/**
 * Where a completion comes from.
 *
 * Three providers sit behind one interface. Hosted Anthropic remains for
 * compatibility; local product development can choose Claude Code or Codex per
 * workspace agent.
 *
 *   api          POST to api.anthropic.com with ANTHROPIC_API_KEY. What a
 *                deployed site uses: cheap per turn, fast, and stateless.
 *   claude-code  Run the `claude` CLI already installed and signed in on this
 *                machine. What a laptop uses: no key to obtain, because it
 *                borrows the authentication Claude Code set up, whether that is
 *                a subscription or a gateway.
 *   codex        Run `codex exec` non-interactively with an ephemeral session
 *                in the same isolated work directory.
 *
 * `AI_PROVIDER` picks one. Left unset, the key wins if there is one and the CLI
 * is the fallback, so a machine with Claude Code installed works with no
 * configuration at all and a server with a key never shells out.
 *
 * The CLI provider is development-only, and not by accident. It runs a local
 * program holding this machine's credentials, at the request of whoever can
 * reach the endpoint. That is fine when the caller is you on localhost and
 * unacceptable when it is the internet, so it refuses to start in production.
 */
const {execFile, spawn} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/** The model to ask for. An alias the CLI also understands. */
const MODEL = process.env.AI_MODEL || 'claude-sonnet-4-6';
/** The alias form, for the CLI, which takes short names. */
const CLI_MODEL = process.env.AI_MODEL_ALIAS || 'sonnet';
/** Optional: without this, Codex uses the model selected by its installation. */
const CODEX_MODEL = process.env.CODEX_AI_MODEL || null;
const CLAUDE_EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'].includes(process.env.CLAUDE_AI_EFFORT)
  ? process.env.CLAUDE_AI_EFFORT
  : 'low';
const CODEX_REASONING_EFFORT = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(process.env.CODEX_AI_REASONING_EFFORT)
  ? process.env.CODEX_AI_REASONING_EFFORT
  : 'none';

const MAX_TOKENS = 1024;

/** The direct API answers in a second or two; the CLI spends five starting up. */
const API_TIMEOUT_MS = 15_000;
const CLI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 60_000;

/**
 * How long a started stream may go silent before it counts as dead.
 *
 * The timeouts above bound how long the answer may take to begin, which is the
 * wrong question once tokens are arriving: a long answer is not a stuck one.
 * What a reader cannot sit through is silence, so the body gets its own budget
 * and every chunk renews it.
 *
 * Both transports work this way, each renewing on the first thing it has that
 * means the answer is under way: the API stream on every read from the socket,
 * the CLI on every delta. The CLI cannot use its own first byte, because it
 * prints a start-up record the instant it launches and thinking time follows
 * that; counting it would cut the budget for a slow first word from the
 * deadline above to this one.
 */
const STREAM_IDLE_MS = 30_000;

/**
 * The refusals both transports can produce, worded once. A caller distinguishes
 * them by status, and a person reads the same sentence whichever provider
 * answered.
 */
const TIMED_OUT = 'The AI request timed out. Please try again.';
const CANCELLED = 'The AI request was cancelled.';
const BUSY = 'The assistant is busy with another request. Try again in a moment.';
const UPSTREAM_ERROR = 'The AI service returned an error. Please try again.';

/** The status for a request the caller abandoned: nginx's, and no worse for it. */
const CANCELLED_STATUS = 499;

/** A reply larger than this is a runaway, not an answer. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * How many CLI runs may be in flight at once.
 *
 * Each one is a whole Claude Code process, a couple of hundred megabytes of it,
 * so an unbounded endpoint is a way to bring the laptop down from a browser tab.
 * The rate limiter counts requests per minute, which does not bound how many
 * are running at the same moment; this does.
 */
const MAX_CONCURRENT_CLI = Number(process.env.AI_MAX_CONCURRENT) || 2;
let running = 0;

/**
 * Tools the CLI must not have.
 *
 * This endpoint answers a text box on a web page, so a completion has no
 * business reading files or running commands, and the request that asks it to
 * is either a mistake or an attack. Named explicitly rather than trusting the
 * default permission behaviour, because the read-only tools do not prompt.
 */
const FORBIDDEN_TOOLS = Object.freeze([
  'Bash', 'Read', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch',
  'Glob', 'Grep', 'Task', 'TodoWrite', 'Agent',
]);

/**
 * Where the CLI runs.
 *
 * Not the repository. Claude Code reads CLAUDE.md, settings, and hooks from the
 * working directory and its parents, so running it here would hand the site's
 * assistant this project's instructions and machinery. An empty directory of
 * its own gives it neither, and leaves nothing nearby to find.
 */
function workdir() {
  const dir = process.env.AI_WORKDIR || path.join(os.homedir(), '.mochi-lab', 'ai');
  fs.mkdirSync(dir, {recursive: true});
  return dir;
}

/** Whether the `claude` CLI is on PATH, checked once. */
let cliPath;
function findCli() {
  if (cliPath !== undefined) return cliPath;
  const explicit = process.env.CLAUDE_CLI_PATH;
  if (explicit) {
    cliPath = fs.existsSync(explicit) ? explicit : null;
    return cliPath;
  }
  const dirs = (process.env.PATH || '').split(path.delimiter);
  cliPath = dirs.map(d => path.join(d, 'claude')).find(p => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  }) ?? null;
  return cliPath;
}

/** Whether the `codex` CLI is on PATH, checked once. */
let codexCliPath;
function findCodexCli() {
  if (codexCliPath !== undefined) return codexCliPath;
  const explicit = process.env.CODEX_CLI_PATH;
  if (explicit) {
    codexCliPath = fs.existsSync(explicit) ? explicit : null;
    return codexCliPath;
  }
  const dirs = (process.env.PATH || '').split(path.delimiter);
  codexCliPath = dirs.map(dir => path.join(dir, 'codex')).find(candidate => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) ?? null;
  return codexCliPath;
}

/**
 * Which provider will answer, or why none will. Decided per call rather than at
 * load, so setting a key and restarting nothing still works in development.
 */
function resolveProvider({
  env = process.env,
  hasCli = Boolean(findCli()),
  hasCodex = Boolean(findCodexCli()),
  isProduction = IS_PRODUCTION,
  requested = null,
} = {}) {
  const configured = env.AI_PROVIDER;
  const asked = requested || configured;
  const hasKey = Boolean(env.ANTHROPIC_API_KEY);

  if (configured === 'off') return {error: 'The AI assistant is switched off (AI_PROVIDER=off).'};
  if (asked === 'api') {
    return hasKey ? {provider: 'api'} : {error: 'AI_PROVIDER=api, but ANTHROPIC_API_KEY is not set.'};
  }
  if (asked === 'claude-code') {
    if (isProduction) return {error: 'The claude-code provider is for development only and will not run in production.'};
    return hasCli ? {provider: 'claude-code'} : {error: 'AI_PROVIDER=claude-code, but no `claude` command was found on PATH.'};
  }
  if (asked === 'codex') {
    if (isProduction) return {error: 'The codex provider is for development only and will not run in production.'};
    return hasCodex ? {provider: 'codex'} : {error: 'The Codex CLI is not installed or not available on PATH.'};
  }

  if (hasKey) return {provider: 'api'};
  if (hasCodex && !isProduction) return {provider: 'codex'};
  if (hasCli && !isProduction) return {provider: 'claude-code'};
  return {
    error: 'No AI provider is available. Install and sign in to Claude Code or Codex for local development.',
  };
}

/* ── The direct API ───────────────────────────────────────────────── */

async function completeWithApi({prompt, system}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{role: 'user', content: prompt}],
        ...(system ? {system} : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') return {error: TIMED_OUT, status: 504};
    return {error: 'Could not reach the AI service.', status: 502};
  } finally {
    clearTimeout(timer);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) return {error: UPSTREAM_ERROR, status: 502};
  return {text: data.content?.[0]?.text || 'No response generated'};
}

/* ── The local CLI ────────────────────────────────────────────────── */

/**
 * The command line, built in one place so the safety flags are visible
 * together and can be tested without running anything.
 *
 * `stream` swaps the single JSON reply for a record per event. The CLI refuses
 * `stream-json` under `--print` without `--verbose`, and emits the partial
 * message events a caller wants to show as they arrive only when asked to, so
 * the three flags travel together.
 */
function cliArgs({prompt, system, stream = false}) {
  return [
    '--print', prompt,
    '--output-format', stream ? 'stream-json' : 'json',
    ...(stream ? ['--include-partial-messages', '--verbose'] : []),
    '--model', CLI_MODEL,
    '--effort', CLAUDE_EFFORT,
    // Nothing this endpoint does should end up in the session history of the
    // person whose Claude Code this is.
    '--no-session-persistence',
    // No MCP servers: --strict-mcp-config with no --mcp-config means none.
    '--strict-mcp-config',
    '--disallowedTools', FORBIDDEN_TOOLS.join(' '),
    ...(system ? ['--system-prompt', system] : []),
  ];
}

/** A non-interactive, ephemeral Codex run with no writable filesystem. */
function codexArgs({prompt, system}) {
  const request = [
    system,
    'Answer the user directly. Do not inspect files, run commands, or use tools.',
    `User request:\n${prompt}`,
  ].filter(Boolean).join('\n\n');
  return [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--config', `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`,
    '--sandbox', 'read-only',
    '--skip-git-repo-check',
    '--color', 'never',
    ...(CODEX_MODEL ? ['--model', CODEX_MODEL] : []),
    '--cd', workdir(),
    request,
  ];
}

/**
 * Read what the CLI printed.
 *
 * It writes JSON to stdout and its banner to stderr, so anything unparseable on
 * stdout means it stopped before answering, which has a reason worth passing on
 * rather than a generic failure.
 */
function parseCliOutput(stdout) {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    const first = String(stdout).trim().split('\n')[0] || '';
    return {error: `The Claude CLI did not return a result${first ? `: ${first.slice(0, 200)}` : '.'}`, status: 502};
  }
  if (payload.is_error || payload.subtype !== 'success') {
    return {error: `The Claude CLI reported: ${payload.subtype || 'an error'}`, status: 502};
  }
  return {text: payload.result || 'No response generated'};
}

function completeWithClaudeCode({prompt, system}) {
  if (running >= MAX_CONCURRENT_CLI) {
    return Promise.resolve({error: BUSY, status: 503});
  }
  running += 1;
  return new Promise((resolve) => {
    execFile(
      findCli(),
      cliArgs({prompt, system}),
      {
        cwd: workdir(),
        timeout: CLI_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_OUTPUT_BYTES,
        // The CLI is interactive by nature and checks for a terminal; without
        // this it can wait on one that is never coming.
        env: {...process.env, CI: '1'},
      },
      (err, stdout) => {
        running -= 1;
        if (err && err.killed) return resolve({error: TIMED_OUT, status: 504});
        if (err && !stdout) return resolve({error: `The Claude CLI failed: ${err.message.split('\n')[0]}`, status: 502});
        resolve(parseCliOutput(stdout));
      },
    );
  });
}

/* ── Reading an answer as it is written ───────────────────────────── */

/**
 * Split an arriving byte stream into lines.
 *
 * Neither transport promises that a chunk ends on a line boundary: a JSON
 * payload routinely lands split across two reads, and parsing half of one would
 * silently drop the text it carried. Holding the remainder back until its
 * newline turns up is the whole job. `end()` releases a last line that arrived
 * without one.
 */
function createLineParser(onLine) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
      }
    },
    end() {
      if (!buffer) return;
      const last = buffer;
      buffer = '';
      onLine(last);
    },
  };
}

/**
 * Server-sent events, reduced to the one field that matters. `event:` lines are
 * ignored on purpose: the payload names its own type, so trusting the payload
 * means one thing to parse rather than two to keep in step.
 */
function createSseParser(onPayload) {
  return createLineParser((line) => {
    if (!line.startsWith('data:')) return;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') return;
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    onPayload(payload);
  });
}

/** The CLI's shape: one JSON record per line, anything unparseable skipped. */
function createNdjsonParser(onRecord) {
  return createLineParser((line) => {
    const raw = line.trim();
    if (!raw) return;
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      return;
    }
    onRecord(record);
  });
}

/**
 * The text a streamed record adds, or null when it adds none.
 *
 * Both providers carry the same `content_block_delta`; the CLI wraps it in a
 * `stream_event` record, so unwrapping that first leaves one question to ask.
 * A thinking delta has no `text`, which is why the field is checked rather
 * than assumed.
 */
function streamEventText(record) {
  const event = record?.type === 'stream_event' ? record.event : record;
  if (event?.type !== 'content_block_delta') return null;
  const text = event.delta?.text;
  return typeof text === 'string' && text ? text : null;
}

/** The completed assistant message emitted by `codex exec --json`. */
function codexRecordText(record) {
  if (record?.type !== 'item.completed' || record.item?.type !== 'agent_message') return null;
  const text = record.item.text;
  return typeof text === 'string' && text ? text : null;
}

async function streamWithApi({prompt, system, onDelta, signal}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, {once: true});

  let timer = setTimeout(abort, API_TIMEOUT_MS);
  // Each chunk buys another idle window: a stream still arriving is not stuck.
  const renewIdle = () => {
    clearTimeout(timer);
    timer = setTimeout(abort, STREAM_IDLE_MS);
  };
  // An abort is the caller's if the caller's signal is the one that fired, and
  // otherwise one of the timers above ran out. Same event, two different things
  // to tell the person waiting.
  const whyAborted = () => (signal?.aborted
    ? {error: CANCELLED, status: CANCELLED_STATUS}
    : {error: TIMED_OUT, status: 504});

  try {
    let response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          stream: true,
          messages: [{role: 'user', content: prompt}],
          ...(system ? {system} : {}),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') return whyAborted();
      return {error: 'Could not reach the AI service.', status: 502};
    }

    if (!response.ok) return {error: UPSTREAM_ERROR, status: 502};
    const reader = response.body?.getReader?.();
    if (!reader) return {error: UPSTREAM_ERROR, status: 502};

    let text = '';
    const parser = createSseParser((payload) => {
      const delta = streamEventText(payload);
      if (delta === null) return;
      text += delta;
      onDelta?.(delta);
    });

    const decoder = new TextDecoder();
    renewIdle();
    try {
      for (;;) {
        const {value, done} = await reader.read();
        if (done) break;
        renewIdle();
        parser.push(decoder.decode(value, {stream: true}));
      }
      parser.end();
    } catch (err) {
      if (err.name === 'AbortError') return whyAborted();
      return {error: UPSTREAM_ERROR, status: 502};
    }
    return {text: text || 'No response generated'};
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

/**
 * The same CLI run as the buffered path, read line by line instead of at the
 * end. `spawn` rather than `execFile` because the point is to see stdout while
 * it is still being written, which is exactly what execFile hides; the limits
 * execFile applied for us (a deadline, a killed process, an output cap) are
 * therefore applied here by hand.
 *
 * The deadline is the one that comes out a different shape. execFile's is wall
 * clock because a buffered run can only be judged by how long the whole of it
 * took, while a run someone is reading as it arrives can be given
 * CLI_TIMEOUT_MS to produce its first word and STREAM_IDLE_MS between words
 * after that. A cap on the total would end an answer that is still being
 * written, which is the one failure a reader would call a bug.
 */
function streamWithClaudeCode({prompt, system, onDelta, signal}) {
  if (running >= MAX_CONCURRENT_CLI) {
    return Promise.resolve({error: BUSY, status: 503});
  }
  running += 1;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(findCli(), cliArgs({prompt, system, stream: true}), {
        cwd: workdir(),
        // The CLI is interactive by nature and checks for a terminal; without
        // this it can wait on one that is never coming.
        env: {...process.env, CI: '1'},
      });
    } catch (err) {
      // Nothing started, so give the slot straight back. A throw here would
      // leak one of the two for the life of the process.
      running -= 1;
      resolve({error: `The Claude CLI failed: ${err.message.split('\n')[0]}`, status: 502});
      return;
    }

    let settled = false;
    let text = '';       // what the deltas built
    let fallback = '';   // the final result record, in case no delta ever came
    let bytes = 0;
    let firstStderrLine = '';

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      running -= 1;
      // A no-op once it has exited, and the only way to stop it when it has not.
      child.kill('SIGKILL');
      resolve(result);
    };
    // The budget to reach the first word, replaced by the idle budget from the
    // first delta onwards, so a process that never speaks still fails and an
    // answer still arriving is never cut off mid-sentence.
    let timer = setTimeout(() => finish({error: TIMED_OUT, status: 504}), CLI_TIMEOUT_MS);
    const renewIdle = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish({error: TIMED_OUT, status: 504}), STREAM_IDLE_MS);
    };
    const onAbort = () => finish({error: CANCELLED, status: CANCELLED_STATUS});
    signal?.addEventListener('abort', onAbort, {once: true});

    const parser = createNdjsonParser((record) => {
      const delta = streamEventText(record);
      if (delta !== null) {
        renewIdle();
        text += delta;
        onDelta?.(delta);
        return;
      }
      if (record.type !== 'result') return;
      if (record.is_error || (record.subtype && record.subtype !== 'success')) {
        finish({error: `The Claude CLI reported: ${record.subtype || 'an error'}`, status: 502});
        return;
      }
      // Kept, not sent: if the run produced deltas this repeats them, and it is
      // only ever used when it did not.
      if (typeof record.result === 'string') fallback = record.result;
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT_BYTES) {
        finish({error: 'The AI response was too large to read.', status: 502});
        return;
      }
      parser.push(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (!firstStderrLine) firstStderrLine = String(chunk).trim().split('\n')[0] || '';
    });

    child.on('error', (err) => finish({error: `The Claude CLI failed: ${err.message.split('\n')[0]}`, status: 502}));
    child.on('close', (code) => {
      parser.end();
      const answer = text || fallback;
      if (answer) return finish({text: answer});
      if (code !== 0) {
        return finish({
          error: `The Claude CLI did not return a result${firstStderrLine ? `: ${firstStderrLine.slice(0, 200)}` : '.'}`,
          status: 502,
        });
      }
      finish({text: 'No response generated'});
    });
  });
}

/** Run Codex as a local text provider and expose its final message as a delta. */
function streamWithCodex({prompt, system, onDelta, signal}) {
  if (running >= MAX_CONCURRENT_CLI) return Promise.resolve({error: BUSY, status: 503});
  running += 1;

  return new Promise((resolve) => {
    let child;
    try {
      const codexEnv = {...process.env};
      // AI_PROVIDER belongs to Mochi. Some Codex distributions also inspect a
      // variable with that generic name, so leaking it into the child can alter
      // its own provider/sandbox setup.
      delete codexEnv.AI_PROVIDER;
      child = spawn(findCodexCli(), codexArgs({prompt, system}), {
        cwd: workdir(),
        // Keep the authenticated local Codex environment. In particular, do
        // not force CI=1: some installations intentionally refuse interactive
        // account credentials when they believe they are running in CI.
        env: codexEnv,
        // Codex also accepts additional prompt text from stdin. Closing it at
        // launch prevents a non-interactive web request from waiting for input
        // that will never arrive.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      running -= 1;
      resolve({error: `Codex failed to start: ${err.message.split('\n')[0]}`, status: 502});
      return;
    }

    let settled = false;
    let answer = '';
    let failure = null;
    let bytes = 0;
    let stderr = '';

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      running -= 1;
      child.kill('SIGKILL');
      resolve(result);
    };
    const timer = setTimeout(() => finish({error: TIMED_OUT, status: 504}), CLI_TIMEOUT_MS);
    const onAbort = () => finish({error: CANCELLED, status: CANCELLED_STATUS});
    signal?.addEventListener('abort', onAbort, {once: true});

    const parser = createNdjsonParser((record) => {
      const text = codexRecordText(record);
      if (text !== null) {
        answer += text;
        onDelta?.(text);
      }
      if (record?.type === 'error' || record?.type === 'turn.failed') {
        failure = record.message || record.error?.message || 'Codex could not complete the request.';
      }
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT_BYTES) {
        finish({error: 'The AI response was too large to read.', status: 502});
        return;
      }
      parser.push(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on('error', (err) => finish({error: `Codex failed: ${err.message.split('\n')[0]}`, status: 502}));
    child.on('close', (code) => {
      parser.end();
      if (failure) return finish({error: failure, status: 502});
      if (answer) return finish({text: answer});
      if (code !== 0) {
        const detail = stderr.trim().split('\n').find(line => (
          line
          && !line.startsWith('Codex CLI at ')
          && !line.startsWith('Using AI Gateway ')
          && line !== 'Reading additional input from stdin...'
        ));
        return finish({
          error: `Codex did not return a result${detail ? `: ${detail.slice(0, 300)}` : '.'}`,
          status: 502,
        });
      }
      finish({text: 'No response generated'});
    });
  });
}

/**
 * One registry is the extension point for hosted APIs and local test backends.
 * Every adapter performs one inference turn and returns the same result shape:
 * `{text}` today, with optional `{toolCalls, usage, responseId}` for the agent
 * runtime to consume as those capabilities are added.
 */
const providerAdapters = Object.freeze({
  api: Object.freeze({complete: completeWithApi, stream: streamWithApi}),
  'claude-code': Object.freeze({complete: completeWithClaudeCode, stream: streamWithClaudeCode}),
  codex: Object.freeze({
    complete: request => streamWithCodex({...request, onDelta: undefined}),
    stream: streamWithCodex,
  }),
});

/**
 * Answer `prompt` the same way `complete` does, calling `onDelta(chunk)` with
 * each piece of text as it arrives and resolving to the whole of it.
 *
 * Returns `{text}` or `{error, status}` exactly like `complete`, and never
 * throws, so a caller can hand the resolved value straight to the wire. `signal`
 * aborts the provider, which is how a reader closing the page stops a CLI
 * process that would otherwise run to completion for nobody.
 */
async function stream(request) {
  const {provider: requested, signal} = request;
  const {provider, error} = resolveProvider({requested});
  if (error) return {error, status: 503};
  if (signal?.aborted) return {error: CANCELLED, status: CANCELLED_STATUS};
  return providerAdapters[provider].stream(request);
}

/**
 * Answer `prompt`, with `system` as the instruction, from whichever provider is
 * available. Returns `{text}` or `{error, status}`; never throws.
 */
async function complete(request) {
  const {provider: requested} = request;
  const {provider, error} = resolveProvider({requested});
  if (error) return {error, status: 503};
  return providerAdapters[provider].complete(request);
}

/** What the provider is right now, for the startup banner and diagnostics. */
function describe() {
  const {provider, error} = resolveProvider();
  if (error) return {available: false, reason: error};
  return {
    available: true,
    provider,
    model: provider === 'api' ? MODEL : (provider === 'codex' ? (CODEX_MODEL || 'Codex default') : CLI_MODEL),
    ...(provider === 'claude-code' ? {command: findCli(), workdir: process.env.AI_WORKDIR || path.join(os.homedir(), '.mochi-lab', 'ai')} : {}),
    ...(provider === 'codex' ? {command: findCodexCli(), workdir: process.env.AI_WORKDIR || path.join(os.homedir(), '.mochi-lab', 'ai')} : {}),
  };
}

module.exports = {
  MODEL, CLI_MODEL, CODEX_MODEL, CLAUDE_EFFORT, CODEX_REASONING_EFFORT,
  FORBIDDEN_TOOLS, MAX_CONCURRENT_CLI,
  API_TIMEOUT_MS, CLI_TIMEOUT_MS, STREAM_IDLE_MS,
  resolveProvider, cliArgs, codexArgs, parseCliOutput, findCli, findCodexCli, describe, complete,
  stream, createSseParser, createNdjsonParser, streamEventText, codexRecordText, providerAdapters,
};
