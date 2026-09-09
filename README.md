# Mochi Lab

A collaborative workspace for knowledge, documents, communication, and AI agents.

Install the Node dependencies once and create your local environment file:

```bash
npm ci
cp .env.openrouter.local.example .env.openrouter.local
```

Then replace the placeholder in `.env.openrouter.local` with your OpenRouter
key:

```dotenv
OPENROUTER_API_KEY=...
```

Then choose a database mode. Both commands start the complete stack: NanoAgent,
the Mochi API, and the site.

For ordinary local development:

```bash
npm start
```

This uses a local SQLite file under `var/data/`. It needs no database setup and
is the quickest way to run the project.

For development against PostgreSQL:

```bash
npm run start:postgres
```

This uses the prepared Neon PostgreSQL branch and credentials from
`.env.postgres.local`. Run `npm run db:postgres:setup` before using it. Choose
this mode when testing PostgreSQL behavior, migrations, permissions, or the
production-like database path.

Open [http://localhost:3000](http://localhost:3000). NanoAgent is bundled in
`services/nanoagent`; no adjacent checkout or second terminal is required. Set
`NANOAGENT_URL` only when you intentionally want to use an external agent
service.

See [repository commands and local setup](scripts/README.md) or the [documentation index](docs/README.md).
