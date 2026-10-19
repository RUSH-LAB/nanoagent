# RUSH Lab

https://www.alphaxiv.org

A collaborative workspace for knowledge, documents, communication, and AI agents.

Every member's AI runs on their own computer, in RUSH Lab (the Mac app,
`desktop/`, which they download from the site and connect with one click). Its NanoAgent
calls OpenRouter with the key kept there, and installs, serves the pages of, and
runs every plugin. RUSH's servers keep no model key and run no model or plugin:
they only list the marketplace and hold its plugin packages. While a member's
RUSH Lab is not connected, their AI and plugins are refused, never run elsewhere.

## OpenRouter keys

- AI runs on the member's own laptop, using the OpenRouter key saved in their
  RUSH Lab (`settings.env` in its connection folder).
- If they haven't saved one, RUSH creates one for them: a key of their own,
  named `RUSH <user id>`, in the OpenRouter workspace `mochi` (`mochi-dev` for
  every site but production), which holds $10 for every member together
  (`src/server/openrouter-keys.js`). If they type their own under Settings →
  Usage, that one is used instead.
- The only OpenRouter secret RUSH's server needs is `OPENROUTER_MANAGEMENT_KEY`
  on Railway's `mochi-lab` service, which creates those keys. RUSH keeps none
  of the keys it creates.

## Running locally

Install the required runtimes, dependencies, adjacent NanoAgent checkout, and
sanitized local environment file:

```bash
./install.sh
```

Then fill in the GitHub values in `.env` ([scripts/README.md](scripts/README.md));
`npm run db:setup` sets `OPENROUTER_MANAGEMENT_KEY` in it from Railway.

Start the complete stack—NanoAgent, the RUSH API, and the site—with one
command:


```bash
npm start
```

This runs on a local copy of production's database, which `npm start` migrates
itself. Run `npm run db:setup` once, then `npm run db:pull` whenever you want a
fresh copy; `npm run db:push -- <slug>` sends one workspace back to
rush-lab.org (docs/infra/neon-postgres-setup.md).
Open [http://localhost:3000](http://localhost:3000). By default, the supervisor
uses the adjacent `../nanoagent` checkout. Set `NANOAGENT_PROJECT_DIR` to use a
checkout elsewhere, or `NANOAGENT_URL` to use an already-running agent service.
With the local NanoAgent, the checkout is also your RUSH Lab: every AI run goes
to a member's own computer, so `npm start` prints a sign-in link once; open it,
signed in as the account you test with, and approve the code. Your runs then use
the local NanoAgent, and Settings → AI can set its API key (until `npm start`
stops; `.env`'s keys are where it starts).
The installer never overwrites an existing local environment file.

NanoAgent ships no plugin: each is published to the marketplace from its own
repository. To have the local NanoAgent publish plugin packages too, set
`NANOAGENT_PLUGINS_DIR` to a folder of plugins (each a folder with a
`nanoagent.yaml`); RUSH shows them as apps at `/apps`, where you can read what
each one does and run its tasks. A `NANOAGENT_PLUGINS_DIR` that is missing or
holds no plugin stops the launch.

All local secrets and connection settings live in the single git-ignored
`.env` file.

See [repository commands and local setup](scripts/README.md) or the [documentation index](docs/README.md).
