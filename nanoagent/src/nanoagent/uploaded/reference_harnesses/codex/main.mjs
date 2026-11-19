// Codex in the workspace as a person sees it on a terminal, the model reached through the gateway's Responses dialect: its own
// interactive screen when someone is at the terminal (`interactive`), otherwise `codex exec` with the prompt on stdin.
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

// The gateway only passes function tools: no web search, and no multi-agent tool namespace. The container is the sandbox.
const common = [
  "--sandbox", "danger-full-access", "--cd", request.workspace, "--disable", "plugins", "--disable", "multi_agent", "-c", 'web_search="disabled"',
  "--model", model, "-c", 'model_provider="rush"', "-c", `model_providers.rush=${provider}`,
];
const env = {...process.env, CODEX_HOME: mkdtempSync(join(tmpdir(), "codex-home-"))};
const child = request.interactive
  // Someone is at the terminal: Codex's own screen, started with the prompt, the workspace trusted as after a person's first run.
  // The screen offers the model its thread and worktree tools as one `namespace` tool, which the gateway refuses. It leaves them
  // out when a configured MCP server holds their name, codex_tui, so one is configured, switched off.
  ? spawn(process.execPath, [
      codex, ...common, "-c", `projects.${JSON.stringify(request.workspace)}.trust_level="trusted"`,
      "-c", 'mcp_servers.codex_tui={command="true",enabled=false}', request.prompt.user,
    ], {
      cwd: request.workspace, stdio: "inherit", env,
    })
  : spawn(process.execPath, [codex, "exec", "--color", "always", "--skip-git-repo-check", ...common, "-"], {cwd: request.workspace, stdio: ["pipe", "inherit", "inherit"], env});
if (request.interactive) process.on("SIGINT", () => {}); // Ctrl-C is Codex's to handle
else child.stdin.end(request.prompt.user);
child.on("error", (error) => {
  console.error(`codex failed to start: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code === 0 ? 0 : 1));
