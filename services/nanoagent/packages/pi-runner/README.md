# `@nanoagent/pi-runner`

Companion process that exposes `@earendil-works/pi-agent-core` through NanoAgent's JSONL runner
protocol. Install it beside the NanoAgent server (or put its bin on `PATH`) and configure a
server-owned profile:

```yaml
profiles:
  pi-sonnet:
    label: Claude Sonnet · PI
    model: anthropic/claude-sonnet-4
    harness:
      type: pi
      command: [node, packages/pi-runner/dist/index.js]
      cwd: null
      options:
        provider: openrouter
        api_key_env: OPENROUTER_API_KEY
        thinking_level: "off"
    model_overrides: {}
```

Model credentials are read from the named server environment variable; they are never accepted
from a run request. User/assistant history is preserved in the one-shot prompt; tools remain
disabled at the bridge.
