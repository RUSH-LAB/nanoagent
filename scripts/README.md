# Repository commands

This directory contains executable repository operations, not tests. Prefer the
named `npm run` commands in `package.json`; the files below are implementation
details grouped by responsibility.

## Local setup

Prerequisites are Node.js 20+, npm, Python 3.12, `uv`, and access to an
isolated Mochi Lab Neon development branch. Local PostgreSQL and Docker are not
required.

Install the JavaScript dependencies and prepare the Neon branch:

```bash
npm ci
npm install --global neon@latest
neon auth
neon link --project-id curly-rice-08210507 --branch production -y
neon checkout dev-my-laptop
npm run neon:deploy
npm run db:postgres:setup
```

Prepare the adjacent NanoAgent checkout:

```bash
cd ../nanoagent
uv sync --extra web
cd ../mochi-lab
```

`npm run db:postgres:setup` creates the git-ignored `.env.postgres.local` file.
It must contain the following values; never commit real secrets:

```dotenv
DATABASE_URL=postgresql://mochi_runtime:...@...-pooler.../neondb?sslmode=require
DATABASE_MIGRATION_URL=postgresql://neondb_owner:...@.../neondb?sslmode=require
BETTER_AUTH_SECRET=...
PG_DRIVER=neon-serverless
PG_SSL=require
PG_SSL_REJECT_UNAUTHORIZED=true
ENABLE_AUTH=true
DEV_AUTOLOGIN=false
PLATFORM_NAME=Mochi Lab
PLATFORM_TAGLINE=Collaborative knowledge workspaces
```

`.env.production.local` is optional during local development and is only
needed for the R2 and Resend verification commands:

```dotenv
OBJECT_STORAGE_ENDPOINT=...
OBJECT_STORAGE_BUCKET=...
OBJECT_STORAGE_REGION=auto
OBJECT_STORAGE_ACCESS_KEY_ID=...
OBJECT_STORAGE_SECRET_ACCESS_KEY=...
RESEND_API_KEY=...
MAIL_FROM=Mochi Lab <no-reply@mochi-lab.org>
MAIL_TEST_TO=...
```

## Running locally

Start NanoAgent in one terminal. Its current web configuration uses DeepSeek V4
Flash through OpenRouter and grants no tools:

```bash
export OPENROUTER_API_KEY=...
cd ../nanoagent
uv run python -m nanoagent web web_cfg=configs/web_openrouter.yaml
```

Start Mochi in another terminal:

```bash
npm start                 # local SQLite
npm run start:postgres    # prepared Neon development branch
```

Mochi connects to `http://127.0.0.1:8787` by default. Use `NANOAGENT_URL` and
`NANOAGENT_API_TOKEN` for another service, or `NANOAGENT_URL=off` to disable AI.
The sole model currently exposed by Mochi is
`deepseek/deepseek-v4-flash-0731`.

## `db/`

Database setup and schema operations:

- `postgres.mjs` is the local command entry point for Neon PostgreSQL
  setup, migration, verification, and API startup.
- `apply-schema.mjs` applies PostgreSQL schema migrations.
- `bootstrap-runtime-role.mjs` creates or repairs the restricted application
  login used separately from the migration owner.

Common entry points are `npm run db:postgres:setup` and
`npm run db:postgres:migrate`.

## `migrations/`

One-time or explicitly requested data movement:

- `json-stores-to-database.mjs` carries legacy JSON stores into the scoped
  database. It is a dry run unless `--write` is supplied.
- `sqlite-to-postgres.mjs` performs the legacy SQLite-to-PostgreSQL cutover. It
  is a dry run unless `--apply` is supplied.

These are migration tools, not application startup steps.

## `maintenance/`

Manual verification, repair, or cleanup commands:

- `verify-object-storage.mjs` performs a self-cleaning upload, metadata,
  download, and delete probe against configured S3/R2 storage.
- `verify-mail.mjs` sends one explicitly addressed deployment-test email using
  the configured Resend or webhook provider.
- `verify-nanoagent.mjs` starts a real NanoAgent web process against a local
  deterministic fake model and verifies Mochi's private streaming contract.

Run the agent check with `npm run nanoagent:verify`. It expects the NanoAgent
checkout at `../nanoagent`, or at `NANOAGENT_PROJECT_DIR` when set.

## `dev/`

Developer workflow commands:

- `start-local.mjs` starts the API and site as one supervised process group for
  SQLite, PostgreSQL, or no-auth development.
- `create-plugin.mjs` implements `npm run new:plugin -- <name>`.

## Tests and workflows

Executable PostgreSQL acceptance checks live under
`tests/integration/postgres/`. GitHub workflow files only provision CI services
and invoke the same `npm` commands used locally; they do not contain test logic.
