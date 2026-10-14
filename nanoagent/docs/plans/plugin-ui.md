# Plan: plugin front ends (`ui/`, protocol `nanoagent.ui/v1`)

Every plugin ships its own front end: a static web page in `ui/`. Mochi shows it in a sandboxed
iframe in place of today's fixed chat box. The page reaches NanoAgent only through a small
`postMessage` bridge that Mochi hosts, so a plugin has full freedom over its interface and no
access to Mochi's session, cookies or the network.

## 1. The rule (NanoAgent, `nanoagent.plugin.manifest`)

- `ui/` joins `REQUIRED_FOLDERS`. `ui/app.js` and `ui/app.css` must exist, and `ui/index.html`
  and `ui/kit/` must not: NanoAgent serves its own.
- `ui/app.js` has a default export, the page's layout.
- Every script imports only by a literal `./` or `../` path, of the kit's modules or the plugin's
  own files in `ui/`: no URLs, no package names, no computed `import()`.
- `ui/` holds only static web files: `.html .js .mjs .css .svg .png .jpg .jpeg .gif .webp .ico
  .woff .woff2 .json .md`, at most 5 MB in total. Nothing is built at load time; a plugin that
  uses a bundler commits the built files.
- `nanoagent plugin new` ships a default page (section 5), so every plugin starts with one.
  `ui/app.js` and `ui/app.css` are the plugin's own page; NanoAgent serves it with its own
  `index.html` and shared UI kit `kit/`.

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
- `POST /v1/workspaces/{workspace_id}/installs/{sha256}/tasks/{task_id}/runs`, body
  `{"arguments": {...}}`: runs one task the verified way, in that workspace, as an SSE stream.
  - `runner: tool`: the tool, then `verify_task`.
  - `runner: agent`: the reference tool (pinned), then an agent with the web host's model and only
    the task's tools, then `verify_task`.
  - Events, each `data:` a JSON object with `type` and `runId`:
    `task.started {task}`, `task.reference {tool}`, `task.tool {name, arguments, output, isError}`,
    `task.answer {text}`, `task.result {response}` (tool runner), `task.verdict {valid, score,
    message, details}`, `task.error {message}`, and last always `task.done`.
  - Arguments name workspace files by their path in the workspace.
- `DELETE /v1/runs/{run_id}` (existing) also cancels a task run.

## 3. The Mochi host

- The apps page shows the plugin's page in
  `<iframe sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox" src="/api/apps/{id}/ui/{uiVersion}/index.html">`
  in place of the chat box. No `allow-same-origin`, so the page has an opaque origin; its links
  open in a new tab.
- `/api/apps/{id}/ui/*` proxies NanoAgent's UI route with the server's token and passes the CSP
  header through. It is public (no login): a sandboxed page's subresource requests carry no
  cookies, and the files are the plugin's published assets.
- A bridge host component answers the page's requests (below) with the signed-in user's
  workspace, through Mochi's existing server routes (new ones proxy the task-run endpoint).
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
| `describe` | `{}` | `{plugin, workspace: {id}, theme: "light"\|"dark"}` (`plugin`: the catalog entry, tasks with `inputSchema`) | — |
| `runTask` | `{task, arguments}` | `{runId}` | the `task.*` events of section 2 |
| `prompt` | `{text}` | `{runId}` | `chat.delta {text}`, `chat.tool {name, arguments, output, isError}`, `chat.answer {text}`, `chat.error {message}`, `chat.done` |
| `cancel` | `{runId}` | `{}` | — |
| `sessions.list` | `{}` | `{sessions: [summary]}`, each `{id, pluginId, title, createdAt, updatedAt, runs, cost, ttftS}` | — |
| `session.get` | `{id}` | `{session}`: the summary with `state`, `chat` and `calls` (every run, with its cost and timings) | — |
| `session.start` | `{}` | `{session}`, a new one with `state: null` and `chat: []`; it becomes the current session. The kit sends it on a new session's first `runTask`, `prompt` or `session.save` | — |
| `session.resume` | `{id}` | `{session}`; it becomes the current session, and `prompt` continues its conversation | — |
| `session.save` | `{state, title?}` | `{}`: keeps the current session's state (any JSON, at most 256 KB) and title (at most 200 characters) | — |
| `workspace.list` | `{}` | `{files: [{path, size}]}` | — |
| `workspace.read` | `{path}` | `{text}` for UTF-8 text, otherwise `{base64}` | — |
| `workspace.write` | `{path, text}` or `{path, base64}` | `{}` | — |

`prompt` is today's chat: a free-form message to the plugin's agent; the session keeps the
conversation (its last 12 turns). `runTask` and `prompt` run in the current session, and the host
refuses them until a session is started or resumed. The host also sends `{protocol, event: "host.theme", data:
{theme}}` when the site's theme changes.

## 5. The UI kit and a plugin's page

A page is served from one URL folder, `ui/{uiVersion}/`, holding NanoAgent's frame and the
plugin's own page:

