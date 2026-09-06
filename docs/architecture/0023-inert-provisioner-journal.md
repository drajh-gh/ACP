# 0023 — Inert provisioner process and sealed-stop journal

Status: Accepted local storage-only prerequisite, migration 0019. Verification
is tracked in M2. No native launcher, GO acknowledgement, Git mutation or release
is enabled.

## Preserve native claims before execution wiring

Specification 15.2–15.3 requires isolation and exclusive mutable-target ownership.
The immutable attempt in [ADR0017](0017-inert-provisioner-plans.md) and separate
native fence in [ADR0022](0022-native-provisioner-fence.md) need their own durable
process/stop history. They cannot borrow an admitted worker run, worker process
ID or worker launch-stop row: provisioning precedes worker admission.

Two append-only tables retain at most one process claim and one sealed-stop
claim per existing `wpa_` attempt. The stable attempt also determines the permanent
fence key and `Local\ACP.Provisioner.<wpa-id>` job name. No new process ID namespace
is introduced. The private store accepts only exact native root/fence/observation
fields, not caller-selected runtime, provenance, job name or recording time.
SQL derives those fields from the immutable plan and its original runtime.
Each insertion has one atomic, immutable mission event.

These records are trusted producer claims, not independent OS proof. A read-only,
host-scoped single-statement snapshot reports row presence as `unrecorded`,
`process_recorded` or `stop_recorded`. It never reports `running`, `suspended`,
`success`, usable worktree, free target or permission to execute. Plan validity and
journal state remain separate dimensions; a still-current plan does not override
a recorded permanent stop.

## Exact native identity, bounded database time

The native fence records PID, Windows FILETIME creation token and a UTC timestamp
with seven fractional digits. PostgreSQL timestamps retain only microseconds.
The journal therefore stores root start time as canonical UTC7 text, and validates
its exact 100-nanosecond equality to the FILETIME token independently in TypeScript
and SQL using integer Gregorian arithmetic. Native identity never round-trips
through a JavaScript Date or PostgreSQL timestamp. PID and exit code retain signed
32-bit bounds; malformed calendar dates, unsupported ranges, timestamp/token
aliases and a one-tick mismatch are denied.

Temporal admission bounds compare at the database's common microsecond precision:
the root's integer FILETIME quotient must be between plan creation and database
recording time. SQL uses `div`, not ordinary numeric division followed by `floor`:
division may round a large FILETIME value before truncation. Boot scope keeps the
existing native descriptor's canonical UTC-millisecond representation, rather
than inventing extra precision the producer does not retain. It remains a
namespace guard, not independent proof of a kernel boot.

## Original-owner admission and cleanup

Both mutations acquire the existing plan/hold parent-lock chain, the exact
attempt row and a shared lock on the workflow binding consumed by actor validity.
Binding retirement cannot pass through journal COMMIT; a retirement-first caller
must be denied after waiting. Original host/session/application identity must
match the plan, and the existing filesystem observation actor predicate must be
current at insertion and deferred COMMIT.

A new process claim additionally requires the captured hold revision, original
unstarted dispatch owner and immutable plan deadline to remain live. The native
root must not predate the recorded boot or plan creation, or exceed database now
at the respective observable precision. A stop-first record permanently denies
new process admission, including a later call under the same attempt.

A new sealed-stop claim deliberately does not require the plan/hold deadline,
hold revision, cancellation state or repository retirement state to remain live.
Cleanup must remain recordable after execution authority ends. It still requires
the exact original current actor: host draining, workflow-binding retirement,
runtime expiry or owner replacement are not silently treated as recovery authority.
Their future recovery-claim lane remains separate.

Only the actual native vocabulary is accepted:

- Rootless `lost`: `sealed_launch_job_absent` or `sealed_launch_job_empty`.
- Rooted `lost`: `owned_job_and_original_root_absent` or `owned_job_empty`.
- Rooted `terminated`: `exact_owned_tree_terminated` with an exit code.

Every form requires a permanent seal. `unconfirmed` and invented success never
become stop evidence. If a process row exists, the stop must exactly match its
PID/token/UTC7 tuple and native fence identity/scope; rootless absence cannot
erase a journaled root. Without a process row, supported rooted or rootless
observations can preserve the native-create/database-journal gap. Neither form
fabricates a process row or releases the retained hold/exclusion keys.

## History and failure

Exact process/stop replay returns retained history before fresh admission checks,
including after expiry or runtime retirement, but only for the exact original
actor and input terms. Replay never renews, restarts or adds provenance/events.
Both SQL callbacks opt into physical-session containment and always discard their
checked-out connections. A socket error prevents subsequent statements; an
unavailable rollback cannot mask the original failure. Uncertain COMMIT remains
rejected: no callback retry or automatic readback repairs the missing ACK.

Empty-journal downgrade removes only 0019 objects, retaining earlier plans,
holds and exclusion keys. It locks both exact journal tables before testing
emptiness; a concurrent writer's committed history must not disappear between
that test and table removal. Any process or stop history refuses downgrade.

## Unimplemented consumers and safeguards

No native effect is called by this store. The ledger does not validate actual
directory ACLs, pin metadata, establish a suspended root, authorize termination,
send GO, extend a deadline, provision Git, mark success, release a hold or convert
it into a worker lease. Cross-class/global OS-root uniqueness, retirement-safe
recovery claims, fresh-ACK execution admission, restricted parent/common-metadata
write authority and gap-free conversion remain prerequisites before execution
or recovery consumes these records. Native code must independently verify the
exact fence, PID token, job membership and descendant-empty closure before acting.

The focused `ProvisionerJournal` gate has separate core, races, expiry, upgrade
and predecessor-regression phases under the existing 30-second child and
90-second outer bounds. Its synthetic paths/PIDs are recorded claims only; no
such path or process is created. Passing SQL tests is not native lifecycle proof.
