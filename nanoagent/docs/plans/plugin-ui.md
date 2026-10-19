# Plan: plugin front ends (`ui/`, protocol `nanoagent.ui/v1`)

Every plugin's page is NanoAgent's: a chat with the plugin's agent, in which each task the agent
runs shows its typed output (docs/plans/ai-native-plugins.md). Mochi shows the page in a
sandboxed iframe. The page reaches NanoAgent only through a small `postMessage` bridge that
Mochi hosts, so it has no access to Mochi's session, cookies or the network. A plugin's `ui/`
only says how to draw its outputs.

## 1. The rule (NanoAgent, `nanoagent.plugin.manifest`)

- `ui/` joins `REQUIRED_FOLDERS`. `ui/renderers.js` and `ui/renderers.css` must exist, and
  `ui/index.html`, `ui/kit/`, `ui/app.js` and `ui/app.css` must not: the page is NanoAgent's.
- `ui/renderers.js`'s default export is an object literal of renderers, keyed only by the output
  classes of the plugin's tasks, checked when the plugin loads.
- Every script imports only by a literal `./` or `../` path, of the kit's modules or the plugin's
  own files in `ui/`: no URLs, no package names, no computed `import()`.
- A renderer draws only its output, with the kit's modules: no script names `document`, `window`,
  `parent`, `fetch` or the other page, host and network globals in `UI_GLOBALS` (comments and
  strings aside), and none reaches for `.ownerDocument`, `.parentNode`, `.host` or the other ways
  out of its output in `UI_PROPERTIES`. The kit draws each renderer's output in a closed shadow
  root of its own, with
  `kit.css` and `renderers.css`, the only place `renderers.css` applies: the plugin's styles
  reach nothing around its output, so the page's layout is the same for every plugin.
- `ui/` holds only static web files: `.html .js .mjs .css .svg .png .jpg .jpeg .gif .webp .ico
  .woff .woff2 .json .md`, at most 5 MB in total. Nothing is built at load time; a plugin that
  uses a bundler commits the built files.
- `nanoagent plugin new` writes `renderers.js` exporting `{}`: every output is drawn from its
  JSON Schema until the plugin draws one itself.

## 2. NanoAgent web endpoints

All require the operator bearer token, like every `/v1` route.

