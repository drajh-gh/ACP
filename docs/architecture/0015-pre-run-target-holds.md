# 0015 — Pre-run target holds

Status: Accepted storage prerequisite. No filesystem mutation, process launch,
release, takeover, conversion or worker admission is enabled by this contract.

## Hold a target before a worker run exists

Specification 5.6 and 15.2–15.4 require isolated workspaces and exclusive,
recoverable writer ownership. Provisioning cannot borrow an admitted worker's
identity: it precedes admission (ADR0007/0008). A `wtr_` reservation therefore
retains prospective workspace and branch intent independently of `worker_runs`.

The exact input is reservation ID, repository binding, mission, node, graph
revision, workspace path, branch ref and provenance. SQL derives the original
runtime, current project/profile, repository/machine identity and exclusion keys.
It also derives the existing selected dispatch run/generation: that request
already exists, but no admitted run or process journal is fabricated.

The mission must be executing; the delivery node can be runnable or prepared
(`running` is set before actual admission). Its current dispatch must remain
assigned to this exact live host/session/application, with an unexpired
delivery/write grant for the exact prospective workspace. Any worker row for
that dispatch, or a started run for that node, denies fresh authority. The retained
graph, current context, cancellation state and repository retirement are checked.
Another otherwise valid same-project host cannot reserve the selected node.

Canonical Windows paths are checked lexically; no native identity is invented
for an absent directory. Branch spelling remains exact and case-sensitive. This
is not Git `check-ref-format`, a base-commit selection, an absence reservation,
or proof that short names, aliases or filesystem state match the intent.

## One exclusion projection across both kinds of owner

Migration 0015 adds a single primary-key projection for target holds and existing
unreleased writer leases. A hold claims logical repository/mission workspace,
physical host/machine/common-Git identity, exact logical repository/branch, and
host/prospective-path keys. Writers project their existing four keys plus the
observed workspace path. Shared common metadata is exclusive even across branches.
The original four writer unique indexes remain in place.

A host-registration advisory lock serializes prospective paths with retained
directory roles. Equal, ancestor and descendant overlap is denied in both
insertion orders, including retired history. A held path cannot subsequently be
registered as a worktree: that requires a future explicit conversion contract.

Projection entries cannot change owners, claim unrelated keys, disappear while
held, or be truncated. Deferred checks require complete projections. Only an
already durably released writer removes its own active keys through the existing
sealed-stop/terminal-result release contract. Migration backfill runs with old
writer and binding mutations locked out. An empty-hold downgrade preserves old
writer history and indexes; any target-hold history refuses downgrade.

## Expiry removes permission, never exclusion

Database time bounds each hold to the earliest of 20 seconds, assignment expiry
and grant expiry. Renewal requires the original dispatch generation and runtime,
and an already expired hold cannot renew. Mission/node/dispatch/assignment locks
precede runtime and repository locks; commit rechecks authority and time.

Exact replay returns retained history without renewal. Lost COMMIT responses are
resolved by that identity, not another acquisition. `held` and `recovering` are
read-time projections; cancellation, retirement, worker admission, generation
change, runtime replacement or expiry preserves all keys. Recovery inventory is
host-scoped, bounded and keyset-paged. Reading an item grants no reclamation right.

## Boundaries still to implement

There is intentionally no release API, even for an apparently unused target.
This slice records no provisioner or evidence that native creation could never
occur. A future provisioner needs its own durable attempt/launch identity,
permanent native fence, bounded deadline, actual process journal, renewable
execution authority and independently confirmed sealed tree stop. Stop alone
does not establish successful worktree creation.

Provisioning success additionally needs exact fresh native output identities,
pointer topology, branch and HEAD evidence. Conversion must atomically retain
exclusion while registering that exact worktree and transferring ownership to
an admitted writer; release-then-reserve is forbidden. Partial creation remains
reconciliation state, not automatic deletion or retry.

The selected assignment is currently immutable and cannot be extended through a
hold heartbeat. No workspace grant is silently broadened into permission to
modify its parent or common Git metadata. Production roots, base/branch policy,
restricted execution and deployment remain separate authority/configuration.

## Verification surface

The focused PostgreSQL phases `core`, `races`, `expiry` and `upgrade` use synthetic
dispatch/process/directory identities in a disposable database; they do not touch
those named filesystem paths. `regression` runs the existing writer suite under
0015. Migration-session checks exercise the actual fifteen migration pairs.
See M2's evidence section for exact completed gate results.
