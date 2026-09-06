# 0026 — Private one-shot provisioner controller

Status: Locally verified orchestration prerequisite. Native ownership is a
synthetic port in these tests; no actual provisioner or Git mutation is enabled.

## Selected boundary

Consume ADR0025's fresh acknowledgement through one private controller attached
to an already-owned suspended root. Snapshot the original store owner, request
and expected plan. Validate every acknowledgement field against the exact root,
fence, nonce, epoch, original reservation/revision/deadline and provenance.
Compare timestamps at microsecond precision, and verify the integer duration
without rounding the deadline through JavaScript Date.

One session object can be consumed only once, including across controller
instances. The database's no-replay admission and the native permanent fence
separately exclude identity aliases; JavaScript object identity is not an OS
ownership mechanism. Native acceptance must echo the exact request and original
revision. Only then attempt GO once. A throwing GO remains an uncertain attempt,
never permission to retry or evidence of successful work.

Cancellation, closure, malformed or lost acknowledgements and a bounded local
timeout irreversibly remove authority and request termination immediately,
independently of pending database or native operations. Mark termination as
started before invoking the adapter, so synchronous cancellation re-entry cannot
request it twice. Drain the admission, native acceptance and termination calls
before recording a stop. Termination resolution is not closure evidence.

Only an exact rooted, sealed, descendant-empty observation from the owned session
can reach the stop writer. Reject rootless or substituted observations. A failed
or uncertain stop commit retains physical closure as `closed_stop_unconfirmed`;
it does not fabricate a durable receipt. `stop_recorded` reports retained stop
history and whether authority was lost, not worktree success. Invalid request or
expected-plan values still clean up an otherwise well-formed owned session.

## Native obligations and remaining work

The private native port must independently enforce bounded operations and channel
closure, bootstrap and absolute-plan deadlines, challenge-issuance-age monotonic
expiry, one-use GO, permanent sealing and exact tree-empty closure. The local
JavaScript timer is only a backstop; a blocked event loop cannot enforce these
obligations. This decision does not yet implement that port. The future trusted
host must forward later durable cancellation into the controller's abort signal.

There is no process pre-journal, heartbeat renewal, readback repair, recovery,
success, hold release or conversion API here. Original-owner retirement may
prevent stop persistence despite actual closure; a separately fenced recovery
path is still required. Restricted filesystem authority, fixed Git execution,
independent worktree verification and gap-free hold conversion remain unfinished.

## Evidence

Twenty-one focused tests and all 609 sequential local tests pass with strict
TypeScript. A real synchronous re-entry regression first observed two terminate
calls and passes with one after the sentinel correction. Six disposable
PostgreSQL scenarios combine the actual admission/stop stores with a synthetic
native session: committed visibility from another connection before GO, lost
admission acknowledgement, cancellation during admission, lost stop
acknowledgement, cancellation during native acceptance and owner retirement.
They retain the original target hold and all four exclusion keys. Latch tests
release and drain after assertion failure while preserving the primary error.
Independent source and fixture readback found no remaining defects. These are
database/orchestration claims, not native-process or filesystem-sandbox evidence.
