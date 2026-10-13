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
    awsRegion: undefined,
    awsProfile: undefined,
    temperature: undefined,
    maxTokens: undefined,
  });
  assert.throws(() => parseOptions({provider: "openrouter"}), /model.*required/);
});

test("PI runner takes a run's temperature and output limit", async () => {
  const {parseOptions} = await import("../dist/index.js");
  const options = parseOptions({provider: "openrouter", model: "m", temperature: 0.4, max_tokens: 512});
  assert.equal(options.temperature, 0.4);
  assert.equal(options.maxTokens, 512);
  assert.throws(() => parseOptions({provider: "openrouter", model: "m", temperature: 3}), /temperature/);
  assert.throws(() => parseOptions({provider: "openrouter", model: "m", max_tokens: 0}), /max_tokens/);
});

test("PI catalog lists providers with their credentials, and models with their prices", () => {
  const child = spawnSync(process.execPath, ["dist/models.js"], {
    encoding: "utf8",
    env: {PATH: process.env.PATH, OPENROUTER_API_KEY: "sk-test"},
  });
  assert.equal(child.status, 0, child.stderr);
  const {providers, models} = JSON.parse(child.stdout);
  assert.equal(providers.find((provider) => provider.id === "openrouter").keySet, true);
  assert.equal(providers.find((provider) => provider.id === "anthropic").keySet, false);
  const model = models.find((entry) => entry.provider === "openrouter");
  assert.equal(typeof model.contextWindow, "number");
  assert.equal(typeof model.cost.input, "number");
});

test("PI usage maps to NanoAgent fields", async () => {
  const {usageFields} = await import("../dist/index.js");
  assert.deepEqual(usageFields({
    input: 2,
    output: 3,
    cacheRead: 4,
    cacheWrite: 1,
    cacheWrite1h: 1,
    reasoning: 2,
    totalTokens: 10,
    cost: {input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3},
  }), {
    usage: {
      prompt_tokens: 7,
      completion_tokens: 3,
      total_tokens: 10,
      cached_tokens: 4,
      cache_write_tokens: 1,
      cache_write_1h_tokens: 1,
      reasoning_tokens: 2,
    },
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
