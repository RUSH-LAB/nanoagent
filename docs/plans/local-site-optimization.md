# Local site optimization

Status: active.

Production deployment is intentionally paused. The application will continue
to use the migrated Neon `development` database locally while product quality,
speed, and developer workflow are improved.

## Baseline

- Unit suite: 2614 passing after the first optimization batch.
- PostgreSQL 17 GitHub acceptance: passing.
- Authenticated production build: passing.
- Built site size: approximately 6.1 MB.
- Largest JavaScript assets: approximately 534 KB and 319 KB before transfer
  compression.
- Local frontend and API use ports 3000 and 3001 under one process supervisor.

## Workstreams

### 1. Startup and reliability

- [x] Provide one reliable command for starting and stopping the local PostgreSQL
  API and Docusaurus frontend together.
- Keep actionable startup errors for database, authentication, R2, and email.
- Prevent build/dev-server cache collisions.

### 2. Navigation and workspace UX

- Exercise every primary navigation path under `/w/:workspaceSlug/...`.
- Preserve the current workspace across links, command navigation, refreshes,
  and multiple browser tabs.
- Improve loading, empty, unauthorized, and API-unavailable states.

### 3. Frontend performance

- [x] Measure route and shared bundle sizes before changing code.
- [x] Split local search and safe plugin MDX clients out of the initial
  application bundle.
- Lazy-load editor, visualization, math, proof, and command-bar features that
  are not required for the first screen.
- Avoid duplicate workspace, session, and document-tree requests.

### 4. Content workflow

- Optimize large document and bibliography loading without changing the
  database as the source of truth.
- Verify editing, version history, search, references, and asset operations on
  both migrated workspaces.
- Keep Markdown rendering constrained to the approved safe component set.

### 5. Product polish

- Audit keyboard navigation, responsive layouts, empty states, and error copy.
- Remove obsolete compatibility paths only after their remaining callers are
  migrated.
- Keep the browser smoke test and automated suites green after each batch.

## First milestone

The first optimization batch will target local startup reliability and initial
JavaScript cost. Success means one local command starts both services cleanly,
shutdown leaves no orphan processes, and the initial application bundle is
smaller without changing workspace behavior.

Completed result: `npm start`, `npm run start:postgres`, and
`npm run start:noauth` supervise both services and stop them together. The
uncompressed initial application bundle fell from 546,307 bytes to 512,910
bytes; its gzip size fell from about 172.7 KB to 161.6 KB.
