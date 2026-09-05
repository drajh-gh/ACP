import assert from "node:assert/strict";
import { it } from "node:test";
import { createStableId } from "@acp/domain";
import type { FilesystemWriterLease, RepositoryBindingInput, WorktreeBindingInput } from "@acp/storage";
import { WindowsLeasedWorktreeObserver } from "../src/windows-leased-worktree-observer.ts";
import type { WindowsWorktreeObservation } from "../src/windows-repository-observer.ts";

function fixture() {
  const controller = new AbortController(); let monotonic = 0, renewals = 0, observations = 0, loads = 0;
  const authority = { hostIdentifier:"host:preflight",sessionId:createStableId("workerHostSession"),applicationVersion:"preflight-test" };
  const directory = (path: string, digit: string) => ({ path,identity:`win32-dir:12345678:000000000000000${digit}` });
  const repository: RepositoryBindingInput = { repositoryBindingId:createStableId("repositoryBinding"),repositoryId:createStableId("repository"),
    projectId:createStableId("project"),machineFingerprint:"a".repeat(64),checkout:directory("C:\\fixture", "1"),
    commonGitDirectory:directory("C:\\fixture\\.git","2"),observedAt:"2000-01-01T00:00:00.000Z",provenanceId:createStableId("provenance") };
  const worktree: WorktreeBindingInput = { worktreeBindingId:createStableId("worktreeBinding"),repositoryBindingId:repository.repositoryBindingId,
    missionId:createStableId("mission"),workspace:directory("C:\\worktree ž","3"),gitDirectory:directory("C:\\fixture\\.git\\worktrees\\branch","4"),
    branchRef:"refs/heads/Feature/Case",headRevision:"a".repeat(40),observedAt:repository.observedAt,provenanceId:createStableId("provenance") };
  let lease: FilesystemWriterLease = { leaseId:createStableId("lease"),runId:createStableId("run"),workerProcessId:createStableId("workerProcess"),
    worktreeBindingId:worktree.worktreeBindingId,repositoryBindingId:repository.repositoryBindingId,provenanceId:createStableId("provenance"),
    hostIdentifier:authority.hostIdentifier,ownerSessionId:authority.sessionId,applicationVersion:authority.applicationVersion,
    workspaceKey:"logical-workspace",physicalWorkspaceKey:"physical-workspace",physicalRepositoryKey:"physical-git",branchKey:"logical-branch",
    acquiredAt:repository.observedAt,heartbeatAt:repository.observedAt,expiresAt:"2000-01-01T00:00:20.000Z",revision:1,releasedAt:null,state:"active" };
  let observation: WindowsWorktreeObservation = { state:"confirmed",kind:"worktree",machineFingerprint:repository.machineFingerprint,
    workspace:worktree.workspace,gitDirectory:worktree.gitDirectory,branchRef:worktree.branchRef,headRevision:worktree.headRevision,observedAt:repository.observedAt };
  const writers = { authority,async load() { loads++; return { ...lease }; },async heartbeat() {
    renewals++; lease={ ...lease,revision:lease.revision+1 }; return { ...lease };
  } };
  const bindings = { authority,async loadWorktree() { return { binding:worktree,retired:false }; },async loadRepository() { return { binding:repository,retired:false }; } };
  const options = { gitExecutable:"C:\\Program Files\\Git\\cmd\\git.exe",monotonicNow:() => monotonic,
    async observeWorktree(received: RepositoryBindingInput, workspace: string, signal: AbortSignal): Promise<WindowsWorktreeObservation> {
      assert.deepEqual(received,repository); assert.equal(workspace,worktree.workspace.path); assert.equal(signal.aborted,false);
      observations++; return observation;
    } };
  return { controller,authority,repository,worktree,writers,bindings,options,
    observer:() => new WindowsLeasedWorktreeObserver(writers,bindings,options),
    get lease() { return lease; },set lease(value) { lease=value; },set observation(value: WindowsWorktreeObservation) { observation=value; },
    get counts() { return { renewals,observations,loads }; },set monotonic(value: number) { monotonic=value; } };
}
it("leased native preflight brackets exact retained observation with fresh renewals without relying on host wall time",async () => {
  const f=fixture(),initial=f.lease;
  const result=await f.observer().observe(initial.leaseId,f.controller.signal);
  assert.deepEqual(result,{ state:"observed",leaseId:initial.leaseId,runId:initial.runId,workerProcessId:initial.workerProcessId,
    worktreeBindingId:initial.worktreeBindingId,repositoryBindingId:initial.repositoryBindingId,leaseRevision:3,
    branchRef:f.worktree.branchRef,headRevision:f.worktree.headRevision,observedAt:f.worktree.observedAt });
  assert.deepEqual(f.counts,{ loads:1,renewals:2,observations:1 });
});
it("leased native preflight rejects mismatched stores, executable configuration and invalid lease IDs",async () => {
  const f=fixture();
  assert.throws(() => new WindowsLeasedWorktreeObserver(f.writers,{ ...f.bindings,authority:{ ...f.authority,sessionId:createStableId("workerHostSession") } },f.options),/same exact/u);
  assert.throws(() => new WindowsLeasedWorktreeObserver(f.writers,f.bindings,{ ...f.options,gitExecutable:"git" }),TypeError);
  await assert.rejects(f.observer().observe(createStableId("run") as never,f.controller.signal),TypeError);
  assert.deepEqual(f.counts,{ loads:0,renewals:0,observations:0 });
});
it("cancelled, recovering, released and foreign-session snapshots never reach a native process",async () => {
  for (const change of [{ state:"recovering" as const },{ state:"released" as const },{ ownerSessionId:createStableId("workerHostSession") },{ releasedAt:"2000-01-01T00:00:01.000Z" }]) {
    const f=fixture(); f.lease={ ...f.lease,...change };
    assert.deepEqual(await f.observer().observe(f.lease.leaseId,f.controller.signal),{ state:"unconfirmed" });
    assert.equal(f.counts.renewals,0); assert.equal(f.counts.observations,0);
  }
  const f=fixture(); f.controller.abort();
  assert.deepEqual(await f.observer().observe(f.lease.leaseId,f.controller.signal),{ state:"unconfirmed" }); assert.equal(f.counts.loads,0);
});
it("retired or mismatched persisted bindings cannot choose the path to observe",async () => {
  for (const kind of ["retired","wrong-tree","wrong-parent"]) {
    const f=fixture(); f.bindings.loadWorktree=async () => ({ retired:kind==="retired",binding:{ ...f.worktree,
      ...(kind==="wrong-tree" ? { worktreeBindingId:createStableId("worktreeBinding") } : {}),
      ...(kind==="wrong-parent" ? { repositoryBindingId:createStableId("repositoryBinding") } : {}) } });
    assert.deepEqual(await f.observer().observe(f.lease.leaseId,f.controller.signal),{ state:"unconfirmed" }); assert.equal(f.counts.renewals,0);
  }
});
it("every observed native identity, path, branch spelling and HEAD must match retained evidence",async () => {
  const base=fixture();
  for (const change of [{ machineFingerprint:"b".repeat(64) },{ workspace:{ ...base.worktree.workspace,path:"C:\\other" } },
    { workspace:{ ...base.worktree.workspace,identity:"win32-dir:12345678:0000000000000009" } },
    { gitDirectory:{ ...base.worktree.gitDirectory,path:"C:\\other-git" } },
    { gitDirectory:{ ...base.worktree.gitDirectory,identity:"win32-dir:12345678:0000000000000008" } },
    { branchRef:base.worktree.branchRef.toLowerCase() },{ headRevision:"b".repeat(40) },{ state:"unconfirmed" }]) {
    const f=fixture(); f.observation={ state:"confirmed",kind:"worktree",machineFingerprint:f.repository.machineFingerprint,
      workspace:f.worktree.workspace,gitDirectory:f.worktree.gitDirectory,branchRef:f.worktree.branchRef,headRevision:f.worktree.headRevision,
      observedAt:f.worktree.observedAt,...change } as WindowsWorktreeObservation;
    assert.deepEqual(await f.observer().observe(f.lease.leaseId,f.controller.signal),{ state:"unconfirmed" }); assert.equal(f.counts.renewals,1);
  }
});
it("lost initial and final heartbeat acknowledgements permanently withhold preflight evidence",async () => {
  for (const failedCall of [1,2]) {
    const f=fixture(),heartbeat=f.writers.heartbeat; let calls=0;
    f.writers.heartbeat=async () => { const renewed=await heartbeat(); if (++calls===failedCall) throw new Error("lost acknowledgement"); return renewed; };
    assert.deepEqual(await f.observer().observe(f.lease.leaseId,f.controller.signal),{ state:"unconfirmed" });
    assert.equal(f.counts.renewals,failedCall); assert.equal(f.counts.observations,failedCall-1);
  }
});
it("renewal must advance the original owner tuple and cannot switch durable targets",async () => {
  for (const kind of ["same-revision","wrong-run","wrong-key","recovering"]) {
    const f=fixture(),heartbeat=f.writers.heartbeat,initial=f.lease;
    f.writers.heartbeat=async () => ({ ...await heartbeat(),...(kind==="same-revision" ? { revision:initial.revision } : {}),
      ...(kind==="wrong-run" ? { runId:createStableId("run") } : {}),...(kind==="wrong-key" ? { branchKey:"other" } : {}),
      ...(kind==="recovering" ? { state:"recovering" as const } : {}) });
    assert.deepEqual(await f.observer().observe(initial.leaseId,f.controller.signal),{ state:"unconfirmed" }); assert.equal(f.counts.observations,0);
  }
});
it("shortened lease duration subtracts heartbeat roundtrip and margin before native invocation",async () => {
  const f=fixture(),heartbeat=f.writers.heartbeat;
  f.lease={ ...f.lease,expiresAt:"2000-01-01T00:00:00.500Z" };
  f.writers.heartbeat=async () => { f.monotonic=300; return heartbeat(); };
  assert.deepEqual(await f.observer().observe(f.lease.leaseId,f.controller.signal),{ state:"unconfirmed" }); assert.equal(f.counts.observations,0);
});
it("lease watchdog aborts native observation and awaits its cleanup before returning",async () => {
  const f=fixture(); let cleaned=false;
  f.lease={ ...f.lease,expiresAt:"2000-01-01T00:00:00.270Z" };
  f.options.observeWorktree=async (_r,_w,signal) => new Promise((done) => {
    signal.addEventListener("abort",() => { setTimeout(() => { cleaned=true; done({ state:"unconfirmed" }); },5); },{ once:true });
  });
  assert.deepEqual(await f.observer().observe(f.lease.leaseId,f.controller.signal),{ state:"unconfirmed" });
  assert.equal(cleaned,true); assert.equal(f.counts.renewals,1);
});
it("caller abort during native cleanup or final heartbeat cannot be revived by a late success",async () => {
  for (const at of ["native","final"]) {
    const f=fixture(),observe=f.options.observeWorktree,heartbeat=f.writers.heartbeat; let calls=0,settled=false;
    f.options.observeWorktree=async (...args) => { const result=await observe(...args); if (at==="native") f.controller.abort(); return result; };
    f.writers.heartbeat=async () => { const result=await heartbeat(); if (++calls===2 && at==="final") { f.controller.abort(); await Promise.resolve(); settled=true; } return result; };
    assert.deepEqual(await f.observer().observe(f.lease.leaseId,f.controller.signal),{ state:"unconfirmed" });
    assert.equal(f.counts.renewals,at==="native" ? 1 : 2); if (at==="final") assert.equal(settled,true);
  }
});
it("a delayed final success past the monotonic watchdog cannot publish cached observation",async () => {
  const f=fixture(),heartbeat=f.writers.heartbeat; let calls=0;
  f.writers.heartbeat=async () => { const result=await heartbeat(); if (++calls===2) f.monotonic=30000; return result; };
  assert.deepEqual(await f.observer().observe(f.lease.leaseId,f.controller.signal),{ state:"unconfirmed" }); assert.equal(f.counts.renewals,2);
});
it("caller abort during an initial heartbeat prevents native work even after a late successful acknowledgement",async () => {
  const f=fixture(),heartbeat=f.writers.heartbeat; let settled=false;
  f.writers.heartbeat=async () => { const result=await heartbeat(); f.controller.abort(); await Promise.resolve(); settled=true; return result; };
  assert.deepEqual(await f.observer().observe(f.lease.leaseId,f.controller.signal),{ state:"unconfirmed" });
  assert.equal(settled,true); assert.equal(f.counts.renewals,1); assert.equal(f.counts.observations,0);
});
