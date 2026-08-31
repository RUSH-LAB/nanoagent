# Mochi Lab

A workspace-scoped research knowledge platform for writing, organizing, and exploring technical content, built with React/Docusaurus and a Node.js API.

The browser URL is the source of workspace context (`/w/:workspaceSlug/...`).
Workspace APIs always carry the immutable workspace id
(`/api/workspaces/:workspaceId/...`); the server revalidates membership and
constructs one `RequestContext` before domain code runs.

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
the owner account, a real row in the local development database at
`var/data/mochi.db` that the server creates on first run.

```bash
npm start            # API + site, with the one-click root sign-in
npm run start:noauth # no gate at all: every request is a fixed development user
npm run build && npm run start:production # one-origin production shell + API
```

Production requires `BETTER_AUTH_SECRET`, `SITE_URL`, `DATABASE_URL`, a
separate-owner `DATABASE_MIGRATION_URL`, `MAIL_WEBHOOK_URL`, and the
`OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_BUCKET`,
`OBJECT_STORAGE_ACCESS_KEY_ID`, and `OBJECT_STORAGE_SECRET_ACCESS_KEY` values.
See [`docs/production-deployment.md`](docs/production-deployment.md) for the
container, migration, verification, and rollback checklist.

The same screen supports ordinary email/password accounts alongside root.

## Authentication

