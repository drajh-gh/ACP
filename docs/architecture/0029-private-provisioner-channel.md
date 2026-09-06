# 0029 — Exact private provisioner session channel

Status: Pure TypeScript channel/controller prerequisite. No process wrapper,
stored-plan executor or production provisioner is enabled by this change.

## Exact bounded private IPC

`WindowsProvisionerChannel` snapshots its original WPA, expected plan, owner,
fence plan, machine identity and I/O methods. READY must match that binding and
retain actual directory identity, boot/session scope, PID, raw FILETIME and UTC7.
The session exposes only one exact admission, one parameterless GO and termination.
No caller-selected command or operation is accepted by the session.

Share complete ACK and expected-plan normalization with ADR0026's controller to
avoid two drifting interpretations. Register the native acceptance wait before
sending. Match every returned attempt/fence/root/challenge/revision field; consume
GO before sending it. Repeated or unsolicited transitions cannot revive authority.
The acceptance wait is bounded to at most five seconds, default three seconds.
This is a local IPC bound, not replacement native issuance-age or plan authority.

Extract the existing manifest parser's duplicate-decoded-key scanner into a small
bounded JSON utility. Preserve manifest behavior and its 262144-byte, depth-32,
10000-node limits. Native frames instead require canonical safe integer tokens,
65536-byte frames, depth 12 and 1000 nodes. Reject rounding aliases, exponent or
decimal spellings, negative zero and escaped duplicate keys before interpretation.
Fatal streaming UTF-8, bounded unterminated buffering and a 4096-frame cap prevent
replacement-character acceptance and unbounded frame accumulation. Coalesced
frames and split Unicode sequences remain supported.

OUTPUT is legal only after GO, has canonical base64 encoding, at most 8192
decoded bytes per frame, and a constructor-pinned total limit at most one MiB.
Output remains private and unavailable until physically closed rooted evidence
exists. Neither the bytes nor a zero exit code establish provisioning success.

## Two independent obligations at closure

A valid native CLOSED frame retains exact rooted, sealed, terminated evidence
but does not settle `session.closed`. Only `transportClosed`, called by the future
wrapper on the child's actual **close** event after process and pipes settle, can
resolve that promise. Missing, malformed, substituted or trailing terminal data
invalidates evidence. A nonzero bridge exit cannot leave authority intact, but
does not discard otherwise valid physical stop evidence.

The channel owns an internal AbortSignal. `failed:true`, protocol loss, transport
failure or cancellation aborts it synchronously before closure settles. The future
executor must combine it with the caller signal in `controller.run`; otherwise
post-GO native failures would be lost. Mark terminal state before abort listeners
can re-enter termination. The existing controller still owns pending database
drain and durable stop persistence, without a cycle through its own completion.

Wire shutdown and physical transport cleanup are separate. Every provisional
terminal starts the I/O owner's at-most-once bounded drain hook with
`sendStop:false`; earlier failure requests the same hook with `sendStop:true`.
A terminal frame forbids another wire command, not a cleanup timer. The future
wrapper must implement a graceful-close/owned-kill bound even when the bridge
emits terminal evidence but never closes its pipes. The pure channel cannot
fabricate physical closure or implement that operating-system cleanup itself.

Cancellation rejects an outstanding acceptance promptly. If its one known ACK
arrives later, validate and drain it once without restoring GO. This preserves
subsequent valid physical stop evidence. Unsolicited, wrong or repeated late ACKs
still invalidate the protocol. All failure state is sticky.

## Verification boundary and next integration

Synthetic channel/controller tests separate provisional messages, physical close,
pending admission and durable stop writes. They cover split/invalid/truncated
UTF-8, strict frames/numbers, identity substitution, timeout, synchronous replies,
re-entry, one-shot GO, late ACK drain and retained failure evidence. Latch fixtures
drain the controller even when an assertion fails. Parser and manifest regressions
guard extraction compatibility. Actual execution counts and RED/GREEN evidence
are recorded in M2.

Next add the real bounded process wrapper, constructor-pinned fixed runner and
one stored-plan load per `{attemptId, signal}` invocation. Reject missing,
recovering, cancelled, expired or foreign-owner plans before spawning; planned
state remains an inert prefilter, never GO authority. Then prove actual
PostgreSQL/controller/native ordering before implementing separately restricted
filesystem authority, Git operations, verification, hold conversion and recovery.
