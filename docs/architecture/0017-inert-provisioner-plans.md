# 0017 — Inert provisioner attempt plans

Status: Accepted storage-only M2 prerequisite, migration 0016. No provisioner,
native fence, process launch, Git mutation or worker admission is enabled.

## Preserve an attempt before any native creation

ADR0015 retains the prospective workspace/branch and shared exclusion before a
worker run exists. This next prerequisite records one immutable `wpa_` attempt
per retained `wtr_` hold. It does not borrow `worker_runs`, `worker_processes` or
worker launch intents: provisioning precedes their admission.

The seven exact caller fields are attempt ID, reservation ID, captured hold
revision, full base object ID, reported parent observation, planned fence and
deadline. The base must be a lowercase 40/64-character object ID; this does not
prove Git resolved an existing commit or that project policy selected it.

SQL derives mission/node/graph, project/profile, repository/common metadata,
workspace, exact-case branch, selected dispatch/generation, original runtime,
machine and provenance from the immutable hold. Caller-supplied derived fields
are overwritten; the supplied actor must exactly match its original owner.
There is no new grant or implicit permission to write a parent or shared Git
metadata. Creation also records an immutable mission event atomically.

## Reported and planned are not observed native authority

The reported parent path must exactly match the prospective workspace's parent,
with a syntactically canonical Windows directory identity. Its timestamp must
be nonfuture and no older than five seconds at insertion and deferred commit.
SQL validates these recorded claims; it does not inspect the filesystem or keep
handles open. Direct-root workspace plans such as `C:\worktree` are explicitly
unsupported because the existing native parent-binding contract excludes drive
roots. The shared path parser and existing hold contract are not widened.

The planned fence has a distinct `acp-worktree-provisioner-v1` namespace, a
canonical directory and the derived filename key `<wpa-id>.provision`. Its
directory cannot lexically overlap this target or its repository. It is not a
created, owned or sealed fence, a configured control root, or proof of physical
non-aliasing with other targets. Future native execution must independently
validate host policy, native directory identity and permanent fence ownership.
The current worker-specific fence API does not accept provisioner identities.

## Immutable history and conservative invalidation

Planning follows existing parent-lock order, then locks and rereads the hold.
Insertion and deferred commit require the exact live revision, original
unstarted dispatch owner and a future deadline no later than the current hold
expiry (already capped by assignment/grant expiry). The immutable deadline is
not a renewable execution lease. This initial plan window is at most the hold's
remaining twenty seconds; no native executor consumes it in this slice.

Exact replay returns historical bookkeeping without renewal, including after
expiry or runtime retirement. Timestamp equality means the same PostgreSQL
microsecond instant, not identical offset spelling. The parser rejects excess
precision, SQL compares instants, and JSON readback preserves all six digits.
Changed terms or owner reject. A second attempt cannot claim the same hold,
even after the old attempt expired. No stop evidence or retry authority exists.

`planned` means only that the retained record still matches its captured hold
revision and original live owner/deadline. A later heartbeat, expiry, admission,
cancellation, retirement or replacement owner makes it `recovering`. Neither
label asserts current parent/fence identity or grants execution. Host-scoped
recovery inventory is bounded and keyset-paged; it is not a reclamation API.

The table rejects update/delete/truncate. Empty-attempt downgrade preserves all
0015 hold/exclusion history. Any attempt history refuses downgrade. Unused,
failed or stale plans intentionally remain retained and may strand a target
until a future independently specified reconciliation contract exists.

## Boundaries and verification

No launch, native process journal, stop receipt, provisioning success,
replacement attempt, cleanup, release or gap-free conversion is implemented.
Those require their own native and database evidence and narrowly scoped
authority; a reported parent, future deadline or plan readback substitutes for
none of them. Production roots and project base/branch policy remain unselected.

Local parser/store and focused disposable-PostgreSQL `ProvisionerPlans` gates
exercise `core`, `races`, `expiry`, `upgrade`, and existing hold `regression`.
They use synthetic directory/process names only; none of those filesystem paths
is created or inspected. Migration-session checks cover all sixteen actual
pairs. See M2 for exact completed evidence and remaining native work.
