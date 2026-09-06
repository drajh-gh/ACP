# 0022 — Native-only permanent provisioner fencing

Status: M2 native prerequisite. No database-plan consumer, provisioner launcher,
GO channel, database process/stop journal or Git mutation is introduced.

## A separate native identity

The inert `wpa_` attempt from [ADR0017](0017-inert-provisioner-plans.md) must not
borrow a worker run or `wpr_` process identity. `WindowsLaunchFence.OpenProvisioner`
uses the distinct `ACP-PROVISIONER-FENCE-1` header and `<wpa-id>.provision` filename.
Its named job is `Local\ACP.Provisioner.<wpa-id>`. Worker header bytes, `.launch`
files and `Local\ACP.Worker.<wpr-id>` jobs remain unchanged. C# identity checks use
strict end-of-string anchors, including denial of trailing newline aliases.

The native core shares the existing pinned directory/ancestor handles, exclusive
non-delete-shared file handle, reparse/hardlink denial, bounded append-only format
and durable flush protocol. The record binds exact ID, machine, boot and session.
It does not contain or authenticate an immutable database plan, reservation,
deadline, grant or parent/common-Git-metadata permission.

`Begin` flushes one permanent consumption before a caller may create a root.
Any nonempty or partially written claim prevents reuse. A trusted owner may
record the exact owned PID/FILETIME and start timestamp, then must call
`RequireRoot` immediately before resume while holding the same fence. A seal is
permanent and flushes before any stop or absence observation. No code removes,
resets, truncates or reuses a production fence. Malformed/ambiguous retained
records remain unconfirmed, not unused or safely reclaimable.

## Seal-only production surface

`describeWindowsProvisionerFence` observes an existing native directory and OS
scope and adds the exact `acp-worktree-provisioner-v1` namespace. Its descriptor
parser additionally requires a canonical Windows directory path. The observed
directory is not automatically an approved control root: trustworthy ACLs,
non-model-writable/non-synced placement and physical separation remain host policy.

`sealWindowsProvisionerAttempt` accepts only that descriptor and a `wpa_` ID.
The private helper independently reads current machine/boot/session, verifies
the exact directory identity, opens the provisioner fence and flushes its seal.
For a recorded root, recovery checks the exact PID creation token and membership
in the exact named job before termination. Positive termination waits for both
root exit and zero active processes. A reused PID or a live colliding/unrecorded
job cannot authorize termination. An unrecorded job yields absence only when the
sealed name is absent or empty; a live job stays `unconfirmed` and untouched.

The helper's bounded stop-operation deadline is not a new execution deadline.
It neither renews the original plan's at-most-twenty-second window nor grants any
new launch permission. The resulting native observation is not a durable database
stop receipt, reservation release, conversion, successful provision or recovered
owner claim. Calling the helper does not create a provisioner root or worktree.

## Remaining execution protocol

A future provisioner capsule must validate the exact immutable plan and original
deadline, durably journal native creation before GO, obtain fresh owner-bound
database acknowledgement, and stop on uncertainty, cancellation, retirement or
expiry. Admission must respect consumed attempts until independently sealed stop.
Recovery claims, owner handoff, parent/common-metadata write authority and gap-free
hold conversion remain separate native-and-SQL work. This standalone primitive
does not satisfy them and is not wired into delivery dispatch.

## Native verification

The `provisioner-fence` suite uses only owned UUID temporary roots and test-only
synthetic suspended/running processes. It has two required exact positive phases:
`^provisioner core:` and `^provisioner safety:`. The outer 90-second native job and
inner 70-second suite own every descendant; each fixture also reports helper,
root and child PIDs and confirms their exit before completion. Cleanup removes
only the validated owned fixture after the entire outer job is empty.

Core checks cover sealed-unused replay, one-shot consumption, worker-namespace
denial, a seal-only/live-suspended-root resume denial, and exact root-plus-descendant
stop. Safety checks cover helper death before root recording, unknown live jobs,
wrong scope/replaced directory, malformed/cross-format files and hardlinks.
Because the append-only primitive and seal helper are shared, the existing full
worker `launch-fence` regression is mandatory alongside both new phases. Its
thirteen checks run in three sequential positive-filter phases documented in
the worker README; an unfiltered attempt exceeded the unchanged 70-second inner
bound and its owned job and fixture were cleaned before narrowing the gate.
No fixture provisions Git, accesses a database, calls a model or proves a complete
database-bound provisioner lifecycle.
