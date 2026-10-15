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

This runs on production's database, the only one, as the restricted runtime
role, so what you change locally is real. Run `npm run db:setup` once before
using it; `npm start` refuses to run until production has applied exactly the
migrations in your checkout.
Open [http://localhost:3000](http://localhost:3000). By default, the supervisor
uses the adjacent `../nanoagent` checkout. Set `NANOAGENT_PROJECT_DIR` to use a
checkout elsewhere, or `NANOAGENT_URL` to use an already-running agent service.
With the local NanoAgent, the checkout is also your Mochi Lab: every AI run goes
to a member's own computer, so `npm start` prints a sign-in link once; open it,
signed in as the account you test with, and approve the code. Your runs then use
the local NanoAgent, and Settings → AI can set its API key (until `npm start`
stops; `.env`'s keys are where it starts).
The installer never overwrites an existing local environment file.

NanoAgent ships no plugin: each is published to the marketplace from its own
repository. To have the local NanoAgent publish plugin packages too, set
`NANOAGENT_PLUGINS_DIR` to a folder of plugins (each a folder with a
`nanoagent.yaml`); Mochi shows them as apps at `/apps`, where you can read what
each one does and run its tasks. A `NANOAGENT_PLUGINS_DIR` that is missing or
holds no plugin stops the launch.

All local secrets and connection settings live in the single git-ignored
`.env` file.

See [repository commands and local setup](scripts/README.md) or the [documentation index](docs/README.md).
