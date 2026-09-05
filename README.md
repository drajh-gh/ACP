# Agentic Control Plane

ACP is an always-on control plane for durable, policy-governed Codex work. The
repository is being implemented from [specification version 1.0.0](SPECIFICATION.md).
M0 and M1 are complete. M2 is in progress; the current candidate is not yet a
deployed autonomous service.

## Current slice

- npm workspaces with TypeScript source
- stable, typed domain identifiers
- orthogonal mission, candidate, deployment, acceptance, tracker, effect, and
  business-completion state
- completion-contract evaluation that cannot imply sibling lifecycle state
- runtime-validated intake, claim, approval, workflow, capability, readiness,
  and reconciliation contracts
- deterministic effect-transition, approval-drift, cursor, and kill-switch
  guards
- reversible PostgreSQL migrations, an up/down-checksum-aware runner, and stores for
  transactional mission/event writes, effects, leases, workflow projections,
  durable subscriptions, and reconciliation
- immutable policy/adapter registries, scalar-or-structured exact pre-effect
  observations, evidence-complete receipt-only verification, exact-scope
  single-use kill-switch authorization, and context-bound transition provenance
- a DBOS 4.27.6 worker shell with stable workflows, capped queues, checkpointed
  persistence, atomic durable submission, deduplicated starts, and approval
  wakeups that revalidate persisted authorization, plus identity-checked,
  terminal-winner-preserving idempotent cancellation reconciliation,
  old-version in-flight
  control, ordinary-error and recovery-exhaustion projection, and bounded
  periodic reconciliation of terminal DBOS failures and durable cancellation
  intents
- a deterministic effect-adapter boundary that records lost responses as
  unknown outcomes, prevents blind retries, reconciles by idempotency key, and
  independently verifies recovered target state
- an opt-in live DBOS recovery proof that force-kills one worker and completes
  the same checkpointed workflow on a replacement without repeating steps
- strict runtime compatibility contracts and fail-closed admission of new work
  against pinned API, worker, schema, and workflow versions
- strict, digest-bound context packets and structured worker results, with a
  manager that starts fresh Codex SDK threads behind read-only or verified Git
  worktree profiles and records terminal failures only after worker settlement
- database-enforced, expiring capability grants; live host registration and
  heartbeats; per-resource-class capacity admission; and immutable worker-run
  and process-journal schema
- immutable node-context revisions and identity-only, transactionally assembled
  context packets, with current-reference checks, exact retry/deadline admission,
  and cancellation fencing
- versioned lifecycle snapshots with exact observation/candidate identities,
  tracker source versions, explicit known/unknown deployment artifacts, and
  append-only source records protected through producer rollback
- host/session-specific DBOS worker queues with atomic capacity reservations,
  fresh-packet dispatch, non-reusable daemon sessions, independent heartbeats,
  cancellation-intent admission fences, and replay without duplicate execution
- Windows process-tree ownership with suspended startup, journal-before-release,
  native deadline enforcement independent of pipe I/O, and confirmed tree cleanup
  before result projection
- bounded Windows crash recovery with machine/boot/session-scoped inspection,
  exact per-process claims, fresh runtime provenance, and projection repair after
  owner retirement or an explicit single-run handoff; ambiguous or unjournaled
  launches remain pending, and handoff fences late owner writes
- an opt-in persistent native creation/resume seal for the next launch-intent
  recovery slice; database intent/revocation wiring is still unfinished
- an authenticated, Origin-checked, trusted-proxy-aware, version-negotiated,
  size-bounded Streamable HTTP MCP control surface for
  idempotent mission creation, exact mission status, and bounded active-mission
  listing
- a validated repository-local Codex counterpart plugin package whose
  marketplace entry, deployment URL, and bearer-token environment reference are
  deliberately left for deployment/installation
- strict TypeScript 7 checks, local tests, and dependency-free secret scanning
- architecture decision records for the fixed M0 technology choices

## Local checks

Node.js 24 or newer is required. Dependencies are exact-version locked; install
them without package lifecycle scripts.

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run check:secrets
npm run check
pwsh -NoProfile -File scripts/check-postgres.ps1
pwsh -NoProfile -File scripts/check-postgres.ps1 -LifecycleOnly
npm run test:dbos-recovery
npm run test:worker-supervision
pwsh -NoProfile -File scripts/check-worker-supervision.ps1 -Suite launch-fence
```

The PostgreSQL invariant fixture is at
`packages/storage/test/integration/postgres-invariants.sql`. It is designed for
a disposable database after applying `0001_control_plane.sql`, the populated
upgrade seed at `packages/storage/test/integration/postgres-0001-upgrade-seed.sql`,
`0002_durable_runtime.sql`, `0003_worker_runtime.sql`, and
`0004_counterpart_interface.sql`. Run
`packages/storage/test/integration/postgres-authority-lock-negative.sql` after
`0002` and before the invariant fixture to prove unfenced authority mutations
are denied. `scripts/check-postgres.ps1` runs that full cycle plus a two-session
probe proving that a transaction begun before a concurrent pause waits on the
authority fence and observes the pause after it commits. Reverse migrations run
in the opposite order and cover all ten migrations. After the legacy invariant
fixture, migration `0005_authoritative_context.sql` is applied as a populated
upgrade and the real PostgreSQL suite in
`packages/storage/test/integration/context-store.ts` exercises authoritative
assembly, revision races, stale-reference/tampering denial, and cancellation
fencing through the TypeScript stores. Migration `0006_host_dispatch.sql` then
adds durable dispatch, `0007_supervised_workers.sql` adds exact owned-process
admission, and `0008_worker_recovery.sql` adds OS scope and recovery authority
guards. `0009_lifecycle_context.sql` upgrades the packet producer to 1.1.0 and
protects lifecycle observations from mutation and future-dated insertion. Its
down migration restores the 1.0.0 producer while retaining those audit guards.
`packages/storage/test/integration/lifecycle-context.ts` tests preflight failure,
old-run recovery, exact-version admission, rollback replay, and re-upgrade.
`0010_worker_handoff.sql` adds one-way, exact-assignment recovery handoff without
retiring the host. The PostgreSQL handoff suite checks late-write races, lost
acknowledgements, manager-to-recovery integration, and unchanged healthy work.
Downgrade refuses unresolved handoffs and retains their immutable event receipts.
`packages/storage/test/integration/host-dispatch.ts`
uses real PostgreSQL and DBOS queues with synthetic, credential-free transports
to test reservation races, atomic enqueue rollback, session fencing, dependency
drift, cancellation, terminal replay, process-admission races, and native
synthetic transport/journal integration, killed-owner recovery, mixed bindings,
database-session loss, and recovery-authority races. See [worker integration](apps/worker/README.md)
for the Windows embedding contract and remaining recovery boundary. `npm run
test:dbos-recovery` uses the supported host Node
runtime and a digest-pinned, resource-limited PostgreSQL container on a random
loopback port to prove live DBOS process replacement and exactly-once replay of
completed steps. `npm run test:worker-supervision` proves the native Windows
boundary with credential-free subprocesses. These integration scripts have overall deadlines and remove
only resources created by their own run.
The `-LifecycleOnly` variant skips the host/DBOS/native suite for a narrower
lifecycle and synthetic handoff migration check. The full gate remains sequential, with a 90-second
overall limit and a 45-second limit for the host suite.

No commit, push, deployment, or external integration is performed by these
commands.
