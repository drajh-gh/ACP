# ACP storage

This package owns application-managed PostgreSQL migrations and durable ACP
stores. DBOS system tables remain owned by DBOS.

## Migration rules

- Migrations are ordered, immutable SQL files. The migration runner owns the
  transaction and records the SHA-256 of both each up and down file.
- Application state and the audit event that records its transition are written
  in one transaction by the store layer.
- Published workflow definitions, mission events, and runtime provenance are
  append-only.
- Provider payloads stay behind adapter or evidence boundaries; core tables use
  ACP identifiers and contracts.
- Effect idempotency is scoped by `adapter_id` and `adapter_account_id`, and a
  canonical proposal digest rejects materially different collisions.
- Effect execution requires a current covered approval, unpaused global/project
  controls, a database-timed writer lease with a matching fencing token, and an
  exact unexpired execution-precondition evaluation.
- Effect verification is receipt-only; the projection references the exact
  receipt, which must cover every verification-plan step with matched observed
  state, a digest, observation time, and current, available project-scoped
  evidence matching that exact digest and time.
- Unknown-outcome reconciliation requires outcome-specific observed state,
  bounded chronology, and available evidence from the effect's project that
  exactly matches the observation source, digest, and timestamp.
- Policy, adapter, workflow, profile, and completion-contract versions are
  pinned through immutable registries; runtime provenance is context-bound to
  the exact mission binding and effect adapter.
- Runtime controls require a fresh monotonic append-only event for each
  mutation, a time-bounded exact-scope single-use authorization to unpause, and
  same-project provenance for project controls, and fail closed if the global
  row is absent.
- Mission identity and requested scope are immutable; every mission state
  transition carries context-matching provenance and produces an append-only
  transition audit row.
- Completion evaluations use the mission's pinned contract, context-matching
  immutable provenance, and a timestamp within the mission lifecycle; the
  evaluation pointer is attached exactly once when scoped completion occurs.
- Effect execution admission and every runtime-control, approval, evaluation,
  or lease mutation share one transaction-level PostgreSQL advisory fence.
  Execution reads authority only after acquiring that fence, so a concurrent
  pause, revocation, or lease release cannot commit behind stale admission.
- The initial global control leaves external effects paused until an authorized
  runtime action enables them.

`0001_control_plane.sql` establishes the core control-plane schema. The
reversible `0002_durable_runtime.sql` hardens cross-project and completion
invariants and adds DBOS recovery projections. `0003_worker_runtime.sql` adds
capability evaluations and grants, digest-bound packets/results, live
host-capacity admission, worker runs, and the immutable process journal.
`0004_counterpart_interface.sql` adds idempotent counterpart mission requests
bound to an exact active project workflow and runtime provenance.
`0005_authoritative_context.sql` adds immutable node-context revisions and
database-checked packet assembly/admission. `0006_host_dispatch.sql` adds
host-session issuance/fencing, runtime bindings, durable dispatch reservations,
exact-assignment run admission, and cancellation-intent fences.
`0007_supervised_workers.sql` requires exact Windows job/start-token identity
for new process journals and permanently fences one supervised root per run. The
`0008_worker_recovery.sql` migration requires exact OS scope for new Windows
journals and defines retired-owner/current-recovery-runtime eligibility.
`0009_lifecycle_context.sql` adds packet schema 1.1.0 and lifecycle observation
immutability. It locks the five observation tables during a populated-data
preflight and fails if future-dated observations require reconciliation. New
inserts cannot be future-dated; UPDATE, DELETE, and TRUNCATE are denied.
Its down migration restores the prior packet producer without rewriting
history or removing those audit guards. Re-upgrade replaces the retained
guards safely. This is a producer rollback, not an exact removal of all safety
constraints; older code must still append observations rather than mutate them.
`0010_worker_handoff.sql` adds immutable per-run handoffs and independent mission
event receipts, with database fences against late owner process/result writes.
Its down migration refuses any handed-off run still in `started`, removes the
operational handoff table only after reconciliation, and retains audit receipts.
The integration fixtures include an explicit denial of authority mutation without
the shared transaction lock.
`../../scripts/check-postgres.ps1` also proves with two database sessions that a
pre-existing transaction waits for a concurrent pause and then observes it.

