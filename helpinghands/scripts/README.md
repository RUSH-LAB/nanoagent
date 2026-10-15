# Repository commands

This directory contains executable repository operations, not tests. Prefer the
named `npm run` commands in `package.json`; the files below are implementation
details grouped by responsibility.

## Local setup

Prerequisites are Node.js 22.19+, npm, Python 3.12, `uv`, and access to the
Railway project. There is one database, production's, and the local server
uses it as the restricted runtime role
([docs/infra/neon-postgres-setup.md](../docs/infra/neon-postgres-setup.md)).
Local PostgreSQL and Docker are not required. Clone NanoAgent beside this repository,
or set `NANOAGENT_PROJECT_DIR` to its checkout path.

Install the JavaScript dependencies and write production's runtime database
connection into the git-ignored `.env`:

```bash
npm ci
railway login
npm run db:setup
```

`.env` must contain the following values; never commit real secrets:

```dotenv
DATABASE_URL=postgresql://mochi_runtime:...@...-pooler.../neondb?sslmode=verify-full
BETTER_AUTH_SECRET=...
PG_SSL=require
PG_SSL_REJECT_UNAUTHORIZED=true
PLATFORM_NAME=RUSH Lab
PLATFORM_TAGLINE=Collaborative knowledge workspaces
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
ROOT_GITHUB_LOGIN=your-github-login
```

GitHub is the only way to sign in, so the server refuses to start unless all
three GitHub values are set. Create an OAuth App under GitHub Settings →
Developer settings → OAuth Apps with the homepage
`http://localhost:3000` and the authorization callback URL
`http://localhost:3001/api/auth/callback/github`. A GitHub OAuth App takes one
callback URL, so a deployment uses its own app, with the callback
`<SITE_URL>/api/auth/callback/github`.

`ROOT_GITHUB_LOGIN` names the GitHub account that administers the platform.
Every start of production's server resolves it to GitHub's numeric account id, creates that account's
user if the database has none, and makes it a platform administrator and an
owner of the `mochi` workspace, so its first GitHub sign-in lands there. A
start that cannot reach GitHub's API fails.

### Content store

Documents, uploads, app records, and chat live in the workspace file system
([docs/plans/workspace-filesystem.md](../docs/plans/workspace-filesystem.md)).
The original tables stay in the schema; to copy their content into the file
system, review a dry run, then import:

```bash
npm run fs:import            # what would be imported; writes nothing
npm run fs:import -- --apply # copy, verified by SHA-256; the legacy tables are untouched
```

Production-only verification values can also live in `.env` and are only
needed for the Resend verification command:

```dotenv
RESEND_API_KEY=...
MAIL_FROM=Mochi Lab <no-reply@rush-lab.org>
MAIL_TEST_TO=...
```

## Running locally

Put the OpenRouter key in the git-ignored `.env` file:

```dotenv
OPENROUTER_API_KEY=...
```

Start the complete local stack with one command:

```bash
npm start                 # adjacent NanoAgent checkout + API + site, on production's database
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

Railway runs both before each deploy. Locally, `npm run db:setup` writes the
runtime connection into `.env`; nothing local migrates.

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
