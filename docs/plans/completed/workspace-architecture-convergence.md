# Completed: workspace architecture convergence

Status: completed on 2026-08-31. This is an implementation record, not an
active plan. Remaining deployment work is tracked in
[`../on-hold/production-readiness.md`](../on-hold/production-readiness.md).

## Acceptance evidence

Last verified on 2026-08-31:

- `npm test`: 2601 passed, 0 failed.
- `npm run test:integration:all`: 135 passed, 0 failed, 1 intentionally
  skipped external-network check.
- `npm run build:auth`: production Docusaurus shell built successfully.
- API shutdown: SIGINT closes the listener and exits cleanly, so container
  replacement does not remain stuck on application timers or open handles.
- The real Neon/PostgreSQL acceptance command was completed from the developer
  machine. It must be repeated on an isolated development or staging branch
  before each schema release.
- The SQLite-to-PostgreSQL rehearsal on the Neon `development` branch matched
  all 19 migrated datasets by row count and canonical SHA-256 hash. The
  filesystem comparison also matched all 153 Markdown documents and all 740
  bibliography records, with zero conflicts.

These results prove the repository implementation and local runtime path. They
do not by themselves constitute a production cutover.

## Agreed database environments

The delivery topology is intentionally asymmetric:

- Normal local development uses SQLite; fast PostgreSQL policy coverage uses
  PGlite. Neither requires a locally installed PostgreSQL server.
- PostgreSQL integration work uses an isolated Neon development branch with a
  direct schema-owner URL and a separate pooled `mochi_runtime` URL.
- GitHub Actions runs the same real-database acceptance command against the
  official PostgreSQL 17 image.
- Production receives a separate database and credentials. The Neon dev branch
  and the production database must never be the same target.

The developer-only URLs live in the git-ignored `.env.postgres.local` file.
The supported commands are:

```bash
npm run db:postgres:migrate
npm run test:postgres
npm run start:postgres:api
```

`test:postgres` is destructive only to its namespaced, self-cleaning fixtures,
but it must still never be pointed at production.

## Target request boundary

Every workspace request follows this path:

```text
authenticated user
  -> workspace slug/id from the URL
  -> membership lookup and authorization
  -> RequestContext
  -> domain service
  -> Postgres and object storage
```

Browser routes use readable workspace slugs:

```text
/w/:workspaceSlug/documents/...
/w/:workspaceSlug/settings
/w/:workspaceSlug/people
```

Workspace APIs use immutable workspace IDs:

```text
/api/workspaces/:workspaceId/documents/...
/api/workspaces/:workspaceId/settings
/api/workspaces/:workspaceId/members/...
```

`activeOrganizationId` or a future last-used workspace preference may choose a
default redirect. It must never authorize a request or scope business data.

## Invariants

1. Every business row belongs to a user, a workspace, or their intersection.
2. Every workspace API carries the workspace ID explicitly.
3. The server derives the user from the session and revalidates membership.
4. A missing workspace, resource in another workspace, and non-member access
   have the same externally visible 404 response.
5. Cache keys, search indexes, jobs, audit events, and object keys use immutable
   workspace IDs. Slugs are presentation and routing identifiers only.
6. A signed-in user with no workspace receives an explicit onboarding state;
   business services never fall back to a primary workspace.
7. Domain services accept a RequestContext, not caller-selected user or
   workspace IDs.
8. Platform administration is separate from workspace authorization.
9. Better Auth exclusively owns users, sessions, organizations, memberships,
   invitations, and generic role-transition rules. Mochi owns product data and
   its workspace-scoped authorization.

The application RequestContext is:

```js
{
  userId,
  workspaceId,
  membershipId,
  role, // owner | editor | viewer
}
```

Background work uses a separately named system context and must still name one
workspace. It must not impersonate a user or use an unscoped repository.

## Role model

| Role | Workspace | Members | Content | Comments |
|---|---|---|---|---|
| owner | manage/archive | manage | create/edit/publish/delete | read/write |
| editor | read | read | create/edit/publish | read/write |
| viewer | read | read | read | read/write |

