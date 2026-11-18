// PI in the workspace, the model reached through the gateway's chat completions dialect on pi-ai's openrouter route: its own
// interactive screen (the `pi` CLI) when someone is at the terminal (`interactive`), started with the prompt, and otherwise its
// agent loop with its coding tools (read, bash, edit, write), as nanoagent/js/pi-runner runs it.
import {Agent} from "@earendil-works/pi-agent-core";
import {setBedrockProviderModule} from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import {bedrockProviderModule} from "@earendil-works/pi-ai/bedrock-provider";
import {builtinModels} from "@earendil-works/pi-ai/providers/all";
import {createCodingTools} from "@earendil-works/pi-coding-agent";
import {spawn} from "node:child_process";
import {mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const request = JSON.parse(readFileSync(process.env.RUSH_REQUEST, "utf8"));
const {base_url: baseUrl, model: modelId} = request.openrouter;
const maxTokens = request.limits?.max_output_tokens_per_call;

if (request.interactive) {
  // Its home routes the openrouter provider to the gateway, keyed by the attempt token, the model capped at the attempt's output tokens.
  const home = mkdtempSync(join(tmpdir(), "pi-home-"));
  writeFileSync(join(home, "models.json"), JSON.stringify({providers: {openrouter: {
    baseUrl, apiKey: "$RUSH_ATTEMPT_TOKEN", modelOverrides: {[modelId]: {maxTokens}},
  }}}));
  const pi = join(dirname(fileURLToPath(import.meta.url)), "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  // --offline: no update or catalog fetch at startup; the gateway serves model calls only. The member ends it with /quit.
  const child = spawn(process.execPath, [pi, "--provider", "openrouter", "--model", modelId, "--thinking", "medium", "--offline", "--no-session", request.prompt.user], {
    cwd: request.workspace, stdio: "inherit", env: {...process.env, PI_CODING_AGENT_DIR: home},
  });
  process.on("SIGINT", () => {}); // Ctrl-C is PI's to handle
  child.on("error", (error) => {
    console.error(`pi failed to start: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code === 0 ? 0 : 1));
} else {
  // Bundled, so Bedrock's implementation is registered here rather than imported at run time from a file that is not there.
  setBedrockProviderModule(bedrockProviderModule);
  const models = builtinModels();
  const found = models.getModel("openrouter", modelId);
  if (!found) throw new Error(`PI model not found: openrouter/${modelId}`);
  const agent = new Agent({
    initialState: {
      systemPrompt: "You are a helpful assistant.",
      model: {...found, baseUrl},
      thinkingLevel: "medium",
      tools: createCodingTools(request.workspace),
    },
    streamFn: (model, context, options) => models.streamSimple(model, context, {...options, ...(maxTokens ? {maxTokens} : {})}),
    getApiKey: () => process.env.RUSH_ATTEMPT_TOKEN,
  });
  process.once("SIGTERM", () => agent.abort());

  await agent.prompt(request.prompt.user);
  const final = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
  if (!final || final.stopReason === "error" || final.stopReason === "aborted") {
    console.error(`PI failed: ${final?.errorMessage ?? final?.stopReason ?? "no assistant message"}`);
    process.exit(1);
  }
}
