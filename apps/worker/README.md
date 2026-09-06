# ACP worker runtime

This package is an embeddable DBOS worker runtime, not an automatically started
production daemon. Credentials, project configuration, service installation,
and a deployed endpoint are not provisioned by its tests.

## Static npm manifest discovery

`discoverNpmPackageManifest` is a command-free syntax adapter over explicitly
supplied manifest bytes, an evidence ID and an expected SHA-256 content hash.
It copies the exact byte view, checks the hash, decodes UTF-8 strictly and rejects
duplicate decoded JSON keys. Its bounded result reports only configured
`test`/`test:*`, `lint`/`lint:*` and `build`/`build:*` script names and command
fingerprints, including matching pre/post command fingerprints. Command bodies
are undisclosed and execution is explicitly not performed. These naming groups
are extraction conventions, not proof of a command's purpose or safety.

The adapter never executes a script, resolves environment variables, reads paths,
traverses workspaces or contacts a provider. It does not infer required gates,
CI status, installed dependencies, host readiness or authority. Absent categories
produce no observation; the generic reducer keeps those profile fields missing.
Malformed, ambiguous, mismatched or oversized input returns a constant unconfirmed
result with no partial observations. A caller must not reinterpret that result as
a successful empty-source scan.

Bounds are 262,144 bytes, JSON depth 32 and 10,000 nodes, 100 scripts, 200-character
names and 4,096-byte command strings, followed by the shared proposal fact limits.
Only the supplied byte/hash relationship is checked. Filesystem identity,
project scope, current evidence-row identity/hash, source authorization, acquisition
and appropriate disclosure of script names remain the trusted producer's job.
The current generic writer pins database evidence but does not independently
compare this adapter's top-level `contentHash` to that evidence row.

`pwsh -NoProfile -File scripts/check-postgres.ps1 -ProfileProposals manifest`
uses explicit fixture-only file acquisition and disposable PostgreSQL evidence
to exercise a correctly composed parser/reducer/private-writer path. It does not
establish a production acquisition pipeline or run the discovered commands.

