# 0012 — Database-bound native writer epochs

Status: Accepted private controller prerequisite. No public launcher or delivery
transport wiring; no filesystem isolation claim.

The subsequent opt-in public launcher channel and persisted target preflight are
specified in [ADR0013](0013-private-native-lease-channel.md). The scope and evidence
below describe the original standalone controller checkpoint.

ADR0011 supplies a native clock and an independently enforced deadline. Its raw
frames cannot prove a database commit. `NativeFilesystemWriterController` supplies
the trusted ordering contract over an internal, already-suspended native session:

1. Bind the exact lease/run/process IDs and the store's original host/session/
   application identity. A historical load is only the immutable comparison base.
2. Use the initial native challenge, or obtain a fresh subsequent challenge.
3. Obtain a **new committed** owner heartbeat and validate every immutable field,
   a strictly increasing revision, and a finite duration greater than 250 ms and
   no greater than 20 seconds.
4. Submit that challenge, exact identity, revision and database-derived duration;
   await a matching native acceptance before GO or scheduling the next renewal.

The entire challenge/heartbeat/acceptance chain is serial. No caller supplies a
deadline or cached duration. Native challenge issuance precedes database access;
the native watchdog alone charges issuance/IPC/commit age and rejects renewal
past the old epoch. A local timer schedules attempts, not authority. No Node/QPC
clock conversion or receipt-time deadline is introduced.

`run` takes ownership of the supplied session's lifecycle immediately. Closure
and abort observers are attached before the first await, including lease load.
Validation failure and cancellation therefore stop an already-created root.
Stop requests do not wait for a blocked database or native acknowledgement.
The private port must bound IPC waits, settle them when its bridge closes, and
provide exact owned-tree closure or reject; the store already bounds database
connection/query operations. The controller awaits these operations and owned
cleanup instead of detaching a transaction or treating an aborted promise as
process-stop evidence.

Confirmed native closure stops scheduling. A pending database ACK is still
validated and awaited, but its unsent native commit is suppressed. A pending
native rejection remains conservative authority loss, including the existing
natural-root-exit race described in ADR0011. No final database/native renewal
occurs after closure. Only the quiescent return permits a future transport to
attempt its separately authorized durable launch-stop write.

The outcome deliberately separates `state: closed` and exact native exit data
from `authorityLost`. The latter is false only after initial database/native
acceptance and successful submission of GO, without subsequent uncertainty.
It is computed after pending operations settle, so late errors cannot promote
output to success. A malformed/rejected `session.closed` remains `unconfirmed`
even if `terminate()` returns an apparent success. A closed outcome is neither a
validated worker result nor a persisted seal receipt. Existing transport/manager
checks must still require the appropriate native seal, persist stop, validate
output and actual HEAD, and commit the terminal result before releasing exclusion.

The controller has only store load/heartbeat access. It cannot reserve, release,
retire, record a stop, or complete a run. Its raw native port is an internal
trusted dependency, not a field on the public `OwnedWorker` or model input.
The current public Windows launcher does not construct this port. Native path
pins, restricted filesystem access, provisioning and actual delivery admission
remain independent prerequisites.

The first feedback loop proved the four absent lifecycle behaviors red and then
green. Twenty-six deterministic local cases now cover exact ordering, all
immutable fields, serial epochs, identity/revision/budget rejection, cancellation
at each await, immediate stop during blocked calls, no final renewal, clean-close
quiescence, pending failures, malformed stop evidence and original-owner pinning.
Their stores and native sessions are test doubles. They do not establish real
PostgreSQL-to-native wiring, authenticated model execution, or production IPC
cleanup; those need the next private channel and synthetic integration slice.
