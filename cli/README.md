# Folder sync

`mochi` keeps a workspace's documents in sync with a local folder in both
directions, so you can edit them with any editor. The server stays the source
of truth: every write goes through the same API, permissions, and revision
check as the web editor.

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

- Each document is one file at its document path, with its frontmatter.
- Only `.md` and `.mdx` files sync. Other files and anything whose name starts
  with a dot stay local.
- Renaming or moving a file moves the document, keeping its history and
  visibility. New documents are readable by the whole workspace.

## Conflicts

| Local | Server | Result |
|---|---|---|
| Edited | Edited | The server version keeps the path. Yours is saved beside it as `name (conflicted copy <host> <date>).md` and uploaded as a new document. |
| Deleted | Edited | The server version is downloaded again. |
| Edited | Deleted | Your version is uploaded again. |

When the server refuses a file, for example because its MDX does not compile or
you are a viewer, the reason is printed once. The file is left as it is and
tried again after it changes. Deleted documents go to the workspace trash.

The folder's settings are in `.mochi/config.yaml` and the last synced state is
in `.mochi/state.json`. Deleting `state.json` would make every file look new,
so leave the `.mochi` folder alone.
