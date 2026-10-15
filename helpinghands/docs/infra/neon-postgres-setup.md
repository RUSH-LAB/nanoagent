# Neon Postgres setup

Mochi has one database: the `production` branch of the Neon project
`curly-rice-08210507`. Railway's Mochi service (rush-lab.org) and every local
`npm start` use it, so what you change locally is real, and rush-lab.org
shows it. The local site has a banner across the top that says so.

## Two connections

| Variable | Connection | Role | Held by |
| --- | --- | --- | --- |
| `DATABASE_MIGRATION_URL` | Direct | Neon schema owner | Railway only: migrations, grants, the jobs below |
| `DATABASE_URL` | Pooled | `mochi_runtime` | Railway and local `.env`: Better Auth and every repository |

The runtime role is not a schema owner and has none of `SUPERUSER`, `CREATEDB`,
`CREATEROLE`, `INHERIT`, `REPLICATION`, or `BYPASSRLS`. PostgreSQL row-level
security protects workspace-owned application tables. Better Auth owns the
user, session, workspace, membership, and invitation lifecycle.

## The schema

Only Railway changes the schema. Its deploy applies the pending migrations
before the new container starts, all in one transaction
([release-policy.md](release-policy.md)). The local server holds no owner URL
and never migrates: it starts only when the database has applied exactly the
migrations in your checkout, and otherwise names the difference:

- `The database has not applied 0037_x.sql: release them first`: your
  checkout has a migration production doesn't. Release it, then start.
- `The database has applied 0037_x.sql, which this checkout lacks: pull first`.
- `Applied migration changed: 0037_x.sql`: an applied migration was edited.
  Restore it and write a new migration.

Production's server alone, the one holding the owner URL, provisions root
(`ROOT_GITHUB_LOGIN`), sweeps rate limits, deletes queued objects and
publishes scheduled documents (`ownsDatabase` in `src/server/index.js`), so
the shared rows are never worked on twice.

## Set up a new machine

You need access to the Railway project. Then:

```bash
git clone <repository-url>
cd helpinghands/helpinghands
npm ci
railway login
npm run db:setup
npm start
```

`db:setup` reads the `mochi-lab` service's `DATABASE_URL` (the runtime role),
`PG_SSL` and `PG_SSL_REJECT_UNAUTHORIZED` from Railway and writes them into
the git-ignored `.env` (mode `0600`). Any `DATABASE_MIGRATION_URL` is removed,
and `npm start` refuses to run if one is set. Run it again whenever Railway's
database password changes.

## Tests

`npm test` uses no database. The PostgreSQL acceptance suite
(`npm run test:postgres`) creates and deletes rows, so it runs only on a
loopback database: CI's `postgres:17-alpine` service, never the shared one.
A pull request into `production` also runs its pending migrations on a Neon
branch made from production and deleted when the job ends (`production-data`
in `.github/workflows/helpinghands-postgres.yml`).

## Files and secrets

- `.neon` names the Neon organization, project and the `production` branch.
  It holds no password and is committed.
- `.env` holds the runtime URL and Mochi's other private local configuration.
  It is git-ignored.
- `infra/neon.ts` is committed configuration-as-code (`neon:plan`,
  `neon:deploy`).

Never put a database URL in client-side Docusaurus variables, commit it, or
paste it into chat or an issue. Rotate it immediately after any disclosure.

## The first request is slow

This is normally a Neon scale-to-zero cold start. Retry once before diagnosing
it as an application failure.

## Implementation map

- `scripts/db/postgres.mjs` — `db:setup` and the acceptance command
- `scripts/db/bootstrap-runtime-role.mjs`, `scripts/db/apply-schema.mjs` — Railway's pre-deploy steps
- `src/server/postgres/client.js` — `migrate` and `assertSchemaCurrent`
- `src/server/postgres/migrations/` — schema and RLS policies
- `tests/integration/postgres/` — the acceptance suite
