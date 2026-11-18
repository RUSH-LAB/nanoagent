// The plugin's tools for PI (bin/pi loads this with -e), which has no MCP client of its own: each tool of the MCP server at
// $RUSH_MCP_URL (the attempt's tool broker, shell.py) becomes a PI tool named as Claude Code names it, mcp__<plugin>__<tool>,
// with the plugin's description and input schema, and each call is that server's tools/call, which RUSH records.
const url = process.env.RUSH_MCP_URL!;
const server = process.env.RUSH_MCP_NAME!;
let next = 0;

async function rpc(method: string, params: object): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: {"Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${process.env.RUSH_ATTEMPT_TOKEN}`},
    body: JSON.stringify({jsonrpc: "2.0", id: ++next, method, params}),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${server} ${method}: ${body.error.message}`);
  return body.result;
}

export default async function (pi: any) {
  await rpc("initialize", {protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {name: "rush-pi", version: "1"}});
  const {tools} = await rpc("tools/list", {});
  for (const tool of tools) {
    pi.registerTool({
      name: `mcp__${server}__${tool.name}`,
      label: `${server}: ${tool.name}`,
      description: tool.description,
      parameters: tool.inputSchema,
      async execute(_id: string, params: object) {
        const result = await rpc("tools/call", {name: tool.name, arguments: params});
        const text = result.content.map((part: any) => part.text).join("\n");
        if (result.isError) throw new Error(text);
        return {content: [{type: "text", text}], details: result.structuredContent};
      },
    });
  }
}
