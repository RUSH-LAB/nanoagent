# Repository commands

This directory contains executable repository operations, not tests. Prefer the
named `npm run` commands in `package.json`; the files below are implementation
details grouped by responsibility.

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

- `import-workspace-content.mjs` imports workspace Markdown and bibliography
  records. It is a dry run unless `--apply` is supplied.
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
- `clean-test-bibliography.mjs` removes known integration-test bibliography
  records and creates a backup before writing. It is a dry run unless `--apply`
  is supplied.

## `dev/`

Developer-only generators. `create-plugin.mjs` implements
`npm run new:plugin -- <name>`.

## Tests and workflows

Executable PostgreSQL acceptance checks live under
`tests/integration/postgres/`. GitHub workflow files only provision CI services
and invoke the same `npm` commands used locally; they do not contain test logic.
