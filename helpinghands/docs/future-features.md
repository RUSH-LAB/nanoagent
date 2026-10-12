# Future features

Features that were started and then put on hold. Each entry says where the
work lives, what is done, and what is left before it can ship.

## Block storage for workspace files (on hold)

Dropbox-style content-addressed storage: file bytes are split into 4 MiB
blocks named by their SHA-256, stored once per workspace in PostgreSQL, and a
file revision is its ordered list of block hashes. `mochi sync` uploads only
the blocks the workspace lacks and downloads only the blocks the local copy
does not have.

- Branch: [`block-storage`](https://github.com/zeyuyang8/helpinghands/tree/block-storage),
  commit `ca71709`.
- Local worktree: `/Users/yangdzey/Code/helpinghands-block-storage`.

### Done

- `src/server/fs/blocks.js`: splitting, hash checks, storing and reading blocks,
  orphan-block cleanup.
- Migration `0017_fs_blocks.sql`: block tables and policies; moves existing
  `object_blob` data into blocks; idempotent and transactional.
- Endpoints in `routes/fs.js`: `POST missing`, `PUT block`, `GET block`,
  `POST commit`, `GET blocks`. A commit naming a block the workspace lacks
  fails with 409 `missing-blocks`.
- `cli/sync.mjs`: block uploads and downloads with hash verification.
- The whole-file `object_blob` path and `object-storage:verify` are removed.
- Reviewed for data integrity, security, and project rules; all nine findings
  fixed (cleanup races, probing private files by hash, quota bypass with a
  repeated block). `npm test` passes 2457/2457.

### Left before shipping

- The migration has only run on PGlite. Run it on a Neon branch copied from
  production and verify the bytes before going near production.
- Rebase onto `devmode`, which has moved on since the branch was cut.
- Decide on the temporary insert policy migration step 2 adds on `fs_content`
  (scoped to the migration role, dropped in the same transaction).
- After deploying: `VACUUM FULL fs_content` off-peak. Deploy when quiet, because
  servers still on the old code fail their writes until they are replaced.
- Known limit: a file of exactly 256 blocks (1 GiB) exceeds the largest
  PostgreSQL value in batch reads; only workspaces allowed over 1 GiB can hit it.
- Optional: a shared local block cache (`.mochi/blocks/<sha256>`) so identical
  blocks in different files are not downloaded twice. Today blocks are reused
  only from the previous local version of the same file.
