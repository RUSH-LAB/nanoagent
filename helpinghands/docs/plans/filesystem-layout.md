# File system layout

The workspace file system ([workspace-filesystem.md](workspace-filesystem.md))
stored everything well, but the tree a member saw was the storage layout: app
records, chat bookkeeping and plugin blobs beside the workspace's documents,
folders named by ids, and a plugin's chats not files at all. This plan gives
the tree one rule for what a person sees and one for who may write where, and
makes every plugin chat a folder. Steps 1 to 5 are built; step 6 waits for the
owner.

## Rules

1. **A path segment starting with a dot is app state** (`isAppState`,
   fs/store.js). The Explorer, search, the change feed, RUSH Lab's folder and
   the `rush` CLI leave it out, and `/api/fs` refuses to write it
   (`app-state`); only the service that owns it does.
2. **Every other path is a person's file**, named for people, because RUSH
   Lab's folder shows stored names as they are.
3. **A member's home is theirs.** `home/<x>` is always a folder private to and
   owned by `x`, and never moves (migration 0044); what is inside a private
   home needs its owner to write it. Every member, viewers included, may write,
   move and delete inside their own home through `/api/fs`, but not publish it.

## The tree

```
<root>                                  Explorer: the workspace's files
  <the workspace's documents and files> Book and Blog are folders here (pathPrefix)
  .apps/<app>/<key>.json                glossary, schedule, whiteboards, agents
  .plugins/<plugin>/records/<collection>/<key>.json   a site plugin's records
  .plugins/<plugin>/blobs/<uuid>.<ext>  a site plugin's blobs (e.g. bibliography PDFs)
  .plugins/.imported/<asset id>.<ext>   imported legacy blobs, which name no plugin
  .chat/<channel id>/…                  workspace chat (fs/chat.js)
  .chat/.names/, .chat/.dms/            its registries
  home/<userId>/                        Explorer: home; others' shared nodes under Shared with me
    <anything the member keeps>
    plugins/<plugin>/
      files/                            what each run of <plugin> is given and writes (runner/run-files.mjs)
      chats/<yyyy_mm_dd>_<title>/       e.g. 2026_10_19_find_the_paper
        chat.json                       every turn, as the plugin's page shows it
        turns/<n>/graph.json            each turn's provenance graph
        turns/<n>/messages.json         what its model saw and did, as an ATIF trajectory
    .apps/<app>/<key>.json              bookmarks, tasks, notes, quicknotes, flashcards, reading lists
```

`plugin_session.chat_file` names a session's chat.json by node id, so the
session follows the folder when its member renames or moves it. A chat whose
file the member deleted is gone: the session shows no turns, and its next turn
starts a new folder.

## What was built

1. **Home privacy** (migration 0044). An editor who wrote `home/<bob>/x`
   before Bob had a home made it with the workspace's access, and every member
   could read what Bob kept there. A trigger now refuses any home that is not a
   folder private to and owned by its member, and the migration made every
   home made that way private again.
2. **Zones** (migration 0045). The moves below, each logged as a move by no
   one so every client follows it; records move one file at a time, so a
   member's own files in a folder of the same name stay, and folders left
   empty go to the trash. Nothing moves if a target is taken.

   | From | To |
   |---|---|
   | `chat/…` | `.chat/…` |
   | `.plugins/blobs/<id>` | `.plugins/.imported/<id>` |
   | `.plugins/<plugin>/<blob>` | `.plugins/<plugin>/blobs/<blob>` |
   | `apps/<glossary\|schedule\|whiteboards\|agents>/<key>.json` | `.apps/<same>/<key>.json` |
   | `apps/<plugin>/<collection>/<key>.json` | `.plugins/<plugin>/records/<collection>/<key>.json` |
   | `home/<u>/<bookmarks\|tasks\|…>/<key>.json` | `home/<u>/.apps/<same>/<key>.json` |
   | `home/<u>/agent/…` | `home/<u>/Plugins/…` |
   | `home/<u>/files/…` | `home/<u>/From earlier runs/…` |

3. **Explorer roots** (components/Workbench/tree.js `treeIndex`): home
   first, even before it holds anything, then the workspace's files, then
   Shared with me, each home under its member's name.
4. **Chats as files** (fs/chats.js, migration 0046). NanoAgent's web runtime
   sends a run of its own agent loop's trajectory as a `trajectory` event
   before it ends; RUSH writes it, the graph and the turn in one transaction
   with the session, and never sends the trajectory to the page. Migration
   0046 wrote the chats kept so far to their folders; their turns have no
   trajectory, which NanoAgent did not send then.
5. **RUSH Lab's folder.** It stays `~/rushlab/<login>/<workspace slug>/`
   (`~/rushlab-dev/…` for RUSH Lab Dev): one computer serves several members,
   and the login level keeps their files apart. The member folder's
   `.mochi/member.json` names its member by id, so a folder made under a login
   they had before is renamed for the new one rather than downloaded again
   (`memberFiles`, src/runner/lab.mjs). A run's conflicted copy is named as
   the sync's is: `name (conflicted copy <plugin> run <YYYY-MM-DD>[ n]).ext`.
   Migration 0047 put each plugin's chats and files in its one folder, and
   0048 named the folders RUSH makes in lowercase words joined by _
   (`plugins/`, `chats/2026_10_19_find_the_paper/`) and moved what runs left
   before plugins had folders (`From earlier runs/`) to the trash. A release
   applies 0045 to 0048 at once, so a member's computer goes from `agent/` to
   `plugins/` and never syncs a rename by case alone, which macOS and Windows
   disks cannot tell apart.
6. **Drop `plugin_session.chat`**, which nothing reads or writes since 0046,
   when the owner decides, after step 4 is verified on production.

## Not in this plan

- Apps as typed files (workspace-filesystem.md step 6). Records stay one JSON
  file per key, now hidden. When an app gets an editor, its records become one
  visible file of its type in My files or the workspace.
- Running a plugin directly in RUSH Lab's folder instead of a scratch copy.
- Renaming NanoAgent's scratch "workspaces" and `plugin_run.folder`. Members
  never see either.
