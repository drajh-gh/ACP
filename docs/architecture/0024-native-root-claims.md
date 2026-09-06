# 0024 — Shared recorded Windows root exclusion

Status: Accepted local storage-only prerequisite, migration0020. Verification
and its limits are recorded in M2; no native consumer is enabled.

## One recorded owner across process classes

Specification 15.2–15.3 and the next M2 prerequisite require worker and provisioner
records not to alias one Windows root. Before0020, worker uniqueness includes the
ACP host label; provisioner uniqueness covers only its attempt. Neither excludes
the other class, another host registration on the same machine, or a rooted stop
recorded before its process journal.

Add an immutable, source-derived `windows_native_root_claims` projection with one
logical owner: a worker `wpr_` identity or provisioner `wpa_` attempt. A unique
index on machine fingerprint, PID and numeric FILETIME is the serialization
boundary. Host labels, boot strings and Windows sessions must not weaken that
key. Keep their exact source metadata and original token spelling. Normalize only
the numeric exclusion key, so legacy leading-zero tokens cannot alias ownership.
Keep the worker's existing bigint PID and 16–20-digit token compatibility; do not
retroactively impose the provisioner's stronger native parser on worker history.

Claims are permanent, including after terminal history. Reuse of a PID with a
different creation token remains distinct. Process plus matching stop produces
one claim. A rooted stop without a process produces the owner's claim; rootless
absence produces none. No losing source insertion or its audit event may survive
a claim collision; the prior owner's history remains intact.

## Derived history, not new runtime authority

Source precedence is the scoped worker process, otherwise its rooted launch stop
joined to the immutable intent; or the provisioner process, otherwise its rooted
stop. After-insert hooks derive claim fields from those exact retained sources.
A claim-table guard independently rejects missing or substituted source identity.
Matching stops must validate the existing claim, not silently ignore a conflict.
Use plain first-owner insertion and a central unique index: a waiting cross-table
existence query is not itself a uniqueness constraint.

Legacy supervised worker rows with NULL scope remain untouched and receive no
claim. Missing scope cannot be inferred from today's host or machine. A future
consumer must require an exact claim and independently verify native identity;
unscoped history remains ineligible for that consumer. Existing native recovery
already returns unconfirmed for such rows. The projection only excludes exact
scoped recorded claims; it does not attest fingerprints or discover OS processes.

Migration locks all four source tables and worker launch intents before backfill.
Both directions use NOWAIT: existing source DML can acquire these tables in a
different order, so a busy migration must fail fast and be explicitly retried
after writers are quiescent instead of entering a lock cycle.
Conflicting retained owners abort upgrade atomically. Downgrade may remove this
derived projection under the same source locks, preserving all original history;
re-upgrade reconstructs it and refuses any conflict admitted while downgraded.

No GO, process creation or termination, recovery ownership, lease renewal, Git
mutation, worktree success, hold release or conversion is introduced. Native
verification and fresh-ACK execution admission remain separate prerequisites.
