# 0018 — Read-only provisioner target observation

Status: Accepted standalone native M2 prerequisite. No provisioner creation,
database-plan consumer, launch, worker admission or filesystem permission.

## Observe the first missing target without inventing a parent

ADR0017 can retain a reported parent and exact base/branch intent, but SQL does
not inspect Windows or Git. This separate observer consumes an existing exact
repository binding and three fields: canonical prospective workspace path,
full `refs/heads/` branch spelling and lowercase 40/64-character base object ID.
First discovery does not accept a caller-authored expected parent identity.
It derives an existing non-root parent, opens its native identity and reports it.
A later database-bound consumer must compare that observation independently.

The only positive result is `state: observed`, `kind: provisioner_target`,
`scope: observation_only`, exact repository/machine/parent bindings, original
target/branch/base, two absence flags and the final observation timestamp.
Strict parsing rejects omitted or unknown fields, authority-shaped additions,
noncanonical paths, contradictory topology and a result that differs from the
request. `unconfirmed` covers unavailable, invalid, cancelled or ambiguous facts.

## Bounded native checks

The helper reopens exact repository identities on the actual machine and uses
the existing narrow supported Git configuration/layout checks. It rejects any
workspace overlapping checkout/common metadata. Its parent must have exact
native path spelling. Directory and ancestor handles request `FILE_LIST_DIRECTORY`
with read/write sharing but no delete sharing; zero-access metadata handles do
not provide the required rename exclusion. This intentionally denies layouts
whose ACLs allow attribute access but not directory listing. Directory pins do
not prevent child creation or content writes.

Only Win32 error 2 for a child of an already opened parent means absence.
Missing parent, access denial, existing file/directory, reparse point or alias
does not. Git validates exact ref syntax and resolves `BASE^{commit}`; output
must equal the supplied full base ID. A tag object's peeled commit, another
object type, missing object or SHA-256 abbreviation cannot substitute.

Branch observation uses sorted, bounded head enumeration twice, with a 201st
item detecting overflow beyond 200. Exact/prefix conflicts are rejected, as are
shared path components that differ only in case before the first genuinely
different component. Native traversal also pins existing loose-ref prefixes,
requires ordinal spelling and rejects dangling refs, prefix files, directories
at the requested leaf and redirection. Present `packed-refs` is a pinned,
single-link, non-reparse regular file bounded to 16 KiB; an initially absent file
is checked again. Unsupported Windows branch components or more than 16 branch
components are rejected, even if another Git filesystem might support them.

Every successful Git read requires empty stderr and exact bounded UTF-8 output;
warnings are not absence evidence. Both output streams have independent 16 KiB
bounds, so long UTF-8 names can reject an inventory below 200 items. The helper
uses minimal environment, no optional locks/hooks/fsmonitor/replacements/lazy
fetch, one shared 16-second Git deadline and an 18-second outer helper limit.
Git children are atomically job-owned. Internal completion/failure paths attempt
whole-tree stop and bounded settlement of both readers, even if a stop call
throws. A positive result requires both confirmations. The 18-second outer
hard stop can interrupt worst-case native deadline/cleanup, and AbortSignal
kills the helper. Those paths return only `unconfirmed` after helper-root close;
they are not independently confirmed descendant-empty stop receipts. Native
job kill-on-close applies, while test fixture cleanup separately waits for all
reported PIDs and the outer gate confirms its owned job is empty. No direct
runtime task-state or before-return descendant-empty claim is made for abort.

## Observation is not provisioning authority

These are sequential observations, not one atomic Git/filesystem snapshot.
Branch enumeration/native branch checks are repeated before the final target
absence check and timestamp, but nothing reserves an absent name. All handles
are released before a positive result reaches TypeScript; later mutation remains possible.
An existing commit is not evidence that project policy selected that base, and
branch syntax/absence is not permission to create it. This is not a hostile
repository-content or restricted-access sandbox.

No plan is persisted here. No fence is created, no hold renewed, no Git write
executed, no worker launched and no success, release, cleanup or conversion
recorded. ADR0017's immutable captured revision and deadline remain unchanged.
Actual parent/common-metadata write authority and a separately journaled,
sealed, recoverable provisioner lifetime remain future contracts.

Native checks use only disposable outer-job-owned Git fixtures. See M2 for
completed evidence. Git semantics follow the official
[ref enumeration](https://git-scm.com/docs/git-for-each-ref) and
[revision parsing](https://git-scm.com/docs/git-rev-parse) contracts; Windows
access/share behavior follows [CreateFile](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew).
