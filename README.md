# nanoagent

Install:

```bash
uv sync
```

Run:

```bash
uv run nanoagent --help
```

## Plugins

NanoAgent plugins follow the strict `nanoagent.plugin/v1` directory contract.
NanoAgent validates their files, permissions and JSON schemas, then launches
the standard Python entrypoint from the committed uv lockfile through a
standard MCP stdio connection:

```bash
uv run nanoagent plugin inspect ../arxiv-source
uv run nanoagent plugin run ../arxiv-source save-paper-source \
  arxiv_id=1706.03762 destination=downloads/attention
```

Each declared plugin tool is also available as a regular NanoAgent `Tool`
through `nanoagent.plugin.plugin_tools`.

## Railway service

The repository includes a production container and private Railway service
configuration for Mochi Lab.

Required variables:

```dotenv
PORT=8787
OPENROUTER_API_KEY=...
NANOAGENT_API_TOKEN=...
```

Deploy the service without a public domain. Mochi connects over Railway's
private network using the same `NANOAGENT_API_TOKEN`.

Local development does not use this deployment unless `NANOAGENT_URL` is
explicitly set. Mochi's `npm start` uses the adjacent NanoAgent checkout.
