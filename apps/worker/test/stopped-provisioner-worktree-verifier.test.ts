import assert from "node:assert/strict";
import { it } from "node:test";
import { createStableId } from "@acp/domain";
import type { ProvisionerJournalSnapshot, ProvisionerProcessRecord, ProvisionerStopRecord, RepositoryBindingInput } from "@acp/storage";
import { StoppedProvisionerWorktreeVerifier } from "../src/stopped-provisioner-worktree-verifier.ts";
import { provisionerPlanFixture, utc6 } from "./provisioner-plan-fixture.ts";
import { parseWindowsStoppedProvisionerWorktreeObservation } from "../src/windows-repository-observer.ts";

function fixture() {
  const base = provisionerPlanFixture();
  const plan = { ...base, state: "recovering" as const, deadlineAt: "2026-09-06T01:00:05.000000Z", createdAt: "2026-09-06T00:59:59.000000Z",
    reportedParent: { ...base.reportedParent, observedAt: "2026-09-06T00:59:58.000000Z" } };
  const authority = { hostIdentifier: plan.hostIdentifier, sessionId: plan.ownerSessionId, applicationVersion: plan.applicationVersion };
  const fence = { ...plan.fencePlan, directoryIdentity: "win32-dir:12345678:0000000000000001",
    scope: { machineFingerprint: plan.machineFingerprint, bootedAt: "2026-09-06T00:00:00.000Z", sessionId: 1 } };
  const root = { processId: 5678, processStartToken: "win32-filetime:134331300001234567", startedAt: "2026-09-06T01:00:00.1234567Z" };
  const receipt = { hostIdentifier: plan.hostIdentifier, ownerSessionId: plan.ownerSessionId, applicationVersion: plan.applicationVersion,
    provenanceId: plan.provenanceId, treeIdentifier: `Local\\ACP.Provisioner.${plan.attemptId}`, recordedAt: utc6(Date.now()) };
  const process: ProvisionerProcessRecord = { attemptId: plan.attemptId, fence, root, ...receipt };
  const stop: ProvisionerStopRecord = { attemptId: plan.attemptId, fence,
    observation: { state: "terminated", sealed: true, reason: "exact_owned_tree_terminated", root, exitCode: 0 }, ...receipt };
  const snapshot: ProvisionerJournalSnapshot = { attemptId: plan.attemptId, state: "stop_recorded", process, stop };
  const repository: RepositoryBindingInput = { repositoryBindingId: plan.repositoryBindingId, repositoryId: plan.repositoryId, projectId: plan.projectId,
    machineFingerprint: plan.machineFingerprint, checkout: { path: "C:\\ACP-repository", identity: "win32-dir:12345678:0000000000000004" },
    commonGitDirectory: plan.commonGitDirectory, observedAt: new Date().toISOString(), provenanceId: createStableId("provenance") };
  const observation = { state: "observed", kind: "provisioner_worktree", scope: "observation_only", machineFingerprint: plan.machineFingerprint,
    checkout: repository.checkout, commonGitDirectory: repository.commonGitDirectory,
    parent: { path: plan.reportedParent.path, identity: plan.reportedParent.identity },
    workspace: { path: plan.workspacePath, identity: "win32-dir:12345678:0000000000000005" },
    gitDirectory: { path: "C:\\ACP-repository\\.git\\worktrees\\FutureCase", identity: "win32-dir:12345678:0000000000000006" },
    branchRef: plan.branchRef, headRevision: plan.baseRevision, observedAt: new Date().toISOString() };
  const events: string[] = [], caller = new AbortController();
  const plans = { authority, async load(id: string) { assert.equal(id, plan.attemptId); events.push("plan"); return plan; } };
  const journal = { authority, async load(id: string) { assert.equal(id, plan.attemptId); events.push("stop"); return snapshot; } };
  const repositories = { authority, async loadRepository(id: string) { assert.equal(id, plan.repositoryBindingId); events.push("repository"); return { binding: repository, retired: false }; } };
  const observer = { async observe(..._args: unknown[]) { events.push("native"); return observation; } };
  return { plan, authority, process, stop, snapshot, repository, observation, events, caller, plans, journal, repositories, observer,
    verifier: () => new StoppedProvisionerWorktreeVerifier(plans, journal, repositories, observer), input: () => ({ attemptId: plan.attemptId, signal: caller.signal }) };
}

