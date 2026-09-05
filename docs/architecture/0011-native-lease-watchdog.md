# 0011 — Native filesystem-lease watchdog

Status: Accepted native prerequisite only. No database controller or delivery wiring.

ADR0010's cooperative scope cannot stop an owned writer while its Node event loop
is paused. This opt-in private Windows bridge protocol adds a native deadline
without giving the native process database credentials or enabling a new launcher.
Existing TypeScript launch requests do not send the new `filesystemLease` field.

At creation, a leased job binds canonical ACP UUIDv4 lease/run/worker identifiers;
the worker ID must name the same kernel-owned job. A 15-second bootstrap budget,
also capped by the persisted run deadline, keeps a never-acknowledged root bounded.
The root remains suspended until the first accepted lease epoch. There is no
post-launch upgrade from an unleased job or switch to another lease identity.

The native bridge issues one nonce and increasing epoch before each database
heartbeat. A future trusted controller must obtain the exact-owner COMMIT ACK
after that challenge, validate immutable lease identity and increasing revision,
then send its duration (database expiry minus heartbeat, at most 20 seconds).
The native deadline is challenge issuance plus duration minus 250 ms, never
arrival plus duration. Startup/IPC/COMMIT latency spends the same budget. A
challenge alone does not renew anything; duplicate requests, stale/replayed ACKs,
changed identities and invalid numeric fields fail closed. The native process
cannot establish from JSON alone that a PostgreSQL ACK actually occurred: that
fact belongs to the trusted daemon and its private, non-inherited control channel.
No public duration-setting API is added to `WindowsWorkerLauncher`.

QPC timing stays entirely native via `Stopwatch.GetTimestamp` and its frequency;
Node's process-relative clock is not compared with it. Lease mode requires a
high-resolution counter. Microsoft documents QPC's monotonic, UTC-independent
behavior and inclusion of standby/hibernate time; the watchdog rechecks its
timestamp after each wake. [Microsoft timing guidance](https://learn.microsoft.com/en-us/windows/win32/sysinfo/acquiring-high-resolution-time-stamps)

One native watchdog thread checks the minimum of the original run deadline and
the current bootstrap/lease deadline at intervals no greater than 100 ms. Renewal,
GO, expiry and stopping share the existing ownership lock; the old deadline is
checked before accepting a replacement. Expiry is irreversible. The watchdog
terminates the kernel-owned tree without waiting on Node, PowerShell control
processing, database access or stdout. If normal bridge cleanup cannot finish,
the existing six-second bridge-exit fallback closes the final job handle. No
priority, CPU-affinity, parent-job or Resource Guard restriction is bypassed.

This is not a filesystem ACL sandbox, a retained native identity pin, a durable
lease admission, a result validator or a release receipt. The existing launch-seal
protocol remains separate and must still precede terminal persistence. The next
controller must bind fresh database renewal to native challenges and quiesce
renewal after owned-tree closure but before the durable stop receipt. Writer
exclusion remains retained until the existing sealed-stop/terminal-run release.

Tests use synthetic runners and private raw frames, not authenticated Codex or
database-derived epochs. The native suite is split into protocol, timed-liveness
and slow bootstrap gates, retaining the existing 70/90-second bounds. A real stalled
Node process uses a non-spinning wait with pipes open; separate probes leave
stdout undrained and confirm native expiry of a live root and detached descendant.
Sleep/hibernate is not exercised on the operator's machine. Late-reply tests prove
no revival after root death; the exact pre-termination old-deadline rejection
branch also has source review, not a separate deterministic runtime probe.

A renewal can race natural root exit before the bridge has reported closure.
The current private protocol conservatively reports failure in that race; the
future controller must not turn it back into a successful result. Clean closure
quiesces without a final native renewal. A typed normal-close transition, if
introduced later, needs separate runtime proof and cannot forgive an earlier
expiry, malformed frame or lost database acknowledgement.
