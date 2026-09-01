# Documentation

The documentation is organized by purpose:

- [`product/`](product/) describes the product direction and decision criteria.
- [`infra/`](infra/) documents the current system architecture and operational setup.
- [`plans/`](plans/) contains the current delivery plan. Completed plans are
  retained under [`plans/completed/`](plans/completed/) as implementation
  records rather than active work.
- [`debug/`](debug/) records root causes and reusable debugging lessons from
  significant incidents.

Start with the [product north star](product/north-star.md), then read the
[platform architecture](infra/platform-architecture.md). For database setup on
a new machine, follow the [Neon Postgres guide](infra/neon-postgres-setup.md).
For releases, use the [production deployment runbook](infra/production-deployment.md).
The [production status](infra/production-status.md) summarizes the services
already prepared and the work remaining before a public launch.
The completed workspace rendering migration is recorded in the
[workspace content and Docusaurus rendering plan](plans/completed/workspace-content-and-rendering.md).
The local Claude Code prototype and the production path for hosted LLM agents
are tracked in the [LLM agent platform plan](plans/llm-agent-platform.md).
Production deployment is intentionally
[on hold](plans/on-hold/production-readiness.md).
The runtime-content migration investigation is documented in
[Docusaurus runtime content parity](debug/docusaurus-runtime-content-parity.md).
