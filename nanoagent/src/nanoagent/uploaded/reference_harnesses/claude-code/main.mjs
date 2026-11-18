// Claude Code as a person runs it: its interactive screen on the case's terminal, started with the prompt, the model reached
// through the gateway's Anthropic Messages dialect. Its home holds the answers to its first-run questions. When someone is at the
// terminal (`interactive`) they go on typing and end it themselves; otherwise its Stop and StopFailure hooks end it once it has
// finished the turn.
import {spawn} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const request = JSON.parse(readFileSync(process.env.RUSH_REQUEST, "utf8"));
const {base_url: baseUrl, model} = request.openrouter;
// Claude Code adds /v1/messages itself, so it is given the gateway's root without /v1.
if (!baseUrl.replace(/\/+$/, "").endsWith("/v1")) throw new Error(`openrouter.base_url must end in /v1: ${baseUrl}`);
// The platform's binary is a dependency of the lock (no install script runs to put it in place).
const binary = join(dirname(fileURLToPath(import.meta.url)), "node_modules/@anthropic-ai/claude-code-linux-" + process.arch, "claude");

const home = mkdtempSync(join(tmpdir(), "claude-home-"));
const stopped = join(home, "stopped");
const failed = join(home, "failed");
// Onboarding done, the workspace trusted and bypass permissions mode accepted, as after a person's first run.
writeFileSync(join(home, ".claude.json"), JSON.stringify({
  hasCompletedOnboarding: true,
  theme: "dark",
  bypassPermissionsModeAccepted: true,
  projects: {[request.workspace]: {hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true}},
}));
mkdirSync(join(home, ".claude"));
writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
  skipDangerousModePermissionPrompt: true,
  ...(request.interactive ? {} : {hooks: {
    Stop: [{hooks: [{type: "command", command: `touch ${stopped}`}]}],
    StopFailure: [{hooks: [{type: "command", command: `touch ${failed}`}]}],
  }}),
}));

const child = spawn(binary, ["--permission-mode", "bypassPermissions", "--model", model, request.prompt.user], {
  cwd: request.workspace,
  stdio: "inherit",
  env: {
    ...process.env,
    HOME: home,
    ANTHROPIC_BASE_URL: baseUrl.replace(/\/+$/, "").slice(0, -"/v1".length),
    ANTHROPIC_AUTH_TOKEN: process.env.RUSH_ATTEMPT_TOKEN,
    // Claude Code prefers an API key to the token: none.
    ANTHROPIC_API_KEY: "",
    // The gateway serves the attempt's model only: the calls Claude Code makes on its smaller model go to it too.
    ANTHROPIC_SMALL_FAST_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // The gateway refuses a call asking for more output tokens than the attempt allows.
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(request.limits.max_output_tokens_per_call),
  },
});
child.on("error", (error) => {
  console.error(`claude failed to start: ${error.message}`);
  process.exit(1);
});
if (request.interactive) process.on("SIGINT", () => {}); // Ctrl-C is Claude Code's to handle
let ended = null;
child.on("exit", (code) => process.exit(ended ?? (code === 0 ? 0 : 1)));
// Once a hook has said the turn is over, the screen is given a moment to draw it, and Claude Code is ended.
const watch = request.interactive ? null : setInterval(() => {
  if (existsSync(failed)) ended = 1;
  else if (existsSync(stopped)) ended = 0;
  else return;
  clearInterval(watch);
  setTimeout(() => child.kill("SIGTERM"), 1500);
}, 200);
