// Claude Code, non-interactively in the workspace: the prompt on stdin, the model reached through the gateway's Anthropic Messages dialect.
import {spawn} from "node:child_process";
import {mkdtempSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const request = JSON.parse(readFileSync(process.env.RUSH_REQUEST, "utf8"));
const {base_url: baseUrl, model} = request.openrouter;
// Claude Code adds /v1/messages itself, so it is given the gateway's root without /v1.
if (!baseUrl.replace(/\/+$/, "").endsWith("/v1")) throw new Error(`openrouter.base_url must end in /v1: ${baseUrl}`);
// The platform's binary is a dependency of the lock (no install script runs to put it in place).
const binary = join(dirname(fileURLToPath(import.meta.url)), "node_modules/@anthropic-ai/claude-code-linux-" + process.arch, "claude");

const child = spawn(
  binary,
  [
    "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", "--model", model,
  ],
  {
    cwd: request.workspace,
    stdio: ["pipe", "inherit", "inherit"],
    env: {
      ...process.env,
      HOME: mkdtempSync(join(tmpdir(), "claude-home-")),
      ANTHROPIC_BASE_URL: baseUrl.replace(/\/+$/, "").slice(0, -"/v1".length),
      ANTHROPIC_AUTH_TOKEN: process.env.RUSH_ATTEMPT_TOKEN,
      // Claude Code prefers an API key to the token: none.
      ANTHROPIC_API_KEY: "",
      // The gateway refuses a call asking for more output tokens than the attempt allows.
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(request.limits.max_output_tokens_per_call),
    },
  },
);
child.stdin.end(request.prompt.user);
child.on("error", (error) => {
  console.error(`claude failed to start: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code === 0 ? 0 : 1));
