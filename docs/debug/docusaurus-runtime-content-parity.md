# Docusaurus runtime content parity

## Problem

After workspace content moved from files into PostgreSQL, blog and docs pages
still rendered, but they no longer looked or behaved like the original
Docusaurus site. Examples included:

- blog navigation appearing in the wrong order;
- an author key such as `zeyu` appearing instead of the configured profile;
- migrated posts showing the migration date;
- test-generated posts appearing in the real blog;
- docs sidebars and blog excerpts behaving differently from the build-time
  versions.

The first assumption was that the theme or CSS had changed. That was not the
root cause. A comparison with the last build-time Docusaurus version showed
that the layout CSS was substantially the same.

## Root cause

Docusaurus has two separate layers:

1. `plugin-content-docs` and `plugin-content-blog` read files and generate
   routes and metadata at build time.
2. The Docusaurus theme renders that generated data through components such as
   `BlogListPage`, `BlogPostPage`, and `DocItem`.

Database-backed workspace content is only known after the request has been
authenticated. Therefore the build-time content plugins cannot load it safely:
they do not know the current user or workspace, and bundling every workspace at
build time would expose private content and require rebuilding after changes.

The runtime implementation correctly needed to replace layer 1, but its data
adapter initially supplied only document titles and bodies. The original
plugins had also generated:

- navigation and collection definitions;
- author profiles, images, and social links;
- excerpts and truncate-marker state;
- descriptions, dates, reading time, tags, TOC entries, and pagination;
- docs sidebar hierarchy and ordering.

At the same time, the PostgreSQL migration copied the existing
`workspace_settings` row, which did not contain the old Docusaurus site
configuration. The content migration had only been run in dry-run mode, and
the original repair logic did not reliably fill partially initialized
settings. The server silently inferred a fallback configuration, hiding the
data problem instead of failing. The visible evidence was the inferred
alphabetical navigation order and the raw `zeyu` author key.

A separate issue polluted PostgreSQL with integration-test documents. The
canonical Mochi tree contained 153 documents, while the migrated database had
270 rows, including 79 active resilience and rate-limit test posts.

## Correct architecture

```text
workspace URL
  -> authenticate the user
  -> verify workspace membership and role
  -> read Markdown from PostgreSQL
  -> parse it into a safe, inert content tree
  -> adapt metadata to Docusaurus's component contract
  -> render with native BlogListPage / BlogPostPage / DocItem
```

This preserves native Docusaurus layout and interaction without copying the
content plugins. The adapter should contain data conversion only; it should not
reimplement the theme markup or CSS.

Arbitrary MDX JavaScript remains intentionally unsupported. Workspace content
may use Markdown, math, and allowlisted components, but not `import`, `export`,
or executable expressions.

## Fix

- Render blog lists, blog posts, and docs with the native theme components.
- Supply the native metadata contract, including excerpts, truncate markers,
  descriptions, authors, tags, reading time, TOC, and pagination.
- Preserve the original site CSS and custom `BlogLayout` instead of replacing
  them with runtime-specific layouts.
- Make the content migration fill missing navigation, collections, author
  profiles, sidebar titles, and rendering settings without overwriting values
  already customized by a workspace.
- Exclude known integration-test paths from legacy migration and provide a
  backup-producing cleanup command for databases already affected.

The one-time PostgreSQL content repair was completed before the legacy content
tree was retired. The importer and repair command no longer exist; runtime
content must now be edited through the workspace document API.

## Verification checklist

- Navbar order matches the original configuration: Research, Blog, Survey,
  Programming, Math.
- `books/builder` is not exposed as a product section.
- Blog index pages stop at the truncate marker and display **Read more**.
- Blog post pages display the configured author name, avatar, title, and links.
- Research posts show reading time; ordinary blog posts do not.
- Blog and docs use their native, distinct Docusaurus layouts.
- Docs sidebars preserve hierarchy, title-based labels, ordering, active state,
  and collapsed inactive categories.
- Two browser tabs can remain in different workspaces.
- A forged workspace ID returns 404 and cannot reveal content.

## Debugging lessons

1. Inspect the rendered page before changing CSS.
2. Compare against a known-good commit and inspect Docusaurus's generated JSON
   under `.docusaurus/`; that JSON is the actual theme input contract.
3. Distinguish a code deployment from a data migration. New rendering code
   cannot display configuration that was never written to PostgreSQL.
4. Treat a successful fallback as suspicious during migrations. Inferred
   defaults can conceal incomplete persisted data.
5. Run destructive integration tests against a disposable database branch,
   never the shared development database.
6. Do not copy Docusaurus's content plugins. Keep a small compatibility layer
   and continue consuming the native theme components.
