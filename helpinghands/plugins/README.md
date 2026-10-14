# Plugins

A tool in this codebase is a directory under `plugins/`. Nothing lists it: the
site finds it by looking, so **adding a tool is adding a directory**.

```bash
npm run new:plugin -- reading-list
```

That copies `_template/` into `plugins/reading-list/`, and the tool is live on
the next `npm start`: its page is routed, its endpoints answer, and its name is
in the Cmd+K palette and the CLI. Delete the halves it does not have, then write
the one it does.

## What a directory contains

One conventional filename per contribution. Every one of them is optional, and a
plugin that fills none is inert but legal.

| File | Contributes | Loaded by |
|---|---|---|
| `plugin.json` | Title, description, deployment-level `enabled`, `scope`, `options`, and for a server half `apiVersion` and `requires`. **Required** — it is what makes the directory a plugin | `loader.js` |
| `index.js` | The build half: a Docusaurus plugin factory. Pages, global data, the command | `docusaurus.config.js` |
| `server.js` | The API half: endpoints, and what it lends the rest of the server | `src/server/plugins.js` |
| `remark.js` | Markdown syntax, added to the chain every content page is parsed with | `docusaurus.config.js` |
| `client.js` | Browser-side MDX components exported as `components` | `plugins/client-components.js` |
| `components/`, `lib/`, anything else | The plugin's own business | The plugin |

Discovery is alphabetical by directory name, and therefore stable. It matters in
both directions: the server runs route modules in order and the first to answer
wins, and the remark chain transforms each page in order.

A directory whose name starts with `_` or `.` is skipped, which is what makes
`_template/` a template. A plugin that throws while loading is reported on the
console and skipped, so one broken tool never costs the whole site.

### `plugin.json`

```json
{
  "title": "Reading List",
  "description": "One line about what this tool is for",
  "enabled": true,
  "scope": "workspace",
  "apiVersion": 1,
  "requires": ["cache", "storage", "ai", "process"],
  "commands": ["lake"],
  "runtimeRemark": true,
  "safeComponents": {"ExampleWidget": {"name": "string", "open": "boolean"}},
  "options": {}
}
```

The name is the directory name, not a field, so the two can never disagree.
`options` is handed to `index.js` as its second argument and may configure only
the installed implementation. It must never contain one workspace's data.
`"enabled": false` removes the tool from the whole deployment, both halves at
once. `"scope": "workspace"` (the default) lets an owner disable the installed
tool for that workspace through validated `workspace_settings`; `platform`
plugins ignore workspace enablement. `apiVersion`
and `requires` are the server half's half of the bargain and are covered under
[What a plugin is handed](#what-a-plugin-is-handed); a plugin that is only pages
and markdown declares neither.

`safeComponents` is the request-time Markdown contract. It names only the
components and static prop types (`string`, `boolean`, `number`, or
`stringOrBoolean`) that untrusted workspace documents may render.
`runtimeRemark: true` opts a remark extension into that same constrained parser.
`commands` is required with the `process` capability and is the executable
allowlist for that plugin.

Plugin code, dependencies, routes, capability grants, safe-component schemas,
and subprocess allowlists are trusted deployment state. Plugin enablement and
the records/assets it owns are workspace state. A workspace can never supply a
module path, package, command, or JavaScript option.

## The extension points

**A page.** `index.js` registers it with `addRoute`, pointing at a component in
the plugin's own `components/`:

```js
addRoute({path: '/reading-list', component: '@site/plugins/reading-list/components/Page', exact: true});
```

**A way in.** Put a `command` in the plugin's global data and both launchers
list it; neither `src/components/CommandBar` nor `CommandPalette` is edited to
add a tool. `icon` is a key into `src/components/commands.js` rather than an SVG,
because global data has to survive being serialized.

```js
setGlobalData({...content, command: {
  id: 'reading-list', name: 'reading-list', category: 'Tools', icon: 'book',
  title: 'Reading List', description: 'What to read next', href: '/reading-list',
}});
```

**Endpoints.** `server.js` exports a `(req, res, url, pathname, api)` function.
The shape matches a core route module's, because a plugin's endpoints are not a
different kind of endpoint; the last argument does not, and that is the subject
of the next section. Answer with `api.respond` and return; the dispatcher detects
a sent response through `res.writableEnded`. Fall through silently for anything
the plugin does not own. Plugin routes run *after* the core ones: a plugin
extends the site, it does not get to shadow the routes the site is made of.

**Markdown syntax.** `remark.js` exports a remark plugin factory. It runs after
`remark-math`, so math is already out of the tree. See
`bibliography/remark.js` (`[@key]`) and `wiki-links/remark.js` (`[[page]]`).

**MDX components.** `client.js` exports a `components` object. The browser
registry discovers these modules and merges them into the site's MDX component
map, so a plugin owns its renderer without adding an import under `src/`.

### Lending data to the rest of the server

`server.js` may also export `provides`, merged into what every plugin sees as
`api.shared` and every core handler sees on `ctx`:

```js
module.exports.provides = {references: {...}};
```

This is how one plugin's data reaches code that is not part of it. The core
handlers that answer questions about the bibliography read that rather than
reaching into `plugins/` with a relative require. The rule that makes
it work: a core handler must **degrade honestly** when no plugin provides its key
(`src/server/index.js` falls back to an empty bibliography), because a plugin can
be removed and the site has to survive it.

## What a plugin is handed

`server.js` does not get `ctx`. It gets the narrow API in
`src/server/plugin-api.js`, built per request from the capabilities its
`plugin.json` asks for. A plugin holding `fs` could read the whole repository,
and a plugin reading `ctx` would break on any rename in core.

Always there: `respond`, `stream`, `readBody`, `rateLimit`, `caller`, `shared`,
`sanitize`. Everything else has to be asked for:

| `requires` | Grants |
|---|---|
| `cache` | `cache`, `invalidateCache`, keyed under the plugin's own name |
| `content:read` | async `content.read`, `content.list`, `content.stat`, `content.exists`, and `content.walk` over database documents in the verified workspace |
| `network` | `fetch`, with a timeout, refusing calls back into this server |
| `storage` | `storage.read`/`storage.write`, in the plugin-and-workspace corner of `var/` |
| `records` | workspace-scoped collections namespaced to the plugin |
| `blobs` | workspace-scoped PostgreSQL asset metadata and object bytes plus bounded raw request bodies |
| `ai` | async `ai.complete` and `ai.describe`, on the NanoAgent of the member's own computer |
| `process` | `exec`, restricted to declared `commands` and a cwd inside the plugin |

A capability the manifest did not ask for is simply absent, so reaching for one
fails on that plugin's first request rather than quietly acquiring reach nobody
granted. `apiVersion` is the promise the server makes back: declare the version
`plugin-api.js` implements, or the server refuses to load the server half.

```json
{"title": "Reading List", "apiVersion": 1, "requires": ["cache", "storage"]}
```

Remark plugins may use `plugins/_shared/markdown`, which belongs to the plugin
host rather than to `src`. In `index.js`, take the repo root from
`context.siteDir` rather than resolving from `__dirname`, so the plugin survives
being moved.

## Testing

Tests mirror the tree: `tests/unit/plugins/<name>/`. The plugin system's own
tests are in `tests/unit/plugins/loader/`, and one of them scaffolds `_template`
and loads it, so a template that stops satisfying the contract fails the suite.

```bash
npm test          # unit
npm run build     # the build half really building
```