`PostgresWorkerRuntimeStore` exposes database-clock host admission and process
journal operations consumed by the Windows supervisor: derive and register a process from
its active run while preserving OS start and database observation time,
heartbeat it using PID plus process-start identity, finish it idempotently,
atomically claim stale/deadline-expired processes with a host-bound expiring
claim, find started runs that never acquired a process journal entry, and find
terminal processes whose corresponding run projection is still live. A
process-keyed PostgreSQL session advisory lock remains held across the caller's
bounded OS inspection/termination callback while that session is alive. On
connection loss, inspection is aborted and no terminal write is accepted;
shutdown waits for bounded observer cleanup. The native inspector uses exact
held job/process identities even when a connection loss releases the lock.

On schema 0007, process insertion locks mission, node, and run in that order,
then rechecks uncancelled execution, actual current time, and active host/session
authority. A draining host may finish previously admitted work. The journal
stores `supervision_kind = windows_job` and exact `Local\ACP.Worker.<wpr_id>`
ownership beside the native PID/start token. Historical legacy journals remain
readable, but new unsupervised inserts fail closed. `loadWorkerProcess` permits
exact-record lookup after an uncertain registration acknowledgement. Existing
immutable-identity, claimed-reconciliation, and process-stop-before-projection
guards still apply. Schema 0008 adds immutable installation/boot/session scope;
old rows are not assigned invented OS identity.

`PostgresWorkerRecoveryStore` requires schema 0010 and selects retired-owner or
explicitly handed-off candidates on one host,
advances a bounded keyset cursor through the worker consumer, and creates fresh
same-binding recovery provenance from the current session's advertised runtime.
Claims target one exact process, not a mixed-binding batch. The worker consumer
supplies current runtime authority to reconciliation, which checks claim
microseconds exactly, bounds inspection by the database lease, and locks the
session, host, and process before the final clock/authority check.
`recoverStoppedRun` rechecks owner retirement or handoff and durable tree-stop evidence
under mission→node→run→session→host locks. Existing terminal results win; other
recoverable gaps become cancelled or failed without inferred success. Healthy
owner gaps, unjournaled runs, and ambiguous native observations remain pending.

`handoff(message)` binds the exact original run/generation/host/session/application
assignment to an existing supervised process journal. It returns `handed_off`,
`pending` (no journal), `terminal` (a result already won), or `obsolete` (not the
current owner). Exact acknowledgement replay is idempotent. A handoff is one-way:
it does not release capacity, stop a process, retire the daemon, or allow another
launch. Running handoffs are immediately claimable without waiting for heartbeat
staleness. Their terminal process writes require fresh current recovery provenance,
an unexpired exact claim, and the inspector's held database-session advisory lock.
Ordinary owner heartbeats, process insertion/completion, and result writes are
fenced even if they began before handoff and waited on its locks. Successful
results cannot be manufactured by handoff recovery.

## Authoritative worker context

`PostgresContextStore.publishNodeContext` accepts trusted supervisor intent:
objective, non-goals, behavioral contract, acceptance criteria, conflicts,
questions, next action, limits, and selected evidence/claim/result/approval IDs.
It appends an immutable revision, requiring the expected prior revision and
the node's exact graph revision. It is not exposed as an arbitrary worker or
MCP-client write capability.

`buildAndRecordContextPacket` accepts only packet/mission/node/grant IDs and
runtime-template/output provenance IDs. It derives mission scope, pinned
versions, profile `sourceAuthorityRules`, evidence summaries/hashes, prior
results, retry count, and independent lifecycle dimensions from PostgreSQL.
The pinned profile must explicitly contain a `sourceAuthorityRules` object;
missing rules fail closed and are not filled from a newer profile version.
Missing acceptance defaults to pending, not accepted or not-required. An old
acceptance remains attached to its original candidate revision.

