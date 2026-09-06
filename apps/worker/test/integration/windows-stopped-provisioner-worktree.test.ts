import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { observeWindowsStoppedProvisionerWorktree, observeWindowsWorktree } from "../../src/windows-repository-observer.ts";
import { provisionerFixture, metadataSnapshot } from "./provisioner-observation-fixture.ts";
import { StoppedProvisionerWorktreeVerifier, windowsStoppedProvisionerWorktreeObserver } from "../../src/stopped-provisioner-worktree-verifier.ts";
import { nativeProvisionerRunnerProbe, syntheticProvisionerAck } from "./native-provisioner-runner-probe.ts";
import { utc6 } from "../provisioner-plan-fixture.ts";

const settings = { skip: process.platform !== "win32", timeout: 30000 }, unconfirmed = { state: "unconfirmed" };
async function rewritePointer(path: string, value: string | Buffer) {
  // Git marks .git hidden on Windows; opening an existing hidden file with 'w'
  // can fail before the intended pointer fault. No attribute or ACL relaxation.
  const handle = await open(path, "r+");
  try { await handle.writeFile(value); await handle.truncate(Buffer.byteLength(value)); }
  finally { await handle.close(); }
}
async function fixture(format: "sha1" | "sha256" = "sha1") {
  const f = await provisionerFixture(format);
  try {
    const target = await f.observe();
    assert.equal(target.state, "observed"); if (target.state !== "observed") assert.fail("fixture parent unavailable");
    // Deliberate disposable fixture setup, not production provisioner execution.
    await f.git(f.checkout, "worktree", "add", "-b", f.input.branchRef.slice(11), f.input.workspacePath, f.input.baseRevision);
    const parent = target.parent;
    const observe = () => observeWindowsStoppedProvisionerWorktree(f.repository, f.input.workspacePath, parent, f.signal(), f.options);
    return { ...f, parentBinding: parent, parentObservedAt: target.observedAt, read: observe };
  } catch (error) { await f.dispose(); throw error; }
}

for (const format of ["sha1", "sha256"] as const) {
  it(`poststop core: exact Unicode ${format} linked worktree returns detached native identities without writes`, settings, async () => {
    const f = await fixture(format);
    try {
      const before = await metadataSnapshot(f.repository.commonGitDirectory.path), result = await f.read();
      assert.equal(result.state, "observed"); if (result.state !== "observed") assert.fail("native worktree unavailable");
      assert.equal(result.scope, "observation_only"); assert.deepEqual(result.checkout, f.repository.checkout);
      assert.deepEqual(result.commonGitDirectory, f.repository.commonGitDirectory); assert.deepEqual(result.parent, f.parentBinding);
      assert.equal(result.workspace.path, f.input.workspacePath); assert.equal(result.branchRef, f.input.branchRef);
      assert.equal(result.headRevision, f.input.baseRevision); assert.equal(result.headRevision.length, format === "sha1" ? 40 : 64);
      assert.deepEqual(await metadataSnapshot(f.repository.commonGitDirectory.path), before);
    } finally { await f.dispose(); }
  });
}

it("poststop identity: a replaced parent cannot hide behind the original moved-back worktree identity", settings, async () => {
  const f = await fixture();
  try {
    const original = await f.read(); assert.equal(original.state, "observed");
    if (original.state !== "observed") assert.fail("initial worktree unavailable");
    await rename(f.parent, f.parent + "-old"); await mkdir(f.parent);
    await rename(join(f.parent + "-old", "FutureCase"), f.input.workspacePath);
    const legacy = await observeWindowsWorktree(f.repository, f.input.workspacePath, f.signal(), f.options);
    assert.equal(legacy.state, "confirmed"); if (legacy.state !== "confirmed") assert.fail("legacy observer should still see moved-back workspace");
    assert.equal(legacy.workspace.identity, original.workspace.identity, "same workspace is insufficient to preserve original parent identity");
    assert.deepEqual(await f.read(), unconfirmed);
  } finally { await f.dispose(); }
});

it("poststop identity: case-only aliases of original parent, repository, common metadata and workspace deny", settings, async () => {
  const f = await fixture();
  try {
    for (const [repository, workspace, parent] of [
      [f.repository, f.input.workspacePath, { ...f.parentBinding, path: f.parentBinding.path.toUpperCase() }],
      [{ ...f.repository, checkout: { ...f.repository.checkout, path: f.repository.checkout.path.toUpperCase() } }, f.input.workspacePath, f.parentBinding],
      [{ ...f.repository, commonGitDirectory: { ...f.repository.commonGitDirectory, path: f.repository.commonGitDirectory.path.toUpperCase() } }, f.input.workspacePath, f.parentBinding],
      [f.repository, join(f.parent, "futurecase"), f.parentBinding],
    ] as const) assert.deepEqual(await observeWindowsStoppedProvisionerWorktree(repository, workspace, parent, f.signal(), f.options), unconfirmed);
    assert.equal((await f.read()).state, "observed");
  } finally { await f.dispose(); }
});

