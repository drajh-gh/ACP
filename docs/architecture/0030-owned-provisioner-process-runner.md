# 0030 — Owned private provisioner process runner

Status: Private, model-free process prerequisite. No production dispatcher,
stored-plan executor, restricted filesystem grant or Git mutation is enabled.

## Original plan, fixed launch

Copy, validate and recursively freeze the complete retained provisioner plan
before any asynchronous operation. Preserve canonical six-digit timestamp
precision and the exact original owner, reservation revision, target, base,
parent observation and common-Git identity. Reuse the selected supported Windows
target spelling and reject inconsistent topology. This snapshot is metadata,
not a fresh authority or a renewed deadline.

The runner constructor fixes the capsule path, PowerShell path, host Node
executable, output bound and observability hook. Each start accepts only the
retained plan and cancellation signal. Require the original planned owner and
250–20000 milliseconds of remaining original budget; recheck cancellation and
deadline after read-only artifact existence checks. Prepare every launch option
and the bounded frame before spawning. Send only derived target/base metadata
to the fixed capsule and use the existing minimal environment allowlist.

Path-value pinning is not file identity/content provenance. The current parent
`stat` is not native identity revalidation, a retained handle or a reparse-point
defense. Parent/common-Git replacement races and restricted write authority must
be closed before selecting a mutating capsule or integrating production dispatch.
The synthetic probe intentionally creates no Git worktree and mutates no target.

## Ownership starts before readiness

Construct `WindowsProvisionerProcessOwner` before spawning, then synchronously
attach the exact child and return its owned handle without awaiting READY. Every
spawned bridge is therefore available for cancellation and cleanup immediately.
Report bridge and validated native-root PIDs with purpose; hook failures cannot
interrupt ownership. Startup silence has a ten-second bound, additionally
capped by the original plan deadline. The independent native bootstrap and
issuance-age watchdog from ADR0027 remains the authority when JS is stalled.

The owner handles pipe errors, bounded stderr, pending write callbacks, abort,
process exit and actual process/pipe close separately. A provisional terminal
frame starts at-most-once drain without another command. Earlier failure sends
one STOP, ends input and starts drain. After at most six seconds, request kill
only on the exact owned child and destroy local pipe endpoints. Do not infer
closure from kill success, process exit or a protocol frame. An OS kill failure
leaves closure unconfirmed and pending until an actual close observation.

Stdout EOF finalizes strict UTF-8/framing once. Missing or truncated terminal
evidence immediately revokes authority while ownership remains pending. Valid
CLOSED followed by EOF retains its provisional evidence, never premature stop
persistence. Data after EOF corrupts evidence. Only child close settles the
channel; first allow queued Node write callbacks an I/O checkpoint, then fail
any remainder. Remove cancellation listeners and clear owned timers on close.

Valid late READY after cancellation supplies exact owned identity for cleanup,
not permission. A pre-aborted controller can then retain a rooted sealed stop
without admitting or attempting GO. The eventual executor must combine caller
cancellation and the channel's internal authority-loss signal.

## Verification boundary

Pure tests cover complete snapshots, timestamp precision, malformed plans,
EOF, delayed close, failed kill, initialization silence, late READY, bounded
stderr and write/listener cleanup. Real Windows phases cover fixed Unicode
input, environment filtering, source/constructor mutation, exact exit code,
pre-spawn rejection, permanent replay denial, cancellation and original expiry.
The short-deadline case proves the combined JS/native boundary; it does not
independently isolate the native deadline watchdog. The earlier native primitive
suite provides separate watchdog evidence. Native runner/controller composition
still uses synthetic admission/journal ports. PostgreSQL composition is next.

Run `provisioner-runner` phases `^provisioner runner core:`,
`^provisioner runner loss:` and `^provisioner runner expiry:` sequentially with
`scripts/check-worker-supervision.ps1`. Each keeps the existing 70-second child
and 90-second outer limits, reports owned PIDs and removes its UUID fixture only
after owned processes have stopped. Current execution evidence is in M2.
