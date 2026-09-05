# ADR 0006: Mediate external effects deterministically

- Status: Accepted
- Date: 2026-09-04
- Specification: 1.0.0, sections 5, 7, and 14

## Context

Model reasoning is useful for investigation and proposals, but it cannot safely
own unrestricted credentials or decide that an uncertain network response means
an external mutation failed. Approvals also become stale when mutable targets
drift.

## Decision

Models produce typed effect proposals. A non-model executor validates policy,
approval envelopes, exact target preconditions, idempotency, and the target's
writer lease immediately before executing one narrow adapter operation. A
separate read verifies the resulting external state and persists a receipt.

`unknown_outcome` is a first-class state. It blocks success-dependent work and
must be reconciled against the authoritative target before any retry. Approval
drift invalidates the proposal rather than silently widening authority.

## Consequences

- Every effect adapter implements propose, preview, revalidate, execute, verify,
  reconcile, and—where supported—rollback contracts.
- Credentials are scoped to the executor and never placed in model context.
- External APIs may remain at-least-once; ACP provides idempotency and explicit
  reconciliation rather than claiming universal exactly-once effects.
- Mission, candidate, deployment, acceptance, tracker, effect, and business
  completion states remain independent domain facts.
