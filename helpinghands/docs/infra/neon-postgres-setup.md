# Neon Postgres setup and reproduction

This guide reproduces Mochi Lab's PostgreSQL environment on a new machine.
The application runs locally while Neon provides the database.

## Architecture

Mochi uses two PostgreSQL connections with deliberately different privileges:

| Variable | Connection | Role | Purpose |
| --- | --- | --- | --- |
| `DATABASE_MIGRATION_URL` | Direct | Neon schema owner | Role bootstrap, migrations, and grants |
| `DATABASE_URL` | Pooled | `mochi_runtime` | Better Auth and all application repositories |

The runtime role is not a schema owner and has none of `SUPERUSER`, `CREATEDB`,
`CREATEROLE`, `INHERIT`, `REPLICATION`, or `BYPASSRLS`. PostgreSQL row-level
security protects workspace-owned application tables. Better Auth owns the
user, session, workspace, membership, and invitation lifecycle.

## Prerequisites

- Node.js 20 or newer
- npm
- Access to the Mochi Lab Neon account
- A browser for Neon OAuth

No local PostgreSQL or Docker installation is required.

## Branches

The Neon project `curly-rice-08210507` has one branch per environment:

| Branch | Used by |
| --- | --- |
| `production` | Railway's Mochi service (rush-lab.org) |
| `development` | Local development: `npm start` and `npm run test:postgres` |

`.neon` names the project and the `development` branch, so Neon commands run
from this folder act on `development`. Nothing local connects to `production`.

`npm run db:sync` resets `development` to production's current data, discarding
whatever changed in `development`; stop the local server first. Schema changes
need no syncing: migrations apply to `development` when the local server
starts, and to `production` when Railway deploys. Nothing is copied from
`development` to `production`.

## Set up a new machine

Install the project, which includes the Neon CLI, and sign in to Neon:

```bash
git clone <repository-url>
cd helpinghands/helpinghands
npm ci
npx neon login
npx neon env pull
npm run neon:deploy
```

`neon env pull` writes the `development` branch's pooled and direct owner URLs
into the git-ignored `.env`. `neon:deploy` applies the configuration declared
in `infra/neon.ts`.

Prepare the application role and schema:

```bash
npm run db:postgres:setup
```

The setup command:

1. Reads `DATABASE_URL_UNPOOLED` from `.env`.
2. Normalizes it as the direct migration connection.
3. Derives the matching pooled endpoint for application traffic.
4. Generates a password for `mochi_runtime` and a Better Auth secret when they
   do not already exist.
5. Writes `.env` atomically with file mode `0600`.
6. Creates or repairs the restricted runtime role.
7. Applies versioned migrations and grants the runtime role only the required
   table, sequence, and function privileges.

After setup succeeds, keep `.env`; it is the single local configuration file
for the database, NanoAgent, and optional verification commands.

## Verify the environment

Run the real PostgreSQL acceptance suite:

```bash
npm run test:postgres
```

The suite performs two self-cleaning probes:

- RLS, cross-workspace isolation, workspace deletion, and the object-deletion
  outbox
- A running API with Better Auth sign-up, workspace provisioning, invitation
  acceptance, role changes, member removal, documents, settings, preferences,
  generic stores, chat, and assets

Both probes use unique fixture identifiers and clean up in `finally` blocks.
The command succeeds only when both JSON reports contain `"ok": true`. A `404`
for a forged workspace ID is an expected authorization result.

## Run the application

Start the API and site in separate terminals:

```bash
npm run start:postgres:api
```

```bash
npm run start:site
```

The API loads `.env`. Neon may suspend an idle compute, so the
first request after a long pause can be slower than subsequent requests.

## Routine commands

```bash
npm run neon:plan             # Preview infra/neon.ts changes
npm run neon:deploy           # Apply infra/neon.ts to the development branch
npx neon env pull             # Refresh Neon-managed variables in .env
npm run db:sync               # Reset development to production's data (discards development's changes)

npm run db:postgres:prepare   # Regenerate the private local environment
npm run db:postgres:bootstrap # Create or repair mochi_runtime
npm run db:postgres:migrate   # Apply pending schema migrations
npm run db:postgres:verify    # Run the RLS/outbox probe
npm run test:postgres         # Run the complete database acceptance suite
```

## Local files and secrets

- `.neon` names the Neon organization, project, and the `development` branch.
  It contains no database password and is committed.
- `.env` contains Neon credentials and Mochi's other private local configuration. It is
  git-ignored and must remain mode `0600`.
- `infra/neon.ts` is committed configuration-as-code. Because it is not at the
  repository root, use the `neon:plan` and `neon:deploy` npm scripts.

Never put either database URL in client-side Docusaurus variables, commit it,
or paste it into chat or an issue. Rotate credentials immediately after any
accidental disclosure.

## Troubleshooting

### Setup cannot find a connection URL

Refresh the linked branch environment, then retry setup:

```bash
npx neon env pull
npm run db:postgres:setup
```

### Direct TCP port 5432 is unavailable

Hosted mode uses `@neondatabase/serverless` over secure WebSockets. The generated
application uses `node-postgres` with the pooled runtime URL, so normal traffic does
not require outbound TCP access to port 5432.

### The first request is slow

This is normally a Neon scale-to-zero cold start. Retry once before diagnosing
it as an application failure.

## Implementation map

- `infra/neon.ts` — Neon configuration-as-code
- `scripts/db/postgres.mjs` — environment preparation and command dispatcher
- `scripts/db/bootstrap-runtime-role.mjs` — restricted role bootstrap
- `scripts/db/apply-schema.mjs` — migration runner
- `src/server/postgres/migrations/` — schema and RLS policies
- `tests/integration/postgres/rls-acceptance.mjs` — RLS and outbox acceptance
- `tests/integration/postgres/runtime-acceptance.mjs` — authenticated HTTP E2E
- `.github/workflows/postgresql-acceptance.yml` — PostgreSQL 17 CI acceptance
