# 0028 — Private native provisioner bridge

Status: Native transport prerequisite. No production dispatcher, database-backed
TypeScript adapter, Git provisioner or restricted filesystem grant is enabled.

## One private owner and permanent fence

The dedicated PowerShell host observes the actual Windows machine/boot/session
scope and runs `WindowsProvisionerBridge`. Its private parent supplies an original
plan, original owner and fixed command. These pipes are not an API for model or
caller-selected commands, and the bridge cannot authenticate a database receipt.
The future trusted adapter must load immutable plan identity from storage and
pin command selection at construction, not accept it from an invocation.

Before creating a root, exclusively open and flush consumption of the separate
WPA fence. Create the already-job-owned suspended root with ADR0027's original
and bootstrap deadlines; append and flush its actual PID, raw FILETIME and UTC7
before READY. Observe directory identity and OS scope natively. Re-open and hold
the exact rooted fence through the single dedicated GO. A competing launcher,
completed replay or seal before GO cannot resume another root.

READY contains the exact attempt/fence/root/challenge admission request. Accept
only the complete sixteen-field fresh acknowledgement: original owner and plan,
claim owner/job name, native fence/root/challenge, canonical UTC6 timestamps and
their exact integer-millisecond duration. Native acceptance still charges delay
from challenge issuance and cannot renew the original deadline. Unknown, missing
or duplicate JSON fields, malformed UTF-8, partial EOF and oversized frames deny.
The input reader bounds unterminated frames without waiting for EOF or a newline.

GO supplies only the already-selected fixed input. Native stdout is bounded and
base64-framed; stderr is bounded and discarded rather than disclosed. A repeated
admission, repeated GO, EOF, stop, protocol error or independent native expiry
requests termination. Root exit alone never substitutes for descendant-empty
job closure. A root that dies before GO is an authority failure, even if its
physical stop is subsequently confirmed.

## Provisional physical evidence, not success

After confirmed job emptiness, re-open the exact fence, compare all retained root
identity fields, durably seal it and read the actual held root exit code. Emit
that rooted stop separately from the top-level `failed` flag. Never replace a
real exit code with a generic failure number. Failure can coexist with valid
physical stop evidence; absence of failure never certifies successful provisioning.

The `closed` frame is deliberately provisional. The future TypeScript session
must await bridge-process **and pipe closure** before exposing it: process disposal
and exit settle remaining control/input/stderr tasks. It must strictly validate
the whole frame, propagate `failed:true` into controller authority loss while
retaining valid stop evidence, and reject missing/malformed/extra terminal data.
No test in this native-only slice claims a public session's quiescence barrier.

A busy/mismatched seal or missing rooted evidence produces `unconfirmed`, not a
manufactured receipt. Abrupt bridge death independently kills its owned tree but
does not create a closure frame. An independent exact-scope seal/stop observation
can establish physical evidence later; database recovery remains separate.

## Verification boundary

Eight exact positive-filter phases cover core transitions, four groups of ACK
substitutions, strict framing, fence races and transport loss. All use synthetic
original plans/receipts and disposable native processes, never PostgreSQL, Git,
credentials or production filesystem permissions. Existing 70/90-second owned-job
limits remain unchanged, with PID reporting and verified process-tree cleanup.

Seal-only tests keep the original suspended root alive; busy-seal tests require
unconfirmed closure before releasing the holder. Competing/replay denials must
occur before the unchanged original deadline. Bridge-loss tests observe a live
descendant before killing its owner and require exact independent sealing after
physical closure. Multi-resource test cleanup attempts every resource without
replacing the primary assertion failure. Execution evidence is recorded in M2.

Next: a bounded private TypeScript session bound to stored original plan identity,
actual PostgreSQL/controller/native ordering tests, then separately restricted
parent/common-Git write authority, fixed operations, independent verification,
gap-free hold conversion and retired-owner recovery. This bridge does not grant
any of those capabilities merely by existing.
