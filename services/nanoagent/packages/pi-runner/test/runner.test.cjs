const assert = require("node:assert/strict");
const {spawnSync} = require("node:child_process");
const test = require("node:test");

test("PI runner validates server-owned options", async () => {
  const {parseOptions} = await import("../dist/index.js");
  assert.deepEqual(parseOptions({provider: "openrouter", model: "model"}), {
    provider: "openrouter",
    model: "model",
    apiKeyEnv: undefined,
    thinkingLevel: "off",
    systemPrompt: "You are a helpful assistant.",
  });
  assert.throws(() => parseOptions({provider: "openrouter"}), /model.*required/);
});

test("PI usage maps to NanoAgent fields", async () => {
  const {usageFields} = await import("../dist/index.js");
  assert.deepEqual(usageFields({
    input: 2,
    output: 3,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 5,
    cost: {input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3},
  }), {
    usage: {prompt_tokens: 2, completion_tokens: 3, total_tokens: 5},
    cost: 0.3,
  });
});

test("PI runner preserves conversation history in its one-shot prompt", async () => {
  const {promptText} = await import("../dist/index.js");
  assert.equal(promptText({
    input: "next",
    messages: [
      {role: "user", content: "first"},
      {role: "assistant", content: "reply"},
    ],
  }), "Conversation history:\n\nUser:\nfirst\n\nAssistant:\nreply\n\nCurrent user request:\nnext");
});

test("PI runner speaks the JSONL protocol on configuration errors", () => {
  const child = spawnSync(process.execPath, ["dist/index.js"], {
    encoding: "utf8",
    input: `${JSON.stringify({
      protocol: "nanoagent.runner.v1",
      request: {input: "hello", messages: []},
      options: {provider: "missing", model: "missing"},
    })}\n`,
  });
  assert.equal(child.status, 0);
  const event = JSON.parse(child.stdout.trim());
  assert.equal(event.type, "error");
  assert.equal(event.code, "pi_error");
  assert.match(event.error, /model not found/);
});
