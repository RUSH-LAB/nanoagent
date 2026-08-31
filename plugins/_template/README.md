# __TITLE__

One line about what this tool is for.

Generated from `plugins/_template` by `npm run new:plugin -- __NAME__`. Nothing
lists this plugin anywhere: the site found it by looking, so the first thing to
do is delete the halves this tool does not have.

| File | Contributes | Delete it if |
|---|---|---|
| `plugin.json` | Title, description, `enabled`, `options` | Never — it is what makes the directory a plugin |
| `index.js` | Pages, global data, the Cmd+K command | The tool is API-only |
| `server.js` | `/api/__NAME__/*` endpoints, `provides` | The tool is build-only |
| `remark.js` | Markdown syntax | The tool adds no syntax (most do not) |
| `components/` | The pages `index.js` routes | There are no pages |

Then:

1. Write the real thing. `lib/` is yours for logic both halves share.
2. Add tests under `tests/unit/plugins/__NAME__/`.
3. `npm test && npm run build`.

The contract these files implement is written down in `plugins/README.md`.