- `GET /v1/installs/{sha256}`: an installed plugin's catalog entry; each task entry also carries
  `inputSchema` (the task's input JSON Schema).
- `GET /v1/installs/{sha256}`: the plugin also carries `uiVersion`, a digest of its `ui/`.
- `GET /v1/installs/{sha256}/ui/{uiVersion}/{path}`: a file from the plugin's `ui/` at its
  current version (any other is 404), cached forever (`immutable`), with its content type and this Content-Security-Policy:
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'` (no `frame-ancestors`: who may
  frame the page is the host's choice, and its site and API may be different origins).
  A path outside `ui/` is 404.
- `POST /v1/workspaces/{workspace_id}/installs/{sha256}/runs`, body `{"input": "..."}`: a
  prompt to the plugin's agent, in that workspace, as an SSE stream; each of the agent's tools is
  one of the plugin's tasks, run the verified way (`nanoagent.plugin.tasks.run_task`).

## 3. The Mochi host

- The apps page shows the plugin's page in
  `<iframe sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox" src="/api/apps/{id}/ui/{uiVersion}/index.html">`
  in place of the chat box. No `allow-same-origin`, so the page has an opaque origin; its links
  open in a new tab.
- `/api/apps/{id}/ui/*` proxies NanoAgent's UI route with the server's token and passes the CSP
  header through. It is public (no login): a sandboxed page's subresource requests carry no
  cookies, and the files are the plugin's published assets.
- A bridge host component answers the page's requests (below) with the signed-in user's
  workspace, through Mochi's existing server routes.
  It accepts messages only from that iframe (`event.source === iframe.contentWindow`) and posts
  replies to it with target origin `*` (the page's origin is opaque).

## 4. The bridge protocol `nanoagent.ui/v1`

Every message is a JSON object with `protocol: "nanoagent.ui/v1"`.

- Page → host request: `{protocol, id, method, params}`; `id` is a string the page chooses.
- Host → page reply: `{protocol, id, result}` or `{protocol, id, error: {message}}`.
- Host → page event: `{protocol, event, runId, data}`.

Methods:

| method | params | result | events |
|---|---|---|---|
| `describe` | `{}` | `{plugin, workspace: {id}, theme: "light"\|"dark"}` (`plugin`: the catalog entry, tasks with `inputSchema`; with `latest`, its newest version, when the host can update it, and `repository` and `latestRepository`, `{owner, repo, path, commit}` on GitHub, of the version it runs and the newest, when they were published from one) | — |
| `prompt` | `{text}` | `{runId}` | `chat.reasoning {text}`, `chat.delta {text}`, `chat.tool.started {id, name}`, `chat.tool.progress {id, name, event, data}` (a task's `task.reference {tool}`, `task.tool {name, isError}`, `task.delta {kind, text}` and `task.result {}` while it runs), `chat.graph {patch}` (a change to the turn's provenance graph, `nanoagent.plugin.provenance`, as it is made) and `chat.graph {graph}` (the whole graph once the turn ends), `chat.tool {id, name, arguments, output, isError}`, `chat.answer {text}`, `chat.error {message}`, `chat.restart {}` (the stream dropped and the run is followed again from its first event), `chat.turn {turn}` (it ended while the stream was down: the turn the session kept), `chat.done` |
| `follow` | `{}` | `{runId, prompt}` | as `prompt`'s, for the message the current session was still answering when it was resumed (`running`) |
| `cancel` | `{runId}` | `{}` | — |
| `sessions.list` | `{}` | `{sessions: [summary]}`, each `{id, pluginId, title, createdAt, updatedAt, archivedAt, runs, cost, ttftS, running}`, archived ones too; `running` is whether it is answering a message | — |
| `session.get` | `{id}` | `{session}`: the summary with `chat` and `calls` (every run, with its cost and timings) | — |
| `session.start` | `{}` | `{session}`, a new one with `chat: []`; it becomes the current session. The kit sends it on a new session's first `prompt` | — |
| `session.resume` | `{id}` | `{session}`, with `running: {prompt}` while it is still answering a message, else null; it becomes the current session, and `prompt` continues its conversation | — |
| `session.archive` | `{id, archived}` | `{session}` (its summary); an archived session leaves the Dashboard's list for its Archived view until it is restored (`archived: false`) or chatted in again | — |
| `plugin.version` | `{version}` | `{version, latest, repository, latestRepository}`: the person runs `version` from now on, or with `version` null follows the newest; the host opens the page again when the version changed. The Dashboard's header shows the version, a link to its source, and when a newer one is out What's new (GitHub's comparison of the two commits) and Update | — |

`prompt` is today's chat: a free-form message to the plugin's agent; the session keeps the
conversation (its last 12 turns, each `{prompt, answer, tools, activity, error}`, `activity`
being what the agent did on the way, in order: each `{kind: "thought", text}` and each finished
task's `{kind: "task", name, steps, thinking, text}`). `prompt` runs in the
current session, and the host refuses it until a session is started or resumed. A run is the
host's, not the page's: a page closed, reloaded or left mid-answer leaves it going, and a page
that resumes the session meanwhile shows the message being answered and `follow`s it to its end.
Mochi restarting does not stop it either, nor RUSH Lab's connection dropping for less than ten
minutes: RUSH Lab holds the run and hands it to the Mochi it reconnects to. Every message ends
as a turn: answered, or with `error` saying why not (it failed, was stopped, or RUSH Lab quit or
was away longer), which the agent's conversation leaves out. Only `cancel` stops a run, and a
session answers one message at a time. The host also sends `{protocol, event: "host.theme",
data: {theme}}` when the site's theme changes.

## 5. The UI kit and the page

A page is served from one URL folder, `ui/{uiVersion}/`, holding NanoAgent's page and the
plugin's renderers:

```
src/nanoagent/plugin/v0001/page/   the spec's, served to every v0001 plugin
  index.html     loads kit/kit.css, preloads renderers.css, loads kit/boot.js as a module
  kit/
    boot.js        mounts the page with renderers.js's default export
    components.js  the one import a renderer needs (re-exports what renderers use)
    bridge.js      the nanoagent.ui/v1 client
    shell.js       the frame: Dashboard and Session tabs
    session.js     sessions and the Dashboard
    chat.js        the chat
    result.js      a task's result: the card, and the view drawn from a JSON Schema
    dom.js  display.js  markdown.js
    kit.css        the look: Mochi's tokens, light and dark, narrow widths
<plugin>/ui/                 the plugin's
  renderers.js   its renderers, by output class name (`{}` in the template)
  renderers.css  their styles (a comment in the template)
  ...            any other static files they need (their own .js modules, images, fonts)
```

A plugin ships only its own files; every plugin gets the kit of the NanoAgent that serves it,
so a kit change reaches every plugin when NanoAgent is deployed, and a plugin's package never
goes stale. `uiVersion` digests both halves, so a new kit is a new URL.

### Dashboard and Session

The kit's frame (`mountApp`, `kit/shell.js`) has two tabs, the same for every plugin:

- **Dashboard**, where the app always opens. It lists the member's sessions with this plugin in
  this workspace (Mochi keeps them in PostgreSQL), newest first, each with when it was last
  used, its runs, cost and time to first token; clicking one resumes it, and its Runs button
  shows each run. "New session" opens a new one.
- **Session**: the chat, always one click away: the tab shows the open session or, with none
  open, a new one. A new session is the page's alone until it first chats: only then does the
  kit ask the host to start it (`session.start`, sent from `request` in `kit/bridge.js`), so
  opening an app and leaving it keeps nothing. The host keeps the session's conversation, task
  results included, so a resumed session shows it again and continues it.

### The chat and its results

A person says what they need. The plugin's agent has one tool per task (named by the task's id,
taking its input, described by its description), runs the task the verified way, and answers in
a sentence or two. The Session page has two columns: the chat on the left, and on the right
the result of one task call (`resultsPane`, `kit/result.js`). Each task the agent ran shows above
its answer as a chip, named for the task and marked with whether it passed its check; picking a
chip shows its result card on the right, and the latest result shows there as it arrives and
when a session is resumed. A frame narrower than 760 px stacks the result over the chat. The
result card (`resultCard`) holds the task's description, its verdict as a badge ("Checked", or
"Check failed" with the verifier's message), and its output. A task that failed says why, in the
chat.

The output is drawn by the plugin's renderer for its output class, when `renderers.js` has one,
and otherwise from the task's `outputSchema` (`schemaView`): an object as labelled fields (the
field names humanized, their descriptions as tooltips), a list of objects as a table of its
scalar fields with the rest under each row, a list of anything else as a list, text (a link when
it is one, a paragraph when it is long), numbers, and yes or no.

```js
// ui/renderers.js
import { h } from "./kit/components.js";

export default {
  NoteOutput: (note, { verdict, send }) =>
    h("div", { class: "row" }, h("code", { text: note.path }), h("button", { class: "button small", text: "Read it", onclick: () => send(`Read ${note.path}`) })),
};
```

A renderer is `(value, {task, verdict, send}) => Element`: `value` is the output, an instance
of the class as JSON; `send(text)` sends a message as if the person typed it. The kit refuses
a renderer named for a class no task outputs.

### The kit's API for renderers

`kit/components.js` exports:

| From | Exports |
|---|---|
| `dom.js` | `h(tag, attrs, ...children)`, `icon(name)` (`ICON_NAMES`), `humanize`, `formatDuration`, `plural` |
| `display.js` | `statusPill` (tones `ok`, `warn`, `bad`, `info`, `neutral`, `TONES`; always words, optionally the tone's icon), `disclosure`, `dataTable` (sortable, filterable, "Show all N", one card per row when its container is narrow) |
| `markdown.js` | `markdown(text)`: Markdown as DOM nodes, never HTML |
| `result.js` | `schemaView(value, schema)`, the generic view, e.g. for part of an output |

`kit.css` gives the look and these variables for a renderer's styles: `--bg`, `--surface`,
`--surface-2`, `--border`, `--border-strong`, `--text`, `--muted`, `--accent` (`#3b5998`, dark
`#8ea6d6`), `--accent-strong`, `--accent-soft`, `--on-accent`, `--ok`, `--warn`, `--bad`,
`--neutral` and their `-soft` backgrounds, `--up`, `--down`, `--mark`, `--focus`, `--shadow`,
`--shadow-lg`, `--radius-sm` (10 px), `--radius` (16 px), `--radius-lg` (20 px),
`--radius-pill`, `--sans` (Inter, then the system stack), `--mono`; a `tone-<name>` class sets
`--tone` and `--tone-soft`. Classes a renderer may use directly: `button` (`primary`, `ghost`,
`small`), `input`, `card`, `pill`, `stack` (a vertical grid),
`row` (a wrapping flex row), `muted`, `small-text`, `numeric`, `visually-hidden`. Narrow screens start at 640 px.

Fonts: CSP `font-src 'self'` means a font must ship in `ui/`. The kit names Inter first and
falls back to the system stack.

Previewing a page needs a host: a throwaway page outside the repo that frames a copy of the
page with the same `sandbox`, serves it with CORS (module scripts of an opaque-origin frame are
fetched in CORS mode) and answers the bridge from recorded fixtures.
