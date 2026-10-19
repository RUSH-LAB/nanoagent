# File system layout

The workspace file system ([workspace-filesystem.md](workspace-filesystem.md))
stores everything well, but the tree a member sees is the storage layout:
app records, chat bookkeeping and plugin blobs sit beside the workspace's
documents, folders are named by ids (`home/<userId>`, `chat/ch_<hex>`), and a
plugin's chats are not files at all. This plan gives the tree one rule for what
a person sees, one for who may write where, and makes every plugin chat a
folder.

## Rules

1. **A path segment starting with a dot is app state.** The Explorer, search,
   the laptop mirror and the `rush` CLI never show it, and `/api/fs` refuses to
   write it; only the service that owns it does. Sync clients already skip dot
   paths (src/runner/sync.mjs).
2. **Every other path is a person's file**, named for people, because the
   laptop mirror shows stored names as they are. Ids stay in node ids and in
   `.`-folders.
3. **Who may write is decided by the path, in the database.** `home/<x>/` is
   `x`'s: created only by `x`, always private to `x`, written only by `x` or by
   members of a share inside it. The rest of the root follows the workspace
   role.

## The tree

```
<root>                                  Explorer: the workspace's name
  <the workspace's documents and files> Book and Blog are folders here (pathPrefix)
  .apps/<app>/<key>.json                glossary, schedule, whiteboards, agents
  .plugins/<plugin>/records/<collection>/<key>.json   a site plugin's records
  .plugins/<plugin>/blobs/<uuid>.<ext>  a site plugin's blobs (e.g. bibliography PDFs)
  .plugins/.imported/<asset id>.<ext>   imported legacy blobs, which name no plugin
  .chat/<channel id>/…                  workspace chat, as fs/chat.js lays it out now
  .chat/.names/, .chat/.dms/            its registries
  home/<userId>/                        Explorer: My files (only your own is listed)
    <anything the member keeps>
    Plugins/<plugin>/                   what each run of <plugin> is given and writes
    Chats/<plugin>/<YYYY-MM-DD HH.MM> <title>/
      chat.json                         session id, plugin, title, page state, archived
      messages.json                     the conversation as an ATIF Trajectory
      graphs/<turn>.json                each turn's provenance graph
    From earlier runs/                  what home/<u>/files/ holds today
    .apps/<app>/<key>.json              bookmarks, tasks, notes, quicknotes, flashcards, reading lists
```

Shared nodes in other members' homes appear in the Explorer under **Shared
with me**, at their own names, without the `home/<id>` part.

A chat folder has the same shape as a NanoAgent run folder (`ChatLayout`:
`messages.json` beside the work), with the plugin's folder as the work, so a
chat reads the same in the site, on the laptop and in the CLI. Its folder is
renamed when its title changes; its node id, which `plugin_session` keeps,
does not.

## What changes

### Database (one migration)

- Moves, each logged as a move by no one so every sync client follows it (as
  0031 does):

  | From | To |
  |---|---|
  | `apps/<glossary\|schedule\|whiteboards\|agents>/…` | `.apps/<same>/…` |
  | `apps/<plugin>/<collection>/…` | `.plugins/<plugin>/records/<collection>/…` |
  | `.plugins/blobs/<id>` | `.plugins/.imported/<id>` |
  | `.plugins/<plugin>/<uuid>` | `.plugins/<plugin>/blobs/<uuid>` |
  | `chat/…` | `.chat/…` |
  | `home/<u>/<domain>/…` (per-user records) | `home/<u>/.apps/<domain>/…` |
  | `home/<u>/agent/<plugin>/…` | `home/<u>/Plugins/<plugin>/…` |
  | `home/<u>/files/…` | `home/<u>/From earlier runs/…` |

  The migration first checks that no target path is already taken, and stops
  with the list when one is: nothing is renamed around a member's own folder.
- Every `home/<u>` is set private and owned by `u`, its subtree's inherited
  access recomputed. This repairs any home an editor created first, which is
  then visible to the whole workspace (see Security).
- `fs_may_write`: under `home/<x>/` only `x`, or a member of a share that
  holds the path; `home/<x>` itself may be inserted only by `x`, private,
  owned by `x`. Elsewhere it is unchanged: owners and editors, and `.chat/` for
  every member.
