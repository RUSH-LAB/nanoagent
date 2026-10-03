# Production deployment

Mochi's public surface is one Node process serving both the built Docusaurus
shell and `/api/*`. Keeping one public origin lets Better Auth use HttpOnly,
Secure, same-site cookies without exposing credentials to browser JavaScript.
It calls NanoAgent over Railway's private network; NanoAgent is never public.

## Required services

- A PostgreSQL database separate from development, with a direct schema-owner
  URL and a pooled restricted `mochi_runtime` URL.
- An HTTPS transactional-email webhook for verification, password reset, and
  workspace invitations.
- A container host with HTTPS termination and secret management.
- A private NanoAgent service with its model-provider key and a shared
  `NANOAGENT_API_TOKEN`.

The current deployment target is Railway. It builds the committed `Dockerfile`,
injects `PORT`, checks `/api/health`, and terminates TLS at the public domain.

Uploaded object bytes are stored in PostgreSQL alongside their metadata. After
applying migrations, verify the database-backed object path before deploying:

```bash
npm run object-storage:verify
```

The probe writes one random object below an existing workspace, verifies its
bytes and metadata, deletes it, and confirms deletion. It never reads or
modifies a business asset.

For account email, verify `mochi-lab.org` in Resend, configure
`RESEND_API_KEY`, `MAIL_FROM`, and `MAIL_TEST_TO`, then send one deployment
probe:

```bash
npm run mail:verify
```

`MAIL_TEST_TO` is used only by this command. The application sends verification,
password-reset, and invitation messages to their actual recipients.

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

## Railway

Create the public Mochi service from the GitHub repository and select the release branch.
Railway will use `railway.toml` and the root `Dockerfile`. Add every value from
the database, authentication, and email configuration described above to the
service variables; do not upload `.env.local`.

Create a second, private service from the standalone NanoAgent repository. Run
`nanoagent web` with a web config that binds
`0.0.0.0:$PORT`, reads
`NANOAGENT_API_TOKEN` from the environment, and keeps `tools: []` for the first
release. Install the `nanoagent[hermes]` extra to enable Hermes profiles and
install/link `@nanoagent/pi-runner` with Node 22.19 or newer to enable PI
profiles; profiles whose runner is missing remain visible as unavailable. Put
the model-provider credential only on this service. On Mochi, set
`NANOAGENT_URL` to the private Railway URL and set the same
`NANOAGENT_API_TOKEN`. Do not expose a public domain for NanoAgent.

Generate a Railway domain for the first deployment. Once it is healthy, attach
`mochi-lab.org` or an application subdomain, update `SITE_URL` and
`CORS_ORIGIN` to that exact HTTPS origin, and redeploy.

## Rollback

Keep the pre-cutover PostgreSQL backup for an explicit rollback window. Because
asset metadata and bytes share the database, one database restore returns them
to the same point in time. Roll back the application image before reopening
writes.
