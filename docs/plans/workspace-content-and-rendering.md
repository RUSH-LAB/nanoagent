# Workspace content and Docusaurus rendering

Status: active.

## Implementation status — 2026-08-31

Completed in the current milestone:

- all 153 migrated Markdown/MDX documents compile through the inert runtime renderer;
- workspace-relative links, images, math, tables, code, admonitions, task lists,
  approved components, headings, sidebars, table of contents, and document
  pagination render without a Docusaurus rebuild;
- workspace site title, tagline, homepage, navigation, collections, and safe
  rendering flags are validated database settings with an owner UI;
- `/w/:workspaceSlug/files` provides database-backed create, read, edit,
  preview, move, soft delete, version inspection, and version restore;
- workspace assets have logical paths, R2/local object storage bytes, upload,
  read, list, delete, migration, and relative-image rendering;
- focused security, isolation, corpus, route, and URL tests pass, as does the
  authenticated production build.

Remaining work is Phase 5 cleanup: move derived analysis/search/feed handlers
off the read-only filesystem compatibility adapter, then remove the adapter
after the rollback window. The compatibility adapter already reads PostgreSQL
snapshots; it is not a second writable content source.

## Objective

Preserve the current `content/<workspace>/...` authoring model and the visual
behavior users expect from Docusaurus, while making PostgreSQL the only live
source of workspace content. A workspace and a document must become available
without restarting or rebuilding the application.

This is not a plan to store and execute one `docusaurus.config.js` per
workspace. Docusaurus configuration is trusted build-time JavaScript. Allowing
a workspace to supply it would require a rebuild for every change and would let
workspace content execute code in the signed-in application origin.

Instead, the system will have:

- one shared Docusaurus application shell and trusted component/plugin set;
- validated, data-only site settings for each workspace;
- virtual content paths in PostgreSQL that preserve the existing folder model;
- a runtime compiler and Docusaurus-themed renderer with a documented safe
  Markdown/MDX contract;
- an optional export/build path later for a workspace that needs a public,
  fully static site.

## Current baseline

- `content/mochi/` contains 153 Markdown/MDX documents. The
  `content/hello-world/` directory exists but has no documents.
- PostgreSQL already contains the migrated documents, versions, references,
  workspace settings, and workspace membership boundary.
- The runtime route `/w/:workspaceSlug/documents/...` reads scoped database
  rows and does not require a Docusaurus rebuild.
- The runtime compiler renders all 153 source documents. The corpus test keeps
  relative links/images, LaTeX braces, MDX comments, safe `details`, and
  component attributes from regressing.
- The old Docusaurus build supplied docs/blog layouts, generated sidebars,
  heading anchors, table of contents, code rendering, blog metadata, feeds,
  and search. The current runtime document route does not yet reproduce all of
  these behaviors.
- Several older routes still use `/api/file` shapes or a read-only virtual
  filesystem facade over document rows. PostgreSQL is already the backing
  source in production, but the compatibility layer obscures that boundary.

## Architecture decisions

### Shared application code

The following remain global, versioned application code:

- `docusaurus.config.js`;
- `src/pages`, `src/theme`, shared CSS, React components, and client modules;
- installed plugins and the global allowlist of components that workspace
  documents may use;
- authentication, authorization, rendering, search, and publishing code.

Browser code is public to the browser. `src/server` and plugin server modules
remain server-only, but they are still shared application code rather than
workspace data.

### Workspace-owned data

PostgreSQL owns:

- workspace identity and membership;
- site settings such as title, tagline, logo asset, home document, navigation,
  collection definitions, and enabled safe features;
- documents, their virtual paths, source format, parsed frontmatter, status,
  and version history;
- asset metadata and workspace-relative asset paths, with bytes in R2;
- authors, references, tags, and other workspace collections.

The database path `books/math/3-linear-algebra/1-vectors-and-matrices.md` is the
equivalent of the current file below `content/<workspace>/`. Directories remain
virtual prefixes rather than operating-system directories.

### Workspace site settings