```
src/nanoagent/plugin/page/   NanoAgent's, served to every plugin
  index.html     loads kit/kit.css, then app.css, then app.js as a module
  kit/
    components.js  the one import a page needs (re-exports every module below)
    bridge.js      the nanoagent.ui/v1 client
    dom.js  display.js  inputs.js  run.js  chat.js  markdown.js  workspace.js  forms.js  shell.js
    kit.css        the look: Mochi's tokens, light and dark, narrow widths
plugins/<id>/ui/             the plugin's
  app.js         the plugin's page, its default export
  app.css        the plugin's own styles (near-empty in the template)
  ...            any other static files the page needs (its own .js modules, images, fonts)
```

A plugin ships only its own files; every plugin gets the kit of the NanoAgent that serves it,
so a kit change reaches every plugin when NanoAgent is deployed, and a plugin's package never
goes stale. `uiVersion` digests both halves, so a new kit is a new URL.

### Dashboard and Session

The kit's frame (`mountApp`, `kit/shell.js`) has two tabs, and the plugin designs only one:

- **Dashboard**, where the app always opens: the kit's own, the same for every plugin, and `ui/`
  changes nothing here. It lists the member's sessions with this plugin in this workspace
  (Mochi keeps them in PostgreSQL), newest first, each with when it was last used, its runs,
  cost and time to first token; clicking one resumes it, and its Runs button shows each run.
  "New session" opens a new one.
- **Session**: the plugin's page, always one click away: the tab shows the open session or,
  with none open, a new one.
  Opening a session calls `app.js`'s default export as `layout({plugin, workspace, session})`
  and shows what it returns. A new session is the page's alone until it first runs a task,
  chats or saves: only then does the kit ask the host to start it (`session.start`, sent from
  `request` in `kit/bridge.js`), so opening an app and leaving it keeps nothing. `session` holds
  `id` (`null` until a new session starts), `title`, `state` (what the page last saved, `null` in a new session) and `chat` (the
  conversation so far), and `session.save(state, {title})` keeps the state, and a title,
  which names the session on the Dashboard. A page restores itself from `session.state`, so a person who
  leaves comes back to where they were.

The template's `app.js` exports `chatLayout`: the whole page is a chat over `prompt`, with the
plugin's icon, name and tagline until the first message; the agent's tool calls are not shown.

### How a plugin designs its page

A page is one of two shapes. A plugin whose use is open-ended keeps the template's chat
(`chatLayout`). Every other page is designed around what a person comes to do, in an
`appShell`, and must:

- ask for the task's inputs, in their words, with real controls (a date, a file, a few choices);
- run the task with one primary button (`runButton`, `taskRun`), its progress as plain steps
  and a Stop;
- show the result, with the verifier's verdict in plain words (`verdictBanner`) and errors in
  plain words (`errorCard`);
- never show tools, tool names, task ids or JSON to users;
- work in both themes and down to 320 px wide.

Chat with the plugin's agent may stay available in a drawer from the header ("Ask the agent").

```js
import { appShell, taskRun, runButton, verdictBanner, errorCard } from "./kit/components.js";

export default ({ plugin }) => {
  const shell = appShell({ plugin, chat: { suggestions: ["What can you do?"] } });
  const result = document.createElement("div");
  const run = taskRun({
    task: "my-task",
    steps: [{ id: "read", label: "Reading your file" }, { id: "check", label: "Checking the answer" }],
    onEvent: (name, data, run) => { if (name === "task.answer") run.step("check"); },
    onFinish: (outcome) => result.replaceChildren(outcome.verdict
      ? verdictBanner(outcome.verdict)
      : errorCard({ message: outcome.error ?? "The run ended without a check." })),
  });
  const go = runButton({ label: "Check my file", run, onClick: () => run.start({ path: "inputs/file.txt" }) });
  shell.main.append(go.element, run.element, result);
  return shell.element;
};
```

### The kit's API

Every export has JSDoc in its module; components return `{element, ...}` with a small API
(read, set, disable), except pure builders that return an Element.

