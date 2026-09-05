# Architecture decisions

Architecture decision records (ADRs) capture choices that constrain ACP's
implementation. They are immutable once superseded: a later decision replaces
an earlier one by adding a new ADR and linking both records.

The M0 baseline is derived from [product specification 1.0.0](../../SPECIFICATION.md)
dated 2026-09-04. The specification is the product authority; these records
explain how its fixed technology choices shape the repository.

| ADR | Decision |
|---|---|
| [0001](0001-typescript-monorepo.md) | TypeScript monorepo |
| [0002](0002-postgresql-operational-state.md) | PostgreSQL operational state |
| [0003](0003-dbos-durable-workflows.md) | DBOS durable workflows |
| [0004](0004-codex-sdk-workers.md) | Codex SDK workers |
| [0005](0005-remote-mcp-plugin.md) | Authenticated remote MCP plugin |
| [0006](0006-deterministic-effect-mediation.md) | Deterministic effect mediation |
| [0007](0007-host-filesystem-bindings.md) | Immutable host filesystem bindings |