`workspace_settings.value` will use a versioned, validated schema rather than
accepting Docusaurus JavaScript. The first schema will cover:

```json
{
  "schemaVersion": 1,
  "site": {
    "title": "Mochi Lab",
    "tagline": "Innovative Research & Development",
    "logoAssetId": null,
    "homeDocument": "books/programming/0-intro.md"
  },
  "navigation": [
    {"label": "Research", "path": "posts/research"},
    {"label": "Programming", "path": "books/programming/0-intro.md"}
  ],
  "collections": [
    {"key": "programming", "type": "docs", "pathPrefix": "books/programming", "title": "Programming"},
    {"key": "research", "type": "blog", "pathPrefix": "posts/research", "title": "Research"}
  ],
  "rendering": {
    "math": true,
    "citations": true,
    "wikiLinks": true,
    "leanProofs": true,
    "interactiveMath": true
  }
}
```

Only known keys and bounded values are accepted. A workspace may enable a
subset of components already installed by the application; it cannot load a
package, module path, script, stylesheet URL, or arbitrary React component.

## Rendering contract

The runtime renderer must reproduce the supported Docusaurus authoring
experience without evaluating document JavaScript.

### Required Markdown behavior

- frontmatter: `title`, `slug`, `sidebar_position`, `authors`, `tags`, `date`,
  and `draft`;
- headings with stable slugs and clickable anchors;
- paragraphs, emphasis, strong text, blockquotes, lists, task lists, tables,
  thematic breaks, and footnotes;
- fenced code blocks rendered with the site's Docusaurus/Prism code component;
- inline and display math rendered through KaTeX;
- relative document links rewritten under the current
  `/w/:workspaceSlug/documents/...` route;
- relative images resolved against the current document and served from the
  workspace asset API;
- admonitions and the existing safe `details`/`summary` pattern;
- bibliography citations, references, wiki links, theorem environments, Lean
  proofs, and interactive math components already used by the content corpus;
- MDX comments such as the blog truncate marker treated as metadata/no-op.

### Explicitly forbidden

- `import` and `export` in workspace documents;
- JavaScript expressions, event handlers, or executable component props;
- raw scripts, iframes, unsafe HTML, protocol-relative URLs, and unapproved URL
  schemes;
- arbitrary component names or components not enabled for the workspace.

The parser must distinguish Markdown text and math braces from MDX expressions.
The existing corpus is the compatibility fixture: all 153 imported documents
must parse before the old content tree can be retired.

### Docusaurus page behavior

The runtime page will use shared Docusaurus theme components to provide:

- workspace-aware navbar and branding;
- generated document sidebar from paths and `sidebar_position`;
- breadcrumbs, table of contents, heading anchors, and previous/next links;
- docs and blog presentation selected by collection type;
- blog title, date, authors, tags, reading time, archive/list pages, and truncate
  behavior;
- syntax-highlighted code, theme-aware math, responsive tables, and the current
  custom academic components;
- database-backed workspace search instead of a build-time static search index.

## Data model work

1. Add `source_format` (`md` or `mdx`) and validated `frontmatter` JSON to
   `document`; derive both during create, save, and import.
2. Add a workspace-scoped content collection model, or an equivalently
   validated collection section in `workspace_settings`, for docs/blog type,
   path prefix, route, title, description, ordering, and feed behavior.
3. Give assets a workspace-relative logical path in addition to their immutable
   object key, with a unique constraint per workspace.
4. Keep document bodies and versions in PostgreSQL and asset bytes in R2.
5. Keep RLS on every new workspace-owned row and pass only `RequestContext` to
   content services.

## File manager and editing workflow

Create a workspace route at `/w/:workspaceSlug/files` with:

- a virtual folder tree built from document and asset paths;
- create document/folder, rename, move, duplicate, soft delete, restore, and
  empty-trash operations;
- atomic directory moves with complete conflict detection;
- Markdown editor plus rendered preview using the exact production compiler;
- explicit save first, followed later by conflict-aware autosave;
- version history, diff, preview, and restore;
- image/attachment upload to R2 and insertion of stable workspace asset URLs;
- owner/editor write controls and viewer read-only behavior.

