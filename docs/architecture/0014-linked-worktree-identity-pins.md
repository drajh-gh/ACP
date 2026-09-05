# 0014 — Standalone linked-worktree identity pins

Status: Accepted native prerequisite. Not connected to delivery admission or the
worker launcher; not a filesystem sandbox or writer-lease grant.

## Retain the observed namespace without freezing Git content

`WindowsLinkedWorktreePins.Open` receives an actual native machine scope and the
retained checkout, common Git directory, linked workspace and linked metadata
directory path/identity pairs. Its constructor is private: no public caller can
create a pinless instance without validation.

The component opens all four directories with the existing read-lease primitive,
checks exact canonical spelling and native volume/file identity, and retains their
ancestor handles. It accepts an ordinary checkout with `.git` metadata and a
separate linked workspace. The linked metadata must be a direct child of the
common directory's `worktrees` directory. It pins and checks the workspace `.git`
pointer plus the linked metadata's `gitdir` and `commondir` pointers as one
consistent forward/reverse/common relationship.

Directory handles do not share deletion. The three bounded, single-link,
non-reparse pointer files share reading only, denying replacement and writes
while held and rejecting pre-existing writers. A failed acquisition closes all
earlier handles before propagating failure. Explicit disposal is idempotent and
attempts every retained close in reverse acquisition order.

HEAD, index, branch refs, objects, reflogs and ordinary working files remain
mutable. This permits Git add/commit while retaining identity; it does not grant
permission for those operations or assert that a particular branch/HEAD is still
the desired candidate. The component has no database, renewal or result effects.

## Limits that must remain explicit

The native directory primitive checks reparse and case-sensitivity metadata when
opening a handle. It does not establish protection against hostile in-place
directory metadata changes after opening. Nor does it freeze Git configuration,
hooks or routing policy: optional `config.worktree` or object `alternates` files
can still be created. Observed absence is not reserved absence.

If the pin owner dies, Windows eventually releases its handles. That is not
evidence that every writer has stopped before release; a job's kill-on-close
behavior does not establish ordering among unrelated process handle closures.
Do not attach this component to the existing worker-job disposal path and infer
that it supplies that missing guarantee.

Delivery still needs a restricted-access/credential boundary, provisioning
reservations, routing/configuration policy, fresh branch/HEAD checks, proven
normal and abrupt writer-stop/pin-release ordering, and explicit transport
admission. Keep the database lease keys reserved until sealed stop and terminal
result evidence independently allow release (ADR0013).

## Evidence

The `filesystem-pins` gate uses actual disposable Unicode Git worktrees and
separately bounded PowerShell pin holders. Five native cases cover:

- retained directory and ancestor rename denial, pointer write/rename denial,
  and ordinary file edit/add/commit with clean Git status while pins remain held;
- wrong-machine and each wrong-directory-identity rejection, followed by
  successful rename/write probes while the rejecting helper remains alive;
- malformed and hardlinked forward/reverse/common pointers, exact fixture
  restoration, and earlier-pointer write probes before the rejecting helper exits;
- pre-existing pointer writers and noncanonical retained path rejection;
- eventual handle release after holder death, and explicit counterexamples to
  any claim that absent optional configuration/routing files are reserved.

All helper launches assert that the native type has no public constructor. The
positive test failed with the implicit public constructor and passed after it
was made private. Helpers remain alive after acquisition rejection so kernel
cleanup at process exit cannot masquerade as correct partial-acquisition cleanup.
The outer gate owns an exact UUID-keyed temporary directory and removes it only
after empty-job accounting plus root exit. These are model-free local probes;
there is no live delivery worker, hostile token or abrupt writer-stop ordering
proof in this suite.
