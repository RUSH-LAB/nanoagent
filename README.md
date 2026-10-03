# nanoagent

Install:

```bash
uv sync
```

Run:

```bash
uv run nanoagent --help
```

## Software packages

NanoAgent can load a directory containing a `nanoagent.yaml` manifest, inspect
its tasks, and invoke its tools through a small JSON-lines subprocess protocol:

```bash
uv run nanoagent software inspect ../arxiv-source
uv run nanoagent software run ../arxiv-source save-paper-source \
  arxiv_id=1706.03762 destination=downloads/attention
```

Each declared software tool is also available as a regular NanoAgent `Tool`
through `nanoagent.software.software_tools`.

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
