# Workspace file system

Every workspace becomes one versioned file system in the cloud. Everything a
person makes is a file in it; every app, plugin, agent, browser, and device is
a client of it. The Workspace page is the one place to see and manage files,
and published folders are readable by anyone at the site's domain.

## Why

Content is split today across `document`/`document_version`,
`asset`/`object_blob`, `reference`, the content domains of `store_item`, and
NanoAgent's local disk, behind the Book/Blog pages, the Files page, the
Workspace page, and one API per plugin. Nothing outside Mochi can see any of it
without an account, and NanoAgent's files do not survive a redeploy.

## Model

- A workspace is a tree of **nodes** (files and folders). A node has a stable
  id, so a rename or move keeps its history, links, and permissions.
- **Files are the source of truth; tables are indexes derived from them.**
  Search, backlinks, the citation graph, flashcard scheduling, and task lists
  are rebuilt from files by workers that follow the change log.
- **System state is not content** and stays in its services: identity,
  membership, sessions, presence, analytics, and audit.

## Storage (Neon PostgreSQL)

| Table | Holds |
|---|---|
| `fs_node` | `id`, `workspace_id`, `path`, `kind` (file/folder), `content_hash`, `size`, `content_type`, `access`, `access_inherited`, `rev`, creator and timestamps, `deleted_at` |
| `fs_content` | Content-addressed bytes per workspace, keyed by SHA-256. Small bodies inline; large ones may move to object storage (`object_key`) later without changing nodes. |
| `fs_change` | The append-only log: `seq`, `workspace_id`, `node_id`, `op` (create, write, move, delete, restore, access), paths, `content_hash`, actor, time. |

The change log is the backbone. Version history, trash, sync, audit of
content, and index rebuilds all read it; none needs its own mechanism.

## Access

- `access` is `workspace` (members), `private` (its creator), or `public`
  (anyone, signed in or not). A node inherits its folder's access unless set
  explicitly; the effective value is stored on every node and recomputed for a
  subtree when it changes, so a policy never walks ancestors.
- Row-level security on `fs_node` and `fs_content` enforces it, including for
  anonymous requests, which see only `public` nodes.
- **Publishing is a permission.** Book and Blog are folders whose access is
  `public`; the site renders them for every visitor, on the server, at stable
  URLs.

## API

`/api/workspaces/:id/fs/…` for members and `/api/public/:slug/fs/…` (read-only)
for everyone:

- `GET tree?prefix=`: nodes without bodies
- `GET file?path=`: the bytes, with `rev` as the ETag
- `PUT file?path=&baseRev=`: create or replace, refused when `baseRev` is stale
- `POST folder`, `POST move {from, to, baseRev}`, `DELETE node?path=&baseRev=`
- `PUT access {path, access}`
- `GET history?path=`, `POST restore {path, seq}`
- `GET changes?since=<seq>`: the change feed every sync client follows
- `GET events`: the workspace's push channel, batched changes and live Markdown
  updates as server-sent events; a client catches up from `changes` on reconnect

## Sync

One protocol: follow `changes` from a cursor, send operations with the
revision they were based on, merge by file type. Every client holds a partial
replica: the whole tree, contents fetched when opened or pinned, the least
recently used evicted.

- **Mergeable files** (Markdown and the apps' own types such as `.bib`,
  `.deck`, `.tasks`, `.whiteboard`, `.chat`) are CRDT documents (Yjs). Two
  concurrent edits merge; the same updates stream live to everyone who has the
  file open.
- **Binary files** keep last-write-wins with full history, and become a
  conflicted copy only when two edits truly collide.
- Clients: the browser (IndexedDB), the `mochi` CLI (a local folder caching
  the drive, minus the paths the user marks online only), Mochi Lab (the
  member's own home in each workspace, at `~/rushlab/<slug>/`), and **agents
  and plugins**, whose runs mount the folders
  they may use and sync their changes back attributed to the run. NanoAgent
  keeps nothing of its own.

## Apps

A plugin declares the file types it opens and creates and the folders it needs.
The Workspace Explorer opens a file with its app, as an operating system does;
plugin pages become editors of files instead of separate stores.

## Delivery

Each step ships on a feature branch with its tests; nothing deploys until the
site is re-enabled. Status as of 2026-10-07: steps 1–8 are built on
`site-cli-and-layout`; the desktop app is on hold.
As of 2026-10-08 apps run only with the file system: each run gets a scratch
folder in NanoAgent that is removed afterwards, its changes are written back
against the revisions it started from, and `/api/agent-files` reads and writes
`home/<user>/agent/` in the file system.
As of 2026-10-14 each plugin has its own folder, `home/<user>/agent/<plugin>/`,
and a run is given only that one; what runs left in `home/<user>/agent/` before
moved to `home/<user>/files/` (migration 0031). A member's home is private to
them however it is made (fs/store.js). Mochi Lab keeps each of the member's
homes in sync both ways with `~/rushlab/<workspace slug>/` (src/runner/files.mjs,
`files_folder` in desktop/config.yaml); the workspace's shared files stay in the
cloud, so no other member ever writes what a computer syncs.
Not yet done: large bytes in object storage, relaying live edits between
several server processes (LISTEN/NOTIFY), and the Book/Blog page editor
editing live (it saves whole revisions, which the merge folds in).

1. **File system core.** `fs_node`, `fs_content`, `fs_change`, access and RLS,
   the `/fs` API, history and restore. Migrate documents and assets into it,
   and serve the existing document and asset interfaces from it so every
   current page keeps working.
2. **Workspace is the file manager.** The Explorer lists `/fs`; Book and Blog
   read their folders. Retire the Files page and `/agent-files`.
3. **Publishing.** Public folders, the read-only public API, and server-rendered
   public pages.
4. **Sync.** The change feed in the browser replica (partial, pinned, offline
   edits) and in the CLI.
5. **Mergeable files.** Yjs for Markdown, live co-editing.
6. **Apps as file types.** Bibliography, flashcards, notes, quick notes, tasks,
   reading lists, and whiteboards move into typed files with derived indexes.
7. **Agents as clients.** Plugin and agent runs sync into the file system;
   NanoAgent's workspace storage is retired.
8. **Chat as files**, then the desktop app.

## Rules while building

- Migrations are additive and backward compatible: local `npm start` migrates
  whichever Neon branch `.env` names.
- The file system serves the application everywhere, with no switch; the old
  tables stay in the schema, and `npm run fs:import` copies their content into
  the file system. An old table
  is dropped only when the owner decides, after its data is verified in the
  file system.
- No fallbacks: a request the file system cannot serve fails clearly.