| Module | Exports |
|---|---|
| `bridge.js` | `request(method, params)`, `startRun(method, params, onEvent)` (events through `*.done`, early ones buffered), `on(event, handler)`, `hasHost()`, `PROTOCOL` |
| `dom.js` | `h(tag, attrs, ...children)`, `icon(name)` (`ICON_NAMES`), `applyTheme`, `announce(text)` (screen readers), `humanize`, `pretty`, `formatSize`, `formatDuration`, `plural`, `nextId` |
| `shell.js` | `mountApp(layout)` (describe, theme, `host.theme`, a plain message outside a host or when the host is silent; `layout` may be async), `appShell({plugin, nav, actions, chat, width})` (header with icon, name, tagline, chat button; `main` for the page; `drawer`), `chatLayout(context, options)` (the default page: a full-page `chatPanel` with `options`) |
| `chat.js` | `chatPanel({intro, placeholder, suggestions, prepare, render, onTurnDone})` (answers as Markdown; `render[tool](output, {arguments, send})` draws a tool's result above the answer, and the session keeps it; suggestion chips fill the box, never send; `prepare` adds the page's context), `chatDrawer({title, note, ...})` (right panel on wide screens, full-screen sheet under 640 px, focus trap, Escape, focus returns to the opener) |
| `markdown.js` | `markdown(text)`: Markdown (paragraphs, headings, lists, quotes, fenced code, inline code, bold, italics, links) as DOM nodes, never HTML |
| `run.js` | `taskRun({task, title, steps, onEvent, onFinish})`: runs `runTask` with a progress card (forward-only steps with detail lines, progress bars and notes, elapsed time, Stop) and resolves with the outcome `{status: valid\|invalid\|error\|cancelled\|unchecked, verdict, error, answer, result, tools (with parsed outputs), seconds, startFailed}`; `runButton({label, onClick, run, cancelWhileBusy, note, block})` with `setBlocked(reason)`; `verdictBanner(verdict, words)` (plain words, score in words, raw message and details under "Details"); `explainError(message, rules)`, `errorCard({message, rules, title, actions})`, `COMMON_ERRORS` (stopped, maintenance, timeouts, network); `parseToolOutput`; developer views `taskView`, `runControls`, `toolItem`, `verdictView`, `block` |
| `inputs.js` | `labeled` (label, hint, inline error), `segmented` (one of a few; also filter chips with counts), `chipToggles` (several on/off), `chipRow` (presets, quick picks, examples, saved runs; scrolls sideways), `chipsInput` (a list of short strings), `numberStepper`, `dateInput` (quick-pick chips, checks with a one-click fix), `isoDate({timeZone, days})`, `fileDrop` (drop, choose, paste or pick a workspace file; checked with `inspect`, written to a fixed path with `workspace.write` at once; `restore()` shows a file left by an earlier visit), `workspacePicker`, `copyText`, `copyButton` and `copyField` (say plainly when the sandbox refuses the clipboard) |
| `display.js` | `card` (16 px, `size: "large"` 20 px), `statusPill`, `banner` (tones `ok`, `warn`, `bad`, `info`, `neutral`; always an icon and words), `disclosure`, `meter` (a value with an optional target band), `dataTable` (sortable, filterable, "Show all N", one card per row when its container is narrow), `emptyState`, `howItWorks(plugin.product.steps)`, `skeleton`, `actionBar` (sticky at the bottom on narrow screens), `columns` (two columns, one under 880 px) |
| `workspace.js` | `listFiles({prefix, extensions})`, `readFile`, `readText`, `readJSON`, `writeText`, `writeJSON`, `jsonStore({path, version, initial})` (the page's state in one workspace file: the page has an opaque origin and no localStorage; serialized whole-file writes; never overwrites a file it can't read until `reset()`), `filesPanel` |
| `forms.js` | `schemaForm(inputSchema)`, `stringList` (for developer views) |

`kit.css` gives the look and these variables for a page's own styles: `--bg`, `--surface`,
`--surface-2`, `--border`, `--border-strong`, `--text`, `--muted`, `--accent` (`#3b5998`, dark
`#8ea6d6`), `--accent-strong`, `--accent-soft`, `--on-accent`, `--ok`, `--warn`, `--bad`,
`--neutral` and their `-soft` backgrounds, `--up`, `--down`, `--mark`, `--focus`, `--shadow`,
`--shadow-lg`, `--radius-sm` (10 px), `--radius` (16 px), `--radius-lg` (20 px),
`--radius-pill`, `--sans` (Inter, then the system stack), `--mono`; a `tone-<name>` class sets
`--tone` and `--tone-soft`. Classes a page may use directly: `button` (`primary`, `ghost`,
`small`, `large`, `block`, `icon-only`), `input`, `card`, `pill`, `chip`, `chips`, `stack`
(a vertical grid), `row` (a wrapping flex row), `muted`, `small-text`, `numeric`,
`visually-hidden`. Breakpoints: 640 px (narrow: icon-only chat button, sheet drawer, sticky
action bar, full-width run button) and 880 px (columns stack).

Fonts: CSP `font-src 'self'` means a font must ship in `ui/`. The kit names Inter first and
falls back to the system stack; it bundles no font file because `nanoagent plugin new` copies the
template as text. A plugin that wants Inter everywhere adds the `.woff2` files and an
`@font-face` rule in its own `app.css`.

Previewing a page needs a host: a throwaway page outside the repo that frames a copy of `ui/`
with the same `sandbox`, serves it with CORS (module scripts of an
opaque-origin frame are fetched in CORS mode) and answers the bridge from recorded fixtures.

## Build

1. NanoAgent: the rule, the endpoints, the shared task runner (also used by `nanoagent plugin
   run` / `agent`), tests.
2. In parallel: the Mochi host and bridge (agent), the template UI, the five plugins' UIs and the
   custom arxiv-source UI (agent).
3. Integrate and run it in a browser end to end.
