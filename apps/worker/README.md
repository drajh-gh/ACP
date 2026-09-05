# ACP worker runtime

This package is an embeddable DBOS worker runtime, not an automatically started
production daemon. Credentials, project configuration, service installation,
and a deployed endpoint are not provisioned by its tests.

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
stores and current-owner handoff. The direct `CodexSdkWorkerTransport` remains
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

Unjournaled launch gaps still need durable launch-intent recovery. A missing
journal stays pending even after a local handoff request; a later exact journal
can make the retry eligible. Cross-boot/session recovery, Linux/systemd supervision, authenticated
live Codex execution, and live sandbox-write denial are not yet proved.

## Verification

`scripts/check-postgres.ps1` applies all ten ACP migrations, tests real DBOS
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
Local tests exercise queue/message identity, TTL cadence/watchdog, cancellation,
shutdown failure, journal-before-release, lost acknowledgements, and replay. The separate
`scripts/check-dbos-recovery.ps1` proves DBOS checkpoint recovery with its own
synthetic public-schema fixture; it is not an ACP migration or OS-supervisor test.
