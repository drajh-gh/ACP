# 0013 — Private leased-launch channel and persisted target binding

Status: Accepted opt-in launcher prerequisite. Delivery dispatch remains
disconnected; filesystem pinning and restricted-access enforcement are not claimed.

This extends [ADR0012](0012-native-writer-controller.md). The public Windows
launcher may now receive a trusted lease/run/process identity when configured
with a database-bound controller. It still returns only `OwnedWorker`: suspended
root identity, public release, closure and termination. Epoch/challenge/commit
methods are never exposed on that public handle or forwarded to the child.

## Bind the original target before creating a root

A lease identity alone is insufficient. A closed native job disappears before
its durable stop receipt necessarily commits. Reusing the same lease and run
without the original permanent launch seal could then create a second root.
Allowing any new, valid seal directory would recreate the same gap. A valid
lease also must not be paired with a different workspace or a longer deadline.

The original-owner-scoped `loadLaunchBinding` read joins the active lease,
immutable launch intent, started run and retained worktree binding. The controller
requires the exact lease/run/process, original host/session/application, original
fence directory/native identity/scope, declared workspace and persisted deadline.
Missing, unavailable, inactive or mismatched metadata denies launch before spawn.
Request values, nested fence scope and launcher configuration are copied before
asynchronous work so caller mutation cannot substitute a target after validation.

This read is only a metadata comparison. It neither renews the lease nor pins
the workspace. The native permanent fence still consumes the one launch identity.
The initial fresh heartbeat after native challenge issuance still grants the
first epoch; cancellation or revocation between the read and that heartbeat
cannot be healed by the earlier snapshot.

## Keep acknowledgement and ownership ordering private

READY supplies the initial challenge while the root is suspended. Public
`release` starts the controller; only the controller can submit the raw GO after
fresh database and exact native acknowledgements. A single private channel
allows one request at a time, registers its wait before sending, bounds the ACK
wait to three seconds, and settles pending waits on raw bridge closure.
Malformed, unsolicited, duplicate, late or mismatched frames stop ownership.

Public closure is distinct from raw pipe/tree closure. Once release starts,
public closure waits for controller quiescence, including a held database call.
Public termination requests raw stop immediately and then awaits that public
outcome; it must not make the controller wait on its own completion promise.
If the suspended root closes before public release, public closure resolves as
failed without starting database renewal. Unconfirmed native evidence remains
unconfirmed. A failure writing stop to the bridge pipe does not bypass its
independent final-handle-close timeout.

The conservative natural-exit/periodic-ACK race from ADR0011 is unchanged. A
lost or rejected pending ACK does not become successful just because the root
produced output. First-epoch successful-output tests isolate that case with a
five-second cadence; sustained renewal and failure tests use separate short
cadences and explicit ownership assertions.

## Evidence and remaining boundary

Nineteen deterministic channel tests and six added controller preflight tests
cover framing, single-flight operation, deadlines, closure/termination ordering,
original-owner and complete launch-target matching, and mutation/cancellation
across awaits. Seven real Windows cases cover initial ACK loss, suspended public
release, successful Unicode output, pre-release termination, held initial ACK
cleanup, no-spawn target denials, permanent replay denial and caller mutation
(related assertions share cases). Three more native cases cover serial epochs,
periodic ACK loss with detached-child termination, and native old-epoch expiry
during a held database call. These channel cases use synthetic database replies.

The existing 100-check PostgreSQL/native gate additionally verifies the new
real metadata join, exact original-owner filtering, no renewal from readback,
and denial after expiry, retirement, handoff, stop or release. Its native
observer remains read-only. These two evidence sets do not yet establish a
single real PostgreSQL-to-native writer lifecycle.

The next gate must combine actual admitted intent/lease, actual process journal
before GO, fresh committed heartbeats, native closure and quiescence, then
durable stop/result/release in disposable fixtures. Native continuous path pins,
restricted filesystem access, provisioning reservations, recovery and delivery
transport admission remain separate prerequisites. No credentials, model calls,
production deployment, external writes or automatic lease release are introduced.
