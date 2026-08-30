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

`npm start` signs you in automatically as **root**, the owner account. Nothing to type, no keys to
configure. The account is a real row in a local SQLite database at `var/data/mochi.db`, which the
server creates on first run.

```bash
npm start            # API + site, signed in as root
npm run start:noauth # no gate at all: every request is a fixed development user
```

To use the sign-in screen instead, sign out from `/settings`, or run without auto-login:

```bash
ENABLE_AUTH=true node src/server/index.js & ENABLE_AUTH=true npm run start:site
```

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

**Schema.** `src/server/migrations/*.sql` is applied at startup and recorded, so a clean checkout works
on the first `npm start`. `tests/unit/server/db-schema.test.mjs` fails if the committed schema drifts
from what the installed Better Auth expects.

**The root account.** `npm start` creates `root` if it is missing and makes it an owner in the role
store, which is what gives `/admin` a first owner to act as. It is an ordinary account: the generated
password is written to `var/data/.root-password` (git-ignored), so you can also sign in as root by
hand, or set `ROOT_PASSWORD` / `ROOT_USERNAME` / `ROOT_EMAIL` to choose your own.

**Auto-login is development-only, three times over.** `POST /api/dev-login` performs an ordinary
password sign-in on your behalf, and refuses unless all of these hold:

| Guard | Failure |
|---|---|
| `DEV_AUTOLOGIN=true`, set only by `npm start` | `404` |
| `NODE_ENV` is not `production` | `404` |
| The request came from loopback | `403` |

There is no branch that skips authentication, so the session it returns is indistinguishable from one
you typed a password for. `tests/unit/server/dev-auth.test.mjs` checks each guard on its own.

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
  plugins/               # Docusaurus plugins
    lean-proofs/         #   Serves the Lake project in proofs/ as global data
    bibliography/  math-registry/  remark-cite/  remark-wiki-links/
  tests/
    unit/                #   Mirrors the source tree
    integration/         #   HTTP suites against a running server
  var/                   # Runtime state, gitignored (data, logs, trash)
```

The platform runs two processes in parallel: a **Docusaurus static site** serving content pages, and a **Node.js HTTP API server** providing data persistence and backend features.

## API Overview

The API server exposes **188 REST endpoints** under `/api/*`. Major categories:

| Category | Endpoints | Description |
|---|---|---|
| File operations | 27 | CRUD, move, quality analysis, targets |
| References | 37 | Bibliography, citations, enrichment, export, tracking |
| Content analysis | 18 | Health, duplicates, freshness, topics, coverage, clusters |
| Analytics & stats | 20 | Page views, heatmaps, dashboards, productivity reports |
| Search | 8 | Full-text search, metadata search, find-and-replace |
| Flashcards | 6 | Spaced-repetition review, deck management |
| Notes | 4 | Personal keyed notes |
| Collaboration | 4 | Sessions, users |
| Knowledge tools | 6 | Bookmarks, reading lists, glossary |
| Infrastructure | 10 | Health, backup, snapshots, logs, debug, perf |

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
