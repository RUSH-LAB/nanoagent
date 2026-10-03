# Mochi Lab

https://www.alphaxiv.org

A collaborative workspace for knowledge, documents, communication, and AI agents.

Install the required runtimes, dependencies, adjacent NanoAgent checkout, and
sanitized local environment file:

```bash
./install.sh
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
The installer never overwrites an existing checkout or local environment file.
Set `NANOAGENT_REPOSITORY` and `NANOAGENT_REF` before running it to reproduce
against a fork or a specific branch/tag.

See [repository commands and local setup](scripts/README.md) or the [documentation index](docs/README.md).
