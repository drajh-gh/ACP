# 0016 — Recorded counterpart mission status

Status: Accepted read-only M2 interface. Schema remains at migration 0015.

## One recorded snapshot, independent lifecycle dimensions

Specification 8, 16.1 and M2 require mission status without collapsing candidate,
deployment, acceptance, tracker, effect or business-completion state into the
mission label. The dedicated `CounterpartMissionStatus` DTO and
`getMissionStatus` store method extend only the `get_mission_status` tool.
Mission creation and active-list projections retain their original contracts.

One PostgreSQL statement reads the mission, nodes, latest candidate, latest
deployment per environment, latest acceptance/tracker/business observations,
effect states, and exact applied/latest completion evaluations. A single MVCC
snapshot prevents mixing source revisions across concurrent commits. Timestamp
and record-ID ordering is deterministic; JSON timestamps preserve PostgreSQL
microseconds. Absent observations are explicit nulls, not fabricated pending or
not-required states. Unknown artifacts, unmapped tracker states, old-candidate
acceptance and expired historical waivers remain visible as recorded.

The response declares `recorded_only`, with freshness and conflicts
`not_assessed`. It invokes no context-packet assembly, evaluator, application of
completion, grant renewal or other mutation. Terminal missions, closed runtimes
and retired workflow bindings remain readable. An observation is not permission.

## Completion identity and historical compatibility

For a completed mission, the applied evaluation is the exact immutable record
named by `completed_by_evaluation_id`, with matching mission and pinned contract,
passing status, no disqualifiers and both verification flags true. A later failed
evaluation does not overwrite that historical application. The latest record
must be no earlier than the applied record and cannot contradict the same ID.

Current-format passed evaluations require both flags and no disqualifiers;
failed evaluations require a disqualifier. Migration 0002 explicitly preserved
legacy status while backfilling false flags and the exact digest
`legacy-unverified:<evaluationId>`. That exact tuple remains reportable as
history, never applicable completion authority. Malformed reserved-prefix uses
are rejected. Invalid latest records fail the whole response, not an older
favorable fallback. These are status-layer checks, not new database constraints.

## Bounded disclosure

Only selected evidence IDs, observation timestamps, recorded freshness and
accessibility are returned. Raw content, source references, evidence summaries,
credentials, worker prompts and effect payloads are excluded. Missing,
cross-project or restricted evidence and inconsistent source provenance deny
the whole snapshot. Restricted-evidence policy remains a separate future path.

Limits are 200 nodes/effects/selected evidence references/evaluation-reason
entries, 50 deployment environments and 65,536 UTF-8 payload bytes. SQL and the
strict DTO boundary reject overflow rather than silently returning partial
collections. The MCP handler revalidates the DTO and exact requested mission
before exposing structured output. Authentication and compatibility checks
precede dispatch. The control API pool is capped at four connections with
three-second connection, five-second statement and two-second lock timeouts.

These bounds do not claim keyset pagination or indexed constant-cost history
scans. Large missions may return a bounded error until a separate pagination
contract is implemented. No live freshness/conflict assessment or readiness
decision is inferred from the recorded projection.

## Verification

Local parser, store and real HTTP MCP tests exercise exact identity, malformed
data, historical compatibility, redaction boundaries, authentication and bounds.
Focused disposable-PostgreSQL `CounterpartStatus` phases cover `core`, `limits`
and `snapshot`. The snapshot race places a test-only advisory barrier in the
actual production SELECT, proves it is blocked behind a concurrent producer,
then observes the wholly old snapshot followed by the wholly new snapshot.
The production query contains no such barrier. A separate read-only-transaction
check and unchanged durable counts support the non-mutating boundary.

See M2 for exact completed checks. No live model, deployment, plugin installation,
new migration, production credential or external service is involved.