it("stopped provisioner verification loads original evidence before native reads and returns observation only", async () => {
  const f = fixture(), result = await f.verifier().verify(f.input());
  assert.deepEqual(f.events, ["plan", "stop", "repository", "native"]);
  assert.equal(result.state, "observed");
  if (result.state !== "observed") assert.fail("expected read-only observation");
  assert.equal(result.scope, "observation_only"); assert.deepEqual(result.attempt, f.plan); assert.deepEqual(result.stop, f.stop);
  assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.attempt.reportedParent), true);
  assert.equal(Object.isFrozen(result.worktree.workspace), true);
  assert.notEqual(result.worktree, f.observation); assert.notEqual(result.stop, f.stop);
});

it("stopped provisioner verification rejects malformed invocation and captures exact read-only ports", async () => {
  const f = fixture(), verifier = f.verifier(); let getters = 0;
  const accessor = Object.defineProperty({ signal: f.caller.signal }, "attemptId", { enumerable: true, get() { getters++; return f.plan.attemptId; } });
  for (const value of [{ ...f.input(), command: "git" }, { ...f.input(), attemptId: createStableId("run") }, { ...f.input(), signal: {} },
    { attemptId: f.plan.attemptId }, Object.create(f.input()) as unknown, accessor, { ...f.input(), [Symbol()]: true }]) await assert.rejects(verifier.verify(value as never));
  assert.equal(getters, 0); assert.deepEqual(f.events, []);
  for (const port of ["journal", "repositories"] as const) {
    const other = { ...f[port], authority: { ...f.authority, sessionId: createStableId("workerHostSession") } };
    assert.throws(() => new StoppedProvisionerWorktreeVerifier(f.plans, port === "journal" ? other as typeof f.journal : f.journal,
      port === "repositories" ? other as typeof f.repositories : f.repositories, f.observer));
  }
  f.plans.load = async () => assert.fail("substituted plan loader"); f.journal.load = async () => assert.fail("substituted journal loader");
  f.repositories.loadRepository = async () => assert.fail("substituted registry loader"); f.observer.observe = async () => assert.fail("substituted observer");
  assert.equal((await verifier.verify(f.input())).state, "observed");
});

it("stopped provisioner verification accepts historical original receipts under a replacement read-only session", async () => {
  const f = fixture(), replacement = { ...f.authority, sessionId: createStableId("workerHostSession"), applicationVersion: "new-reader" };
  f.plans.authority = replacement; f.journal.authority = replacement; f.repositories.authority = replacement;
  f.repositories.loadRepository = async () => ({ binding: f.repository, retired: true });
  const result = await f.verifier().verify(f.input()); assert.equal(result.state, "observed");
  if (result.state !== "observed") assert.fail("historical observation required");
  assert.equal(result.repository.retired, true); assert.equal(result.attempt.ownerSessionId, f.plan.ownerSessionId);
  assert.notEqual(result.attempt.ownerSessionId, replacement.sessionId);
});

it("stopped provisioner verification never converts nonzero or lost rooted stop into successful creation", async () => {
  for (const observation of [
    { state: "terminated", sealed: true, reason: "exact_owned_tree_terminated", root: fixture().process.root, exitCode: 1 },
    { state: "lost", sealed: true, reason: "owned_job_empty", root: fixture().process.root },
  ]) {
    const f = fixture(); Object.assign(f.stop, { observation });
    const result = await f.verifier().verify(f.input()); assert.equal(result.state, "observed");
    if (result.state !== "observed") assert.fail("read-only metadata may exist after an unsuccessful writer");
    assert.deepEqual(result.stop.observation, observation); assert.equal("success" in result, false);
  }
});

it("stopped provisioner verification rejects absent, extra, foreign and accessor-backed plans before journal/native reads", async () => {
  for (const change of [undefined, { attemptId: createStableId("worktreeProvisionerAttempt") }, { hostIdentifier: "other-host" },
    { deadlineAt: "not-a-time" }, { authorityGranted: true }]) {
    const f = fixture(); f.plans.load = async () => change === undefined ? undefined as never : { ...f.plan, ...change } as typeof f.plan;
    assert.deepEqual(await f.verifier().verify(f.input()), { state: "unconfirmed" }); assert.deepEqual(f.events, []);
  }
  const f = fixture(); let calls = 0;
  Object.defineProperty(f.plan, "branchRef", { enumerable: true, get() { calls++; return "refs/heads/private"; } });
  assert.deepEqual(await f.verifier().verify(f.input()), { state: "unconfirmed" }); assert.equal(calls, 0); assert.deepEqual(f.events, ["plan"]);
});