it("poststop metadata: case-alias pointer destinations fail without modifying metadata during observation", settings, async () => {
  const f = await fixture();
  try {
    const original = await f.read(); assert.equal(original.state, "observed");
    if (original.state !== "observed") assert.fail("initial worktree unavailable");
    for (const [path, changed] of [
      [join(f.input.workspacePath, ".git"), "gitdir: " + original.gitDirectory.path.toUpperCase().replaceAll("\\", "/") + "\n"],
      [join(original.gitDirectory.path, "gitdir"), join(f.input.workspacePath, ".git").toUpperCase().replaceAll("\\", "/") + "\n"],
      [join(original.gitDirectory.path, "commondir"), f.repository.commonGitDirectory.path.toUpperCase().replaceAll("\\", "/") + "\n"],
    ]) {
      assert.ok(path && changed); const before = await readFile(path);
      try { await rewritePointer(path, changed); assert.deepEqual(await f.read(), unconfirmed); }
      finally { await rewritePointer(path, before); }
    }
    assert.equal((await f.read()).state, "observed");
  } finally { await f.dispose(); }
});

it("poststop metadata: detached HEAD and ambiguous HEAD warnings never become positive observations", settings, async () => {
  const f = await fixture();
  try {
    await f.git(f.input.workspacePath, "checkout", "--detach", f.input.baseRevision);
    assert.deepEqual(await f.read(), unconfirmed);
    await f.git(f.input.workspacePath, "checkout", f.input.branchRef.slice(11));
    await writeFile(join(f.repository.commonGitDirectory.path, "refs", "heads", "HEAD"), f.input.baseRevision + "\n");
    const before = await metadataSnapshot(f.repository.commonGitDirectory.path);
    assert.equal((await observeWindowsWorktree(f.repository, f.input.workspacePath, f.signal(), f.options)).state, "confirmed",
      "legacy read tolerates the warning, so strict denial cannot be credited to unrelated failure");
    assert.deepEqual(await f.read(), unconfirmed);
    assert.deepEqual(await metadataSnapshot(f.repository.commonGitDirectory.path), before);
  } finally { await f.dispose(); }
});

it("poststop composition: actual sealed native stop precedes verifier reads without creating success or mutating retained history", { ...settings, timeout: 45000 }, async () => {
  const f = await fixture();
  try {
    const p = await nativeProvisionerRunnerProbe();
    try {
      const plan = { ...p.plan, repositoryBindingId: f.repository.repositoryBindingId, repositoryId: f.repository.repositoryId,
        projectId: f.repository.projectId, commonGitDirectory: f.repository.commonGitDirectory,
        workspacePath: f.input.workspacePath, branchRef: f.input.branchRef, baseRevision: f.input.baseRevision,
        reportedParent: { ...f.parentBinding, observedAt: utc6(Date.parse(f.parentObservedAt)) } };
      // This real native capsule only echoes input. Git creation happened in
      // disposable fixture setup; the stop cannot prove who created the worktree.
      const handle = await p.start(plan), session = await handle.ready;
      await session.acceptAdmission(syntheticProvisionerAck(session.request, plan)); session.go();
      const nativeStop = await handle.closed; await p.cleanup();
      const receipt = { hostIdentifier: plan.hostIdentifier, ownerSessionId: plan.ownerSessionId, applicationVersion: plan.applicationVersion,
        provenanceId: plan.provenanceId, treeIdentifier: `Local\\ACP.Provisioner.${plan.attemptId}`, recordedAt: utc6(Date.now()) };
      const stopped = { ...nativeStop, ...receipt };
      const process = { attemptId: plan.attemptId, fence: session.request.fence, root: session.request.root, ...receipt };
      const history = { attemptId: plan.attemptId, state: "stop_recorded" as const, process, stop: stopped };
      let retainedPlan = { ...plan, state: "recovering" as const }, reads = 0;
      const observer = windowsStoppedProvisionerWorktreeObserver(f.options);
      const verifier = new StoppedProvisionerWorktreeVerifier(
        { authority: p.authority, async load() { return retainedPlan; } },
        { authority: p.authority, async load() { return history; } },
        { authority: p.authority, async loadRepository() { return { binding: f.repository, retired: false }; } },
        { async observe(...args) { reads++; assert.deepEqual(await handle.closed, nativeStop); return observer.observe(...args); } });
      const before = await metadataSnapshot(f.repository.commonGitDirectory.path), retained = JSON.stringify({ plan, history });
      const result = await verifier.verify({ attemptId: plan.attemptId, signal: f.signal() });
      assert.equal(result.state, "observed"); if (result.state !== "observed") assert.fail("stopped native composition unavailable");
      assert.deepEqual(result.stop, stopped); assert.equal(result.scope, "observation_only"); assert.equal(reads, 1);
      for (const change of [{ branchRef: "refs/heads/Feature/Different" }, { baseRevision: "c".repeat(40) }]) {
        retainedPlan = { ...plan, ...change, state: "recovering" };
        assert.deepEqual(await verifier.verify({ attemptId: plan.attemptId, signal: f.signal() }), unconfirmed);
      }
      assert.equal(reads, 3); assert.equal(JSON.stringify({ plan, history }), retained);
      assert.deepEqual(await metadataSnapshot(f.repository.commonGitDirectory.path), before);
      assert.equal("success" in result, false); assert.equal("worktreeBindingId" in result, false);
    } finally { await p.cleanup(); }
  } finally { await f.dispose(); }
});