Creating an empty folder may use a small folder record if empty folders are a
real product requirement. Otherwise folders remain derived from document and
asset path prefixes.

## Delivery phases

### Phase 1 — Compatibility harness (complete)

1. Record every document's path, source hash, frontmatter, parser result, and
   current Docusaurus route.
2. Add a corpus test that runs the runtime compiler across all 153 documents.
3. Add visual fixtures for representative docs, blogs, math, code, tables,
   citations, Lean proofs, interactive diagrams, and relative assets.
4. Classify all 57 current failures before changing content or parser behavior.

Exit criterion: the failures are reproducible and grouped by a supported
syntax rule rather than handled as one-off file edits.

### Phase 2 — Safe rendering parity (complete for the current corpus)

1. Make parsing source-format aware and fix math/MDX tokenization.
2. Implement safe relative-link and relative-asset resolution.
3. Add headings, anchors, code blocks, admonitions, details, task lists,
   footnotes, and approved component props to the inert render tree.
4. Build docs and blog shells from shared Docusaurus theme components.
5. Preserve rejection tests for executable MDX and unsafe URLs.

Exit criterion: all 153 documents compile, representative pages match the old
Docusaurus presentation, and malicious MDX remains inert or rejected.

### Phase 3 — Workspace site configuration (complete)

1. Validate and version the workspace site-settings schema.
2. Import the current global title, navbar, collection, and homepage choices as
   the `mochi` workspace defaults.
3. Add a workspace settings editor for branding, navigation, collections, and
   rendering feature switches.
4. Add a `WorkspaceProvider` that resolves the URL slug once and supplies the
   verified site settings to navbar, document shell, and workspace pages.

Exit criterion: two tabs can display different titles, navigation, sidebars,
and content without changing a session-global active workspace or rebuilding.

### Phase 4 — File manager (complete for single-document operations)

1. Build the virtual tree and editor UI on
   `/api/workspaces/:workspaceId/documents`.
2. Add transactional bulk path operations, restore, and version restore.
3. Integrate R2 assets and document-relative image paths.
4. Add permission, conflict, loading, empty, and API-unavailable states.

Exit criterion: an editor can create, edit, move, preview, version, restore, and
delete a document entirely through the application, and a viewer cannot mutate
it.

Single-document operations and version restore are complete. Transactional
directory moves, duplicate, and a trash browser remain optional follow-ups;
they do not block the database-backed authoring/rendering cutover.

### Phase 5 — Derived features and search

1. Move feeds, graph, lint, statistics, recommendations, recent files, and
   related-document analysis directly onto document/reference repositories.
2. Replace build-time local search with a workspace-scoped database index.
3. Remove browser callers of `/api/file`, `/api/files`, and `/api/content` in
   favor of the canonical workspace document API.

Exit criterion: no business route needs a filesystem-shaped view of workspace
content.

### Phase 6 — Cutover

1. Legacy writes were frozen and the final import completed.
2. Document/reference hashes and every R2 asset were verified.
3. All editing and rendering now use PostgreSQL and R2.
4. The repository content snapshot and importer were removed; Git history is
   the rollback copy.
5. The database-backed filesystem facade remains only for older analysis
   routes and can be removed after those algorithms use document repositories
   directly.

## Acceptance criteria

- All 153 current documents render from PostgreSQL with their expected math,
  code, tables, citations, academic components, navigation, and layout.
- A new workspace can configure its site and create its first document without
  a restart or Docusaurus rebuild.
- Two browser tabs can render different workspace configuration and content at
  the same time.
- Relative links and assets never escape the current workspace.
- Forged workspace IDs and private-document probes return 404.
- Editors can manage files and versions; viewers cannot write.
- Search, feeds, graphs, and analytics read PostgreSQL, not `content/` or a
  filesystem facade.
- User-authored content cannot execute JavaScript in the authenticated origin.
- PostgreSQL and R2 are the only live content sources after cutover.
