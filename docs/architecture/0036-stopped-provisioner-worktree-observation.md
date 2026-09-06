# 0036 — Read-only stopped provisioner worktree observation

Status: Implemented private historical verifier and strict native metadata reader.
No successful-creation receipt, registration, hold conversion or execution grant.

## Original history before filesystem observation

Specification §§15.2–15.4 and §20.1 require an isolated writable delivery worktree;
the target-hold contract (ADR0015) additionally requires independent verification
of actual output identities after native stop. Stopping a process does not prove
it created the expected worktree, or grant permission to release exclusion.

`StoppedProvisionerWorktreeVerifier` accepts only an attempt ID and cancellation
signal. Its constructor captures exact read-only plan, journal, repository and
observer methods. Store ports must agree on their reader authority. Each invocation
loads and detaches the original plan once, then requires the complete retained
process and rooted sealed-stop records, then loads the exact recorded repository,
and only then invokes the native metadata observer. There are no writes or retries.

Both receipts must match the plan's original host/session/version, provenance,
attempt, fence namespace/directory, native machine and permanent tree identifier.
The process and stop must agree on the complete fence/scope and PID/FILETIME root.
Rootless, missing, malformed or contradictory history returns `unconfirmed` before
filesystem access. Canonical receipt timestamps are validated, not compared across
different process/database clock precision to invent an ordering proof.

Historical inspection can use a replacement reader session on the same host.
An expired or recovering plan and a retired repository binding remain inspectable;
their recorded state is retained in the result. Original receipt ownership is not
rewritten to the replacement reader. This is not current-owner authorization,
freshness assessment, atomic multi-store status, or a recovery claim.

## Separate strict native operation

`provisioner_worktree` preserves existing repository/worktree reader behavior.
It pins and compares the original parent identity before opening the workspace.
It requires the exact canonical spelling of the original checkout, common Git
directory, parent and direct-child workspace. Actual linked-worktree metadata
must be a direct child of the common directory's `worktrees` directory, with five
distinct native directory identities. Aliases, overlap and substitutions deny.

Forward `.git`, reverse `gitdir`, and `commondir` destinations must agree with
those exact paths after legitimate relative/separator normalization. Native opens
and Git plumbing must independently agree. The strict operation requires empty
Git stderr, a valid attached branch, and a complete 40- or 64-character commit ID.
The TypeScript parser independently validates the bounded exact output shape and
bindings; the verifier additionally compares branch and HEAD with the stored plan.

The operation reuses the existing configuration allowlist, optional-metadata
checks, pointer/configuration file pins, owned Git jobs and shared 16-second Git
deadline under an 18-second helper bound. No shell command or Git arguments come
from the caller. Cancellation waits for each pending read/helper to settle; no
late result is returned after cancellation.

## Output is evidence, never permission

Success has `kind: stopped_provisioner_worktree` and `scope: observation_only`,
with the detached original attempt, stop receipt, recorded repository/retired
flag and strict native observation. Descriptor-only JSON snapshots bound each
source and the composed result to 65,536 encoded bytes; native output is separately
bounded to 32 KiB. The returned evidence is deeply frozen. Private errors, unknown
fields, unsafe object shapes, limits and mismatches produce one generic
`unconfirmed` result, without a partial snapshot or automatic retry.

A rooted lost/nonzero stop can still have matching metadata; its original outcome
is preserved rather than upgraded to successful creation. The reader does not
verify checkout file contents or index completeness, prove this attempt created
the workspace, retain pins after return, or provide a filesystem sandbox. It
does not reserve absence, solve abrupt-exit pin ordering, establish restricted
parent/common-metadata write authority, register a worktree, convert or release
a hold, or emit a success receipt. Those remain separate prerequisites.

## Local evidence

Thirteen unit cases cover exact historical composition, replacement readers,
rooted stop requirements, all original identity relationships, detached snapshots,
bounded unsafe-object rejection and cancellation drainage at each pending port.
The initial positive contract failed against the deliberately unimplemented seam.

Seven real Windows tests run in four exact `provisioner-verification` phases:
`^poststop core:`, `^poststop identity:`, `^poststop metadata:` and
`^poststop composition:`. They exercise Unicode SHA-1/SHA-256 repositories,
unchanged metadata hashes, replacement-parent and case-only aliases, contradictory
pointer spellings, detached/ambiguous HEAD, and a real native sealed stop followed
by verification. A deliberately ambiguous ref is accepted by the legacy reader
but denied by the new strict reader because Git emits a warning.

The composition uses actual native process/fence closure but synthetic database
ACKs and read-only store ports. Its Git worktree is created by the disposable test
fixture, not by the non-mutating echo capsule. It does not qualify the combined
PostgreSQL-to-native verifier path. The outer gate owns the exact disposable root
and removes it only after the owned job is empty. No live model or external effect.

## Subsequent actual PostgreSQL qualification

`ProvisionerAdmissions native-stopped-worktree` is a separate 45-second child gate
under the existing 90-second outer ownership/cleanup bound, using the seeded schema
through 0021. It creates the linked worktree explicitly before the plan/capsule,
records actual repository identities, and runs the existing executor with real
admission and root-claim commitment before native acceptance/GO. Original physical
close, reported PID absence and native fence sealing precede the durable stop.

Afterward the fixture retires the recorded repository, observes the original
runtime closed, then replaces the same host's current session. The original
session remains in immutable history, not a second current-head row. All three
reader stores use the replacement session and a separate pool with database
transactions read-only by default, asserted on that connection. This is a fixture
configuration, not a new production database-role or authorization mechanism.

The real verifier returns the exact original recovering plan and rooted stop,
retired repository flag, native parent/checkout/common/workspace bindings, branch
and full base. Timestamp comparison uses canonical UTC microseconds rather than
rounding through `Date`. Unknown attempt IDs return unconfirmed before native I/O.
The response has only observation fields. Before/after comparisons retain every
selected attempt/process/admission/stop/root claim, reservation, four exclusion
keys, repository/retirement and mission-event row. No worktree binding or worker
run appears, and common Git metadata hashes remain unchanged. This does not claim
whole-workspace content verification or a production provisioning outcome.
