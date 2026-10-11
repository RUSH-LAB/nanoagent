# PostgreSQL production store

`migrations/` is the canonical production schema. Each request transaction must
set both tenant variables before calling a repository:

```sql
set local app.user_id = '...';
set local app.workspace_id = '...';
```

The application role must not own these tables and must not have `BYPASSRLS`.
Migrations run through a separate deploy role. Better Auth owns the
`workspace`, `workspace_member`, and `workspace_invitation` control-plane
tables through schema aliases; those tables stay outside RLS just like its
user/session/account tables. Every product table remains forced through RLS.

Organization hooks provision workspace settings, `#general`, and channel
membership idempotently. Hard deletion remains a Mochi endpoint because it
must enqueue object-storage keys before the database cascade; Better Auth's
generic organization-delete endpoint is disabled.

Production uses two database roles: `DATABASE_MIGRATION_URL` owns the schema,
while `DATABASE_URL` is the non-owner runtime role constrained by RLS. Startup
applies migrations through the owner connection, grants the runtime role only
the required table/function access, and refuses production if both URLs point
at the owning role.

Apply the schema with:

```bash
DATABASE_URL=postgres://mochi_runtime:... \
DATABASE_MIGRATION_URL=postgres://mochi_owner:... \
npm run db:migrate:postgres
```

The migration runner takes an advisory lock, verifies checksums of previously
applied files, and runs each new migration in its own transaction. Uploaded
bytes live in the workspace-scoped `object_blob` table and are deleted by the
same database cascade as their workspace.

For the one-time production cutover from the local SQLite database, first stop
legacy writes and take a backup, then run the complete dry run:

```bash
DATABASE_FILE=var/data/mochi.db \
DATABASE_URL=postgres://mochi_runtime:... \
DATABASE_MIGRATION_URL=postgres://mochi_owner:... \
```

The report includes source/destination counts and canonical SHA-256 hashes for
accounts, credentials, workspaces, memberships, invitations, settings,
documents and versions, assets, references, scoped feature data, chat, audit,
and platform administrators. Existing sessions and verification tokens are
deliberately invalidated at cutover. Add `--apply` only after reviewing the dry
run. The migration validates legacy files below `var/objects` and copies them
into `object_blob`; use `--skip-asset-bytes` only when they were copied and
verified separately.

Run the live isolation probe against staging before switching traffic:

```bash
DATABASE_URL=postgres://mochi_runtime:... \
DATABASE_MIGRATION_URL=postgres://mochi_owner:... \
npm run db:verify:postgres
```

The probe creates namespaced fixtures, proves cross-workspace reads return no
rows and writes fail with RLS, checks member removal and workspace cascades,
checks the runtime role is not the owner, then removes the fixtures.

`npm test` also executes the same migration in an in-process PostgreSQL/PGlite
engine. That fast check covers real policy evaluation, forged reads and writes,
viewer restrictions, member removal, cascades, and the asset-deletion outbox;
the staging probe above additionally proves the deployed role ownership and
connection configuration.
