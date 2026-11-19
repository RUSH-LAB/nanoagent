// DeepSeek Harness (dsh) in headless mode in the workspace: the prompt on stdin, the model reached through the gateway's chat completions dialect on pi-ai's openrouter route.
import {spawn} from "node:child_process";
import {mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {createInterface} from "node:readline";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const request = JSON.parse(readFileSync(process.env.RUSH_REQUEST, "utf8"));
const {base_url: baseUrl, model} = request.openrouter;
const home = mkdtempSync(join(tmpdir(), "dsh-home-"));
const effort = "medium";
// A patch layer over the headless profile: no title call, the openrouter route at the gateway keyed by the attempt token,
// and the model fresh agents start on. dsh refuses a reasoning effort the model does not declare, so the model declares this one,
// and the gateway refuses a call asking for more output tokens than the attempt allows, so it declares that cap.
const patch = `- id: session-title-llm
  disabled: true
- id: llm-pi-ai
  config:
    providers:
      "openrouter":
        apiKeyEnv: "RUSH_ATTEMPT_TOKEN"
        baseURL: ${JSON.stringify(baseUrl)}
        models:
          - id: ${JSON.stringify(model)}
            maxTokens: ${request.limits.max_output_tokens_per_call}
            reasoningEfforts:
              ${JSON.stringify(effort)}: ${JSON.stringify(effort)}
- id: agent-default-model
  config:
    provider: "openrouter"
    model: ${JSON.stringify(model)}
    reasoningEffort: ${JSON.stringify(effort)}
`;
const patchPath = join(home, "run.patch.yml");
writeFileSync(patchPath, patch);

const dsh = join(dirname(fileURLToPath(import.meta.url)), "node_modules/@deepseek-ai/dsh/lib/bin.js");
const child = spawn(
  process.execPath,
  // Headless has no one to approve a call: a call that needs approval is refused, not left waiting.
  [dsh, "--profile", "headless", "--patch", patchPath, "--json", "--approval-policy", "never", "-"],
  {cwd: request.workspace, stdio: ["pipe", "pipe", "inherit"], env: {
      ...process.env,
      DSH_HOME: home,
      DSH_PERMISSION_MODE: "danger-full-access",
      // The loader of dsh's native addons copies each into /tmp to load it, which is mounted noexec.
      NARB_DISABLE_NATIVE_CACHE: "1",
    },
  },
);
child.stdin.end(request.prompt.user);
// dsh exits 0 even when its run ends for another reason than completing, which its final event names.
let final;
createInterface({input: child.stdout}).on("line", (line) => {
  console.log(line);
  try {
    const event = JSON.parse(line);
    if (event.type === "final") final = event;
  } catch {}
});
child.on("error", (error) => {
  console.error(`dsh failed to start: ${error.message}`);
  process.exit(1);
});
child.on("close", (code) => {
  if (code === 0 && final?.reason?.kind === "completed") process.exit(0);
  console.error(`dsh ended with status ${code}, reason ${JSON.stringify(final?.reason)}`);
  process.exit(1);
});
