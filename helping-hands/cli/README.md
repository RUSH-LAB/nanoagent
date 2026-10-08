# Folder sync

`mochi` keeps a workspace's files in sync with a local folder in both
directions, so you can edit them with any editor. The server stays the source
of truth: every write goes through the workspace file system API, with the same
permissions and revision checks as the Workspace page. The server must run with
`CONTENT_STORE=fs`.

Install the command once from the repository root:

```bash
npm link
```

Then sign in, clone a workspace into a new folder, and keep it in sync:

```bash
mochi login https://mochi-lab.org
mochi clone https://mochi-lab.org my-workspace ~/Mochi/my-workspace
mochi sync ~/Mochi/my-workspace
```

`login` signs in with email and password and stores the session token in
`~/.config/mochi/credentials.json`, readable only by you. Accounts that sign in
only with Google cannot use the command yet. `sync` runs until you stop it. It
syncs within a second of a local change and checks the server every 30 seconds.

## What syncs

- Every file in the workspace is a file at the same path, text or binary.
  Markdown keeps its frontmatter.
- Anything with a path segment starting with a dot stays on its own side:
  `.mochi/` locally, `.plugins/` in the workspace.
- Renaming or moving a file moves it in the workspace, keeping its history and
  who can see it. A new file inherits its folder's access.

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