Accounts, sessions, and organizations live in the local SQL database and are managed by
[Better Auth](https://better-auth.com). `ENABLE_AUTH` gates the site's sign-in screen and the API's
identity check together, so the two can never disagree about whether a session is required.

| | `npm start` | `npm run start:noauth` |
|---|---|---|
| Sign-in screen | Shown | Skipped |
| API identity | The signed-in account | A fixed `dev-user` |
| Used by | Normal development | The test suites |

**How a session travels.** Better Auth uses an HttpOnly session cookie. The
browser cannot read the credential; `apiFetch` sends credentialed requests and
development CORS is restricted to configured trusted origins. Production is
expected to serve the site and API from the same origin with Secure cookies.

**What is public.** Only health, Better Auth endpoints, and the read half of an
invitation link are public. Workspace feeds are scoped resources too. A client
supplied `userId`, workspace id in a body, or session default never authorizes a
business operation.

### Persistence

Local development uses one SQLite file, `var/data/mochi.db`. When
`DATABASE_URL` is set, the server switches authentication and every business
repository to PostgreSQL; uploaded bytes use the S3/R2-compatible object-store
adapter. Production also requires a separate `DATABASE_MIGRATION_URL` owner
connection so the runtime role cannot bypass row-level security. The schema,
transactional migration runner, and RLS policies live under `src/server/postgres/`:

```bash
sqlite3 var/data/mochi.db ".tables"
npm run db:postgres:migrate
```

For an isolated Neon development branch, link the branch and let setup create
the private `.env.postgres.local` automatically:

```bash
npm run neon:deploy
npm run db:postgres:setup
npm run test:postgres
```

Then run `npm run start:postgres:api` and `npm run start:site` in two terminals.
The complete hosted setup and clean-machine checklist is documented in
[`docs/infra/neon-postgres-setup.md`](docs/infra/neon-postgres-setup.md).

The production schema uses `app_user`, `workspace`, `workspace_member`,
`workspace_invitation`, `workspace_settings`, `user_preferences`,
`workspace_member_preferences`, `document`, `document_version`, `asset`, and
`reference`, plus scoped collaboration/support tables. Better Auth maps its
session, account, verification, organization, membership, and invitation
models onto the same PostgreSQL schema. The identity/organization control plane
is authorized by Better Auth; workspace-owned product tables additionally use
PostgreSQL row-level security.
SQLite keeps its historical physical table names only for local development.

### Managing users

Workspace roles are deliberately small: **owner**, **editor**, and **viewer**.
They live on each membership, so one account may own one workspace and merely
view another. `/admin` manages the separate internal platform-admin flag; it
does not grant implicit access to workspace data.

Root is the first local workspace owner, created by `npm start`. Everyone else
joins through workspace membership or an invitation. The last owner cannot be
removed or demoted.

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
  content/               # Legacy import source; not live runtime content
    books/               #   Docs: programming, math, builder, survey
    posts/               #   Blog posts and research papers
      authors.yml        #     Shared author map for both blog instances
    bibliography/        #   references.yaml, one-time bibliography import source
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
    lean-proofs/         #   Authors, formalizes, renders, and checks Lean proofs
    math-registry/       #   Owns numbered math blocks and cross-references
    wiki-links/          #   The [[page]] syntax
  scripts/               # Executable repo tooling, grouped by responsibility
    db/                  #   Database setup and schema commands
    migrations/          #   One-time data movement/imports
    maintenance/         #   Explicit repair and cleanup operations
    dev/                 #   Developer generators
    README.md            #   Command map and safety notes
  tests/
    unit/                #   Mirrors the source tree
    integration/         #   HTTP and real-database acceptance suites
  var/                   # Runtime state, gitignored (data, logs, trash)
```

The platform runs a Docusaurus application shell and a Node.js API. Documents
are fetched and rendered at runtime from scoped database records; Docusaurus no
longer builds one static content tree per workspace.

The current platform boundaries and the deliberate scale-up path are described
in [`docs/infra/platform-architecture.md`](docs/infra/platform-architecture.md). PostgreSQL
is the authoritative store; search, graphs, feeds, and caches are derived data
rather than competing sources of truth.

Every tool on the site is a plugin: one directory under `plugins/` holding its
pages, its endpoints, and any markdown syntax it adds. Nothing lists them, both
processes discover them, so adding a tool is adding a directory —
`npm run new:plugin -- <name>` scaffolds one. The contract is written down in
[`plugins/README.md`](plugins/README.md).

## API Overview

Workspace endpoints are exposed below `/api/workspaces/:workspaceId/*`.
Account-global endpoints such as `/api/preferences` and `/api/workspaces` remain
outside that namespace.

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
npm run test:postgres       # real PostgreSQL RLS + authenticated HTTP acceptance
npm run test:all            # unit + integration tests
```

The suite covers request-context isolation, authorization, content rendering,
database migrations, object storage, endpoint behavior, plugin boundaries, and
executes the production PostgreSQL schema in PGlite to exercise RLS with a
non-owner role. The staging probe remains `npm run db:postgres:verify`.

## Tech Stack

| Layer | Technology |
|---|---|
| Site framework | Docusaurus 3 |
| Frontend | React 19, Mafs (interactive math), KaTeX |
| API server | Node.js (vanilla `http` module, no framework) |
| Auth | Better Auth, email/password, HttpOnly cookie sessions |
| Search | docusaurus-search-local |
| Data storage | SQLite for local development; PostgreSQL + RLS in production; S3/R2-compatible assets |
| Math typesetting | remark-math + rehype-katex |
| Code highlighting | Prism (with custom Lean 4 grammar) |

## Pages

| Page | Route | Description |
|---|---|---|
| Home | `/` | Landing page with feature overview |
| Graph | `/w/:workspaceSlug/graph` | Interactive knowledge graph of workspace content |
| Bibliography | `/w/:workspaceSlug/bibliography` | Workspace reference manager with citation analytics |
| Research | `/w/:workspaceSlug/documents/posts/research` | Research paper summaries and notes |
| Blog | `/w/:workspaceSlug/documents/posts/blog` | Blog posts |
| Reading Lists | `/w/:workspaceSlug/reading-lists` | Personal reading collections in a workspace |
| Recommendations | `/w/:workspaceSlug/recommendations` | Workspace content discovery engine |
| Flashcards | `/w/:workspaceSlug/flashcards` | Personal spaced-repetition cards in a workspace |
| Glossary | `/w/:workspaceSlug/glossary` | Shared workspace terminology |
| Analytics | `/w/:workspaceSlug/analytics` | Workspace usage statistics and dashboards |
| Timeline | `/w/:workspaceSlug/timeline` | Workspace content timeline |
| Mindmap | `/w/:workspaceSlug/mindmap` | Visual mind map of workspace topics |
| Whiteboard | `/w/:workspaceSlug/whiteboard` | Shared workspace drawing canvas |
| Compare | `/w/:workspaceSlug/compare` | Side-by-side workspace document comparison |
| Content Search | `/w/:workspaceSlug/content-search` | Workspace full-text search |
| Tasks | `/w/:workspaceSlug/tasks` | Personal tasks in a workspace |
| Stats | `/w/:workspaceSlug/stats` | Workspace content statistics |
| Settings | `/w/:workspaceSlug/settings` | Workspace settings |
| People | `/w/:workspaceSlug/people` | Members and invitations |
| Admin | `/admin` | Internal platform administration |
| About | `/about` | About the project |
| API Docs | `/api-docs` | Interactive API documentation |

## License

Private project. Copyright Mochi Lab.
