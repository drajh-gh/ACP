# Agentic Control Plane

ACP is an always-on control plane for durable, policy-governed Codex work. The
repository is being implemented from [specification version 1.0.0](SPECIFICATION.md).
M0 and M1 are complete. M2 and independent M3 foundations are in progress; the current candidate is not yet a
deployed autonomous service.

## Current slice

- npm workspaces with TypeScript source
- stable, typed domain identifiers
- orthogonal mission, candidate, deployment, acceptance, tracker, effect, and
  business-completion state
- completion-contract evaluation that cannot imply sibling lifecycle state
- runtime-validated intake, claim, approval, workflow, capability, readiness,
  and reconciliation contracts
- an additive recorded readiness matrix with exact profile/resource identity,
  microsecond expiry, persistent revocation semantics, immutable assessment/evidence
  pins and bounded single-snapshot reads exposed through authenticated read-only
  `get_project_readiness`; no live probes or readiness writer are exposed
- an inert 62-field whole-profile proposal contract with explicit discovery gaps,
  immutable correction/evidence history and exact current review-request digests,
  exposed by read-only `get_project_profile_proposal` and
  `get_profile_confirmation_request`; no profile publication or operator
  confirmation is inferred
- deterministic attributed-discovery assembly that merges equal observations,
  retains conflicting alternatives and fills unanswered fields without guessing;
  its private producer entrypoint reuses the immutable proposal ledger, not a
  public discovery/writer tool or automatic provider scan
- an optional private discovery writer that compares exact evidence fingerprints
  and current usability under database locks; retries retain original pins without
  renewing evidence or proving source-byte provenance
- a static digest-checked npm manifest adapter that discovers configured
  test/lint/build script names and command fingerprints without executing commands
  or claiming filesystem identity, current evidence binding, readiness or authority
- an optional private manifest coordinator that binds supplied bytes to a current
  database SHA-256 and locked evidence fingerprint before retaining a draft;
  no filesystem acquisition or durable standalone byte-proof is implied
- bounded multi-source manifest composition with one descriptor snapshot and one
  draft write, deterministic evidence merging and unresolved conflicts; empty
  contributors are not retained negative scan evidence
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
- storage-only filesystem writer leases with retained workspace, exact-case
  branch and physical Git-directory exclusion; expiry never frees a writer,
  and release requires a sealed stop plus a terminal run (not yet launcher-wired)
- storage-only pre-run target holds tied to the exact selected dispatch and
  workspace grant, sharing exclusion with admitted writers; expiry retains
  every key, and no provisioning, release or conversion is enabled
- immutable storage-only provisioner attempt plans with exact hold revision,
  base and reported parent/fence intent; expiry or drift retains history and
  no native creation, retry, cleanup or execution authority is enabled
- standalone read-only native provisioner preflight for exact parent identity,
  full commit and bounded branch/target absence; no retained reservation,
  database-plan consumer or permission to modify Git is implied
- a standalone permanent native provisioner fence with separate `wpa_` records
  and exact owned-tree seal/stop observations; no provisioner launcher, database
  stop receipt, plan consumer, release or Git mutation is enabled
- an independent append-only provisioner process/sealed-stop claim ledger with
  exact native 100ns root identity, original-owner admission, permanent stop-first
  denial and historical replay; no native consumer, GO or hold release is wired
- shared, immutable Windows root claims across worker/provisioner process and
  rooted-stop history, with numeric FILETIME alias exclusion and deterministic
  backfill; unscoped legacy history is retained without invented identity
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
  owner retirement or an explicit single-run handoff; ambiguous stop evidence
  remains pending, and handoff fences late owner writes
- opt-in persistent native creation/resume seals and atomic durable launch
  intents, revocations, claims and no-journal stop receipts, connected to the
  manager, native transport and bounded recovery sweeps
- immutable, host-scoped repository/worktree observations with exact native
  directory identities, cross-role alias fencing and append-only retirement;
  this registry grants no Git execution or writer-lease authority
- read-only Windows/Git observation for supported checkout and linked-worktree
  layouts, with pinned metadata, exact native identity checks, bounded owned
  Git children and fail-closed unsupported-layout handling
- standalone native linked-worktree identity pins that retain directory and
  structural-pointer handles while allowing ordinary Git content updates;
  not yet launcher-connected and not a restricted-access boundary
- an authenticated, Origin-checked, trusted-proxy-aware, version-negotiated,
  size-bounded Streamable HTTP MCP control surface for
  idempotent mission creation, exact mission status, and bounded active-mission
  listing
