// PI's agent loop with its coding tools (read, bash, edit, write) in the workspace, as nanoagent/js/pi-runner runs it,
// the model reached through the gateway's chat completions dialect on pi-ai's openrouter route.
import {Agent} from "@earendil-works/pi-agent-core";
import {setBedrockProviderModule} from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import {bedrockProviderModule} from "@earendil-works/pi-ai/bedrock-provider";
import {builtinModels} from "@earendil-works/pi-ai/providers/all";
import {createCodingTools} from "@earendil-works/pi-coding-agent";
import {readFileSync} from "node:fs";

const request = JSON.parse(readFileSync(process.env.RUSH_REQUEST, "utf8"));
const {base_url: baseUrl, model: modelId} = request.openrouter;
const maxTokens = request.limits.max_output_tokens_per_call;

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
  streamFn: (model, context, options) => models.streamSimple(model, context, {...options, maxTokens}),
  getApiKey: () => process.env.RUSH_ATTEMPT_TOKEN,
});
process.once("SIGTERM", () => agent.abort());

await agent.prompt(request.prompt.user);
const final = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
if (!final || final.stopReason === "error" || final.stopReason === "aborted") {
  console.error(`PI failed: ${final?.errorMessage ?? final?.stopReason ?? "no assistant message"}`);
  process.exit(1);
}
