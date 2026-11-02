const assert = require("node:assert/strict");
const {spawn, spawnSync} = require("node:child_process");
const http = require("node:http");
const test = require("node:test");

/**
 * A fake of `kind`'s server (vllm or sglang) at `url`, as test/test_servers.py's Engine answers:
 * its /v1/models, SGLang's /server_info, and each chat completion streamed with `reply`'s reasoning
 * and content, in the field each engine names reasoning, and its usage, which counts 4 reasoning
 * tokens where each engine does. `requests` holds what was asked of it.
 */
function engine(kind, {model = "org/model-1b", key = null, toolParser = true, reply = {content: "51"}, silent = false} = {}) {
  const requests = [];
  const field = kind === "vllm" ? "reasoning" : "reasoning_content";
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({method: req.method, path: req.url, authorization: req.headers.authorization ?? null, body: body ? JSON.parse(body) : null});
      if (silent) return;
      const json = (status, value) => res.writeHead(status, {"Content-Type": "application/json"}).end(JSON.stringify(value));
      if (key && req.headers.authorization !== `Bearer ${key}`) return json(401, {error: "Unauthorized"});
      if (req.method === "GET" && req.url === "/v1/models") {
        return json(200, {object: "list", data: [{id: model, object: "model", owned_by: kind, max_model_len: 16384}]});
      }
      if (req.method === "GET" && req.url === "/server_info" && kind === "sglang") {
        return json(200, {tool_call_parser: toolParser ? "qwen" : null});
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") return json(404, {detail: "Not Found"});
      const base = {id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model};
      const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({...base, choices: [{index: 0, delta, finish_reason: finish}]})}\n\n`);
      res.writeHead(200, {"Content-Type": "text/event-stream"});
      send({role: "assistant", content: ""});
      if (reply.reasoning) send({[field]: reply.reasoning});
      send({content: reply.content});
      send({}, "stop");
      const reasoning = kind === "vllm" ? {completion_tokens_details: {reasoning_tokens: 4}} : {reasoning_tokens: 4};
      res.write(`data: ${JSON.stringify({...base, choices: [], usage: {prompt_tokens: 9, completion_tokens: 6, total_tokens: 15, ...reasoning}})}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }),
  })));
}

/** Run `script` of dist/ with `env` (and PATH) and `input`, without blocking this process, so its fakes answer. */
function run(script, env, input = "") {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [`dist/${script}`], {env: {PATH: process.env.PATH, ...env}});
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({status, stdout, stderr}));
    child.stdin.end(input);
  });
}

const listing = async (env) => {
  const child = await run("models.js", env);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
};

const envelope = (options) => `${JSON.stringify({
  protocol: "nanoagent.runner.v1",
  request: {input: "What is 17 times 3?", messages: []},
  options: {system_prompt: "You are terse.", ...options},
})}\n`;

const events = (child) => child.stdout.trim().split("\n").map((line) => JSON.parse(line));

/** The /v1 address of a port nothing listens on any more. */
function closedUrl() {
  const server = http.createServer();
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const {port} = server.address();
    server.close(() => resolve(`http://127.0.0.1:${port}/v1`));
  }));
}

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

