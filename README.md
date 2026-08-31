# Mochi Lab

A research knowledge platform for writing, organizing, and exploring technical content -- built on Docusaurus with a 200+ endpoint Node.js API server.

## Key Features

**Content & Publishing**
- Multi-format content: docs (Programming, Math, Builder, Survey), blog posts, and research papers
- LaTeX math rendering with KaTeX and interactive visualizations (Mafs)
- Lean 4 proof verification with syntax highlighting
- BibTeX bibliography management with citation graphs and author analytics
- Wiki-link cross-referencing between documents
- RSS/Atom feed generation

**Knowledge Tools**
- Spaced-repetition flashcards and glossary management
- Knowledge graph visualization and mind maps
- Content recommendations and semantic search
- Reading lists, bookmarks, and reading progress tracking
- Whiteboard for freeform visual note-taking

**Collaboration & Analytics**
- User sessions and role-based access
- Page view analytics, activity heatmaps, and content health reports
- Task and goal tracking with productivity reports
- Snapshot versioning and backup/restore

## Quick Start

```bash
npm install
npm start        # starts API server (port 3001) + Docusaurus dev server (port 3000)
```

`npm start` shows a sign-in screen with a **Sign in as root** button. One click, no password. Root is
the owner account, a real row in a local SQLite database at `var/data/mochi.db` that the server creates
on first run. No external service, no keys to configure.

```bash
npm start            # API + site, with the one-click root sign-in
npm run start:noauth # no gate at all: every request is a fixed development user
```

The same screen also takes an ordinary username or email and password, so you can create and use other
accounts alongside root.

## Authentication