Migration from Better Auth's default organization roles is deterministic:

```text
owner  -> owner
admin  -> editor
member -> viewer
```

The global `user_role` table is removed from ordinary product authorization.
If platform operators are required, they receive a separate internal role that
does not grant implicit access to workspace data.

## Delivery sequence

### 1. Request boundary and routes

- Add a single RequestContext resolver.
- Introduce `/w/:workspaceSlug/...` browser routes.
- Introduce `/api/workspaces/:workspaceId/...` APIs.
- Make the workspace switcher navigate instead of mutating session authority.
- Remove the primary-workspace fallback from authenticated business routes.
- Add structural tests that forbid direct `req.auth.orgId` scoping in routes.

### 2. Authentication and roles

- Configure Better Auth for owner/editor/viewer workspace roles.
- Remove username registration and sign-in.
- Use same-origin HttpOnly, Secure cookies and CSRF-safe requests.
- Configure verification, reset, and invitation delivery in production.
- Keep last-used workspace only as a user preference for redirects.

### 3. Postgres

- Move persistence behind asynchronous repositories.
- Use a production migration tool and transactional migrations.
- Add foreign keys, uniqueness, lifecycle states, and deletion rules.
- Set request-local user/workspace values on the checked-out connection.
- Keep Better Auth's identity/organization control-plane tables outside RLS;
  enforce their mutations through Better Auth's organization plugin.
- Enable and force RLS on every product workspace-owned table as a second
  isolation layer.
- Provision workspace settings and the default channel through idempotent
  Better Auth lifecycle hooks.

Core application data converges on user, workspace, workspace_member,
workspace_invitation, workspace_settings, user_preferences,
workspace_member_preferences, document, document_version, asset, and reference.
Better Auth-owned physical names may differ, but application repositories expose
only the workspace vocabulary and invariants above.

### 4. Content and assets

- Treat the database as the only content source.
- Render constrained Markdown and math with an explicit component allowlist.
- Reject imports, exports, JavaScript expressions, event attributes, and unsafe
  URL protocols. User content must never be passed to eval/Function.
- Store binaries in S3/R2-compatible object storage under immutable workspace
  and asset IDs.
- Key search, caches, and derived jobs by workspace ID.

### 5. Migration and retirement

There is no long-lived dual-write period:

1. Deploy the new schema and read path behind an operational switch.
2. Put legacy content and stores into read-only mode.
3. Run an import dry run and report counts, hashes, owners, and orphan rows.
4. Import and verify the same report against the destination.
5. Switch reads and writes once.
6. Retain backups and a documented rollback window.
7. Delete legacy `/api/file` write operations, filesystem content discovery,
   SQLite production storage, JSON business stores, and per-workspace
   Docusaurus compilation. Scoped database-backed `/api/file` read aliases may
   remain temporarily for client compatibility.

The one-way content importer was removed after document, reference, and asset
parity was verified against PostgreSQL and R2. The original source snapshot
remains recoverable from Git history; it is no longer a live repository tree.

The database cutover itself is also dry-run by default and verifies canonical
row hashes after importing the complete SQLite product schema:

```bash
npm run db:migrate:legacy
npm run db:migrate:legacy -- --apply
```

It intentionally does not copy sessions or verification tokens, so all users
must sign in again after the cutover.

Before switching traffic, run `npm run db:postgres:verify` with the runtime and
migration URLs. It performs the live cross-workspace RLS and cascade checks with
self-cleaning fixtures.

## Completion gates

- One email account can belong to multiple workspaces.
- Two tabs can use different workspace URLs without affecting one another.
- A forged workspace ID cannot read, infer, or mutate another workspace.
- A new workspace is immediately usable without restart or rebuild.
- Content, settings, search, caches, jobs, references, and assets are isolated.
- Removing a member preserves workspace-owned content.
- Archiving or deleting a workspace deterministically handles all owned data.
- The filesystem and database are not competing content sources.
- Production sessions are not readable by browser JavaScript.
- Both application checks and Postgres RLS independently reject cross-workspace
  access.
