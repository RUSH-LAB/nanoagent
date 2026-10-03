# Documentation

The documentation is organized by purpose:

- [`product/`](product/) describes the product direction and decision criteria.
- [`infra/`](infra/) documents the current system architecture and operational setup.
- [`plans/`](plans/) contains active future work.

Start with the [product north star](product/north-star.md), then read the
[platform architecture](infra/platform-architecture.md). For database setup on
a new machine, follow the [Neon Postgres guide](infra/neon-postgres-setup.md).
For releases, use the [production deployment runbook](infra/production-deployment.md).
The [production status](infra/production-status.md) summarizes the services
already prepared and the work remaining before a public launch.
The [release policy](infra/release-policy.md) defines the shared branch,
compatibility, deployment-order, verification, and rollback rules.
The NanoAgent integration and the production path for hosted LLM agents
are tracked in the [LLM agent platform plan](plans/llm-agent-platform.md).
The shared web/desktop boundary and staged packaging work are described in
[desktop readiness](desktop-readiness.md).