Schema 1.1.0 includes exact record IDs and observation timestamps on persisted
candidate, deployment, acceptance, tracker, and business-completion facts.
Candidate identity is separate from its revision SHA; tracker identity retains
adapter/external ID and the provider's exact source version. Deployments retain
their environment and observation identity, with `artifactVersion` explicitly
`known` (digest) or `unknown`. No deployment ID or missing artifact is invented.
Unobserved defaults remain identity-free. Unknown artifacts remain visible for
diagnosis but cannot satisfy a required deployed/verified completion state;
contracts may additionally require an exact deployment `artifactDigest`.

Selected evidence must be current, available, hashed, and project-bound;
restricted evidence is denied pending an explicit disclosure policy. Claims
must be active and valid at database time, approvals current and mission-bound,
and prior results terminal and mission-bound. Indirect claim/lifecycle evidence
references must also belong to the project. Packets are bounded to 256 KiB
including expanded data. The template's runtime identity is preserved while
packet schema/digest and observation time are generated atomically.

Packet IDs bind immutable build requests. Replaying a request retrieves history
even after sources change; this is not execution permission. New worker
admission reassembles and compares current content, requires the latest context
revision and next attempt, enforces the packet deadline, and locks against
concurrent mission cancellation. Live predecessor runs or processes deny
replacement admission under the same node lock. A new attempt needs a new packet/provenance
pair. Source drift between assembly and insert rolls back the whole build;
the supervisor may retry the same uncommitted request after reconciliation.

Migration 0005 preserves existing packets/runs without inventing context
revisions for them. Legacy packets are read-only history for admission purposes.
The old `recordContextPacket` API is deprecated and cannot insert new unbound
packets on this schema. The host dispatch consumer invokes the builder. After
migration 0009, new admission requires the fresh 1.1.0 snapshot, including
metadata-only observation/source-version changes. Packet schema 1.0.0 remains
readable with its original digest, and already-admitted runs can finish or
recover after upgrade. Neither history nor recovery authorizes a fresh launch.

## Durable host dispatch

`PostgresDispatchStore` requires explicitly bounded pool connection, statement,
and lock timeouts (at most 10 seconds, 10 seconds, and 5 seconds respectively).
`registerRuntime(runtime, host)` atomically registers configuration and a
non-reusable daemon session. Replacement checks the incumbent's old heartbeat
TTL before changing host configuration. Runtime bindings pin one provenance
template per workflow binding and application version.

`request` binds a future run ID to immutable mission/node/grant/attempt terms.
`assign` selects a fresh eligible host and reserves its resource-class capacity
under locks. Laptops require explicit selection. The required enqueue callback
receives the same open `pg.PoolClient` transaction; DBOS workflow creation and
the ACP reservation commit or roll back together. Each reassignment appends a
generation with new packet/provenance IDs. Queue and workflow IDs bind the host
session and generation. Unavailable requests are deferred fairly; expired grants
and cancelled missions produce explicit terminal dispatch dispositions.

New worker runs on schema 0006 require the exact assigned generation, current
host session, runtime template, capability terms, and newly assembled packet.
The consumer replays an existing terminal result, or returns
`reconciliation_required` for an admitted but unfinished run; it never starts
another transport for either. Run completion atomically projects dispatch/node
state under the mission-to-node lock order. Unstarted admission failures leave
`needs_input`, not an orphaned running node.

Accepted `mission.cancellation-requested` events are exact-workflow stop intent.
Their insertion shares the mission admission fence; assignment and run admission
reject cancelled work before terminal mission projection. This does not bypass
the journaled-process stop guard. Existing runs and packets remain readable
history across upgrade; the 0006 downgrade removes dispatch machinery without
deleting their history.
