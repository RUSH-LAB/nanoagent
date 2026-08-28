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
- In-browser rich text editor (TipTap) with AI writing assistance and templates
- Spaced-repetition flashcards and glossary management
- Knowledge graph visualization and mind maps
- Content recommendations and semantic search
- Reading lists, bookmarks, and reading progress tracking
- Whiteboard for freeform visual note-taking

**Collaboration & Analytics**
- Real-time presence indicators and user sessions
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
npm run start:auth   # dev server with auth
npm run build:auth   # production build with auth
```

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
    pages/               #   App pages (editor, graph, flashcards, ...)
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

The API server exposes **205 REST endpoints** under `/api/*`. Major categories:

| Category | Endpoints | Description |
|---|---|---|
| File operations | 38 | CRUD, rename, move, drafts, quality analysis, targets |
| References | 37 | Bibliography, citations, enrichment, export, tracking |
| Content analysis | 18 | Health, duplicates, freshness, topics, coverage, clusters |
| Analytics & stats | 20 | Page views, heatmaps, dashboards, productivity reports |
| Search | 8 | Full-text search, metadata search, find-and-replace |
| Flashcards | 6 | Spaced-repetition review, deck management |
| Notes | 4 | Personal keyed notes |
| Collaboration | 6 | Presence, sessions, users |
| Knowledge tools | 10 | Bookmarks, reading lists, glossary, templates, goals |
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
| Frontend | React 19, TipTap editor, Mafs (interactive math), KaTeX |
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
| Editor | `/editor` | Rich text editor with file tree and AI assistant |
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
