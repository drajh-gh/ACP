# 0031 — Stored-plan private provisioner executor

Status: Private database/native composition with a fixed model-free capsule.
No production dispatcher, Git mutation, restricted filesystem grant, success
receipt, target creation or hold conversion/release is enabled.

## A narrow invocation and one original snapshot

`NativeProvisionerExecutor` accepts only `{attemptId, signal}`. Constructor-owned
plan, admission, journal and runner ports must agree on all three original owner
fields. Capture their methods and owner once. Reject extra, missing, inherited
or malformed invocation fields before I/O. Pre-aborted invocations do not load.

Load exactly one host-scoped retained plan. Await a pending load even after
cancellation rather than abandoning a hidden database operation. Copy and freeze
the complete result with ADR0030's validator; reject absent, recovering,
substituted, foreign-owner or expired/out-of-budget plans before native spawn.
The original planned state is an economical prefilter, not execution permission.
Fresh admission still decides hold-revision drift, retirement, cancellation and
expiry after the load. Do not reload, repair an uncertain reply or reset time.

The trusted runner returns ownership immediately after spawn. Capture its READY,
original physical-closure promise, internal signal and bound termination method
before waiting. Consume a handle once and combine user/native cancellation.
Request termination at most once, with a re-entry sentinel before invoking it.
Only the exact original closure is used for READY validation, the controller and
final cleanup; later property mutation cannot substitute a stop receipt.

Validate actual READY against the frozen attempt, complete expected plan, fence
namespace/directory and machine. Native root, directory identity, scope and
challenge retain their shared parser checks. A mismatched or absent READY causes
owned shutdown and no admission or fabricated stop write. Valid late READY after
cancellation may reach the pre-aborted controller solely for exact stop recording.

## Fresh authority and physical cleanup stay separate

Delegate the fresh database admission → exact native acceptance → one GO path
to ADR0026's actual controller. Its pending database/native work must drain before
durable stop. Capture GO attempts before invoking the native method so a throwing
send remains uncertain, not “never attempted.” Keep internal native failure in
the combined signal even when valid rooted closure later arrives.

Return `not_started` for known pre-ownership denial; it conveys neither release
nor recovery permission. After ownership, preserve the controller's distinction
between unconfirmed closure, physical closure with uncertain stop persistence,
and a durable stop receipt. Every path awaits the original owned closure and any
termination request before returning. A stop receipt never certifies successful
provisioning or ends retained target exclusion. Under OS kill failure, actual
closure can remain pending; do not manufacture a bounded successful stop.

## Actual database/native evidence

The isolated `ProvisionerAdmissions` phases `native-happy`, `native-lost-ack`
and `native-hold-invalidated` use disposable PostgreSQL through 0021, actual
Windows scope/fence/root/bridge/channel ownership, this executor and a fixed
non-mutating synthetic capsule. Plan creation follows fixture setup, a fresh
native parent observation and final pre-plan hold heartbeat. Its deadline is
18 seconds, capped 500 ms before hold expiry. Each child has a 30-second bound
inside the existing 90-second owned outer job.

The happy phase requires a separate connection to observe the exact committed
process/admission/root-claim tuple before native acceptance and GO. Physical
process-and-pipe closure and a sealed fence precede durable stop. The lost-ACK
phase throws only after an actual COMMIT response, proves physical backend
discard, permits no native acceptance/GO and retains exact stop afterward.
The changed-hold phase commits a heartbeat after plan load and native READY;
the original revision's admission must roll back without process/admission/root
claim rows. Its later rooted stop-first transaction itself creates the permanent
root exclusion claim, as required by ADR0024. That is stop history, not admission.

All phases retain target keys, verify the prospective workspace is absent and
create no worker run. Callback assertion failures are retained outside controller
error handling. Cleanup drains exact handles and verifies reported PIDs, backend
closure and outer-job emptiness before deleting the UUID fixture and disposable
database. M2 records executed gates and observed test corrections.

## Remaining activation boundary

The recorded parent is observed natively in these fixtures, but the runner's
production seam still only checks path existence and forwards parent/common-Git
identities as data. Common-Git fixture identity is synthetic and no Git commands
execute. Revalidate and retain real filesystem identities, establish separately
restricted parent/common-metadata write authority and pin/stop ordering, then
implement fixed Git operations, independent verification, gap-free hold
conversion and retired-owner recovery before enabling real provisioning.
