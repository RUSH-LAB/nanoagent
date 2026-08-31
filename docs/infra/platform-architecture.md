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
| Identity control plane | Better Auth | Users, sessions, workspaces, members, invitations |
| Transactional data | PostgreSQL | Authoritative workspace and product records |
| Binary data | S3/R2-compatible storage | Uploaded asset bytes |
| Side-effect delivery | PostgreSQL deletion outbox | Retriable object deletion after SQL commits |
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
  -> repository

Workspace deletion
  -> SQL transaction queues object keys and deletes relational rows
  -> background drain removes object bytes
  -> successful removals clear outbox rows
```

Better Auth owns workspace/member/invitation lifecycle. Mochi hooks add product
state such as settings, the initial channel, channel membership, and audit
records. There is deliberately no second organization writer.

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
