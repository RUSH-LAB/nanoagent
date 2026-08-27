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
- Discussion channels with threaded conversations
- Inline annotations and document comments
- Real-time presence indicators and user sessions
- Page view analytics, activity heatmaps, and content health reports
- Task and goal tracking with productivity reports
- Snapshot versioning and backup/restore

## Quick Start

```bash
npm install
npm start        # starts API server (port 3001) + Docusaurus dev server (port 3000)
```

Auth is disabled by default in dev. To enable Clerk authentication:

```bash
npm run start:auth
```

## Architecture

```
mochi-lab/
  server/index.js            # Node.js API server entry: setup, dispatch, lifecycle (port 3001)
  docusaurus.config.js # Docusaurus site config
  content/
    books/             # Docs: programming, math, builder, survey
    posts/             # Blog posts and research papers
  src/
    pages/             # 20 app pages (editor, graph, flashcards, etc.)
    components/        # React components (Editor, CitationGraph, etc.)
    theme/             # Docusaurus theme overrides
  server/              # Local API server internals
    server-utils.js    # Shared helpers (validation, bibtex, caching)
    routes/            # Request handlers split by domain (files, references, discussions, ...)
  api/                 # Vercel serverless functions
  plugins/             # Docusaurus plugins (bibliography, math-registry, remark-cite, wiki-links)
  data/                # JSON data stores (comments, analytics, discussions, etc.)
  tests/               # Unit and integration test suites
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
| Comments & notes | 8 | Threaded comments, personal notes, annotations |
| Collaboration | 7 | Discussions, presence, sessions, users |
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
| Discussions | `/discussions` | Discussion channels |
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
