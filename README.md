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

Auth is disabled by default, in dev and in production builds. To enable the Clerk sign-in gate:

```bash
export CLERK_SECRET_KEY=sk_...   # required whenever ENABLE_AUTH=true
npm run start:auth               # dev server with auth
npm run build:auth               # production build with auth
```

### Authentication

`ENABLE_AUTH` gates the site's sign-in screen and the API's identity check together.

With it on, every endpoint except `/api/health`, `/api/feed/rss`, and `/api/feed/atom` requires a Clerk
session token, sent as `Authorization: Bearer <token>` or in the `__session` cookie. The server verifies
it with `@clerk/backend` and attaches `{userId, orgId, orgRole, sessionId}` to the request; a missing or
invalid token is a `401` before any handler runs. The server refuses to start with auth on and no
`CLERK_SECRET_KEY`, rather than falling open.

With it off, every request resolves to a fixed development identity, so `npm start` and the test suite
run without a Clerk account.

Either way, handlers read the caller only from the verified identity. A `userId` in a query string or
request body is ignored, and browser code reaches the API through `apiFetch` in `src/utils/api.js`,
which attaches the token. `src/server/auth.js` is the single place any of this is decided.

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
| Auth | Clerk |
| Search | docusaurus-search-local |
| Deployment | Vercel |
| Data storage | JSON files |
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
| Admin | `/admin` | Administration panel |
| About | `/about` | About the project |
| API Docs | `/api-docs` | Interactive API documentation |

## License

Private project. Copyright Mochi Lab.
