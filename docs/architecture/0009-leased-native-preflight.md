# 0009 — Lease-aware native worktree preflight

Status: Accepted for one-shot preflight only. No new writer/Git admission.

Specification 15.2–15.3 and ADR0008 require native reobservation inside durable
exclusion. The first consumer loads an existing exact-owner lease and its retained
host-scoped worktree/repository bindings. It does not accept caller-selected paths,
branch references or commits as authority, acquire new leases, or fabricate runs.

Two acknowledged owner heartbeats bracket the native read. The initial heartbeat
must advance the exact immutable lease tuple. A conservative monotonic watchdog
uses the database expiry-minus-heartbeat duration (at most 20 seconds), subtracts
the entire heartbeat request elapsed time, and reserves 250 ms of margin. It does
not assume synchronized database and host wall clocks. A short grant/run deadline
may leave insufficient time; that call fails closed instead of extending the task.

There is no periodic renewal loop in this bounded preflight. The native helper's
16/18-second bound fits the ordinary lease window; slow acknowledgements shorten
that window. Caller abort, elapsed deadline, missing/retired bindings, any uncertain
heartbeat response or any identity mismatch permanently withholds a successful
observation. The watchdog stays armed through the final heartbeat acknowledgement.
A late success cannot revive an aborted call. Native cleanup is awaited, not
abandoned via a promise race. Store calls retain their explicit database bounds;
an in-flight query is awaited and is not presented as cancellable OS work.

Native repository/machine identity is verified by the existing read-only helper.
The consumer compares exact worktree path/native ID, Git metadata path/native ID,
machine fingerprint, case-sensitive branch reference and full HEAD to the retained
binding. The final heartbeat must advance the same original owner tuple before
returning a named observation snapshot.

The snapshot is not a live filesystem handle or launch permission. Native pins
have closed when it returns and files can change afterward. No launcher consumes
this result; a continuous owned-process guard, technical write isolation, renewal-
loss termination, result validation and provisioning reservations remain required.
Failures never release, reacquire or retire a lease. Sealed stop and terminal-run
proof remain the only release path. Synthetic and native tests use disposable
fixtures, not the operator's repository or authenticated model execution.
