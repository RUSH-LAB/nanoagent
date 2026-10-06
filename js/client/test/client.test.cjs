const assert = require("node:assert/strict");
const {describe, it} = require("node:test");
const {NanoAgentClient, NanoAgentError} = require("../dist/index.js");

function sseResponse(chunks, status = 200) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), {status, headers: {"content-type": "text/event-stream"}});
}

describe("NanoAgentClient", () => {
  it("parses fragmented SSE events and ignores heartbeats", async () => {
    const fetch = async () => sseResponse([
      ": heart",
      "beat\n\nevent: delta\ndata: {\"type\":\"delta\",\"runId\":\"r1\",",
      "\"kind\":\"content\",\"text\":\"hi\"}\n\n",
      "event: done\ndata: {\"type\":\"done\",\"runId\":\"r1\",\"answer\":\"hi\",\"stop_reason\":\"answer\",\"steps\":1,\"usage\":{},\"cost\":0,\"error\":null}\n\n",
    ]);
    const client = new NanoAgentClient({baseUrl: "http://agent", fetch});
    const seen = [];
    for await (const event of client.stream({input: "hello"})) seen.push(event.type);
    assert.deepEqual(seen, ["delta", "done"]);
  });

  it("turns terminal error events into exceptions in run()", async () => {
    const fetch = async () => sseResponse([
      "event: error\ndata: {\"type\":\"error\",\"runId\":\"r1\",\"code\":\"timeout\",\"error\":\"too slow\"}\n\n",
    ]);
    const client = new NanoAgentClient({baseUrl: "http://agent", fetch});
    await assert.rejects(client.run({input: "hello"}), error => (
      error instanceof NanoAgentError && error.code === "timeout"
    ));
  });

  it("sends authorization and supports explicit cancellation", async () => {
    let request;
    const fetch = async (url, options) => {
      request = {url, options};
      return new Response(JSON.stringify({cancelled: true}), {status: 202});
    };
    const client = new NanoAgentClient({baseUrl: "http://agent/", token: "secret", fetch});
    assert.equal(await client.cancel("run/id"), true);
    assert.equal(request.url, "http://agent/v1/runs/run%2Fid");
    assert.equal(request.options.headers.Authorization, "Bearer secret");
  });

  it("discovers server-owned harness profiles", async () => {
    let request;
    const fetch = async (url, options) => {
      request = {url, options};
      return new Response(JSON.stringify({
        defaultProfile: "native-fast",
        profiles: [{
          id: "native-fast", label: "Fast", harness: "native", model: "test",
          available: true, unavailableReason: null,
          capabilities: {streaming: true, reasoning: true, tools: true, usage: true,
            cancellation: true, history: true},
        }],
      }), {status: 200, headers: {"content-type": "application/json"}});
    };
    const client = new NanoAgentClient({baseUrl: "http://agent", token: "secret", fetch});
    const catalog = await client.profiles();
    assert.equal(catalog.defaultProfile, "native-fast");
    assert.equal(request.url, "http://agent/v1/profiles");
    assert.equal(request.options.headers.Authorization, "Bearer secret");
  });
});
