# ADR 0002: Use PostgreSQL for operational state

- Status: Accepted
- Date: 2026-09-04
- Specification: 1.0.0, sections 1, 7, 9, 15, and 27

## Context

Mission recovery, lifecycle facts, approvals, evidence indexes, leases,
receipts, cursors, and runtime provenance require transactional durability and
queryable constraints. The same data must support reconstruction and operational
projections without making a worker conversation authoritative.

## Decision

PostgreSQL is ACP's operational system of record. Application migrations own
ACP tables; DBOS owns its runtime tables. State transitions and their audit
events are committed together. Database constraints enforce invariants that
must survive concurrent processes, including unique active writer leases and
scoped idempotency keys.

Select and pin a supported PostgreSQL major when infrastructure is introduced;
do not couple domain contracts to one client library or provider-specific type.

## Consequences

- Recovery and audit queries share one transactional substrate.
- Schema migrations, backup verification, and restore drills are launch gates.
- Large evidence objects remain outside ordinary rows; PostgreSQL stores their
  metadata, hashes, access state, and immutable references.

## References

- [PostgreSQL transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html)
- [PostgreSQL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)
