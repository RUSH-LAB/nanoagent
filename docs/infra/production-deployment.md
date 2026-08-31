# Production deployment

Mochi runs as one Node process serving both the built Docusaurus shell and
`/api/*`. Keeping one public origin lets Better Auth use HttpOnly, Secure,
same-site cookies without exposing credentials to browser JavaScript.

## Required services

- A PostgreSQL database separate from development, with a direct schema-owner
  URL and a pooled restricted `mochi_runtime` URL.
- S3-compatible object storage for uploaded assets.
- An HTTPS transactional-email webhook for verification, password reset, and
  workspace invitations.
- A container host with HTTPS termination and secret management.

Use `.env.production.example` as the secret checklist. Never commit a filled
environment file.

Copy it to `.env.production.local`, fill the object-storage values, and verify
the bucket before deploying:

```bash
cp .env.production.example .env.production.local
npm run object-storage:verify
```

The probe writes one random object below `_mochi-health/`, verifies its bytes
and metadata, deletes it, and confirms deletion. It never reads or modifies a
business asset.

## Release sequence

1. Back up the legacy database, content tree, and uploaded objects.
2. Run `npm run db:postgres:migrate` as a release job.
3. Run the legacy database and content importers without their apply flags and
   review counts, hashes, owners, and conflicts.
4. Freeze legacy writes and repeat the approved imports with `--apply`.
5. Run `npm run db:postgres:verify` against staging, never production.
6. Build with `docker build -t mochi-lab .` and deploy the resulting image.
7. Verify `/api/health`, registration, workspace creation, invitation delivery,
   asset upload, and cross-workspace 404 behavior before switching traffic.

## Rollback

Keep the pre-cutover PostgreSQL and object-storage backups for an explicit
rollback window. Restore them together; restoring only one side can leave asset
metadata pointing at missing objects. Roll back the application image before
reopening writes.
