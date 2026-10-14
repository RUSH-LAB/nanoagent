# Railway deployment

This directory is the complete configuration bundle for NanoAgent's private Railway service, which
offers Mochi's marketplace its plugin packages. It runs no model or plugin: every run is on a
member's own computer, through Mochi Lab.

- `nanoagent.yaml` configures the web host and selects the default profile.
- `profiles/` contains the server-approved model–harness pairings exposed by that host.

The container starts it with:

```bash
python -m nanoagent web web_cfg=deploy/railway/nanoagent.yaml
```

Required environment variables:

```dotenv
NANOAGENT_API_TOKEN=...
```

`PORT` is optional and defaults to `8787`.
