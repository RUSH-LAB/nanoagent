/**
 * Where a completion comes from.
 *
 * Two providers, because there are two ways to have Claude on hand and most
 * people setting this up have exactly one of them.
 *
 *   api          POST to api.anthropic.com with ANTHROPIC_API_KEY. What a
 *                deployed site uses: cheap per turn, fast, and stateless.
 *   claude-code  Run the `claude` CLI already installed and signed in on this
 *                machine. What a laptop uses: no key to obtain, because it
 *                borrows the authentication Claude Code set up, whether that is
 *                a subscription or a gateway.
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
const {execFile} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/** The model to ask for. An alias the CLI also understands. */
const MODEL = process.env.AI_MODEL || 'claude-sonnet-4-6';
/** The alias form, for the CLI, which takes short names. */
const CLI_MODEL = process.env.AI_MODEL_ALIAS || 'sonnet';

const MAX_TOKENS = 1024;

/** The direct API answers in a second or two; the CLI spends five starting up. */
const API_TIMEOUT_MS = 15_000;
const CLI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 60_000;

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

/**
 * Which provider will answer, or why none will. Decided per call rather than at
 * load, so setting a key and restarting nothing still works in development.
 */
function resolveProvider({env = process.env, hasCli = Boolean(findCli()), isProduction = IS_PRODUCTION} = {}) {
  const asked = env.AI_PROVIDER;
  const hasKey = Boolean(env.ANTHROPIC_API_KEY);

  if (asked === 'off') return {error: 'The AI assistant is switched off (AI_PROVIDER=off).'};
  if (asked === 'api') {
    return hasKey ? {provider: 'api'} : {error: 'AI_PROVIDER=api, but ANTHROPIC_API_KEY is not set.'};
  }
  if (asked === 'claude-code') {
    if (isProduction) return {error: 'The claude-code provider is for development only and will not run in production.'};
    return hasCli ? {provider: 'claude-code'} : {error: 'AI_PROVIDER=claude-code, but no `claude` command was found on PATH.'};
  }

  if (hasKey) return {provider: 'api'};
  if (hasCli && !isProduction) return {provider: 'claude-code'};
  return {
    error: 'No AI provider is available. Either set ANTHROPIC_API_KEY, or install '
      + 'Claude Code and sign in, which lets this borrow the session it already has.',
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
    if (err.name === 'AbortError') return {error: 'The AI request timed out. Please try again.', status: 504};
    return {error: 'Could not reach the AI service.', status: 502};
  } finally {
    clearTimeout(timer);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) return {error: 'The AI service returned an error. Please try again.', status: 502};
  return {text: data.content?.[0]?.text || 'No response generated'};
}

/* ── The local CLI ────────────────────────────────────────────────── */

/**
 * The command line, built in one place so the safety flags are visible
 * together and can be tested without running anything.
 */
function cliArgs({prompt, system}) {
  return [
    '--print', prompt,
    '--output-format', 'json',
    '--model', CLI_MODEL,
    // Nothing this endpoint does should end up in the session history of the
    // person whose Claude Code this is.
    '--no-session-persistence',
    // No MCP servers: --strict-mcp-config with no --mcp-config means none.
    '--strict-mcp-config',
    '--disallowedTools', FORBIDDEN_TOOLS.join(' '),
    ...(system ? ['--system-prompt', system] : []),
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
    return Promise.resolve({error: 'The assistant is busy with another request. Try again in a moment.', status: 503});
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
        if (err && err.killed) return resolve({error: 'The AI request timed out. Please try again.', status: 504});
        if (err && !stdout) return resolve({error: `The Claude CLI failed: ${err.message.split('\n')[0]}`, status: 502});
        resolve(parseCliOutput(stdout));
      },
    );
  });
}

/**
 * Answer `prompt`, with `system` as the instruction, from whichever provider is
 * available. Returns `{text}` or `{error, status}`; never throws.
 */
async function complete({prompt, system}) {
  const {provider, error} = resolveProvider();
  if (error) return {error, status: 503};
  return provider === 'api'
    ? completeWithApi({prompt, system})
    : completeWithClaudeCode({prompt, system});
}

/** What the provider is right now, for the startup banner and diagnostics. */
function describe() {
  const {provider, error} = resolveProvider();
  if (error) return {available: false, reason: error};
  return {
    available: true,
    provider,
    model: provider === 'api' ? MODEL : CLI_MODEL,
    ...(provider === 'claude-code' ? {command: findCli(), workdir: process.env.AI_WORKDIR || path.join(os.homedir(), '.mochi-lab', 'ai')} : {}),
  };
}

module.exports = {
  MODEL, CLI_MODEL, FORBIDDEN_TOOLS, MAX_CONCURRENT_CLI,
  API_TIMEOUT_MS, CLI_TIMEOUT_MS,
  resolveProvider, cliArgs, parseCliOutput, findCli, describe, complete,
};
