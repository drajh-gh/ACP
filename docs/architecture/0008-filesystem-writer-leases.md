# 0008 — Retained filesystem writer exclusion

Status: Accepted for storage-only local implementation. No delivery/Git admission.

Specification 15.2–15.3 requires more than an expiring generic resource lease.
A process can continue writing after its heartbeat expires. Filesystem writer
leases therefore retain their workspace and branch uniqueness until an explicit
release receipt proves both a sealed, stopped launch and a terminal worker run.
The terminal run requirement retains exclusion during manager result validation.

Each lease belongs to one already admitted delivery/write run and its immutable
Windows launch intent, and one retained mission-bound worktree observation. It
must be acquired before any process journal exists. Host, machine, project/profile,
workspace and original session must agree. The worktree's profile matches the
run; the parent repository's profile remains historical observation provenance,
allowing new mission worktrees after a same-project profile revision.
This is not worktree provisioning;
no run is fabricated to prepare a directory.

The database derives four exclusion keys: logical repository/mission workspace,
host/machine/native workspace identity, host/machine/native common Git directory,
and logical repository/exact branch-ref SHA-256. Branch case is preserved.
The common-directory key conservatively serializes writers sharing physical Git
metadata, including case-varied loose refs on Windows. It avoids assuming that
database case folding exactly models every Windows filesystem alias. Separate
physical clones still share logical branch exclusion for an identical ref.
Unreleased rows hold all four keys regardless
of time, cancellation, session replacement, binding retirement or run state.
One run can acquire only one lease, including after release. Lease IDs and owner
tuples are immutable; an acquisition retry is a historical read, not renewal.

Renewal uses database time with a 20-second ceiling, also bounded by the grant
and run deadline. It requires an unexpired lease and the original live, unrevoked,
uncancelled delivery owner. There is no revival after expiry. Readback reports
`recovering` when expiry or loss of that authority occurs; this derived state
does not free any key. Binding retirement can end renewal but never releases a
writer. Heartbeats and acquisition/release transitions have append-only mission
events, and release has its own immutable receipt.

Release can be performed by a fresh current runtime on the same host, including
after original-session replacement, only with the actual launch-stop row and a
terminal run. It does not infer absence from TTL, a PID, or legacy stop helpers.
Fresh release provenance is derived from the current template and original
packet. Both owner and release authority are rechecked at commit. Recovery that
cannot produce sealed native stop evidence leaves exclusion retained indefinitely.

Recovery inventory uses host-scoped keyset pages of at most 100 items. It only
reports retained leases whose snapshot is recovering, distinguishing missing
launch-stop evidence, a stopped launch awaiting its run result, and sealed
terminal ownership. Listing has no write effects and no entry grants authority;
release always revalidates current state and provenance. Each page is its own
database observation, not a repeatable-read scan. Callers continue with the cursor
then restart a fresh pass so newly changed or inserted earlier keys are revisited.

Store mutations lock mission → node → run → host session → host → launch intent,
then repository → worktree → lease. Unique indexes serialize competing keys.
Reservation, heartbeat and release now opt into physical-session containment:
checked-out connection errors become sticky before/after every statement, the
original failure survives a failed rollback, and every transaction (including
successful historical replay) discards its physical connection. Callbacks are
never replayed automatically and uncertain COMMITs remain rejected. Heartbeat
readback is not the missing ACK and cannot restore native writer authority. An
explicit exact release retry may confirm an already-retained terminal receipt,
without another revision, provenance or event; it cannot renew or restart a run.
Direct SQL updates can acquire the lease row before triggers take those locks;
PostgreSQL may abort such an inverted transaction, never bypass a predicate.
Retirement locks the corresponding binding and does not acquire lease locks.

This slice is durable ownership bookkeeping, not an OS fencing mechanism. A
future owner must reobserve native identities and branch state under the lease,
hold process isolation across writes, terminate on renewal loss, and validate its
result before releasing. Provisioning requires a separate reservation protocol.
The later opt-in native launcher channel is specified in
[ADR0013](0013-private-native-lease-channel.md); it preserves stop-on-uncertain-ACK
ordering with physical connection disposal. Local correctness gates do not establish
production connection-capacity or renewal-latency suitability. Populated downgrade is refused
even after release so ownership and release evidence cannot disappear.