- `plugin_session` becomes an index of chat folders: `folder_id` (the chat
  folder's node id) is added, and `chat` is dropped once every session is
  written to files and verified.

### Server

- `fs/records.js`, `fs/assets.js`, `fs/chat.js`, `fs/agent-sync.js` and
  `fs/import.js` use the new prefixes. `agentFolder` becomes `pluginFolder`,
  `home/<u>/Plugins/<plugin>`.
- `fs/store.js`: `ensureFolder` stops deciding a home's access, since the
  database does. The root reserves `home`.
- `routes/fs.js`: dot paths are refused for writes and left out of `tree` and
  `search` unless a service asks. Every member may write and delete inside
  their own home, viewers included, so RUSH Lab's sync of a viewer's home
  stops being refused and members can delete their own files. Deleting
  elsewhere still needs `content:delete`.
- `app-runs.js` and `postgres/sessions.js`: a session opens its chat folder
  when it is made. Each turn appends to `messages.json` and writes
  `graphs/<turn>.json`, as the member. The session routes read the chat from
  the folder and keep the same response shape, so the page kit does not
  change. The prompt still sends NanoAgent only the latest 12 turns, but the
  folder keeps every one.
- The two conflict-copy names become one:
  `name (conflicted copy <source> <YYYY-MM-DD>).ext`, where `<source>` is the
  host name for a sync and `<plugin> run` for a run.

### NanoAgent

- A plugin run's stream ends with the turn's trajectory as ATIF
  (`trajectory.completed`, beside `graph.completed`), built by the
  `to_atif` the CLI already uses. Mochi appends it to `messages.json`.
  Mochi never builds ATIF itself.
- A one-off script, `npm run fs:chats`, writes each existing session's turns
  to its chat folder. Old turns have no ATIF, so it converts their
  `{prompt, answer, tools}` into ATIF steps with NanoAgent's ATIF types, run
  through NanoAgent. Then it checks that every session reads back the same as
  before.

### RUSH Lab (relay)

- The laptop mirror is `~/RUSH Lab/<workspace slug>/` (`~/RUSH Lab Dev/` for
  the dev build; `files_folder` in desktop/config.yaml), without the GitHub
  login level. `.mochi/state.json` records the workspace and the member, and a
  folder of another member is never synced into: a second account on the same
  site is refused with a message, as a taken folder name is today.
- On first start the relay moves each `~/rushlab/<login>/<slug>/` it finds
  with a matching state file to the new root, once. Nothing is downloaded
  again.

### Explorer (components/Workbench)

- Three roots: the workspace (the root minus `home/` and dot paths), **My
  files** (`home/<me>`), and **Shared with me**. Plugin folders show their
  plugin's name. A chat folder opens its chat.
- Search, new-file targets and drag-in follow the same roots.

### Docs

- workspace-filesystem.md: the laptop path, and how a run's changes are
  attributed (written as the member, with only a conflict copy naming the
  run). The comments in 0022, `workspace-context.js` and `routes/apps.js`
  name `Plugins/<plugin>`.

## Security

Right now, an editor who writes `home/<bob>/x` before Bob has a home creates
Bob's home with workspace access: `ensureFolder` makes a home private only
for its own member (fs/store.js), `fs_may_write` lets editors write any path,
and `records.prepare` skips a home that already exists. Every member can then
read Bob's bookmarks and notes. The database rule above closes this, and the
migration repairs any home already made that way. This ships first, on its
own.

## Delivery

Each step has its tests and ships to devmode on its own.

1. **Home privacy.** The `fs_may_write` and home-insert rule, the repair, and
   a test where an editor tries to write another member's home.
2. **Zones.** The moves, the server prefixes, dot paths refused and hidden, and
   own-home writes for every member.
3. **Explorer roots.**
4. **Chats as files.** NanoAgent's `trajectory.completed`, chat folders,
   sessions as an index, and `fs:chats` for existing sessions, run against a
   local copy (`db:pull`) before production.
5. **Laptop folder.** The new root, the one-time move, one conflict name.
   Rebuild RUSH Lab Dev (`npm run desktop:dev`) and check there that the
   mirror moves, a run writes to `Plugins/<plugin>/`, and its chat appears
   under `Chats/`.
6. **Drop `plugin_session.chat`**, when the owner decides, after step 4 is
   verified on production.

## Not in this plan

- Apps as typed files (workspace-filesystem.md step 6). Records stay one JSON
  file per key, now hidden. When an app gets an editor, its records become one
  visible file of its type in My files or the workspace.
- Running a plugin directly in the laptop mirror instead of a scratch copy.
- Renaming NanoAgent's scratch "workspaces" and `plugin_run.folder`. Members
  never see either.
