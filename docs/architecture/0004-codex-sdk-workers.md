# ADR 0004: Run specialist workers through the Codex SDK

- Status: Accepted
- Date: 2026-09-04
- Specification: 1.0.0, sections 1, 6, 15, 16, and 29

## Context

Codex is the operator's primary interaction and engineering harness. ACP needs
server-side workers that can start and resume Codex work while treating worker
conversation history as disposable rather than durable mission state.

## Decision

Use the server-side TypeScript Codex SDK behind a worker-manager boundary.
Each run receives a persisted, bounded context packet plus an expiring capability
grant and returns a schema-validated result. The manager records the exact SDK,
runtime, model, configuration, context digest, and workspace identity.

Workers do not receive effect-executor credentials. Read-only, delivery, and
acceptance profiles are technically isolated, not merely prompted to behave.
M2 pins `@openai/codex-sdk` at `0.153.3`. The supported SDK boundary accepts an
abort signal and isolation settings, but does not expose the spawned process ID
or a process-tree handle. ACP therefore records worker-run outcomes today while
retaining process journaling and orphan-cleanup invariants for a future
supervisor integration that can provide exact OS process identity.

## Consequences

- Codex thread IDs are useful resume handles but are not mission authority.
- A killed worker must be replaceable from durable records.
- Host process ownership, timeout, termination, and orphan cleanup are explicit.
- Provider-specific SDK types remain inside the runtime package.

## Reference

- [OpenAI Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
