# Platform architecture

Mochi follows the useful part of large systems such as Facebook: each layer
has one clear responsibility, state has an authoritative owner, and derived
systems can be rebuilt. It does not copy infrastructure that only becomes
valuable at much larger scale.

## Current architecture

| Layer | Mochi component | Responsibility |
|---|---|---|
| Client | React + Docusaurus | Application shell, navigation, document rendering |
| API | Node.js HTTP server | Authentication gate, request context, domain orchestration |
| Agent runtime | Private NanoAgent service | Model access, bounded agent loop, tool policy, usage and cost |
| Identity control plane | Better Auth | Users, sessions, workspaces, members, email invitations (GitHub-account invitations are Mochi's own) |
| Transactional data | PostgreSQL | Authoritative workspace and product records |
| Binary data | PostgreSQL `object_blob` rows | Uploaded asset bytes and integrity metadata |
| Side-effect delivery | PostgreSQL outbox | Retriable non-database side effects |
| Derived views | Search, graph, feeds, statistics | Rebuilt from authoritative workspace records |

PostgreSQL is the single source of truth. A workspace id is resolved from the
authenticated URL, converted into a `RequestContext`, and installed as
transaction-local database settings. Row-level security then provides a second
tenant boundary underneath application authorization.

```text
Browser
  -> Better Auth session
  -> Node request gate
  -> verified RequestContext(user, workspace, membership, role)
     -> PostgreSQL transaction + RLS
     -> NanoAgent over a private authenticated connection

Workspace deletion
  -> one SQL transaction deletes the workspace
  -> foreign-key cascades delete metadata and object bytes together
```

Better Auth owns workspace/member/invitation lifecycle. Mochi hooks add product
state such as settings, the initial channel, channel membership, and audit
records. There is deliberately no second organization writer.

## Repository and ownership boundaries

The boundary is based on who may change a value and when it takes effect:

| Location | Owner | Changes require deployment | May contain workspace data |
|---|---|---:|---:|
| `src/` | Platform | Yes | No |
| `plugins/` | Platform/plugin authors | Yes | No |
| `infra/` | Deployment operators | Yes | No |
| `scripts/` | Developers/operators | Yes | No live data |
| `tests/` | Developers | Yes | Fixtures only |
| `docs/` | Developers/operators | Yes | Examples only |
| PostgreSQL | Workspace owners and application services | No | Yes |

`src/` contains the shared application shell, authentication, authorization,
domain services, safe renderer, pages, and theme adaptations used by every
workspace. `docusaurus.config.js` and `package.json` are also platform files:
there is one of each per deployment, never one per workspace. The Docusaurus
configuration may define the theme, universal routes, installed plugin code,
and neutral pre-workspace branding. It must not define a workspace's title,
navigation, collections, homepage, authors, or content paths.

The neutral shell identity is deployment configuration read by
`src/platform.js` (`PLATFORM_NAME` and `PLATFORM_TAGLINE`). It is used before a
workspace resolves and in account-level messages; it is never a fallback for
workspace authorization or organization-owned navigation.

`plugins/` contains trusted capabilities installed by the platform. A manifest's
code, dependency options, safe-component schema, capability grants, and process
allowlist are deployment configuration. A workspace may only enable or disable
an installed plugin and store data through its scoped APIs; it cannot supply a
package, module path, command, or JavaScript option.

Workspace-owned presentation is validated data in `workspace_settings`:
branding, homepage, navigation, docs/blog collection definitions, and feature
switches. A workspace keeps no author records: a blog post names its authors by
GitHub username, and the byline is each account's GitHub name, avatar and bio,
copied at every sign-in. Documents and references are PostgreSQL rows. Asset metadata
and bytes are both PostgreSQL data: metadata lives in `asset`, and the payload
and integrity fields live in `object_blob`. No runtime asset depends on a
machine-local directory or a second storage service. Every cache key, job,
plugin record, and object key uses the immutable workspace id.

`infra/` remains separate from `src/`. It describes how the application is
provisioned, while `src/` is what the provisioned application executes.
`scripts/` are explicit development, migration, verification, and maintenance
entry points—not a second runtime. `tests/` prove these boundaries and may use
synthetic workspace fixtures, but production code never reads test fixtures.

NanoAgent is the deliberate exception to the single-process preference below.
Its Python model runtime has an independent dependency and scaling boundary;
Mochi remains the only public service and NanoAgent holds no application data.

## What we are not adding yet

Facebook needs specialized graph stores, distributed caches, RPC frameworks,
stream processing, and many independently deployed services because its data
and organization demand them. Mochi currently gains more from keeping these
boundaries inside one deployable application:

- No GraphQL/Relay layer while REST resources and cache invalidation remain
  straightforward.
- No TAO-like graph service; links and relationships remain PostgreSQL rows or
  derived views.
- No Redis dependency until measured read load or cross-process coordination
  requires it.
- No Kafka/event bus; transactional outbox tables cover durable external side
  effects without dual-write failure.
- No microservice split while one process preserves simpler transactions,
  deployment, authorization, and debugging.

## Scale-up sequence

Add infrastructure only in response to measured pressure:

1. Add PostgreSQL indexes, query budgets, pooling, replicas, and partitioning.
2. Move expensive derived work into durable jobs while retaining PostgreSQL as
   the authoritative source.
3. Add Redis for measured hot reads or distributed coordination, with cache
   entries treated as disposable.
4. Add a search engine or graph projection when PostgreSQL query plans no
   longer satisfy product latency targets.
5. Split a service only when it needs an independent scaling, reliability, or
   ownership boundary.

This preserves the architectural lesson behind Facebook's stack—specialize at
clear boundaries—without paying its operational cost before Mochi needs it.
