# 0007 — Immutable host filesystem bindings

Status: Accepted for local implementation; no Git execution is enabled.

Specification 15.2–15.3 and WF-ISSUE require an exact isolated workspace and an
exclusive writer lease. A URL, branch spelling or user-supplied path is not a
repository identity. Existing generic effect leases are insufficient for live
filesystem writers: expiry alone cannot establish that an old process stopped.

The first slice records logical repository IDs and immutable Windows host-local
checkout/common-Git-directory identities, then mission-bound linked-worktree
observations. Each record pins provenance, project/profile context, native
directory identities, branch spelling and exact observed HEAD where applicable.
Database uniqueness prevents aliases for one physical Git common directory or
workspace from becoming independent logical targets. Retirement is append-only
and prevents new child bindings; it neither deletes files nor rewrites history.

These are trusted-host observation records, not execution permission, OS
sandbox proof or evidence that a path still has its observed contents. No
historical candidate is backfilled into authoritative repository configuration.
No existing checkout is registered by the implementation tests. Tests use
synthetic identities in a disposable database.

The Windows read-only observer now supplies native directory observations for
ordinary non-bare checkouts and attached linked worktrees. It pins ancestors and
metadata files, reopens Git-reported directories to compare physical identities,
and rejects case-sensitive directory layouts, reparse points, hardlinked metadata,
unsupported config, includes, separate Git directories and alternate object stores.
Git commands are fixed, bounded and owned as a process tree, with no inherited
credential/config injection and lazy fetching disabled. Observation does not
automatically register a durable binding.

This helper inherits the trusted host's filesystem access; it is **not** an OS
network sandbox. Config/alternate rejection is a bounded supported-layout check,
not protection against a hostile concurrent writer creating new metadata after
an absence check. Directory pins do not freeze all file contents. The observer
must not be treated as a technically enforced operation/resource grant or as
proof that arbitrary untrusted repository metadata cannot access other files.
Production use still needs a trusted host/configuration and revalidation inside
the forthcoming lease and process-isolation boundary. No delivery admission is
enabled by this slice.

Follow-up slices must add revalidation under a renewable workspace lease,
exact stopped-owner release/recovery guards,
and provisioning reservations before enabling Git mutation or delivery admission.
The existing run-owned lease foreign key must not be bypassed by a fabricated
run merely to prepare a worktree. Branch leases must preserve case by digesting
the exact branch reference rather than lowercasing Git branch names.

Windows lexical validation rejects ambiguous path forms, but volume/file identity
and trusted native observation remain necessary. This is not a security boundary
against a hostile same-user administrator. POSIX identity and cross-host/boot
handling require explicit later contracts. Downgrade is allowed only before new
binding history exists; it must not silently remove retained identity fencing.
