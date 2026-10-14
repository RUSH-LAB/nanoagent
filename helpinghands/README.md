# Mochi Lab

https://www.alphaxiv.org

A collaborative workspace for knowledge, documents, communication, and AI agents.

Every member's AI runs on their own computer, in Mochi Lab (the desktop app,
`desktop/`), whether they use the site in a browser or in the app. Its NanoAgent
calls OpenRouter with the key kept there, and installs, serves the pages of, and
runs every plugin. Mochi's servers keep no model key and run no model or plugin:
they only list the marketplace and hold its plugin packages. While a member's
Mochi Lab is not connected, their AI and plugins are refused, never run elsewhere.

Install the required runtimes, dependencies, adjacent NanoAgent checkout, and
sanitized local environment file:

```bash
./install.sh
```

Then replace the placeholder in `.env` with your OpenRouter
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
`.env`, keeping local development on the same authoritative data
path as production. Run `npm run db:postgres:setup` once before using it.
Open [http://localhost:3000](http://localhost:3000). By default, the supervisor
uses the adjacent `../nanoagent` checkout. Set `NANOAGENT_PROJECT_DIR` to use a
checkout elsewhere, or `NANOAGENT_URL` to use an already-running agent service.
With the local NanoAgent, the checkout is also your Mochi Lab: every AI run goes
to a member's own computer, so `npm start` prints a sign-in link once; open it,
signed in as the account you test with, and approve the code. Your runs then use
the local NanoAgent, and Settings → AI can set its API key (until `npm start`
stops; `.env`'s keys are where it starts).
The installer never overwrites an existing local environment file.

The local NanoAgent also publishes every plugin package built into the
NanoAgent checkout, in its `plugins/` directory (such as `plugins/arxiv-source`).
Mochi shows these as apps at `/apps`, where you can read what each one does and
run its tasks. Set `NANOAGENT_PLUGINS_DIR` to publish packages from somewhere else.
A missing plugins directory stops the launch instead of publishing no apps.

All local secrets and connection settings live in the single git-ignored
`.env` file.

See [repository commands and local setup](scripts/README.md) or the [documentation index](docs/README.md).