it("stopped provisioner verification requires complete rooted stop history before repository/native reads", async () => {
  for (const change of [undefined, { state: "unrecorded" }, { process: undefined }, { stop: undefined }, { attemptId: createStableId("worktreeProvisionerAttempt") },
    { privateField: true }]) {
    const f = fixture(); f.journal.load = async () => change === undefined ? undefined as never : { ...f.snapshot, ...change } as ProvisionerJournalSnapshot;
    assert.deepEqual(await f.verifier().verify(f.input()), { state: "unconfirmed" }); assert.deepEqual(f.events, ["plan"]);
  }
  const f = fixture(); Object.assign(f.stop, { observation: { state: "lost", sealed: true, reason: "sealed_launch_job_absent" } });
  assert.deepEqual(await f.verifier().verify(f.input()), { state: "unconfirmed" }); assert.deepEqual(f.events, ["plan", "stop"]);
});

it("stopped provisioner verification preserves its detached original plan across later source mutation", async () => {
  const f = fixture(), originalBase = f.plan.baseRevision;
  f.journal.load = async () => { Object.assign(f.plan, { baseRevision: "c".repeat(40) }); return f.snapshot; };
  const result = await f.verifier().verify(f.input()); assert.equal(result.state, "observed");
  if (result.state !== "observed") assert.fail("detached original plan required");
  assert.equal(result.attempt.baseRevision, originalBase); assert.equal(result.worktree.headRevision, originalBase);
  Object.assign(f.observation.workspace, { identity: "win32-dir:12345678:0000000000000009" });
  assert.notEqual(result.worktree.workspace.identity, f.observation.workspace.identity);
});

it("stopped provisioner verification rejects every substituted original journal identity before native reads", async () => {
  for (const record of ["process", "stop"] as const) for (const changed of [
    { attemptId: createStableId("worktreeProvisionerAttempt") }, { hostIdentifier: "other-host" }, { ownerSessionId: createStableId("workerHostSession") },
    { applicationVersion: "other-version" }, { provenanceId: createStableId("provenance") }, { treeIdentifier: "Local\\ACP.Worker.wrong" },
    { recordedAt: "2026-02-30T00:00:00Z" }, { privateField: true },
  ]) {
    const f = fixture(); Object.assign(f[record], changed);
    assert.deepEqual(await f.verifier().verify(f.input()), { state: "unconfirmed" }); assert.deepEqual(f.events, ["plan", "stop"]);
  }
  for (const field of ["root", "fence", "scope", "sealed"]) {
    const f = fixture(); Object.assign(f.stop, { fence: structuredClone(f.stop.fence), observation: structuredClone(f.stop.observation) });
    if (field === "root") Object.assign(f.stop.observation, { root: { ...f.process.root, processId: 1234 } });
    if (field === "fence") Object.assign(f.stop.fence, { directoryIdentity: "win32-dir:12345678:0000000000000009" });
    if (field === "scope") Object.assign(f.stop.fence.scope, { sessionId: 2 });
    if (field === "sealed") Object.assign(f.stop.observation, { sealed: false });
    assert.deepEqual(await f.verifier().verify(f.input()), { state: "unconfirmed" }); assert.deepEqual(f.events, ["plan", "stop"]);
  }
  for (const field of ["directory", "machine"]) {
    const f = fixture(), paired = structuredClone(f.process.fence);
    if (field === "directory") Object.assign(paired, { directory: "C:\\another-fence" });
    else Object.assign(paired.scope, { machineFingerprint: "d".repeat(64) });
    Object.assign(f.process, { fence: paired }); Object.assign(f.stop, { fence: paired });
    assert.deepEqual(await f.verifier().verify(f.input()), { state: "unconfirmed" }); assert.deepEqual(f.events, ["plan", "stop"]);
  }
});