test("PI reads a server's reasoning tokens where pi-ai looks for them", async () => {
  const {nestReasoningTokens, serverFetch} = await import("../dist/index.js");
  const sglang = 'data: {"choices":[],"usage":{"prompt_tokens":17,"completion_tokens":463,"prompt_tokens_details":null,"reasoning_tokens":437}}';
  assert.deepEqual(JSON.parse(nestReasoningTokens(sglang).slice("data: ".length)).usage, {
    prompt_tokens: 17, completion_tokens: 463, prompt_tokens_details: null, reasoning_tokens: 437,
    completion_tokens_details: {reasoning_tokens: 437},
  });
  // OpenAI's and vLLM's count, other events, the end of the stream and anything else pass as they are.
  for (const line of [
    'data: {"choices":[],"usage":{"completion_tokens":732,"completion_tokens_details":{"reasoning_tokens":692},"reasoning_tokens":1}}',
    'data: {"choices":[{"index":0,"delta":{"content":"51"}}]}',
    'data: {"choices":[],"usage":null}',
    "data: [DONE]",
    'data: {"usage":{"reasoning_tokens":',
    ": keep-alive",
    "",
  ]) assert.equal(nestReasoningTokens(line), line);

  // An event stream split anywhere arrives whole, its usage nested; anything else is fetch's own answer.
  const events = `data: {"choices":[{"index":0,"delta":{"content":"5€1"}}]}\n\n${sglang}\n\ndata: [DONE]\n\n`;
  const bytes = new TextEncoder().encode(events);
  const server = http.createServer((req, res) => {
    if (req.url === "/json") return res.writeHead(200, {"Content-Type": "application/json"}).end('{"usage":{"reasoning_tokens":3}}');
    res.writeHead(200, {"Content-Type": "text/event-stream; charset=utf-8"});
    for (let at = 0; at < bytes.length; at += 7) res.write(bytes.subarray(at, at + 7));
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const streamed = await (await serverFetch(`${url}/stream`)).text();
    assert.equal(streamed, events.replace(sglang, nestReasoningTokens(sglang)));
    assert.equal(await (await serverFetch(`${url}/json`)).text(), '{"usage":{"reasoning_tokens":3}}');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
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

test("PI catalog lists the server engines, unset until their servers are named", async () => {
  const {providers, models} = await listing({});
  assert.deepEqual(providers.filter((provider) => ["vllm", "sglang"].includes(provider.id)), [
    {id: "vllm", name: "vLLM", keySet: false, baseUrl: null, error: null, tools: null},
    {id: "sglang", name: "SGLang", keySet: false, baseUrl: null, error: null, tools: null},
  ]);
  assert.equal(models.some((model) => ["vllm", "sglang"].includes(model.provider)), false);
});

test("PI catalog lists the models each server serves, free, with its context, asking with its key", async () => {
  const vllm = await engine("vllm", {model: "org/a", key: "k"});
  const sglang = await engine("sglang", {model: "org/b"});
  try {
    const {providers, models} = await listing({VLLM_BASE_URL: `${vllm.url}/`, VLLM_API_KEY: "k", SGLANG_BASE_URL: sglang.url});
    assert.deepEqual(providers.find((provider) => provider.id === "vllm"), {id: "vllm", name: "vLLM", keySet: true, baseUrl: vllm.url, error: null, tools: null});
    // SGLang says it parses tool calls; vLLM does not say, and refuses tools it cannot call.
    assert.equal(providers.find((provider) => provider.id === "sglang").tools, true);
    assert.deepEqual(models.filter((model) => ["vllm", "sglang"].includes(model.provider)), [
      {provider: "vllm", id: "org/a", name: "org/a", contextWindow: 16384, maxTokens: 16384, reasoning: null, cost: {input: 0, output: 0}},
      {provider: "sglang", id: "org/b", name: "org/b", contextWindow: 16384, maxTokens: 16384, reasoning: null, cost: {input: 0, output: 0}},
    ]);
    assert.deepEqual(vllm.requests.map((request) => [request.path, request.authorization]), [["/v1/models", "Bearer k"]]);
  } finally {
    await vllm.close();
    await sglang.close();
  }
});

test("PI catalog says why a server's models could not be listed", async () => {
  const keyed = await engine("vllm", {key: "k"});
  const plain = await engine("sglang", {toolParser: false});
  const silent = await engine("vllm", {silent: true});
  try {
    const error = async (env, id = "vllm") => (await listing(env)).providers.find((provider) => provider.id === id);
    assert.match((await error({VLLM_BASE_URL: keyed.url})).error, /answered 401 to GET \/models: it was started with a key \(--api-key\), which goes in VLLM_API_KEY/);
    assert.match((await error({VLLM_BASE_URL: keyed.url, VLLM_API_KEY: "wrong"})).error, /VLLM_API_KEY is not the key it was started with/);
    assert.match((await error({VLLM_BASE_URL: keyed.url.replace(/\/v1$/, "")})).error, /answered (401|404)/);
    const closed = await closedUrl();
    assert.equal((await error({VLLM_BASE_URL: closed})).error, `Could not reach the vLLM server at ${closed}: ECONNREFUSED`);
    assert.match((await error({VLLM_BASE_URL: silent.url})).error, /no answer within 3s/);
    // An SGLang server started without --tool-call-parser lists its models, but cannot call tools.
    const sglang = await error({SGLANG_BASE_URL: plain.url}, "sglang");
    assert.deepEqual([sglang.error, sglang.tools], [null, false]);
  } finally {
    await keyed.close();
    await plain.close();
    await silent.close();
  }
});

for (const kind of ["vllm", "sglang"]) {
  test(`PI runs a chat on a ${kind} server's model: its own output limit or none, its thinking on or off`, async () => {
    const served = await engine(kind, {key: "k", reply: {reasoning: "Seventeen threes.", content: "51"}});
    const variable = kind === "vllm" ? "VLLM" : "SGLANG";
    const env = {[`${variable}_BASE_URL`]: served.url, [`${variable}_API_KEY`]: "k"};
    try {
      const off = events(await run("index.js", env, envelope({provider: kind, model: "org/model-1b", thinking_level: "off"})));
      assert.deepEqual(off.map((event) => event.type), ["delta", "delta", "done"]);
      assert.deepEqual(off.slice(0, 2).map((event) => event.kind), ["reasoning", "content"]);
      assert.deepEqual({...off.at(-1), usage: undefined}, {type: "done", answer: "51", stop_reason: "answer", steps: 1, usage: undefined, cost: 0, error: null});
      // Each engine's count of reasoning tokens, wherever it puts it.
      assert.deepEqual(off.at(-1).usage, {prompt_tokens: 9, completion_tokens: 6, total_tokens: 15, cached_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 4});
      const tuned = events(await run("index.js", env, envelope({provider: kind, model: "org/model-1b", thinking_level: "high", max_tokens: 64, temperature: 0.3})));
      assert.equal(tuned.at(-1).type, "done");
      const sent = served.requests.filter((request) => request.path === "/v1/chat/completions").map((request) => request.body);
      assert.equal(sent.length, 2);
      // The server sizes an answer to what its context leaves unless the run set a limit; the system
      // prompt goes as `system`; nothing OpenAI-only goes.
      assert.equal("max_tokens" in sent[0] || "max_completion_tokens" in sent[0], false);
      assert.deepEqual([sent[1].max_tokens, sent[1].temperature], [64, 0.3]);
      assert.deepEqual(sent[0].messages[0], {role: "system", content: "You are terse."});
      assert.equal("store" in sent[0] || "reasoning_effort" in sent[0], false);
      assert.deepEqual(sent.map((body) => body.chat_template_kwargs), [{enable_thinking: false}, {enable_thinking: true}]);
      assert.deepEqual(sent[0].stream_options, {include_usage: true});
      assert.ok(served.requests.every((request) => request.authorization === "Bearer k"));
    } finally {
      await served.close();
    }
  });
}

test("PI says which server engine a run needs, and what its server serves", async () => {
  const served = await engine("sglang", {model: "org/b"});
  try {
    const [unset] = events(await run("index.js", {}, envelope({provider: "vllm", model: "org/a"})));
    assert.equal(unset.error, "No vLLM server is set (VLLM_BASE_URL): add one to run org/a");
    const [other] = events(await run("index.js", {SGLANG_BASE_URL: served.url}, envelope({provider: "sglang", model: "org/a"})));
    // SGLang would answer any name with its own model: the run is refused instead.
    assert.equal(other.error, `The SGLang server at ${served.url} does not serve org/a; it serves org/b`);
    const closed = await closedUrl();
    const [gone] = events(await run("index.js", {VLLM_BASE_URL: closed}, envelope({provider: "vllm", model: "org/a"})));
    assert.equal(gone.error, `Could not reach the vLLM server at ${closed}: ECONNREFUSED`);
    assert.ok([unset, other, gone].every((event) => event.type === "error" && event.code === "pi_error"));
    assert.equal(served.requests.some((request) => request.path === "/v1/chat/completions"), false);
  } finally {
    await served.close();
  }
});
