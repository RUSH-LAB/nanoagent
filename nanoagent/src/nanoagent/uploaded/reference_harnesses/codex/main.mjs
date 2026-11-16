// Codex, non-interactively in the workspace: the prompt on stdin, the model reached through the gateway's Responses dialect.
import {spawn} from "node:child_process";
import {mkdtempSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const request = JSON.parse(readFileSync(process.env.RUSH_REQUEST, "utf8"));
const {base_url: baseUrl, model} = request.openrouter;
// The wrapper picks the platform's binary from the lock's optional dependencies.
const codex = join(dirname(fileURLToPath(import.meta.url)), "node_modules/@openai/codex/bin/codex.js");
const provider = `{name="rush",base_url=${JSON.stringify(baseUrl)},env_key="RUSH_ATTEMPT_TOKEN",wire_api="responses"}`;

const child = spawn(
  process.execPath,
  [
    codex, "exec", "--json", "--color", "never", "--skip-git-repo-check",
    // The container is the sandbox.
    "--sandbox", "danger-full-access", "--cd", request.workspace,
    // The gateway only passes function tools: no web search, and no multi-agent tool namespace.
    "--disable", "plugins", "--disable", "multi_agent", "-c", 'web_search="disabled"', "--model", model,
    "-c", 'model_provider="rush"', "-c", `model_providers.rush=${provider}`,
    "-",
  ],
  {
    cwd: request.workspace,
    stdio: ["pipe", "inherit", "inherit"],
    env: {...process.env, CODEX_HOME: mkdtempSync(join(tmpdir(), "codex-home-"))},
  },
);
child.stdin.end(request.prompt.user);
child.on("error", (error) => {
  console.error(`codex failed to start: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code === 0 ? 0 : 1));
