# Repository commands

This directory contains executable repository operations, not tests. Prefer the
named `npm run` commands in `package.json`; the files below are implementation
details grouped by responsibility.

## Local setup

Prerequisites are Node.js 22.19+, npm, Python 3.12, and `uv`. PostgreSQL mode also
requires access to an isolated Mochi Lab Neon development branch. Local
PostgreSQL and Docker are not required. Clone NanoAgent beside this repository,
or set `NANOAGENT_PROJECT_DIR` to its checkout path.

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

`npm run db:postgres:setup` updates the git-ignored `.env` file.
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
# Optional: enables the "Continue with Google" sign-in button.
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

For Google OAuth, register `http://localhost:3001/api/auth/callback/google` as
the local authorized redirect URI. Add the corresponding HTTPS callback under
your `SITE_URL` for deployment. Without both Google values, Mochi keeps the
ordinary email/password form and hides the Google button.

In local PostgreSQL mode, `root@mochi.local` / `root@mochi.local` is the fixed
development root login. The first successful login repairs that account's
password and makes it an owner of the `mochi` workspace.

Production-only verification values can also live in `.env` and are only
needed for the Resend verification command:

```dotenv
RESEND_API_KEY=...
MAIL_FROM=Mochi Lab <no-reply@mochi-lab.org>
MAIL_TEST_TO=...
```

## Running locally

Put the OpenRouter key in the git-ignored `.env` file:

```dotenv
OPENROUTER_API_KEY=...
```

Start the complete local stack with one command:

```bash
npm start                 # adjacent NanoAgent checkout + API + site, prepared Neon branch
```

PostgreSQL is the normal development path and source of truth.

The supervisor installs NanoAgent's Python dependencies with `uv` on its first
run, prepares its PI runner when needed, and stops every process together on
Ctrl+C. Mochi uses the adjacent `../nanoagent` checkout by default and connects
to it at `http://127.0.0.1:8787`. Set `NANOAGENT_PROJECT_DIR` for a checkout in
another location, set `NANOAGENT_URL` and `NANOAGENT_API_TOKEN` to use an
already-running service, or set `NANOAGENT_URL=off` to disable AI. The sole model currently exposed by Mochi is
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

## `maintenance/`

Manual verification, repair, or cleanup commands:

- `verify-object-storage.mjs` performs a self-cleaning upload, metadata,
  download, and delete probe against PostgreSQL object storage.
- `verify-mail.mjs` sends one explicitly addressed deployment-test email using
  the configured Resend or webhook provider.
- `verify-nanoagent.mjs` starts a real NanoAgent web process against a local
  deterministic fake model and verifies Mochi's private streaming contract.

Run the agent check with `npm run nanoagent:verify`. It expects an adjacent
`../nanoagent` checkout, or the project at `NANOAGENT_PROJECT_DIR` when set.

## `dev/`

Developer workflow commands:

- `start-local.mjs` starts NanoAgent, the PostgreSQL API, and the site as one
  supervised process group.
- `create-plugin.mjs` implements `npm run new:plugin -- <name>`.

## Tests and workflows

Executable PostgreSQL acceptance checks live under
`tests/integration/postgres/`. GitHub workflow files only provision CI services
and invoke the same `npm` commands used locally; they do not contain test logic.
