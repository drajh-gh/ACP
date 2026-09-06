# 0025 — Fresh-only provisioner admission

Status: Local storage prerequisite; verification recorded in M2. No native
provisioner channel or Git operation is enabled by this decision.

## Selected boundary

Specification 15.1–15.4 requires exact, expiring capability and exclusive mutable
target ownership. The0016 plan and0019 process journal preserve history, but the
journal's idempotent process receipt cannot distinguish a newly admitted process
from replay. Historical presence must never become permission to release a
suspended native provisioner.

Add one private `PostgresProvisionerAdmissionStore.admit` operation. It copies an
exact attempt, fence, native root and initial challenge before its first await.
The challenge follows the established native 32-lowercase-hex nonce and epoch 1
vocabulary. There is no caller-supplied deadline, duration, revision, owner or
provenance. The store has no readback or accepted-replay method.

Inside one physically isolated transaction, lock the existing plan/journal chain
and reject any previous process, stop or admission. Insert a new process and its
0020 global root claim, then an immutable admission. Return `fresh:true` only
after the physical COMMIT response. A failed or uncertain COMMIT rejects; the
session is discarded and no callback, lookup or mutation is retried. If that
COMMIT actually persisted, every later admission request is denied, including
the exact nonce. This is intentionally not an idempotent success API.

## Atomic pair and immutable original authority

The process receives a nullable `admission_attempt_id`, equal to its own attempt
when present. An initially-deferred foreign key points it back to the admission;
the admission references the process and requires that exact marker. Thus a
marked process cannot commit alone, and an immutable historical NULL marker
cannot be promoted. Both records must be created in the same transaction without
using transaction IDs, tuple xmin or timestamps as identity evidence. Unmarked
standalone process journals remain supported for history only.

Admission derives its original reservation/revision/deadline, runtime identity,
provenance and exact root-claim owner from retained sources. It verifies the
global claim's kind, machine scope, host, tree, PID and exact creation token.
The old deadline remains fixed. Duration is the integer floor of that deadline
minus database admission time, between 251 and 20000 milliseconds. Nothing renews
or releases the target hold, admits a worker, or records worktree success.

Insert checks require original live authority and no stop. The private producer
leaves the deferred checks deferred through COMMIT; they recheck the original
authority, root claim, stop absence and more than 250 milliseconds remaining.
These are private/default-deferred transaction guarantees, not a database
firewall against arbitrary trusted SQL. PostgreSQL permits a SQL caller to move
deferrable checks earlier with `SET CONSTRAINTS`; such a caller does not implement
this admission protocol and its rows are not fresh-ACK transport. The structural
pair and historical-marker exclusion do not depend on keeping checks deferred.

Preserve the 0019 journal event 1.0.0 payload exactly by excluding the new internal
marker. Admission has its own `filesystem.provisioner-admitted` event 1.0.0. No
historical audit record is rewritten. Upgrade and downgrade take NOWAIT source
locks; retry a busy migration only after writers are quiescent. Populated
admission history permanently refuses downgrade, while empty admission rollback
restores the prior journal producer and preserves old process/stop history.

## Still required before native effects

A database acknowledgement is not a bearer capability. The next private
controller must bind it to one already-owned suspended native session, accept
the matching native challenge once, and issue GO at most once. Native monotonic
expiry must start at challenge issuance, never at late acknowledgement arrival.
Cancellation, malformed/late acknowledgements, channel loss and uncertain
database outcomes must request exact-tree termination immediately and drain all
pending operations before accepting sealed descendant-empty closure.

Restricted native write authority, real provisioner transport, native watchdog,
Git execution, independent success verification, gap-free hold conversion and
retired-owner recovery are separate unfinished boundaries. Neither this API nor
its synthetic tests enables those effects.
