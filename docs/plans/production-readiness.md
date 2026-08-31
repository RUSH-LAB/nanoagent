# Production readiness

Status: active.

The workspace architecture and PostgreSQL migration path are complete. The
remaining work is operational: provision production-only dependencies, rehearse
the cutover in staging, and deploy one verified application image.

## Current state

- [x] Workspace context comes from `/w/:workspaceSlug/...` and is revalidated
  by `/api/workspaces/:workspaceId/...`.
- [x] PostgreSQL repositories and forced RLS cover workspace-owned data.
- [x] The Neon `development` database contains the migrated SQLite dataset.
- [x] All 19 database datasets match by row count and canonical SHA-256 hash.
- [x] All 153 Markdown files and 740 bibliography records match the database.
- [x] Unit, HTTP integration, PostgreSQL, and production-build checks pass.
- [ ] Production PostgreSQL is provisioned separately from development.
- [ ] Production object storage is provisioned and upload/delete is verified.
- [ ] Transactional email is configured for verification, reset, and invites.
- [ ] An HTTPS application origin and secret configuration are selected.
- [ ] The production cutover and rollback rehearsal is complete.

## Release plan

1. Provision a separate production Neon project or database. Never point
   `test:postgres` at it.
2. Provision an S3/R2-compatible bucket and configure the five
   `OBJECT_STORAGE_*` values.
3. Configure an HTTPS mail webhook and token.
4. Configure the application host from `.env.production.example`, including a
   new production-only `BETTER_AUTH_SECRET`.
5. Take a fresh SQLite and object backup, then freeze legacy writes.
6. Run the database migration dry run, apply once, and rerun it until every
   count and hash matches.
7. Run the content dry run; apply only if it reports missing rows. Never use
   `--overwrite` without inspecting each conflict.
8. Run `npm run db:postgres:verify` in staging and complete the browser smoke
   tests for sign-in, workspace creation, invitations, assets, and isolation.
9. Build and deploy the container described in
   [`../production-deployment.md`](../production-deployment.md).
10. Switch traffic, monitor authentication and object-deletion failures, and
    retain the coordinated database/object backup for the rollback window.

## Completion gate

Production is ready only when HTTPS, email, object storage, database backups,
RLS verification, migration hashes, and cross-workspace browser tests all pass.
The detailed command sequence and rollback procedure live in the
[production deployment runbook](../production-deployment.md).
