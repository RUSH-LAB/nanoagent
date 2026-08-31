# Documentation

The documentation is organized by purpose:

- [`product/`](product/) describes the product direction and decision criteria.
- [`infra/`](infra/) documents the current system architecture and operational setup.
- [`plans/`](plans/) contains the current delivery plan. Completed plans are
  retained under [`plans/completed/`](plans/completed/) as implementation
  records rather than active work.

Start with the [product north star](product/north-star.md), then read the
[platform architecture](infra/platform-architecture.md). For database setup on
a new machine, follow the [Neon Postgres guide](infra/neon-postgres-setup.md).
For releases, use the [production deployment runbook](infra/production-deployment.md).
The [production status](infra/production-status.md) summarizes the services
already prepared and the work remaining before a public launch.
The current work queue is the
[workspace content and Docusaurus rendering plan](plans/workspace-content-and-rendering.md).
Production deployment is intentionally
[on hold](plans/on-hold/production-readiness.md).
