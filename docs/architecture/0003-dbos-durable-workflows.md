# ADR 0003: Use DBOS TypeScript for durable workflows

- Status: Accepted
- Date: 2026-09-04
- Specification: 1.0.0, sections 1, 7, 10, and 17

## Context

ACP missions must survive process and host restarts, wait on external events
without consuming model turns, and retain bounded retry and recovery behavior.
Building a bespoke durable workflow runtime would duplicate the hardest part of
the system before the product workflow is proven.

## Decision

Use DBOS TypeScript for workflow execution, queues, durable timers, and recovery.
Workflow definitions are versioned ACP artifacts. In-flight missions remain
pinned to their workflow version. Workflow code remains deterministic; database,
network, clock, randomness, and model calls run through named durable steps.

ACP lifecycle and effect records remain explicit application-domain data. They
must not be inferred from DBOS's internal execution status.

## Consequences

- Workflow IDs and ACP mission IDs need an explicit, idempotent mapping.
- Each step requires a timeout and failure disposition.
- Crash testing must prove resumption at worker and effect boundaries.
- The DBOS package version and database schema become runtime provenance.

## References

- [DBOS workflow guarantees](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial)
- [DBOS workflows and steps](https://docs.dbos.dev/typescript/reference/workflows-steps)