The source syntax and hook distinction follow the official [npm manifest
scripts contract](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#scripts)
and [script lifecycle](https://docs.npmjs.com/cli/v11/using-npm/scripts/); presence is
configuration evidence, never successful execution.

## Database-bound supplied manifest discovery

`recordNpmManifestDiscovery` composes supplied bytes with the private proposal
store. Input contains only exact proposal identity, one evidence ID and a byte
view; callers cannot choose hashes, pins, observations, producer or authority.
The coordinator owns a bounded byte copy before asynchronous work. The store's
`getCurrentDiscoveryEvidence` reads the exact project/evidence pair in one bounded
snapshot, requiring current, available, disclosable and temporally valid evidence
with an exact lowercase SHA-256 content hash. Only that hash and its matching
opaque evidence pin are returned internally, never source references or raw content.

The adapter checks its copied bytes against that database hash. Successful,
nonempty observations pass only to `recordPinnedDiscovery`, which rechecks current
usability and the same fingerprint under database locks before retaining server
pins. Source identity or usability drift between lookup and admission fails closed.
The coordinator reparses the returned full proposal and checks exact input identity,
fields and pins before returning `recorded` with the store's replay flag.

An unconfirmed parse/hash returns `not_recorded / manifest_unconfirmed`. A valid
manifest without relevant declarations returns `not_recorded /
no_relevant_declarations`. Neither branch invokes the writer. These outcomes mean
only **this invocation wrote nothing**; they neither query nor establish absence
of an older proposal under the same ID. Source/persistence errors instead throw
one constant error. A thrown error may follow an uncertain committed write, so
it must not be treated as absence or automatically retried with a new ID.

Every coordinator call performs a fresh source lookup. Same-current-source retries
can recover the retained result; changed or restricted evidence cannot bypass the
lookup by replaying history. Original-pin recovery after drift remains the separate
private writer path. A successful invocation binds the parsed byte snapshot to the
database content hash and retained pin at that invocation, but a historical proposal
alone does not preserve a cleartext content-hash transcript or prove source bytes.
Filesystem/path acquisition, provider authenticity, source authority and appropriate
script-name disclosure remain outside this helper. Nothing is installed, scheduled,
published, activated or executed.

`pwsh -NoProfile -File scripts/check-postgres.ps1 -ProfileProposals bound-manifest`
runs the six static fixture checks plus eight coordinator/descriptor checks against
owned PostgreSQL, including current-source drift, no-write outcomes, historical
ID reuse and actual lost-COMMIT recovery/uncertainty.

## Multi-source manifest composition

`recordNpmManifestDiscoveries` accepts exact proposal identity and
`sources: [{ evidenceId, bytes }]`. This is selected-source composition, not
repository discovery: no repository/path identity or acquisition is supplied.
One to five unique evidence IDs are accepted; sparse/decorated lists and extra
source properties reject. Every intrinsic byte view is copied before the first
await. Each source retains the 262,144-byte bound, with 1,048,576 bytes total.

`getCurrentDiscoveryEvidenceBatch` reads the entire exact same-project descriptor
set in one bounded SQL statement and MVCC snapshot. Missing, invalid, restricted,
unusable or substituted sources reject the whole set. Sources and descriptors
are canonically associated by evidence ID, not caller order. Every owned copy
must hash and parse successfully before any proposal write is possible. One failed
manifest produces one whole `manifest_unconfirmed` no-write outcome; all-empty
reports produce `no_relevant_declarations` with no write.

Nonempty observations are reduced together. Equal reports merge evidence,
different reports remain unresolved alternatives, and independent categories
remain separate. There is one final pinned write with exactly the nonempty
contributor union (at most five), not one draft per source. Input ordering cannot
select a winner or change the retained proposal.

Empty sources pass the current descriptor/byte check but contribute no retained
fact or pin. They are **not locked or rechecked through commit**, retained as
negative coverage, or included in historical replay identity. Adding or changing
an empty contributor can therefore replay identical attributed history. If it
later gains relevant declarations, fields/pins change and the old proposal ID
cannot alias those new terms. This is not an atomic complete-scan receipt.
Only nonempty contributors are lock-rechecked and retained by the writer.
The single-source helper and its uncertainty/authority boundaries are unchanged.

`pwsh -NoProfile -File scripts/check-postgres.ps1 -ProfileProposals batch-manifest`
includes the static and single-source checks, then verifies multi-source merging,
conflicts, whole failure, contributor drift, empty-source semantics and a paused
single SELECT across a concurrent evidence transaction.

## Host-aware execution

The optional fourth argument to `launchWorker` is a `HostDispatchRuntime` built
with an exact host registration, a fresh `whs_` session ID, application version,
and workflow-binding/provenance-template registrations. Its application version
must equal the worker configuration. A replacement uses a new session ID;
retired IDs cannot be reused. Simultaneously live daemons cannot take over the
same host identity. Host configuration and session registration are atomic.

The runtime uses `PostgresDispatchStore`, `PostgresContextStore`, a host-bound
`WorkerManager`, and `postgresWorkerEnqueuer(DBOSClient)`. All ACP and DBOS
connections must address the same PostgreSQL database. Schema migration remains
an explicit deployment operation. The dispatch pool must configure bounded
connection, statement, and lock timeouts; examples in the integration check use
3 seconds, 5 seconds, and 3 seconds respectively.

The consumer registers DBOS queues for the exact host/session/resource class.
Reservations and DBOS enqueues share one database transaction. On delivery it
checks the assignment, prepares the node, builds a fresh authoritative packet,
and admits exactly one durable run before invoking the transport. DBOS recovery
may replay an interrupted step even when retries are disabled. An existing run
therefore returns its terminal result or requires reconciliation; it never
causes a second transport invocation.

`launchWorker` renews heartbeats independently of the assignment sweep, at most
one third of the host TTL and no slower than five seconds. A local watchdog
fences the daemon even when renewal is stalled. Exact durable cancellation
intent aborts active workers, and loss of session/host authority fails closed.
A draining host may finish admitted work but cannot accept new assignments.
Shutdown aborts local workers before database cleanup; DBOS shutdown still runs
if host-session closure fails.

## Windows owned-process transport

`WorkerManager` waits for transport settlement before recording cancellation or
timeout. Late success during abort cannot override cancellation. Unconfirmed
termination stays nonterminal and requires reconciliation.

For a Windows 10+ host with PowerShell 7, embed `SupervisedWorkerTransport` with
a `WindowsWorkerLauncher` and the same `PostgresWorkerRuntimeStore` used by the
manager. Supervision requires schema 0008; schema 0009 supplies the current
lifecycle-aware packet producer and schema 0010 is required by the recovery
stores and current-owner handoff. Opt-in durable launch mode requires schema
0012 and the paired fence/receipt-store configuration below. The direct `CodexSdkWorkerTransport` remains
the trusted child implementation; it is not itself a process supervisor.

The native bridge creates a hidden, suspended Node runner already assigned to
a named, kill-on-close Windows job. Only its three stdio handles are inherited.
It reports the PID and creation FILETIME from a held process handle. The parent
commits that exact identity, run-derived deadline, and job name before sending
the release frame. One supervised root is allowed per run, including after its
first process journal becomes terminal. The child receives bounded private IPC,
a minimal environment, and no database client or effect credentials. Trusted
runner/executable paths are embedding configuration, never model-selected data.

On exit, cancellation, overflow, or failure, the bridge stops descendants and
requires both zero job-active processes and a signalled root handle before
acknowledging closure. Root exit alone is insufficient. Native stdin delivery
does not block the control loop. An independent native watchdog kills the tree
at the persisted deadline even if pipe I/O stalls; a bridge still blocked after
six seconds of grace exits as well. Daemon death closes control input. Bridge
death closes the job handle. Missing tree-empty acknowledgement deliberately
leaves durable state reconciliation-required, even if the kernel killed it.

The transport bounds journal calls, heartbeats exact process identity, and
persists process termination before returning any worker result. A lost INSERT
acknowledgement triggers an exact journal lookup after tree stop, never a second
launch. Configure server-side connection/statement/lock timeouts too: a local
promise timeout cannot cancel a database statement already executing.

The job uses the Windows process-creation
[job-list and handle-list attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute).
It has no breakaway, affinity, or priority overrides and inherits the operator's
Resource Guard through [nested jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs).
This is process-lifetime ownership, not a same-user security sandbox. The SDK
sandbox is still required; per-operation tool-broker enforcement, lower-privilege
isolation, and automatic delivery-worktree provisioning are unfinished.

## Windows crash recovery

Supply the optional `HostDispatchRuntime.recovery` integration as a
`WorkerRecoveryRuntime` using a `PostgresWorkerRecoveryStore(pool, runtime)`,
the same worker store, and a `WindowsWorkerTreeInspector`. Its host, session,
and application version must match the daemon. Maintenance coalesces concurrent
sweeps and examines at most two candidates per pass; a keyset cursor advances
past unconfirmed or poisoned candidates. Shutdown and authority loss abort
inspection and await bounded helper cleanup.

New journals store a hashed OS-installation identifier, boot timestamp, and
Windows session ID beside the exact job name and PID/creation token. Recovery
requires that exact scope. A changed boot timestamp is not proof of a reboot;
it fails closed, as do missing historical scope, wrong session, access errors,
or a live job without its matching original root. The inspector never kills by
PID. It confirms exact-job membership through held handles before termination,
and requires both an empty job and a signalled original root. The absence path
uses Windows' guarantee that a [job is destroyed only after its associated
processes have terminated](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects),
not root-PID absence alone. OS fingerprints are namespace safeguards, not a
security boundary against cloned installations or a hostile same-user process.

Runs are eligible after their original daemon session retires or explicitly
hands off that one journaled run. A healthy owner may be between journal
completion and valid result persistence; replay alone cannot take that gap over.
Each exact eligible process gets a fresh claim and provenance cloned from the
recovering daemon's current same-binding runtime
template. Observation holds a PostgreSQL session advisory lock and is bounded
by the remaining database claim lease. Database loss aborts the inspector.
Final writes lock and recheck process identity, claim expiry, and live recovery
authority. PostgreSQL claim microseconds are retained without a JavaScript Date
round trip. Stopped-run repair locks mission, node, and run, preserves an
existing terminal winner, and records cancellation or an interrupted failure;
it never infers success from process exit.

When a locally invoked manager rejects without a durable result, it first
permanently aborts its transport signal. The host then requests an exact durable
handoff; initial dispatch replay and context-build failure cannot invent one.
The database fences late owner journal/heartbeat/result writes, while unrelated
runs and the daemon remain live. Capacity stays occupied until stopped-process
recovery. Lost handoff acknowledgements and missing journals enter a bounded
1,000-entry retry queue, rotated two per maintenance pass. Exhausting that queue
fences the daemon and stops lease renewal rather than discarding uncertainty.
The queue is local; a daemon crash uses the existing retired-owner recovery path.

Legacy unjournaled launch gaps remain pending; legacy runs are never retrofitted
with invented intents. In opt-in launch mode, an exact admitted intent can be
sealed and recovered even without a journal. Cross-boot/session recovery, Linux/systemd supervision, authenticated
live Codex execution, and live sandbox-write denial are not yet proved.

## Durable Windows launch intents

The opt-in `WorkerLaunchRequest.launchFence` supplies the persistent native fence
for durable launch-intent recovery. `describeWindowsLaunchFence` reads the
identity of a configured, existing local directory and the current OS scope.
The descriptor pins its canonical path, volume/directory file identity, machine,
boot and Windows session. This helper does not create the directory or grant
execution authority. Embedders must use a dedicated, persistent, non-synced
directory outside repository/worktree and model-writable boundaries.

An exclusive file named for the immutable process ID flushes a consumed marker
before CreateProcess and appends exact PID/FILETIME identity before reporting
ready. Both creation and resume use that same exclusive lock. Sealing appends
and flushes a permanent tombstone before observing or stopping the job. Even a
late/recreated bridge cannot create or resume after the seal. A seal with no
recorded root can prove only an absent/empty job, never kill an unidentified one.
An occupied file, malformed/partial record, directory identity change, wrong
scope, reparse point or hard link stays unconfirmed. Handles anchor the root and
every ancestor against namespace replacement while acting.

After normal exit, explicit termination, or a recoverable bridge failure, the
owner first confirms tree stop and then durably seals that exact root. Fenced
`OwnedWorkerExit` includes `launchSealed: true` only after both facts are known.
A stopped tree with an occupied/unwritable seal remains unconfirmed to its owner;
independent recovery can seal and observe it later. Legacy launches retain their
existing closure contract and do not receive fabricated seal evidence.

Never truncate, delete, relocate or restore seal files as ordinary cleanup.
They fence potentially delayed launchers; losing that history can reopen an
old identity. Storage failure fails closed. This is trusted-host process-lifetime
coordination, not a security boundary against a hostile same-user administrator.
Database launch-intent admission now has an opt-in atomic storage boundary in
migration 0011. Migration 0012 adds permanent revocation, fresh recovery claims,
and durable no-journal stop receipts through `PostgresWorkerLaunchStore`. Owner
process completion and its sealed receipt are atomic; recovery holds one live
database session through observation and receipt commit, without row locks over
native I/O. Lost acquisition acknowledgements destroy the uncertain session.
Configure both `SupervisedWorkerTransport.launchFence` and `launches`; incomplete
configuration fails at construction. The manager reserves one process ID in the
same transaction as run admission and checks exact persisted readback before
launch. Lost admission acknowledgement, prelaunch abort or uncertain creation
stays pending until recovery seals the intent. The transport uses only that
process ID, journals before release, and atomically records sealed owner closure
before returning a result. It strips launch-directory metadata from child IPC.
A native seal alone must not be used to terminalize historical runs.

For an already-configured bounded pool, current runtime and worker store:

```ts
const fence = await describeWindowsLaunchFence(trustedSealDirectory, signal);
const launches = new PostgresWorkerLaunchStore(pool, runtime);
const transport = new SupervisedWorkerTransport({
  launcher: new WindowsWorkerLauncher(), processes: workers,
  launchFence: fence, launches,
});
const recovery = new WorkerRecoveryRuntime({
  store: new PostgresWorkerRecoveryStore(pool, runtime), workers,
  inspector: new WindowsWorkerTreeInspector(),
  launches: new WorkerLaunchRecoveryRuntime({
    store: launches, inspector: new WindowsWorkerLaunchInspector(),
  }),
});
```

Pass this transport to the manager and recovery to the host consumer. The two
recovery lanes alternate whole maintenance passes, preserving the total bound of
two observations per pass; each advances its own cursor across poisoned items.
All three runtime identities must match. A committed owner receipt survives
handoff/replacement and requires no fresh native I/O, only fresh projection
provenance. Terminal winners remain unchanged; recovery never infers success.

Migration 0012 cannot be removed while an intent is unresolved, or when a
no-journal stop receipt is the only independent stop proof for historical work.
No fake journal is created to make rollback appear safe. Independent mission
events and permanent native seals are retained when compatible rollback is possible.

## Read-only filesystem observations

`observeWindowsRepository(checkout, signal, { gitExecutable, onSpawn })` describes
an existing ordinary Windows checkout. `observeWindowsWorktree(repositoryBinding,
workspace, signal, options)` additionally rechecks the exact machine, checkout and
common-Git-directory identities before describing an attached linked worktree.
The executable must be an absolute, host-configured `git.exe`; it is not selected
from model input. `onSpawn` reports every helper/Git PID and its bounded purpose.

Successful observations carry native directory identities and observation time;
worktrees also carry the exact branch ref and resolved commit SHA. Cancellation,
unknown identity, unavailable Git, detached/unborn HEAD and unsupported layouts
return `unconfirmed`. No registration, file mutation, writer lease or delivery
admission is performed. A caller may explicitly publish a confirmed observation
with selected stable IDs and fresh runtime provenance through the 0013 registry;
that publication still grants no execution authority.

The first supported layout rejects case-sensitive directory namespaces, reparse
points, hardlinked pointer/config files, separate Git directories, alternate
object stores and configuration outside a bounded allowlist. It pins config and
pointer files while reading, disables lazy fetch and inherited Git configuration,
and owns/terminates every Git child tree. It inherits host filesystem access and
is not an OS network sandbox or a complete content snapshot. Hostile concurrent
creation of new metadata needs the later isolation/lease contract; do not infer
technical operation/resource enforcement from these observations.

## Verification

### Native-only provisioner fence

`describeWindowsProvisionerFence` and `sealWindowsProvisionerAttempt` observe and
permanently seal the distinct `wpa_` / `.provision` / `ACP.Provisioner` namespace.
The native core retains exact directory, OS scope and optional PID/FILETIME
identity. Sealing precedes exact owned-tree stop or bounded absence observation;
an unknown live unrecorded job remains unconfirmed. There is no production
provisioner launcher, database journal/GO acknowledgement, plan renewal, release,
conversion or Git write. Native observations cannot be submitted as invented
worker stop receipts. See [ADR0022](../../docs/architecture/0022-native-provisioner-fence.md).

Run the two bounded phases sequentially:

```powershell
pwsh -NoProfile -File scripts/check-worker-supervision.ps1 -Suite provisioner-fence -TestNamePattern '^provisioner core:'
pwsh -NoProfile -File scripts/check-worker-supervision.ps1 -Suite provisioner-fence -TestNamePattern '^provisioner safety:'
pwsh -NoProfile -File scripts/check-worker-supervision.ps1 -Suite launch-fence -TestNamePattern '^(sealing a never|a consumed|a permanent|explicit termination|tree closure)'
pwsh -NoProfile -File scripts/check-worker-supervision.ps1 -Suite launch-fence -TestNamePattern '^(a crash|recovery cannot|sealing a running|wrong scope)'
pwsh -NoProfile -File scripts/check-worker-supervision.ps1 -Suite launch-fence -TestNamePattern '^(malformed|recreated|pure launch|held permanent)'
```

Only test helpers create synthetic processes. The shared worker fence regression
is required in all three positive-filter phases above; selected provisioner tests
do not replace it. The unfiltered worker suite can exceed its unchanged time bound.
All reported PIDs and
the enclosing owned native job must exit before the UUID fixture is removed.

### Existing worker and database gates

`pwsh -NoProfile -File scripts/check-postgres.ps1 -RepositoryBindingOnly` is a
standalone registry-only gate: seeded schema through 0013, empty down/up, immutable
record/retirement and real connection-loss checks, and owned database cleanup.
It excludes native observation, active-writer execution and all other mode flags.
Registry transactions discard their physical sessions and preserve uncertainty;
they never authorize creation, deletion, renewal or automatic retry.

Filesystem-writer reserve/heartbeat/release also discard their physical database
sessions. An uncertain heartbeat COMMIT denies native authority even when readback
shows a newer revision; an explicit exact release retry can only confirm retained
terminal history. Verify active renewals with these separately bounded gates,
sequentially (not in parallel):

```powershell
pwsh -NoProfile -File scripts/check-postgres.ps1 -LifecycleOnly -LaunchRecovery -FilesystemBindings -FilesystemLeases -WorktreeReservations regression
pwsh -NoProfile -File scripts/check-postgres.ps1 -LifecycleOnly -LaunchRecovery -FilesystemBindings -FilesystemLeases -FilesystemLeaseChannelNative initial
pwsh -NoProfile -File scripts/check-postgres.ps1 -LifecycleOnly -LaunchRecovery -FilesystemBindings -FilesystemLeases -FilesystemLeaseChannelNative lost-ack
pwsh -NoProfile -File scripts/check-postgres.ps1 -LifecycleOnly -LaunchRecovery -FilesystemBindings -FilesystemLeases -FilesystemLeaseChannelNative periodic-cancel
```

The native phases assert actual backend closure after controller quiescence and
retain stop/result/release ordering. Disposable model-free writes do not prove a
production filesystem sandbox or connection-churn capacity/latency suitability.

`scripts/check-postgres.ps1` applies all eleven ACP migrations, tests real DBOS
host queues and supervised admission (including a native synthetic runner on
Windows), kills a journaled native owner and recovers its durable state, reverses
the migrations, and removes its owned PostgreSQL container. The lifecycle suite
also preserves an admitted 1.0.0 run across the upgrade, recovers it with its
original packet digest, denies stale identity/version snapshots, and admits a
fresh 1.1.0 retry. Producer rollback preserves historical packets and their
append-only observations; neither replay nor an old packet permits new work.
The synthetic handoff suite checks a real manager/host/store recovery path with
lost acknowledgement, concurrent late-write fences, healthy-owner preservation,
missing-journal retry, cancellation, and downgrade safety. Handoff tests use
fabricated process identities, not native process-stop evidence.
`npm run test:worker-supervision` separately tests native process-tree ownership,
deadlines, daemon loss, blocked pipes, exact recovery, namespace/identity denial,
and aborted-inspector cleanup without model credentials or a database.
The three `launch-fence` phases above
separately test permanent creation/resume fencing, consumed-ID replay, a real
killed helper between CreateProcess and root journaling, exact unjournaled tree
stop, Unicode paths, scope/directory substitution, partial records and hard links.
It removes only its owned temporary seal fixtures after their actors exit;
production seals are retained. The suite has independent 70/90-second bounds.
`pwsh -NoProfile -File scripts/check-worker-supervision.ps1 -Suite filesystem`
tests native/Git observations against disposable Unicode-path fixtures, including
unchanged metadata, exact identities, pointer pinning, unsafe-layout denial,
missing objects, poisoned environments and confirmed cleanup after cancellation.
`pwsh -NoProfile -File scripts/check-postgres.ps1 -LifecycleOnly -LaunchRecovery -LaunchNative`
combines schema 0012 with a synthetic native runner and the actual host/manager/
transport path. It covers normal sealed closure, lost owner receipt ACK, delayed
journal ACK across cancellation/handoff, lost admission ACK without creation,
and a killed unjournaled owner recovered without duplicate execution or a fake
journal. The native child gate is 45 seconds inside the 90-second overall bound.
Local tests exercise queue/message identity, TTL cadence/watchdog, cancellation,
shutdown failure, journal-before-release, lost acknowledgements, and replay. The separate
`scripts/check-dbos-recovery.ps1` proves DBOS checkpoint recovery with its own
synthetic public-schema fixture; it is not an ACP migration or OS-supervisor test.
