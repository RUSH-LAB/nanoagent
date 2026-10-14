# Folder sync

`mochi` keeps a workspace's files in sync with a local folder in both
directions, so you can edit them with any editor. The server stays the source
of truth: every write goes through the workspace file system API, with the same
permissions and revision checks as the Workspace page.

Install the command once from the repository root:

```bash
npm link
```

Then sign in, clone a workspace into a new folder, and keep it in sync:

```bash
mochi login https://rush-lab.org
mochi clone https://rush-lab.org my-workspace ~/Mochi/my-workspace
mochi sync ~/Mochi/my-workspace
```

`login` prints a link and a code. Open the link in a browser, sign in with
GitHub if asked, and approve the code; the command then stores its session token
in `~/.config/mochi/credentials.json`, readable only by you. `sync` runs until you stop it. It
syncs within a second of a local change and checks the server every 30 seconds.

## What syncs

- Every file in the workspace is a file at the same path, text or binary.
  Markdown keeps its frontmatter.
- Anything with a path segment starting with a dot stays on its own side:
  `.mochi/` locally, `.plugins/` in the workspace.
- Renaming or moving a file moves it in the workspace, keeping its history and
  who can see it. A new file inherits its folder's access.

## Online-only files

The workspace's drive lives in the cloud and is shared with its members; the
local folder is a cache of it. Choose what is kept locally:

```bash
mochi clone https://rush-lab.org my-workspace ~/Mochi/my-workspace papers notes
mochi online-only ~/Mochi/my-workspace papers/2024
mochi download ~/Mochi/my-workspace papers/2024
```

- `clone` with folder names downloads only those top-level folders; every
  other top-level folder starts online only. Without names it downloads all.
- `online-only` keeps a folder or file in the workspace only. Sync uploads any
  pending edit under it, then removes the local copy. A file you create or move
  into an online-only folder is uploaded and then removed, so it moves to the
  cloud.
- `download` keeps it locally again, and sync downloads it.

Both commands only change `online_only` in `.mochi/config.yaml`; a running
`mochi sync` applies them on its next cycle, within 30 seconds.

## Conflicts

| Local | Server | Result |
|---|---|---|
| Edited | Edited | The server version keeps the path. Yours is saved beside it as `name (conflicted copy <host> <date>).ext` and uploaded as a new file. |
| Deleted | Edited | The server version is downloaded again. |
| Edited | Deleted | Your version is uploaded again. |

When the server refuses a file, for example because you are a viewer, the
reason is printed once. The file is left as it is and tried again after it
changes. Deleted files go to the workspace trash.

The folder's settings are in `.mochi/config.yaml` and the last synced state is
in `.mochi/state.json`. Deleting `state.json` would make every file look new,
so leave the `.mochi` folder alone.

## Publishing a plugin

Push a plugin in the NanoAgent plugin format to a public GitHub repository,
then publish it to the marketplace. Run the same command again to update it.

```bash
mochi publish https://rush-lab.org https://github.com/you/your-plugin
```

For a plugin in a subfolder, give the folder's URL: `…/tree/<branch>/<folder>`.