it("stopped provisioner verification cross-checks the exact recorded repository instead of deriving checkout identity", async () => {
  for (const changed of [{ repositoryBindingId: createStableId("repositoryBinding") }, { repositoryId: createStableId("repository") },
    { projectId: createStableId("project") }, { machineFingerprint: "d".repeat(64) }, { commonGitDirectory: { path: "C:\\other\\.git", identity: fixture().plan.commonGitDirectory.identity } }]) {
    const f = fixture(); Object.assign(f.repository, changed);
    assert.deepEqual(await f.verifier().verify(f.input()), { state: "unconfirmed" }); assert.deepEqual(f.events, ["plan", "stop", "repository"]);
  }
});

it("stopped provisioner verification rejects substituted native bindings, branch/base and extra result fields", async () => {
  for (const changed of [{ state: "unconfirmed" }, { scope: "authorized" }, { machineFingerprint: "d".repeat(64) }, { branchRef: "refs/heads/feature/ExactCase" },
    { headRevision: "c".repeat(40) }, { privateField: "hidden" }, { observedAt: "2026-02-30T00:00:00.000Z" }]) {
    const f = fixture(); Object.assign(f.observation, changed);
    assert.deepEqual(await f.verifier().verify(f.input()), { state: "unconfirmed" }); assert.equal(f.events.at(-1), "native");
  }
  for (const key of ["parent", "checkout", "commonGitDirectory", "workspace", "gitDirectory"] as const) {
    for (const changed of [{ path: "C:\\different" }, { identity: "win32-dir:12345678:0000000000000009" }]) {
      const f = fixture(); Object.assign(f.observation, { [key]: { ...f.observation[key], ...changed } });
      // Workspace/linked metadata identities are newly observed, not known in the old plan.
      if ((key === "workspace" || key === "gitDirectory") && "identity" in changed) continue;
      assert.deepEqual(await f.verifier().verify(f.input()), { state: "unconfirmed" });
    }
  }
});

it("stopped provisioner verification bounds and detaches native observations without invoking hooks", async () => {
  const f = fixture(); let calls = 0;
  Object.defineProperty(f.observation, "headRevision", { enumerable: true, get() { calls++; return f.plan.baseRevision; } });
  assert.deepEqual(await f.verifier().verify(f.input()), { state: "unconfirmed" }); assert.equal(calls, 0);
  for (const changed of [{ extra: "😀".repeat(20000) }, { extra: { toJSON() { calls++; return {}; } } }]) {
    assert.deepEqual(parseWindowsStoppedProvisionerWorktreeObservation({ ...fixture().observation, ...changed }), { state: "unconfirmed" });
  }
  assert.equal(calls, 0);
});

it("stopped provisioner verification drains cancellation at every pending read before returning", async () => {
  const early = fixture(); early.caller.abort(); assert.deepEqual(await early.verifier().verify(early.input()), { state: "unconfirmed" }); assert.deepEqual(early.events, []);
  for (const stage of ["plan", "stop", "repository", "native"]) {
    const f = fixture(), entered = Promise.withResolvers<void>(), pending = Promise.withResolvers<unknown>();
    const load = async () => { entered.resolve(); return pending.promise; };
    if (stage === "plan") f.plans.load = load as typeof f.plans.load;
    if (stage === "stop") f.journal.load = load as typeof f.journal.load;
    if (stage === "repository") f.repositories.loadRepository = load as typeof f.repositories.loadRepository;
    if (stage === "native") f.observer.observe = load as typeof f.observer.observe;
    let settled = false; const work = f.verifier().verify(f.input()).then(result => { settled = true; return result; });
    try { await entered.promise; f.caller.abort(); await Promise.resolve(); assert.equal(settled, false); }
    finally { pending.resolve(stage === "plan" ? f.plan : stage === "stop" ? f.snapshot : stage === "repository" ? { binding: f.repository, retired: false } : f.observation); }
    assert.deepEqual(await work, { state: "unconfirmed" });
  }
});

it("stopped provisioner verification masks failed reads without retrying or proceeding to later ports", async () => {
  for (const stage of ["plan", "stop", "repository", "native"]) {
    const f = fixture(); let calls = 0;
    const fail = async (): Promise<never> => { calls++; throw new Error("private synthetic failure"); };
    if (stage === "plan") f.plans.load = fail;
    if (stage === "stop") f.journal.load = fail;
    if (stage === "repository") f.repositories.loadRepository = fail;
    if (stage === "native") f.observer.observe = fail;
    assert.deepEqual(await f.verifier().verify(f.input()), { state: "unconfirmed" }); assert.equal(calls, 1);
  }
});
