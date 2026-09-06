# 0032 — Standalone provisioner binding identity pins

Status: Standalone native identity-only prerequisite. Not connected to the
provisioner bridge, executor, dispatcher or a mutating capsule.

## Two retained bindings, no target absence promise

`WindowsProvisionerBindingPins.Open` receives actual machine scope, expected
machine, prospective workspace path and the original parent/common-Git path and
native-identity pairs. Only this factory can create an instance. Require exact
canonical non-root path spelling, workspace as a direct child of the parent,
distinct parent/common identities and no workspace/common-Git overlap.

Open parent then common metadata through `WindowsFilesystemReadLease.Directory`.
Compare each returned native volume/file identity and ordinal canonical path to
the retained binding. That existing primitive opens all ancestors, rejects
reparse/case-sensitive directories at acquisition and uses directory-list access
with read/write sharing but no delete sharing. Retain both leases until disposal.
Every acquired lease is owned before comparing its identity, so later rejection
closes earlier handles. Serialize disposal, close in reverse order, attempt every
close and make repeated disposal inert.

The exact claim is deliberately narrow: identities match at acquisition, and
ordinary rename/delete operations on those directory objects and opened ancestors
are excluded by their Windows sharing while the pins remain held. This is not
unconditional protection against namespace redirection. In particular, write
sharing and acquisition-time reparse checks do not establish protection against
hostile in-place directory metadata conversion after acquisition.

Do not inspect or claim the workspace child's absence. An already-existing file
or directory at that path is acceptable to this identity-only primitive, and
creating the target while pins are held remains possible. Common-Git content,
configuration, packed refs, hooks, objects and optional redirection files are
neither pinned nor authorized. No Git command or branch/base check is performed.
“Pre-create” describes its intended lifecycle position, not an absence finding.

## Evidence and release boundary

The `provisioner-pins` core/rejection phases use disposable Unicode directories,
actual native machine/directory observations and bounded hidden pin helpers.
The helper stays alive after rejection or explicit release. Successful rename
probes plus liveness assertions afterward establish partial-acquisition and
explicit-disposal behavior without crediting kernel cleanup at process exit.
A C# test helper invokes sixteen concurrent Dispose calls; separate probes
demonstrate eventual release after holder death without claiming writer-stop
ordering. Constructor reflection rejects an ordinary public bypass constructor.

Core probes exercise held rename/delete denial, post-release rename/delete,
target creation, metadata creation/rewrite, and existing file/directory targets.
Rejection probes cover wrong machine/identities, missing paths, ordinal case
aliases, noncanonical spelling, reparse aliases, direct-parent mismatch and
overlap. Related assertions share native cases; M2 records executed counts.

Run both phases sequentially with `scripts/check-worker-supervision.ps1 -Suite
provisioner-pins -TestNamePattern '^provisioner pins core:'`, then substitute
`^provisioner pins rejection:`. The 20-second helper, 70-second test child and
90-second outer job bounds remain explicit. Only exact owned UUID fixtures are
removed after empty-job verification.

## Not yet safe provisioning

Next separately bind these exact inputs into the private bridge and prove normal
pin retention through native tree termination and sealing. Abrupt owner death
can release directory and job handles without a proven relative ordering; this
standalone helper-death test does not close that gap. Target/branch/optional-file
absence, hostile in-place directory metadata changes, restricted parent and
common-metadata write authority, fixed Git operations, independent verification,
hold conversion and recovery remain separate activation requirements.
