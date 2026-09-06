# 0027 — Native one-shot provisioner admission

Status: Native primitive prerequisite. No production bridge, database consumer,
permanent-seal integration, Git execution or filesystem grant is enabled here.

## One native owner and lifetime lock

Add a disjoint provisioner mode to `WindowsWorkerJob`. Reuse its atomic suspended
CreateProcess job-list ownership, explicit inherited stdio handles, lifetime
lock, KILL_ON_JOB_CLOSE and independent native watchdog. A second wrapper and
watchdog would duplicate the safety-critical deadline/resume/disposal boundary.
Existing plain and renewable filesystem-worker factories retain their behavior.

The new factory requires a canonical UUIDv4 WPA, its exact
`Local\ACP.Provisioner.<wpa>` name, the original positive int32 reservation
revision and an absolute deadline no more than twenty seconds away. Capture QPC
before sampling UTC, then capture original and fifteen-second bootstrap QPC
targets before CreateProcess. Creation delay consumes those targets; arming the
watchdog does not recompute them or observe wall time again. The sampling order
is conservative if the thread is interrupted between clock reads.

Only provisioner mode can issue one random 32-lowercase-hex challenge, with epoch
exactly 1 and a retained native issuance timestamp. Only that attempt, original
revision, nonce and epoch can be accepted once. A duration must be 251..20000ms.
First check the old original/bootstrap deadline; then set accepted expiry to
the earlier of the original QPC target and challenge issuance plus duration minus
250ms. Queue and acknowledgement latency spend the budget. No readback, second
challenge, later revision, replay or renewal can replenish it.

Bootstrap limits the pre-acceptance suspended phase only. A valid acceptance may
outlive bootstrap, but never the original or accepted issuance-age deadline.
This preserves the twenty-second plan bound without silently making all plans
fifteen seconds long.

`GoProvisioner` alone can resume this mode. It consumes GO before ResumeThread;
an uncertain syscall outcome denies authority and requests exact-job termination.
Legacy `Resume`, both filesystem-lease methods, wrong-mode provisioner methods,
second GO and malformed/replayed native terms deny and stop. The shared native
watchdog enforces expiry even when the PowerShell loop or control output stalls,
and exits the dedicated bridge after its existing six-second cleanup grace.

## Deliberately incomplete authority

This typed C# primitive binds attempt, revision, deadline budget and its held
native root. It is not a database authenticator, a complete original-plan parser,
a raw JSON validator, or an execution capability. The separate private transport
must bind reservation/provenance, exact fence and actual OS scope, preserve raw
FILETIME and UTC7, and consume only ADR0026's fresh controller acknowledgement.
It must flush WPA consumption before creation, bind the root before READY, hold
the same fence through GO, and seal exact descendant-empty closure before reporting
a stop. No production caller is wired by this change.

Actual exit codes must be read after confirmed native stop, not invented from a
generic failure frame. Bridge death without valid sealed evidence remains
unconfirmed. Restricted parent/common-Git write authority, fixed Git operations,
independent success verification, retired-owner recovery and gap-free hold
conversion remain later work.

## Verification boundary

The native-only test probe has four required positive-filter phases: core,
modes, expiry and bootstrap. Every phase retains the existing 70-second test and
90-second enclosing owned-job limits. It uses model-free synthetic processes,
no database, no permanent production fence and no filesystem mutation.

Denial tests observe native expiry and root/job emptiness before test cleanup
can supply a missing kill. The stalled-loop test observes a previously live root
and detached descendant both gone while the bridge is still alive, before its
six-second exit grace. A separate blocked-output test checks independent native
stop and bridge exit. Those checks distinguish watchdog action from helper
cleanup. The shared worker and renewable-lease native regressions are required;
final execution evidence is recorded in M2.