Accounts, sessions, and organizations live in the local SQL database and are managed by
[Better Auth](https://better-auth.com). `ENABLE_AUTH` gates the site's sign-in screen and the API's
identity check together, so the two can never disagree about whether a session is required.

| | `npm start` | `npm run start:noauth` |
|---|---|---|
| Sign-in screen | Shown | Skipped |
| API identity | The signed-in account | A fixed `dev-user` |
| Used by | Normal development | The test suites |

**How a session travels.** Sign-up and sign-in return a token in a `set-auth-token` response header.
The browser keeps it in `localStorage` and `apiFetch` in `src/utils/api.js` attaches it as
`Authorization: Bearer <token>`. Tokens rather than cookies because the site runs on `:3000` and the
API on `:3001`, and a browser will not send a cookie across origins without HTTPS.

**What is public.** Everything except `/api/health`, the two feeds, and `/api/auth/*` needs a valid
session; anything else is a `401` before a handler runs. Handlers read the caller only from that
session, so a `userId` in a query string or request body is ignored.

### The database

One SQLite file, `var/data/mochi.db`, created on first run. Inspect it with any SQLite client:

```bash
sqlite3 var/data/mochi.db ".tables"
sqlite3 -header -column var/data/mochi.db "SELECT username, email, name FROM user;"
sqlite3 -header -column var/data/mochi.db \
  "SELECT u.username, COALESCE(r.role,'viewer') AS role
     FROM user u LEFT JOIN user_role r ON r.userId = u.id;"
```

| Table | Holds |
|---|---|
| `user` | accounts: id, username, email, name |
| `session` | live sessions and their tokens |
| `account` | credentials, including the password hash |
| `user_role` | site-wide role (`owner` / `editor` / `viewer`), foreign key to `user` |
| `organization`, `member`, `invitation` | organizations and membership |
| `verification` | email and reset tokens |
| `_migrations` | which migrations have been applied |

### Managing users

`/admin` lists every account with its role, and an owner can change any of them. Roles are site-wide:
**owner** manages roles, **editor** and **viewer** are for your own authorization checks.

Root is the first owner, created by `npm start`. Everyone else signs up on the sign-in screen and
starts as a viewer until an owner promotes them. The last owner cannot be demoted, since that would
leave nobody able to promote anyone.

Roles live in the database rather than a JSON file, joined to `user` by a foreign key with
`ON DELETE CASCADE`. The file they replaced had no such link: recreating the database gave root a new
id and left the old row behind, so `/admin` came to list three owners, two of them accounts that no
longer existed.

**Schema.** `src/server/migrations/*.sql` is applied at startup and recorded, so a clean checkout works
on the first `npm start`. `tests/unit/server/db-schema.test.mjs` fails if the committed schema drifts
from what the installed Better Auth expects, or if a migration is added but never applied.

**The root account.** `npm start` creates `root` if it is missing and makes it an owner in the role
store, which is what gives `/admin` a first owner to act as. It is an ordinary account: the generated
password is written to `var/data/.root-password` (git-ignored), so you can also sign in as root by
hand, or set `ROOT_PASSWORD` / `ROOT_USERNAME` / `ROOT_EMAIL` to choose your own.

**The root shortcut is development-only, three times over.** The button calls `POST /api/dev-login`,
which performs an ordinary password sign-in on your behalf and refuses unless all of these hold:

| Guard | Failure |
|---|---|
| `DEV_AUTOLOGIN=true`, set only by `npm start` | `404` |
| `NODE_ENV` is not `production` | `404` |
| The request came from loopback | `403` |

There is no branch that skips authentication, so the session it returns is indistinguishable from one
you typed a password for. `tests/unit/server/dev-auth.test.mjs` checks each guard on its own.

An earlier version signed in with no click at all. To avoid an infinite reload it had to remember that
it had already tried, and that memory outlived the session it tracked: wiping the database left tabs
stuck on the form with no way to ask again. A button has no state to go stale.

**Secrets.** `BETTER_AUTH_SECRET` signs sessions. Set it in any real deployment; locally one is
generated on first run and kept in `var/data/.auth-secret`, which git ignores.

`src/server/auth.js` is the single place any of this is decided.

## Architecture

```
mochi-lab/
  docusaurus.config.js   # Docusaurus site config
  vercel.json            # Deploy config (static build, no serverless functions)
  content/               # Everything authored by a human
    books/               #   Docs: programming, math, builder, survey
    posts/               #   Blog posts and research papers
      authors.yml        #     Shared author map for both blog instances
    bibliography/        #   references.yaml, the citation source of truth
  src/                   # All first-party source
    pages/               #   App pages (graph, flashcards, bibliography, ...)
    components/          #   React components, one directory each
    theme/               #   Docusaurus theme overrides
    hooks/  contexts/    #   Shared React hooks and context
    css/                 #   Global stylesheets and the shared page layout
    client/              #   Docusaurus clientModules
    static/              #   Served verbatim (see staticDirectories)
    server/              #   The local API, entry point included
      index.js           #     Setup, dispatch, lifecycle (port 3001)
      routes/            #     Handlers by domain (files, references, feeds, ...)
      server-utils.js    #     Shared helpers (validation, bibtex, caching)
      paths.js           #     Every path the server derives from the repo root
      plugin-api.js      #     #plugin-api: what a plugin may import
  plugins/               # One directory per tool, discovered not listed
    README.md            #   The plugin contract
    loader.js            #   What a plugin is, and how the site finds it
    _template/           #   Scaffold: npm run new:plugin -- <name>
    bibliography/        #   Pages, API, and the [@key] citation syntax
    lean-proofs/         #   Serves the Lake project in proofs/ as global data
    math-registry/       #   Numbers the math books' theorem blocks
    wiki-links/          #   The [[page]] syntax
  scripts/               # Repo tooling (new-plugin.mjs)
  tests/
    unit/                #   Mirrors the source tree
    integration/         #   HTTP suites against a running server
  var/                   # Runtime state, gitignored (data, logs, trash)
```

The platform runs two processes in parallel: a **Docusaurus static site** serving content pages, and a **Node.js HTTP API server** providing data persistence and backend features.

Every tool on the site is a plugin: one directory under `plugins/` holding its
pages, its endpoints, and any markdown syntax it adds. Nothing lists them, both
processes discover them, so adding a tool is adding a directory —
`npm run new:plugin -- <name>` scaffolds one. The contract is written down in
[`plugins/README.md`](plugins/README.md).

## API Overview

The API server exposes **77 REST endpoints** under `/api/*`. Major categories:

| Category | Endpoints | Description |
|---|---|---|
| Study & knowledge | 16 | Flashcards, glossary, notes, tasks, schedule, reading lists, bookmarks, whiteboards |
| Files & folders | 13 | CRUD, move, keywords, quality, readability, mindmap, search, trash |
| Analytics & stats | 11 | Page views, topics, orphans, duplicates, timeline, heatmap, streak, perf |
| Content & search | 9 | Health, duplicates, lint, backlinks, graph, integrity, tags, search, suggest |
| References | 8 | Bibliography, enrichment, export, BibTeX import, tracking, metadata lookup |
| Workspace | 8 | Organizations, members, invitations, audit, chat channels, DMs, users |
| Infrastructure | 7 | Health, logs, snapshots, restore, debug routes and memory |
| Feeds | 3 | RSS, Atom, sitemap |
| AI | 2 | Completion and provider status |

The References row is served by the bibliography plugin rather than by core
(see [`plugins/README.md`](plugins/README.md)); the rest live in
`src/server/routes/`.

## Testing

```bash
npm test                    # unit tests (Node.js test runner)
npm run test:integration    # API integration tests
npm run test:all            # unit + integration tests
```

**18 test suites** covering server utilities, endpoint response shapes, data processing, semantic search, graph algorithms, citation formatting, content health analysis, feed generation, spaced repetition, and more.

## Tech Stack

| Layer | Technology |
|---|---|
| Site framework | Docusaurus 3 |
| Frontend | React 19, Mafs (interactive math), KaTeX |
| API server | Node.js (vanilla `http` module, no framework) |
| Auth | Better Auth (local SQLite) |
| Search | docusaurus-search-local |
| Deployment | Vercel |
| Data storage | SQLite via better-sqlite3 (accounts, organizations); JSON files (app data) |
| Math typesetting | remark-math + rehype-katex |
| Code highlighting | Prism (with custom Lean 4 grammar) |

## Pages

| Page | Route | Description |
|---|---|---|
| Home | `/` | Landing page with feature overview |
| Graph | `/graph` | Interactive knowledge graph of all content |
| Bibliography | `/bibliography` | Reference manager with citation analytics |
| Research | `/research` | Research paper summaries and notes |
| Blog | `/blog` | Blog posts |
| Reading Lists | `/reading-lists` | Curated reading collections |
| Recommendations | `/recommendations` | Content discovery engine |
| Flashcards | `/flashcards` | Spaced-repetition study cards |
| Glossary | `/glossary` | Term definitions and vocabulary |
| Analytics | `/analytics` | Usage statistics and dashboards |
| Timeline | `/timeline` | Chronological content view |
| Mindmap | `/mindmap` | Visual mind map of topics |
| Whiteboard | `/whiteboard` | Freeform drawing canvas |
| Compare | `/compare` | Side-by-side document comparison |
| Content Search | `/content-search` | Advanced full-text search |
| Tasks | `/tasks` | Task and goal tracking |
| Stats | `/stats` | Site-wide statistics |
| Settings | `/settings` | Your account and preferences |
| Admin | `/admin` | Administration panel |
| About | `/about` | About the project |
| API Docs | `/api-docs` | Interactive API documentation |

## License

Private project. Copyright Mochi Lab.
