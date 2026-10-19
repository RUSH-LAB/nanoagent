# Neon Postgres setup

Production's database is the `production` branch of the Neon project
`curly-rice-08210507`, which Railway's RUSH service (rush-lab.org) uses.
Local `npm start` runs on a database of its own on your machine, a copy of
production's that you refresh when you choose. Nothing you change locally
reaches rush-lab.org unless you push a workspace. The local site's banner
says when its copy was pulled.

## Two connections

| Variable | Connection | Role | Held by |
| --- | --- | --- | --- |
| `DATABASE_MIGRATION_URL` | Direct | Neon schema owner (`neondb_owner`) | Railway: migrations, grants. Read from Railway by `db:pull` and `db:push`, never written down |
| `DATABASE_URL` | Pooled | `mochi_runtime` | Railway: Better Auth and every repository |

The runtime role is not a schema owner and has none of `SUPERUSER`, `CREATEDB`,
`CREATEROLE`, `INHERIT`, `REPLICATION`, or `BYPASSRLS`. PostgreSQL row-level
security protects workspace-owned application tables. Better Auth owns the
user, session, workspace, membership, and invitation lifecycle.

## The schema

Each server migrates its own database. Railway's deploy applies production's
pending migrations before the new container starts, all in one transaction
([release-policy.md](release-policy.md)); `npm start` applies your checkout's
to the local database the same way. A new migration therefore runs locally
first and reaches production by release.

## The local database

The local database is a PostgreSQL 18 cluster in `var/postgres` (git-ignored),
on `127.0.0.1:55432`, with production's locale and role names: `neondb_owner`
owns the schema and `npm start` serves it as `mochi_runtime`
(`scripts/db/local.mjs`). It keeps running after `npm start` exits. It needs
Homebrew's `postgresql@18`, the same major version as Neon's, which `pg_dump`
requires.

```bash
npm run db:pull                    # replace the local database with a copy of production's
npm run db:push -- comp-480-580    # replace that workspace on production with the local one
```

`db:pull` copies all of production's data except RUSH Lab's desktop bundles,
then clears every session, verification and device code and every account's
stored tokens and password, so no sign-in travels. It replaces everything
local, including work not pushed yet. Sign in again on the local site.

`db:push` replaces one workspace on production with the local one: its
`workspace` row and every row of every table with a `workspace_id`, in one
transaction. Accounts, sessions, installed plugins, the marketplace and every
other workspace stay as they are. It shows the rows on each side and asks you
to type the workspace's slug. It refuses, changing nothing, when:

- production's copy of the workspace changed since your pull (anyone's
  message, edit or AI call counts). Pull again, which discards your local
  changes, and make them again;
- production applied migrations since your pull, or the two databases have
  applied different migrations (release first, or run `npm start` to apply
  them locally);
- the workspace names an account production does not have. That person signs
  in on rush-lab.org first;
- another workspace on production has the same slug.

A workspace made locally can be pushed while production has none with its id.
Sequence numbers (`ai_usage.id`, `fs_change.seq`) are given by production as
the rows arrive. `scripts/db/sync.mjs` holds both commands.

## Set up a new machine

You need access to the Railway project. Then:

```bash
git clone <repository-url>
cd helpinghands/helpinghands
brew install postgresql@18
npm ci
railway login
npm run db:setup
npm run db:pull
npm start
```

`db:setup` makes the local database and removes any database connection from
the git-ignored `.env`; `npm start` refuses to run while `.env` or the shell
names one.

## Tests

`npm test` uses no database. The PostgreSQL acceptance suite
(`npm run test:postgres`) creates and deletes rows, so it runs only on a
loopback database: CI's `postgres:17-alpine` service or your local cluster, never production.
A pull request into `production` also runs its pending migrations on a Neon
branch made from production and deleted when the job ends (`production-data`
in `.github/workflows/helpinghands-postgres.yml`).

## Files and secrets

- `.neon` names the Neon organization, project and the `production` branch.
  It holds no password and is committed.
- `.env` holds RUSH's private local configuration, and no database URL. It is
  git-ignored.
- `infra/neon.ts` is committed configuration-as-code (`neon:plan`,
  `neon:deploy`).

Never put a database URL in client-side Docusaurus variables, commit it, or
paste it into chat or an issue. Rotate it immediately after any disclosure.

## The first request is slow

This is normally a Neon scale-to-zero cold start. Retry once before diagnosing
it as an application failure.

## Implementation map

- `scripts/db/postgres.mjs` — `db:setup`, `db:pull`, `db:push` and the acceptance command
- `scripts/db/local.mjs`, `scripts/db/sync.mjs` — the local database, and pulling and pushing
- `scripts/db/bootstrap-runtime-role.mjs`, `scripts/db/apply-schema.mjs` — Railway's pre-deploy steps
- `src/server/postgres/client.js` — `migrate`
- `src/server/postgres/migrations/` — schema and RLS policies
- `tests/integration/postgres/` — the acceptance suite
