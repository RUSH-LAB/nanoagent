# Production status

Last updated: 2026-09-09

RUSH is deployed publicly at `https://rush-lab.org`. Railway runs the
application and private NanoAgent service, Cloudflare fronts the custom domain,
and Neon PostgreSQL is the authoritative store for both relational data and
uploaded bytes.

## What we use today

| Area | Service | Current use |
|---|---|---|
| Website | Docusaurus + Node API on Railway | The public application runs at `https://rush-lab.org`; local development remains available at `http://localhost:3000`. |
| Source and CI | Private GitHub repository | Stores the application and runs automated PostgreSQL checks. |
| Database and objects | Neon PostgreSQL | Stores workspace records, asset metadata, and binary object payloads with row-level workspace isolation. |
| Domain and DNS | Cloudflare | Proxies `rush-lab.org` to the Railway application, redirects the former `mochi-lab.org` there, and manages application and email DNS. |
| Sign-in | GitHub OAuth App | The only way to sign in, in the browser and, through device approval, in the `rush` command-line client. |
| Transactional email | Resend | Sends workspace-invitation email from the verified RUSH mail domain. |
| Application hosting | Railway | Builds the repository container and serves the public application. |
| Agent runtime | NanoAgent, private Railway service | RUSH calls NanoAgent over its private authenticated endpoint. |

For local work, run:

```bash
npm start
```

PostgreSQL is the normal local development path and source of truth. The
supervisor starts the website, API, and adjacent NanoAgent checkout together.

## What has been completed for production

- Authentication uses Better Auth with GitHub as the only sign-in, server-side
  sessions, and secure cookie support for a same-origin deployment.
- Workspace identity comes from the URL and every workspace request is checked
  again by the server.
- PostgreSQL is the authoritative data model, with a restricted runtime role
  and row-level security as the second isolation boundary.
- The legacy migration was verified across all 19 datasets by row count and
  canonical SHA-256 hash.
- The content migration verified 153 Markdown documents and 740 bibliography
  records against PostgreSQL.
- Uploaded asset metadata and bytes use PostgreSQL instead of a local
  `var/objects` directory or a separate object-storage service.
- Resend support covers workspace invitations. DNS and real email delivery
  were verified.
- The repository includes a production `Dockerfile`, Railway configuration,
  `/api/health`, and documented production environment requirements.
- Unit, integration, PostgreSQL, isolation, and production-build checks have
  been established.

## Remaining operations

Continue exercising authentication, invitations, editing, asset upload, and
cross-workspace isolation in production. Keep database backups, logs, alerts,
and rollback procedures current as public usage grows. Follow the
[deployment runbook](production-deployment.md) for future releases.
