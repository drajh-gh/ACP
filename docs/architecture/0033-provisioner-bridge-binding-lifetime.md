# 0033 — Provisioner bridge binding lifetime

Status: Private native integration for the fixed non-mutating capsule. Does not
activate production provisioning or grant restricted filesystem access.

## Original bindings before native creation

The initial bridge frame now requires `bindings` with exactly `workspacePath`,
`reportedParent` and `commonGitDirectory`. Each directory contains only its
original `path` and native `identity`; the historical parent observation timestamp
is not a native permission. Require the command working directory to equal the
reported parent with ordinal spelling. The fixed TypeScript runner derives all
these fields from its complete frozen original plan, before spawning the bridge.

After exact launch parsing, acquire ADR0032's parent/common-directory pins against
the actual machine scope. This precedes fence consumption and native creation.
Failure to acquire either original identity rejects without a root or consumed
fence. The pin factory disposes earlier acquisitions on rejection. Empty synthetic
common-metadata directories in tests demonstrate identities, not Git validity.

## Stop, seal, then release

Set `creationAttempted` immediately before the fallible native factory call:
that factory can throw after creating a process but before returning its owner.
A null bridge job field is therefore not proof that no root existed. Likewise,
disposing a job object or closing its kill-on-close handle is not a tree-empty
observation.

Only successful native `TerminateAndWait` sets `treeEmptyConfirmed`. Only the
exact root-bound fence's successful `Seal` sets `stopSealed`. Normal cleanup
releases the binding pins after both facts. Before any creation attempt, ordinary
cleanup may release them without those facts. Cleanup independently attempts all
owned disposals even when an earlier disposal throws.

If creation was attempted but either fact remains unknown, retain the pins in a
locked static collection until the dedicated bridge process exits. This prevents
managed garbage collection from releasing them early; it does not prove relative
Windows handle-release and process-tree termination ordering during abrupt exit.
The bridge remains a dedicated-process API, not an in-process reusable service.

The `closed` frame is still provisional. The TypeScript owner and stored-plan
executor must also await the original physical process/pipe closure before
settling a session or recording durable stop evidence. Retaining pins is not a
substitute for sealed rooted evidence, and a blocked seal reports unconfirmed.

## Runtime witnesses and limits

The real native binding phases use the production bridge with actual original
directory observations. A same-assembly test-only observer additionally attempts
ordinary common-directory rename at confirmed tree-empty/pre-seal, post-seal,
and explicit pin disposal. The first two must fail with Windows sharing violation
32; the last must succeed. Its host remains alive after `Run` returns, allowing
external probes to distinguish explicit cleanup from kernel cleanup at exit.
The internal observer is absent from the production host, no public launch field
selects it, and callback exceptions cannot change authority or skip cleanup.
Its extra witness frames are fixture-only, not accepted production protocol.

A separately held fence forces unconfirmed sealing. The same helper remains
alive with pinned common metadata after `Run` returns and releases it only upon
helper exit. Schema, identity, topology, command-workspace and genuine directory
replacement negatives require no READY/output/root/fence consumption and prove
partial-acquisition cleanup while the helper still lives. A deterministic
post-CreateProcess/pre-factory-return failure is not injected: that precise
failure path is source-reviewed only.

Run the exact `provisioner-bridge` phases `^provisioner bridge bindings:`,
`^provisioner bridge bindings-schema:` and `^provisioner bridge bindings-identity:`
sequentially through `scripts/check-worker-supervision.ps1`, alongside the eight
existing raw-bridge phases. Keep the 70-second child and 90-second outer limits;
owned fixtures are removed only after empty-job confirmation. M2 records executed
counts and the accompanying runner/database regression evidence.

## Not a mutating Git boundary

Pins do not reserve target/branch/optional-file absence, freeze Git contents,
configuration, hooks or alternates, authorize parent/common-metadata writes, or
protect against hostile in-place directory metadata conversion. The opaque
`command.input` remains synthetic capsule data; it is not validated Git-operation
authority. A future mutating capsule must consume independently validated exact
operation data and separately establish restricted access, namespace/absence,
Git policy, verification, recovery and gap-free hold conversion. Those boundaries
must precede production Git mutation, not be inferred from this integration.
