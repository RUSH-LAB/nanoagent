# Local development if you are not the owner (zeyuyang8)

`npm run db:setup` and `npm run db:pull` read production's values from the `mochi-lab` service on Railway, so they work only for an account that is in the Railway project that holds it. The owner's Railway login, `zeyuyang8@gmail.com`, lists only `cozy-solace`, not `mochi-lab`, so ask the owner which account or workspace has it and get your own account invited. Never sign in to Railway as the owner.

Without that access, run on an empty local database.

## 1. Install

Follow [README.md](README.md) (`install.ps1`).

## 2. Fill in `helpinghands/.env`

The owner gives you these over a private channel. `.env` is git-ignored; never commit it.

`OPENROUTER_MANAGEMENT_KEY`, `BETTER_AUTH_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `ROOT_GITHUB_LOGIN`. `LAB_UPLOAD_TOKEN` is for releases only; the `RESEND_*` and `MAIL_*` values are for email only.

`ROOT_GITHUB_LOGIN` is the GitHub account that administers your local copy. Set it to your own GitHub login: sign-up is by invitation, and the root account is the only one that exists on an empty local database, so any other login is refused with `signup-closed`.

Do not put a database URL in `.env`: `npm start` refuses one.

## 3. Create the local database without Railway

From `helpinghands/`, in a new terminal, instead of `npm run db:setup`:

```powershell
node -e "import('./scripts/db/local.mjs').then(m => console.log(m.createLocal() ? 'created' : 'already there'))"
```

This makes the PostgreSQL 18 cluster in `var/postgres` (port 55432), its `mochi` database and its `mochi_runtime` role. It does what `db:setup` does after reading Railway, and needs PostgreSQL 18 installed by `install.ps1`.

Skip `npm run db:pull`: it needs Railway. The local site then starts with no production data.

## 3b. Pulling production (needs access to the Railway project)

The project is `cozy-solace`, with the `mochi-lab` and `nanoagent` services. Your own Railway account needs access to it. With that, from `helpinghands/`:

```powershell
railway login
railway link --project cozy-solace --environment production --service mochi-lab
npm run db:pull      # replaces the local database with a copy of production
```

Stop `npm start` before a pull. `db:pull` only reads production.

On Windows, git checks files out with CRLF, which changes the checksums of the SQL migrations, and `npm start` then stops with `Applied migration changed: 0001_core.sql`. The root `.gitattributes` (`*.sql text eol=lf`) keeps them LF. In a clone made before it existed, delete the tracked `.sql` files and run `git checkout -- <files>` once to rewrite them.

## 4. Generate NanoAgent's lockfile

`npm start` runs `uv sync --locked` in `nanoagent/`, whose `uv.lock` is git-ignored and so is not in a fresh clone. Make it once:

```powershell
cd nanoagent
uv lock
cd ..\helpinghands
```

## 5. Start

```powershell
$env:NANOAGENT_URL = "off"        # NanoAgent's Python server needs Unix sockets and bwrap: it cannot run on native Windows
$env:PG_CONNECT_TIMEOUT_MS = "60000"   # the first start migrates the database and Windows opens connections slowly; the default 10 s times out
npm start                          # http://localhost:3000
```

`npm start` starts the cluster if it is stopped and applies the migrations. With `NANOAGENT_URL=off` the site runs without the AI assistant and without plugins. Running those would need the whole stack inside WSL2 (Ubuntu); that is untried here, and `helpinghands/install.sh` supports macOS only.

## 6. Sign-in

GitHub is the only sign-in. Your GitHub OAuth App must list `http://localhost:3001/api/auth/callback/github` as a redirect URI, or GitHub refuses with "The redirect_uri is not associated with this application".

## Windows notes

- `scripts/db/local.mjs` finds PostgreSQL at `C:\Program Files\PostgreSQL\18\bin`, and `scripts/db/postgres.mjs` runs `railway.cmd` through a shell.
- A new terminal is needed after `install.ps1` for `PATH` to include Node, uv and Railway. In a stale one, `railway.cmd` fails with `"node" is not recognized`.
- `railway login` prints a code at `https://railway.com/activate`; `railway login --browserless` is the form that works from a terminal that can't open a browser.
