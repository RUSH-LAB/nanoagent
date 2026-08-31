# Local testing

## Prerequisites

- Node.js 20 or newer
- npm
- Access to an isolated Mochi Lab Neon development branch
- No local PostgreSQL or Docker installation is required

```bash
npm ci
npm install --global neon@latest
neon auth
neon link --project-id curly-rice-08210507 --branch production -y
neon checkout dev-my-laptop
npm run neon:deploy
npm run db:postgres:setup
```

## Environment

`npm run db:postgres:setup` creates the git-ignored `.env.postgres.local` file.
It must contain these variables; never commit their real values:

```dotenv
DATABASE_URL=postgresql://mochi_runtime:...@...-pooler.../neondb?sslmode=require
DATABASE_MIGRATION_URL=postgresql://neondb_owner:...@.../neondb?sslmode=require
BETTER_AUTH_SECRET=...
PG_DRIVER=neon-serverless
PG_SSL=require
PG_SSL_REJECT_UNAUTHORIZED=true
ENABLE_AUTH=true
DEV_AUTOLOGIN=false
```

`.env.production.local` is optional for local application startup. It is only
needed to verify R2 or Resend:

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

## Run

```bash
npm run test:postgres
npm run start:postgres
```
