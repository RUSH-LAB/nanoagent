# Production deployment

Mochi's public surface is one Node process serving both the built Docusaurus
shell and `/api/*`. Keeping one public origin lets Better Auth use HttpOnly,
Secure, same-site cookies without exposing credentials to browser JavaScript.
It calls NanoAgent over Railway's private network; NanoAgent is never public.
That NanoAgent offers no plugin package of its own and only packs the plugins
published to the marketplace from GitHub: every run, plugin install and plugin
page is on the member's own computer, through RUSH Lab
(`src/server/runner.js`), and is refused while it is not connected.

## Required services

- Production's PostgreSQL database, with a direct schema-owner URL and a
  pooled restricted `mochi_runtime` URL. Local `npm start` runs on a copy of
  it of its own.
- A GitHub OAuth App whose callback is `<SITE_URL>/api/auth/callback/github`,
  for `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`; GitHub is the only
  sign-in. `ROOT_GITHUB_LOGIN` names the GitHub account that administers the
  platform; every start provisions it.
- An HTTPS transactional-email webhook for workspace invitations.
- A container host with HTTPS termination and secret management.
- A private NanoAgent service with a shared `NANOAGENT_API_TOKEN`, and no
  model-provider key.
- An OpenRouter management key, `OPENROUTER_MANAGEMENT_KEY`: a member's Mochi
  Lab that connects without an OpenRouter key is given one of its own on this
  account, in the OpenRouter workspace `mochi` that Mochi makes, with a
  lifetime budget of $10 for every member together
  (`src/server/openrouter-keys.js`); OpenRouter stops every key in it once
  that is spent. Mochi keeps none of the keys; a member who saves their own
  key is given none. Without it, members add their own.
- An upload token, `LAB_UPLOAD_TOKEN`: a long random string the release job
  sends as `Authorization: Bearer` to `PUT /api/lab/bundles/<target>`, the
  RUSH Lab app's dmgs that members download (`src/server/routes/lab.js`).
  Without it, uploads answer 503.

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

For invitation email, verify `rush-lab.org` in Resend, configure
`RESEND_API_KEY`, `MAIL_FROM`, and `MAIL_TEST_TO`, then send one deployment
probe:

```bash
npm run mail:verify
```

`MAIL_TEST_TO` is used only by this command. The application sends invitation
messages to their actual recipients.

## Release sequence

1. Back up the legacy database, content tree, and uploaded objects.
2. Railway's pre-deploy step applies the migrations (`scripts/db/apply-schema.mjs`).
3. Run the legacy database and content importers without their apply flags and
   review counts, hashes, owners, and conflicts.
4. Freeze legacy writes and repeat the approved imports with `--apply`.
5. Build with `docker build -t mochi-lab .` and deploy the resulting image.
6. Verify `/api/health`, GitHub sign-in, workspace creation, invitation delivery,
   asset upload, and cross-workspace 404 behavior before switching traffic.

## Railway

Create the public Mochi service from `RUSH-LAB/nanoagent`, branch `production`,
with root directory `helpinghands` and watch path `/helpinghands/**`. Railway
reads `railway.toml` from the root directory, which sets the build
(`Dockerfile`), the pre-deploy migrations, and the health check; keep those
there rather than in the service settings. Add every value from
the database, authentication, and email configuration described above to the
service variables; do not upload `.env`. `DATABASE_URL` and
`DATABASE_MIGRATION_URL` point at the Neon `production` branch
([neon-postgres-setup.md](neon-postgres-setup.md)). GitHub sign-in uses its own
OAuth App, with the callback `https://rush-lab.org/api/auth/callback/github`.

Create a second, private service from the same repository and branch, with
root directory `nanoagent` and watch path `/nanoagent/**`. Run
`nanoagent web` with a web config that binds
`0.0.0.0:$PORT`, reads
`NANOAGENT_API_TOKEN` from the environment, and keeps `tools: []` for the first
release. Install the `nanoagent[hermes]` extra to enable Hermes profiles and
install/link `@nanoagent/pi-runner` with Node 22.19 or newer to enable PI
profiles; profiles whose runner is missing remain visible as unavailable. Give it no
model-provider credential: it runs nothing. On Mochi, set
`NANOAGENT_URL` to the private Railway URL and set the same
`NANOAGENT_API_TOKEN`. Do not expose a public domain for NanoAgent.

Generate a Railway domain for the first deployment. Once it is healthy, attach
`rush-lab.org` or an application subdomain, update `SITE_URL` and
`CORS_ORIGIN` to that exact HTTPS origin, and redeploy.

## Rollback

Keep the pre-cutover PostgreSQL backup for an explicit rollback window. Because
asset metadata and bytes share the database, one database restore returns them
to the same point in time. Roll back the application image before reopening
writes.
