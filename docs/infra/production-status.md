# Production status

Last updated: 2026-08-31

Mochi is not publicly launched yet. Production deployment is intentionally on
hold while the product is improved locally. The production architecture and
supporting services are mostly prepared, so this is a pause rather than a
restart.

## What we use today

| Area | Service | Current use |
|---|---|---|
| Local website | Docusaurus + Node API | The application runs locally at `http://localhost:3000`; the development API uses port `3001`. |
| Source and CI | Private GitHub repository | Stores the application and runs automated PostgreSQL checks. |
| Database | Neon PostgreSQL | The development database contains the migrated legacy data and is used to test migrations and row-level security. It is not the future production database. |
| Domain and DNS | Cloudflare | Manages `mochi-lab.org` and the DNS records used by application services and email. The domain is not currently pointed at a public Mochi deployment. |
| Object storage | Cloudflare R2 | Stores uploaded images and attachments through the S3-compatible API. A real write, read, metadata, and delete probe has passed. |
| Transactional email | Resend | Sends account verification, password-reset, and workspace-invitation email from the verified Mochi mail domain. A real delivery probe has passed. |
| Application hosting | Railway, planned | The repository contains the container and Railway configuration, but the public service and production secrets have not been activated. |

For local work, run:

```bash
npm start
```

To use the prepared Neon development database instead of local SQLite, run:

```bash
npm run start:postgres
```

Both commands start the website and API together. Stopping the command stops
both processes.

## What has been completed for production

- Authentication uses Better Auth with server-side sessions and secure cookie
  support for a same-origin deployment.
- Workspace identity comes from the URL and every workspace request is checked
  again by the server.
- PostgreSQL is the authoritative data model, with a restricted runtime role
  and row-level security as the second isolation boundary.
- The legacy migration was verified across all 19 datasets by row count and
  canonical SHA-256 hash.
- The content migration verified 153 Markdown documents and 740 bibliography
  records against PostgreSQL.
- Uploaded assets use S3-compatible object storage instead of the application
  repository. Cloudflare R2 connectivity and deletion were verified.
- Resend support covers verification, password reset, and workspace
  invitations. DNS and real email delivery were verified.
- The repository includes a production `Dockerfile`, Railway configuration,
  `/api/health`, and documented production environment requirements.
- Unit, integration, PostgreSQL, isolation, and production-build checks have
  been established.

## What still needs to be done

Before a public launch, we still need to:

1. Create a production-only Neon database. Development and test commands must
   never use it.
2. Connect Railway to the private GitHub repository and add the production
   environment variables, including a new production-only Better Auth secret.
3. Deploy the container to a temporary Railway HTTPS domain and confirm that
   `/api/health` succeeds.
4. Rehearse the migration and rollback using staging backups, then perform the
   final production import during a short legacy-write freeze.
5. Test registration, login, password reset, workspace creation, invitations,
   document editing, asset upload, and cross-workspace 404 isolation in a real
   browser.
6. Attach `mochi-lab.org`, update `SITE_URL` and `CORS_ORIGIN` to the exact
   public HTTPS origin, and switch Cloudflare DNS only after the smoke tests
   pass.
7. Configure backups, logs, alerts, and a rollback window before accepting real
   users.

No production data migration or DNS switch should happen while this work is on
hold. When public deployment becomes a priority, resume the
[production-readiness plan](../plans/on-hold/production-readiness.md) and follow
the [deployment runbook](production-deployment.md).
