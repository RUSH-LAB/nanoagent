# Mochi Lab

https://www.alphaxiv.org

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

Start the complete stack—NanoAgent, the Mochi API, and the site—with one
command:


```bash
npm start
```

This uses the prepared Neon PostgreSQL branch and credentials from
`.env.postgres.local`, keeping local development on the same authoritative data
path as production. Run `npm run db:postgres:setup` once before using it.
The older `npm run start:postgres` command remains as an explicit alias for
`npm start`.

Open [http://localhost:3000](http://localhost:3000). By default, the supervisor
uses the adjacent `../nanoagent` checkout. Set `NANOAGENT_PROJECT_DIR` to use a
checkout elsewhere, or `NANOAGENT_URL` to use an already-running agent service.

See [repository commands and local setup](scripts/README.md) or the [documentation index](docs/README.md).
