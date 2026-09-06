# 0034 — Exact counterpart mission creation sessions

Status: Implemented private storage boundary and legacy selector repair. No
workflow execution, effect dispatch, deployment or authenticated model run.

## Repair actual SQL before crediting replay

The first real creation/replay fixture exposed two defects masked by scripted
query responses: selection referenced nonexistent `workflow.workflow_key`, and
the replay query omitted `request.request_digest`. The shared mission projection
now exposes its column list; creation explicitly adds the retained request digest
without changing read-only mission projections. An identical normalized request
returns the retained mission, while the same request ID with different terms is
rejected. Mission, initial event and request association remain one transaction.

## Legacy-named selector, no invented alias namespace

The optional `workflowKey` wire field now means an exact canonical `wfl_…`
workflow ID. The schema and domain define this ID, not a named workflow-key
registry. Preserve the field's spelling for compatibility, validate its value
with the domain stable-ID parser before database I/O, and describe the meaning
in the MCP schema. Names, case/whitespace aliases, wrong entity IDs and malformed
values do not select a workflow. No migration or guessed name mapping is added.

The ID only narrows the existing active project binding and exact configured
runtime-provenance tuple. That binding still pins the workflow version, profile,
policy and completion contract. Omitting the selector uses the same unique
authoritative binding; it does not select an arbitrary/latest workflow or bypass
the existing zero/multiple-match denial. A historical replay checks original
normalized terms, not a newly selected binding, and conveys no execution grant.

## One contained SQL-only session

Only `PostgresCounterpartMissionStore.createMission` opts into the existing
`withIsolatedTransaction` helper. The callback is SQL-only and uses the existing
transaction-scoped request advisory lock. The shared generic `withTransaction`
helper, read-only APIs, other stores and all authority predicates remain unchanged.

Observe checked-out connection errors and fence subsequent SQL, including a late
apparently successful query response. Preserve the original failure when rollback
also fails. Initiate physical discard with `release(true)` on success, historical
replay and every failed transaction; keep the error guard until that discard call.
The helper does not await the client's later `end` event, so method return alone
is not a physical-backend-absence witness. Integration probes separately await
actual end and confirm backend absence and request-lock release. Pool connection,
statement and lock bounds remain configuration requirements, not new guarantees
of this store interface.

A lost COMMIT response rejects without automatic retry or readback repair. The
transaction may already have retained all three records. An explicit caller
retry with the identical request ID and unchanged terms may retrieve that history;
it does not repeat the inserts or manufacture fresh execution authority.

## Evidence

Twenty-eight new unit checks exercise successful creation/replay disposal,
uncertain BEGIN and each write/commit boundary, rollback failure, sticky physical
errors, query fencing and exact workflow selection. The existing store and MCP
tests also exercise schema/handler rejection before persistence. Related
assertions share cases. Real PostgreSQL `CounterpartSessions core` has six cases:
creation/replay/alias denial, exact version selection and unavailable selectors,
actual successful/replay backend closure, lost BEGIN with failed rollback and a
held transaction lock, killed backend after mission INSERT, and actual COMMIT
with a deliberately lost response followed by explicit historical replay.

The `races` phase has two cases. Both requests demonstrably wait on the same
incumbent request lock; after release, identical terms yield one creation and
one replay, while divergent terms yield one creation and one rejection. Both
leave exactly one mission/event/request history. These are disposable database
checks under the existing 30-second child and 90-second outer bounds. They are
not real PostgreSQL-to-HTTP composition or production deployment evidence.