- a bounded, single-statement mission-status snapshot with independent recorded
  lifecycle dimensions, exact applied/latest evaluations and metadata-only
  evidence; no inferred freshness, completion, approval or execution authority
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
pwsh -NoProfile -File scripts/check-postgres.ps1 -HostOnly
pwsh -NoProfile -File scripts/check-postgres.ps1 -MigrationSessions
pwsh -NoProfile -File scripts/check-postgres.ps1 -CounterpartStatus core
pwsh -NoProfile -File scripts/check-postgres.ps1 -CounterpartStatus limits
pwsh -NoProfile -File scripts/check-postgres.ps1 -CounterpartStatus snapshot
pwsh -NoProfile -File scripts/check-postgres.ps1 -ProvisionerPlans core
pwsh -NoProfile -File scripts/check-postgres.ps1 -ProvisionerPlans races
pwsh -NoProfile -File scripts/check-postgres.ps1 -ProvisionerPlans expiry
pwsh -NoProfile -File scripts/check-postgres.ps1 -ProvisionerPlans upgrade
pwsh -NoProfile -File scripts/check-postgres.ps1 -ProvisionerPlans regression
pwsh -NoProfile -File scripts/check-postgres.ps1 -Readiness core
pwsh -NoProfile -File scripts/check-postgres.ps1 -Readiness races
pwsh -NoProfile -File scripts/check-postgres.ps1 -Readiness expiry
pwsh -NoProfile -File scripts/check-postgres.ps1 -Readiness limits
pwsh -NoProfile -File scripts/check-postgres.ps1 -Readiness snapshot
pwsh -NoProfile -File scripts/check-postgres.ps1 -Readiness upgrade
pwsh -NoProfile -File scripts/check-postgres.ps1 -Readiness regression
pwsh -NoProfile -File scripts/check-postgres.ps1 -Readiness http
pwsh -NoProfile -File scripts/check-postgres.ps1 -LifecycleOnly -LaunchRecovery
pwsh -NoProfile -File scripts/check-postgres.ps1 -LifecycleOnly -LaunchRecovery -LaunchNative
pwsh -NoProfile -File scripts/check-postgres.ps1 -LifecycleOnly -LaunchRecovery -FilesystemBindings
pwsh -NoProfile -File scripts/check-postgres.ps1 -RepositoryBindingOnly
pwsh -NoProfile -File scripts/check-postgres.ps1 -LifecycleOnly -LaunchRecovery -FilesystemBindings -FilesystemNative
pwsh -NoProfile -File scripts/check-postgres.ps1 -LifecycleOnly -LaunchRecovery -FilesystemBindings -FilesystemLeases -FilesystemLeaseChannelNative initial
pwsh -NoProfile -File scripts/check-postgres.ps1 -LifecycleOnly -LaunchRecovery -FilesystemBindings -FilesystemLeases -FilesystemLeaseChannelNative lost-ack
pwsh -NoProfile -File scripts/check-postgres.ps1 -LifecycleOnly -LaunchRecovery -FilesystemBindings -FilesystemLeases -FilesystemLeaseChannelNative periodic-cancel
pwsh -NoProfile -File scripts/check-postgres.ps1 -LifecycleOnly -LaunchRecovery -FilesystemBindings -FilesystemLeases -WorktreeReservations core
pwsh -NoProfile -File scripts/check-postgres.ps1 -LifecycleOnly -LaunchRecovery -FilesystemBindings -FilesystemLeases -WorktreeReservations races
pwsh -NoProfile -File scripts/check-postgres.ps1 -LifecycleOnly -LaunchRecovery -FilesystemBindings -FilesystemLeases -WorktreeReservations expiry
pwsh -NoProfile -File scripts/check-postgres.ps1 -LifecycleOnly -LaunchRecovery -FilesystemBindings -FilesystemLeases -WorktreeReservations upgrade
pwsh -NoProfile -File scripts/check-postgres.ps1 -LifecycleOnly -LaunchRecovery -FilesystemBindings -FilesystemLeases -WorktreeReservations regression
npm run test:dbos-recovery
npm run test:worker-supervision
pwsh -NoProfile -File scripts/check-worker-supervision.ps1 -Suite launch-fence -TestNamePattern '^(sealing a never|a consumed|a permanent|explicit termination|tree closure)'
pwsh -NoProfile -File scripts/check-worker-supervision.ps1 -Suite launch-fence -TestNamePattern '^(a crash|recovery cannot|sealing a running|wrong scope)'
pwsh -NoProfile -File scripts/check-worker-supervision.ps1 -Suite launch-fence -TestNamePattern '^(malformed|recreated|pure launch|held permanent)'
pwsh -NoProfile -File scripts/check-worker-supervision.ps1 -Suite filesystem
pwsh -NoProfile -File scripts/check-worker-supervision.ps1 -Suite filesystem-pins
pwsh -NoProfile -File scripts/check-worker-supervision.ps1 -Suite provisioner-observation -TestNamePattern '^preflight (core|paths|branches):'
pwsh -NoProfile -File scripts/check-worker-supervision.ps1 -Suite provisioner-observation -TestNamePattern '^preflight (metadata|limits|races|cancellation):'
pwsh -NoProfile -File scripts/check-worker-supervision.ps1 -Suite lease-channel
pwsh -NoProfile -File scripts/check-worker-supervision.ps1 -Suite lease-channel-liveness
pwsh -NoProfile -File scripts/check-native-fixture-cleanup.ps1
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
in the opposite order and cover the first eleven migrations. After the legacy invariant
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
`0011_worker_launch_intents.sql` atomically binds admitted launch identity.
The `-LaunchRecovery` gate additionally applies `0012_worker_launch_recovery.sql`,
tests producer rollback/re-upgrade before new history, then exercises durable
sealed receipts and confirms downgrade refusal when no-journal receipt history
cannot be represented safely by 0011. It removes only its disposable database.
Add `-LaunchNative` with `-LifecycleOnly -LaunchRecovery` for the bounded Windows
consumer/receipt/crash proof. It uses synthetic runners, never model credentials.
Use `-FilesystemBindings` instead of `-LaunchNative` to apply migration 0013,
exercise empty-registry rollback/re-upgrade, and test immutable observations,
physical alias races, exact replay, lost acknowledgements, authority loss and
retirement. The database gate uses fabricated directory identities and does not
register or alter an actual checkout. Populated registry downgrade is refused.
Add `-FilesystemNative` for three end-to-end checks that create only disposable
local Git fixtures, persist actual native observations, reject a replaced
checkout and retain retired binding history. No model or external service is used.
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
The `filesystem` suite uses disposable local Git repositories to test directory
identity, pointer pinning, layout rejection, unchanged metadata and helper/tree
cleanup. The observer grants no writer lease and is not an OS network sandbox;
see [the filesystem binding contract](docs/architecture/0007-host-filesystem-bindings.md).
The `filesystem-pins` suite checks retained directory/pointer ownership while
ordinary Git content updates remain possible. It also demonstrates that optional
routing-file absence is not reserved and verifies eventual cleanup on pin-holder
death, not writer-stop ordering. See [the standalone pin contract](docs/architecture/0014-linked-worktree-identity-pins.md).
The `WorktreeReservations` phases use disposable PostgreSQL through 0015 and
synthetic filesystem/process identities. They check pre-run holds, race and
expiry fencing, migration backfill/rollback, and existing writer regression.
They create no native worktree or provisioner and grant no release/transfer
authority. See [the pre-run contract](docs/architecture/0015-pre-run-target-holds.md).
The standalone `CounterpartStatus` phases use seeded PostgreSQL through 0015
without starting workers. They verify independent recorded state, malformed and
over-limit denial, historical access, and one-snapshot consistency across a
concurrent commit. They do not assess live freshness or authorize execution.
See [the status contract](docs/architecture/0016-recorded-counterpart-status.md).
The standalone `ProvisionerPlans` phases apply seeded PostgreSQL through 0016
and test inert immutable attempt plans, expiry/race denial, history-preserving
downgrade and predecessor target holds. Directory identities and paths are
synthetic metadata; no native fence or worktree is created. See
[the provisioner-plan contract](docs/architecture/0017-inert-provisioner-plans.md).
The standalone `Readiness` phases apply seeded PostgreSQL through 0017. They check
immutable assessment/evidence history, exact supersession and uncertain-response
replay, expiry, bounded disclosure, one-snapshot consistency and retained rollback.
The regression phase runs the prior counterpart-status and inert-plan core checks
sequentially under 0017. The `http` phase verifies the actual MCP route over loopback
using a disposable read-only database role, including whole-error disclosure and
identity drift. No live probes, readiness MCP writer or execution authority
is enabled. See [the readiness contract](docs/architecture/0019-recorded-capability-readiness.md).
The standalone `ProfileProposals` phases (`core`, `races`, `references`, `snapshot`,
`upgrade`, `regression`, `http`, `discovery`, `manifest`, `pinned`, `bound-manifest`,
`batch-manifest`) apply seeded PostgreSQL through 0018. Run one phase with
`pwsh -NoProfile -File scripts/check-postgres.ps1 -ProfileProposals core`. They check
inert proposal history, exact retries, socket-loss recovery, evidence disclosure,
MVCC consistency and history-preserving downgrade. The `http` phase exercises
both profile-review tools with SELECT-only credentials, full nested evidence,
large escaped documents, exact scope, whole-document disclosure denial and no
read-side mutation. The `discovery` phase verifies deterministic observation
reduction, immutable normalized retries, corrections and evidence disclosure
through the private producer. The `manifest` phase composes supplied package-JSON
bytes, synthetic evidence, static extraction and that private producer, without
running discovered commands or establishing a production acquisition path.
The `pinned` phase checks exact fingerprint preconditions, current usable-evidence
admission, concurrent exclusion, rollback and uncertain-commit recovery without
re-pinning historical retries.
The `bound-manifest` phase adds supplied-byte/database-hash composition, intervening
source drift, no-write outcomes and real lost-COMMIT recovery/uncertainty.
The `batch-manifest` phase adds single-snapshot multi-source composition, canonical
merge/conflict behavior, contributor drift and explicit empty-source limitations.
No operator confirmation,
publication or activation is enabled. See [the proposal ledger contract](docs/architecture/0021-retained-profile-proposals.md).
The two `provisioner-observation` phases run sequentially in disposable native
Git fixtures, checking actual parent/base/absence, case/prefix conflicts, bounded
metadata, deterministic between-check mutations and process/pin cleanup. The
suite requires a bounded `TestNamePattern`; it is not connected to database
plans or creation. See [the observation contract](docs/architecture/0018-provisioner-target-observation.md).
The `provisioner-fence` suite requires the exact `^provisioner core:` or
`^provisioner safety:` phase. Run both sequentially and all three `launch-fence`
regression phases above; these exercise native one-shot sealing and synthetic tree cleanup,
not a database-bound provisioner lifecycle. See [the native fence contract](docs/architecture/0022-native-provisioner-fence.md).
The private `provisioner-runner` suite requires one exact bounded phase:
`^provisioner runner core:`, `^provisioner runner loss:` or
`^provisioner runner expiry:`. Run all three sequentially with
`pwsh -NoProfile -File scripts/check-worker-supervision.ps1 -Suite provisioner-runner -TestNamePattern '^provisioner runner core:'`
(substitute the other phase names). It exercises actual Windows ownership and
controller ordering with synthetic database ports and a fixed model-free capsule.
No Git mutation, restricted filesystem access or production dispatch is enabled.
See [the owned runner contract](docs/architecture/0030-owned-provisioner-process-runner.md).
The database/native executor adds three isolated phases. Run each sequentially:
`pwsh -NoProfile -File scripts/check-postgres.ps1 -ProvisionerAdmissions native-happy`,
then substitute `native-lost-ack` and `native-hold-invalidated`. These use actual
PostgreSQL admission and Windows ownership with a fixed non-mutating capsule;
they preserve target holds and do not enable production provisioning. See
[the stored-plan executor contract](docs/architecture/0031-stored-plan-provisioner-executor.md).
Standalone `provisioner-pins` phases `^provisioner pins core:` and
`^provisioner pins rejection:` run sequentially through
`scripts/check-worker-supervision.ps1`. They check actual parent/common-Git
identity and ordinary rename/delete exclusion, not target absence, Git-content
stability, in-place metadata protection, restricted access or writer-stop ordering.
See [the identity-only pin contract](docs/architecture/0032-provisioner-binding-identity-pins.md).
The three `FilesystemLeaseChannelNative` phases are focused, model-free real
database/native lifecycle checks. Each applies the seeded schema through 0014,
then runs only its selected scenario; predecessor suites remain separate gates.
They use actual process journals and explicit stop/result/release ordering,
including injected loss of a real COMMIT response. They do not enable delivery
or prove filesystem isolation. The `periodic-cancel` phase also proves three
renewals, actual root/descendant workspace writes, rejection of the next real
heartbeat after durable cancellation, and stable files after native tree stop.
It does not run a DBOS cancellation workflow or a live model. Run all heavy gates sequentially. The outer gate
owns their exact temporary directory and deletes it only after the entire job is
empty; `check-native-fixture-cleanup.ps1` verifies the detached-child boundary.
The `-LifecycleOnly` variant skips the host/DBOS/native suite for a narrower
lifecycle and synthetic handoff migration check. The full gate remains sequential, with a 90-second
overall limit and a 45-second limit for the host suite.
Use `-HostOnly` for a separate host/DBOS/native gate when the combined cycle does
not fit that budget; pair it with `-LifecycleOnly` for migration rollback coverage.

These commands do not commit this project, push, deploy, or connect external
integrations. Some model-free native tests commit only inside their disposable
Git fixture repositories.

Migration runners use a disposable physical database session. Closing that
session releases all session locks and rolls back any uncommitted transaction,
including after a lost BEGIN/COMMIT acknowledgement; it is never returned to the
pool. The lock namespace and migration checksums are unchanged. The standalone
`-MigrationSessions` gate tests normal/reentrant cleanup, real connection loss,
uncertain responses, checksum rejection and concurrent-runner serialization in
an additional database owned by the disposable integration container.
