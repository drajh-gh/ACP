# 0010 — Cooperative filesystem writer renewal

Status: Accepted as a pre-stop-receipt prerequisite. No delivery admission.

Specification 15.2–15.3 requires owned, renewable, recoverable exclusion. ADR0008
provides durable exclusion and ADR0009 a one-shot native observation. The next
consumer runs a trusted, bounded callback inside serial owner renewals. It loads
an existing lease, checks its exact original runtime, and requires an initial ACK
before entering the callback. No caller-provided path or branch is admitted.

Every ACK must advance the revision without changing the immutable ownership,
run, process, binding or canonical exclusion keys. A monotonic watchdog uses the
database expiry-minus-heartbeat duration (at most 20 seconds), subtracts the whole
request elapsed time and reserves 250 ms. The old watchdog remains armed during
renewal; even a successful late ACK cannot revive an expired or cancelled scope.
Periodic renewals are serial, normally one second apart and earlier for a short
remaining budget. The final ACK waits for any pending periodic transaction.

On callback settlement, new periodic work stops. A completed value is withheld
unless pending renewal and a final fresh ACK both succeed. Cancellation, an
uncertain ACK, identity drift, callback failure or an invalid monotonic clock
permanently fails that invocation. Callback/helper cleanup and outstanding store
calls are awaited; no promise race detaches them. Callbacks must implement bounded
cooperative cleanup, and database pools must retain connection/query timeouts.
The frozen initial snapshot and returned value are historical evidence, not live
handles, deadlines or permissions. Nothing here reserves, reacquires or releases.

The scope must end **before** `finishOwnedLaunch`: a durable stop receipt makes
`filesystem_writer_owner_valid` false by design. A future supervised transport
must quiesce this scope after exact owned-tree closure and before recording that
receipt. Database exclusion remains retained through later manager result
validation and terminal persistence. Only the existing sealed-stop plus terminal-
run release path can free those keys; heartbeat expiry never does.

This JavaScript scope is not OS enforcement. Its abort signal cannot run during a
paused Node event loop. Existing native worker supervision enforces the run
deadline, not renewable filesystem-lease epochs. An independent native renewable
watchdog, continuously held native identities, technical write isolation and an
exact launch lifecycle integration remain required before enabling delivery.
The scope also is not a mutex for duplicate same-owner callers. Native launch
identity and the trusted supervisor must continue providing that separate fence.
No current launcher or manager consumes this scope, and no authenticated worker,
Git mutation, live credential or deployment is enabled by this change.
