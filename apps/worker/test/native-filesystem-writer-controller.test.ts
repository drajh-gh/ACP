import assert from "node:assert/strict";
import { it } from "node:test";
import { createStableId } from "@acp/domain";
import type { FilesystemWriterLease } from "@acp/storage";
import type { OwnedWorkerExit } from "../src/windows-worker-launcher.ts";
import { NativeFilesystemWriterController, type NativeFilesystemLeaseCommit,
  type NativeFilesystemWriterSession } from "../src/native-filesystem-writer-controller.ts";

function deferred<T>() { return Promise.withResolvers<T>(); }
function fixture() {
  const caller=new AbortController(), receipt=deferred<OwnedWorkerExit>();
  const trace=["native-challenge:1"], commits: NativeFilesystemLeaseCommit[]=[];
  const authority={ hostIdentifier:"host:native-controller",sessionId:createStableId("workerHostSession"),applicationVersion:"controller-test" };
  let lease: FilesystemWriterLease={ leaseId:createStableId("lease"),runId:createStableId("run"),workerProcessId:createStableId("workerProcess"),
    worktreeBindingId:createStableId("worktreeBinding"),repositoryBindingId:createStableId("repositoryBinding"),provenanceId:createStableId("provenance"),
    hostIdentifier:authority.hostIdentifier,ownerSessionId:authority.sessionId,applicationVersion:authority.applicationVersion,
    workspaceKey:"logical-workspace",physicalWorkspaceKey:"physical-workspace",physicalRepositoryKey:"physical-repository",branchKey:"logical-branch",
    acquiredAt:"2000-01-01T00:00:00.000Z",heartbeatAt:"2000-01-01T00:00:00.000Z",expiresAt:"2000-01-01T00:00:20.000Z",
    revision:1,releasedAt:null,state:"active" };
  const exit: OwnedWorkerExit={ treeEmpty:true,exitCode:0,terminated:false,failed:false,output:'{"candidate":true}' };
  let epoch=1, releases=0, stops=0;
  const writers={ authority,async load(): Promise<FilesystemWriterLease | undefined> { trace.push("load"); return { ...lease }; },
    async heartbeat(): Promise<FilesystemWriterLease> { lease={ ...lease,revision:lease.revision+1 }; trace.push(`db-ack:${lease.revision}`); return { ...lease }; } };
  const session: NativeFilesystemWriterSession={
    leaseIdentity:{ leaseId:lease.leaseId,runId:lease.runId,workerProcessId:lease.workerProcessId },
    initialLeaseChallenge:{ nonce:"1".repeat(32),epoch:1 },
    scope:{ machineFingerprint:"a".repeat(64),bootedAt:"2000-01-01T00:00:00.000Z",sessionId:1 },
    processId:123,processStartToken:"win32-filetime:134000000000000000",startedAt:"2000-01-01T00:00:00.000Z",closed:receipt.promise,
    async requestLeaseChallenge() { epoch++; trace.push(`native-challenge:${epoch}`); return { nonce:epoch.toString(16).padStart(32,"0"),epoch }; },
    async acceptLease(commit) { commits.push({ ...commit }); trace.push(`native-ack:${commit.revision}`); return { nonce:commit.nonce,epoch:commit.epoch,revision:commit.revision }; },
    release(input) { releases++; trace.push(`go:${input}`); receipt.resolve(exit); },
    async terminate() { stops++; trace.push("stop"); receipt.resolve({ ...exit,exitCode:137,terminated:true }); return receipt.promise; },
  };
  return { caller,receipt,trace,commits,writers,session,exit,
    controller:() => new NativeFilesystemWriterController(writers,{ renewalIntervalMs:5 }),
    get lease() { return lease; }, set lease(value) { lease=value; },get counts() { return { releases,stops }; } };
}

it("native controller binds a fresh DB ACK to the issued challenge before GO and has no final renewal",async () => {
  const f=fixture();
  assert.deepEqual(await f.controller().run(f.session,f.caller.signal,"payload"),{ state:"closed",exit:f.exit,authorityLost:false });
  assert.deepEqual(f.trace,["native-challenge:1","load","db-ack:2","native-ack:2","go:payload"]);
  assert.deepEqual(f.commits,[{ ...f.session.leaseIdentity,nonce:"1".repeat(32),epoch:1,revision:2,durationMilliseconds:20000 }]);
  assert.deepEqual(f.counts,{ releases:1,stops:0 });
});

it("an invalid initial DB ACK stops the suspended owned root without native commit or GO",async () => {
  const f=fixture(),heartbeat=f.writers.heartbeat;
  f.writers.heartbeat=async () => ({ ...await heartbeat(),workerProcessId:createStableId("workerProcess") });
  const outcome=await f.controller().run(f.session,f.caller.signal,"payload");
  assert.equal(outcome.state,"closed"); if (outcome.state==="closed") assert.equal(outcome.authorityLost,true);
  assert.equal(f.commits.length,0); assert.deepEqual(f.counts,{ releases:0,stops:1 });
});

it("a mismatched native acceptance never authorizes GO",async () => {
  const f=fixture(),accept=f.session.acceptLease;
  f.session.acceptLease=async (commit) => ({ ...await accept(commit),epoch:commit.epoch+1 });
  const outcome=await f.controller().run(f.session,f.caller.signal,"payload");
  assert.equal(outcome.state,"closed"); if (outcome.state==="closed") assert.equal(outcome.authorityLost,true);
  assert.deepEqual(f.counts,{ releases:0,stops:1 });
});

it("pre-abort still awaits cleanup of the already-owned suspended session",async () => {
  const f=fixture(),cleanup=deferred<OwnedWorkerExit>(); let stopped=false,settled=false;
  f.session.terminate=async () => { stopped=true; const exit=await cleanup.promise; f.receipt.resolve(exit); return exit; };
  f.caller.abort();
  const running=f.controller().run(f.session,f.caller.signal,"payload").then((value) => { settled=true; return value; });
  await Promise.resolve(); await Promise.resolve(); assert.equal(stopped,true); assert.equal(settled,false);
  assert.deepEqual(f.trace,["native-challenge:1"]);
  cleanup.resolve({ ...f.exit,exitCode:137,terminated:true });
  const outcome=await running; assert.equal(outcome.state,"closed"); if (outcome.state==="closed") assert.equal(outcome.authorityLost,true);
});

it("native controller rejects invalid scheduling configuration before ownership",() => {
  const f=fixture();
  for (const renewalIntervalMs of [0,5001,1.5,NaN,Infinity]) {
    assert.throws(() => new NativeFilesystemWriterController(f.writers,{ renewalIntervalMs }),TypeError);
  }
  assert.deepEqual(f.trace,["native-challenge:1"]);
});

it("invalid identity, missing lease and initial read failure still stop the already-owned session",async () => {
  for (const kind of ["id","alias","missing","read-error"]) {
    const f=fixture();
    if (kind==="id") Object.assign(f.session.leaseIdentity,{ leaseId:createStableId("run") });
    if (kind==="alias") f.lease={ ...f.lease,runId:createStableId("run") };
    if (kind==="missing") f.writers.load=async () => undefined;
    if (kind==="read-error") f.writers.load=async () => { throw new Error("database unavailable"); };
    const outcome=await f.controller().run(f.session,f.caller.signal,"payload");
    assert.equal(outcome.state,"closed"); if (outcome.state==="closed") assert.equal(outcome.authorityLost,true);
    assert.deepEqual(f.counts,{ releases:0,stops:1 }); assert.equal(f.commits.length,0);
  }
});

it("inactive, released, invalid-revision and foreign-owner snapshots never obtain an epoch",async () => {
  for (const change of [{ state:"recovering" as const },{ state:"released" as const },{ releasedAt:"2000-01-01T00:00:01.000Z" },
    { revision:0 },{ revision:1.5 },{ revision:Infinity },{ ownerSessionId:createStableId("workerHostSession") },
    { hostIdentifier:"other" },{ applicationVersion:"other" },{ workerProcessId:createStableId("workerProcess") }]) {
    const f=fixture(); f.lease={ ...f.lease,...change };
    const outcome=await f.controller().run(f.session,f.caller.signal,"payload");
    assert.equal(outcome.state,"closed"); if (outcome.state==="closed") assert.equal(outcome.authorityLost,true);
    assert.deepEqual(f.counts,{ releases:0,stops:1 }); assert.equal(f.commits.length,0);
    assert.equal(f.trace.some((value) => value.startsWith("db-ack:")),false);
  }
});

it("every immutable DB lease field remains pinned across initial and periodic acknowledgements",async () => {
  const changes: Partial<FilesystemWriterLease>[]=[{ leaseId:createStableId("lease") },{ runId:createStableId("run") },
    { workerProcessId:createStableId("workerProcess") },{ worktreeBindingId:createStableId("worktreeBinding") },
    { repositoryBindingId:createStableId("repositoryBinding") },{ provenanceId:createStableId("provenance") },
    { hostIdentifier:"other" },{ ownerSessionId:createStableId("workerHostSession") },{ applicationVersion:"other" },
    { workspaceKey:"other" },{ physicalWorkspaceKey:"other" },{ physicalRepositoryKey:"other" },{ branchKey:"other" },
    { acquiredAt:"2000-01-01T00:00:00.001Z" },{ releasedAt:"2000-01-01T00:00:01.000Z" },{ state:"recovering" }];
  for (const failingCall of [1,2]) for (const change of changes) {
    const f=fixture(),heartbeat=f.writers.heartbeat; let calls=0,released=0;
    f.session.release=() => { released++; };
    f.writers.heartbeat=async () => { const value=await heartbeat(); return ++calls===failingCall ? { ...value,...change } : value; };
    const outcome=await f.controller().run(f.session,f.caller.signal,"payload");
    assert.equal(outcome.state,"closed"); if (outcome.state==="closed") assert.equal(outcome.authorityLost,true);
    assert.equal(released,failingCall-1); assert.equal(f.commits.length,failingCall-1);
  }
});

it("a DB revision must advance and the native duration must be finite and within its exact budget",async () => {
  for (const change of [{ revision:1 },{ revision:1.5 },{ revision:Number.MAX_SAFE_INTEGER+1 },
    { expiresAt:"not-a-date" },{ heartbeatAt:"not-a-date" },{ expiresAt:"2000-01-01T00:00:00.250Z" },
    { expiresAt:"1999-12-31T23:59:59.999Z" },{ expiresAt:"2000-01-01T00:00:20.001Z" }]) {
    const f=fixture(),heartbeat=f.writers.heartbeat;
    f.writers.heartbeat=async () => ({ ...await heartbeat(),...change });
    const outcome=await f.controller().run(f.session,f.caller.signal,"payload");
    assert.equal(outcome.state,"closed"); if (outcome.state==="closed") assert.equal(outcome.authorityLost,true);
    assert.deepEqual(f.counts,{ releases:0,stops:1 }); assert.equal(f.commits.length,0);
  }
});

it("initial native challenges require an exact first epoch and canonical nonce",async () => {
  for (const change of [{ nonce:"bad" },{ nonce:"A".repeat(32) },{ epoch:0 },{ epoch:2 },{ epoch:1.5 },{ unexpected:true }]) {
    const f=fixture(); Object.assign(f.session.initialLeaseChallenge,change);
    const outcome=await f.controller().run(f.session,f.caller.signal,"payload");
    assert.equal(outcome.state,"closed"); if (outcome.state==="closed") assert.equal(outcome.authorityLost,true);
    assert.deepEqual(f.counts,{ releases:0,stops:1 }); assert.equal(f.commits.length,0);
    assert.equal(f.trace.some((value) => value.startsWith("db-ack:")),false);
  }
});

it("lost initial database or native ACK never permits GO or a renewal retry",async () => {
  for (const at of ["database","native"]) {
    const f=fixture();
    if (at==="database") f.writers.heartbeat=async () => { throw new Error("committed, acknowledgement lost"); };
    else f.session.acceptLease=async () => { throw new Error("native acknowledgement lost"); };
    const outcome=await f.controller().run(f.session,f.caller.signal,"payload");
    assert.equal(outcome.state,"closed"); if (outcome.state==="closed") assert.equal(outcome.authorityLost,true);
    assert.deepEqual(f.counts,{ releases:0,stops:1 });
  }
});

it("native acceptance must match its nonce, epoch, revision and exact frame shape",async () => {
  for (const change of [{ nonce:"0".repeat(32) },{ epoch:2 },{ revision:1 },{ revision:"2" },{ extra:true }]) {
    const f=fixture(),accept=f.session.acceptLease;
    f.session.acceptLease=async (commit) => ({ ...await accept(commit),...change }) as never;
    const outcome=await f.controller().run(f.session,f.caller.signal,"payload");
    assert.equal(outcome.state,"closed"); if (outcome.state==="closed") assert.equal(outcome.authorityLost,true);
    assert.deepEqual(f.counts,{ releases:0,stops:1 });
  }
});

it("native renewal serializes complete challenge/DB/acceptance epochs and releases only once",{ timeout:2000 },async () => {
  const f=fixture(),heartbeat=f.writers.heartbeat,accept=f.session.acceptLease;
  let active=0,maximum=0,releases=0;
  f.session.release=() => { releases++; };
  f.session.requestLeaseChallenge=async () => {
    active++; maximum=Math.max(maximum,active);
    return { nonce:(f.commits.length+1).toString(16).padStart(32,"0"),epoch:f.commits.length+1 };
  };
  f.writers.heartbeat=async () => { await new Promise((done) => setTimeout(done,3)); return heartbeat(); };
  f.session.acceptLease=async (commit) => {
    const ack=await accept(commit);
    if (commit.epoch>1) { await new Promise((done) => setTimeout(done,3)); active--; }
    if (commit.epoch===4) f.receipt.resolve(f.exit);
    return ack;
  };
  const outcome=await f.controller().run(f.session,f.caller.signal,"payload");
  assert.deepEqual(outcome,{ state:"closed",exit:f.exit,authorityLost:false });
  assert.equal(releases,1); assert.equal(maximum,1); assert.equal(active,0);
  assert.deepEqual(f.commits.map((value) => [value.epoch,value.revision]),[[1,2],[2,3],[3,4],[4,5]]);
  const calls=f.commits.length; await new Promise((done) => setTimeout(done,20)); assert.equal(f.commits.length,calls);
});

it("abort at each initial await boundary suppresses later commit and GO",async () => {
  for (const at of ["load","database","native"]) {
    const f=fixture(),load=f.writers.load,heartbeat=f.writers.heartbeat,accept=f.session.acceptLease;
    f.writers.load=async () => { const value=await load(); if (at==="load") f.caller.abort(); return value; };
    f.writers.heartbeat=async () => { const value=await heartbeat(); if (at==="database") f.caller.abort(); return value; };
    f.session.acceptLease=async (commit) => { const value=await accept(commit); if (at==="native") f.caller.abort(); return value; };
    const outcome=await f.controller().run(f.session,f.caller.signal,"payload");
    assert.equal(outcome.state,"closed"); if (outcome.state==="closed") assert.equal(outcome.authorityLost,true);
    assert.deepEqual(f.counts,{ releases:0,stops:1 }); assert.equal(f.commits.length,at==="native" ? 1 : 0);
  }
});

it("close during a periodic DB ACK suppresses the unsent commit and quiesces before a future receipt",{ timeout:2000 },async () => {
  const f=fixture(),heartbeat=f.writers.heartbeat,pending=deferred<FilesystemWriterLease>(),entered=deferred<void>();
  let calls=0,settled=false;
  f.session.release=() => {};
  f.writers.heartbeat=async () => { if (++calls===2) { entered.resolve(); return pending.promise; } return heartbeat(); };
  const running=f.controller().run(f.session,f.caller.signal,"payload").then((value) => { settled=true; return value; });
  await entered.promise; f.receipt.resolve(f.exit); await Promise.resolve(); await Promise.resolve();
  assert.equal(settled,false); assert.equal(f.commits.length,1);
  pending.resolve({ ...f.lease,revision:3 });
  assert.deepEqual(await running,{ state:"closed",exit:f.exit,authorityLost:false });
  assert.equal(calls,2); assert.equal(f.commits.length,1);
});

it("a pending DB rejection or altered tuple after close invalidates the already-produced result",{ timeout:2000 },async () => {
  for (const kind of ["error","identity"]) {
    const f=fixture(),heartbeat=f.writers.heartbeat,pending=deferred<FilesystemWriterLease>(),entered=deferred<void>();
    let calls=0,settled=false; f.session.release=() => {};
    f.writers.heartbeat=async () => { if (++calls===2) { entered.resolve(); return pending.promise; } return heartbeat(); };
    const running=f.controller().run(f.session,f.caller.signal,"payload").then((value) => { settled=true; return value; });
    await entered.promise; f.receipt.resolve(f.exit); await Promise.resolve(); assert.equal(settled,false);
    if (kind==="error") pending.reject(new Error("late lost ACK"));
    else pending.resolve({ ...f.lease,revision:3,branchKey:"other" });
    assert.deepEqual(await running,{ state:"closed",exit:f.exit,authorityLost:true });
    assert.equal(calls,2); assert.equal(f.commits.length,1);
  }
});

it("abort requests native termination immediately while a DB request remains blocked and awaited",{ timeout:2000 },async () => {
  const f=fixture(),heartbeat=f.writers.heartbeat,pending=deferred<FilesystemWriterLease>(),entered=deferred<void>();
  let calls=0,settled=false; f.session.release=() => {};
  f.writers.heartbeat=async () => { if (++calls===2) { entered.resolve(); return pending.promise; } return heartbeat(); };
  const running=f.controller().run(f.session,f.caller.signal,"payload").then((value) => { settled=true; return value; });
  await entered.promise; f.caller.abort(); assert.equal(f.counts.stops,1);
  await Promise.resolve(); await Promise.resolve(); assert.equal(settled,false);
  pending.resolve({ ...f.lease,revision:3 });
  const outcome=await running; assert.equal(outcome.state,"closed"); if (outcome.state==="closed") assert.equal(outcome.authorityLost,true);
  assert.equal(f.commits.length,1); assert.equal(calls,2);
});

it("native closure during a pending challenge suppresses DB work, while rejection remains conservative loss",{ timeout:2000 },async () => {
  for (const kind of ["ack","error"]) {
    const f=fixture(),entered=deferred<void>(),pending=deferred<{ nonce:string; epoch:number }>();
    f.session.release=() => {};
    f.session.requestLeaseChallenge=async () => { entered.resolve(); return pending.promise; };
    const running=f.controller().run(f.session,f.caller.signal,"payload");
    await entered.promise; f.receipt.resolve(f.exit);
    if (kind==="ack") pending.resolve({ nonce:"2".repeat(32),epoch:2 }); else pending.reject(new Error("native root already closed"));
    assert.deepEqual(await running,{ state:"closed",exit:f.exit,authorityLost:kind==="error" });
    assert.equal(f.trace.filter((value) => value.startsWith("db-ack:")).length,1); assert.equal(f.commits.length,1);
  }
});

it("closure during pending native acceptance is awaited and cannot hide a lost or malformed ACK",{ timeout:2000 },async () => {
  for (const kind of ["ack","error","wrong"]) {
    const f=fixture(),accept=f.session.acceptLease,entered=deferred<NativeFilesystemLeaseCommit>();
    const pending=deferred<{ nonce:string; epoch:number; revision:number }>();
    let calls=0,settled=false; f.session.release=() => {};
    f.session.acceptLease=async (commit) => { if (++calls===2) { entered.resolve(commit); return pending.promise; } return accept(commit); };
    const running=f.controller().run(f.session,f.caller.signal,"payload").then((value) => { settled=true; return value; });
    const commit=await entered.promise; f.receipt.resolve(f.exit); await Promise.resolve(); assert.equal(settled,false);
    if (kind==="error") pending.reject(new Error("native ACK lost"));
    else pending.resolve({ nonce:commit.nonce,epoch:commit.epoch,revision:kind==="wrong" ? 1 : commit.revision });
    assert.deepEqual(await running,{ state:"closed",exit:f.exit,authorityLost:kind!=="ack" }); assert.equal(calls,2);
  }
});

it("rejected or malformed closed evidence remains unconfirmed despite a successful terminate return",async () => {
  for (const kind of ["rejected","empty","invalid-code","unsealed"]) {
    const f=fixture(); let stops=0;
    f.session.terminate=async () => { stops++; return f.exit; };
    f.session.release=() => {
      if (kind==="rejected") f.receipt.reject(new Error("tree closure unconfirmed"));
      else f.receipt.resolve({ ...f.exit,...(kind==="empty" ? { treeEmpty:false } : {}),
        ...(kind==="invalid-code" ? { exitCode:NaN } : {}),...(kind==="unsealed" ? { launchSealed:false } : {}) } as never);
    };
    assert.deepEqual(await f.controller().run(f.session,f.caller.signal,"payload"),{ state:"unconfirmed" }); assert.equal(stops,1);
  }
});

it("bootstrap closure and release failure can never report maintained authority",async () => {
  for (const at of ["load","database","native","release"]) {
    const f=fixture(),load=f.writers.load,heartbeat=f.writers.heartbeat,accept=f.session.acceptLease;
    f.writers.load=async () => { const value=await load(); if (at==="load") f.receipt.resolve(f.exit); return value; };
    f.writers.heartbeat=async () => { const value=await heartbeat(); if (at==="database") f.receipt.resolve(f.exit); return value; };
    f.session.acceptLease=async (commit) => { const value=await accept(commit); if (at==="native") f.receipt.resolve(f.exit); return value; };
    if (at==="release") f.session.release=() => { throw new Error("GO delivery failed"); };
    const outcome=await f.controller().run(f.session,f.caller.signal,"payload");
    assert.equal(outcome.state,"closed"); if (outcome.state==="closed") assert.equal(outcome.authorityLost,true);
    assert.equal(f.counts.releases,0);
  }
});

it("replayed periodic challenge epochs and nonces stop before another DB heartbeat",{ timeout:2000 },async () => {
  for (const change of [{ epoch:1 },{ epoch:3 },{ epoch:Number.MAX_SAFE_INTEGER+1 },{ nonce:"1".repeat(32) }]) {
    const f=fixture(); f.session.release=() => {};
    f.session.requestLeaseChallenge=async () => ({ nonce:"2".repeat(32),epoch:2,...change });
    const outcome=await f.controller().run(f.session,f.caller.signal,"payload");
    assert.equal(outcome.state,"closed"); if (outcome.state==="closed") assert.equal(outcome.authorityLost,true);
    assert.equal(f.trace.filter((value) => value.startsWith("db-ack:")).length,1); assert.equal(f.commits.length,1);
  }
});

it("cancellation while initial load, DB ACK or native ACK is blocked stops immediately and awaits settlement",{ timeout:2000 },async () => {
  for (const at of ["load","database","native"]) {
    const f=fixture(),load=f.writers.load,heartbeat=f.writers.heartbeat,accept=f.session.acceptLease;
    const entered=deferred<void>(),settle=deferred<void>(); let finished=false;
    f.writers.load=async () => { const value=await load(); if (at==="load") { entered.resolve(); await settle.promise; } return value; };
    f.writers.heartbeat=async () => { const value=await heartbeat(); if (at==="database") { entered.resolve(); await settle.promise; } return value; };
    f.session.acceptLease=async (commit) => { const value=await accept(commit); if (at==="native") { entered.resolve(); await settle.promise; } return value; };
    const running=f.controller().run(f.session,f.caller.signal,"payload").then((value) => { finished=true; return value; });
    await entered.promise; f.caller.abort(); assert.equal(f.counts.stops,1);
    await Promise.resolve(); await Promise.resolve(); assert.equal(finished,false);
    settle.resolve(); const outcome=await running;
    assert.equal(outcome.state,"closed"); if (outcome.state==="closed") assert.equal(outcome.authorityLost,true);
    assert.equal(f.counts.releases,0); assert.equal(f.commits.length,at==="native" ? 1 : 0);
  }
});

it("cancellation during a periodic challenge or native acceptance suppresses late success without detaching it",{ timeout:2000 },async () => {
  for (const at of ["challenge","native"]) {
    const f=fixture(),challenge=f.session.requestLeaseChallenge,accept=f.session.acceptLease;
    const entered=deferred<void>(),settle=deferred<void>(); let finished=false,calls=0;
    f.session.release=() => {};
    f.session.requestLeaseChallenge=async () => { const value=await challenge(); if (at==="challenge") { entered.resolve(); await settle.promise; } return value; };
    f.session.acceptLease=async (commit) => { const value=await accept(commit); if (++calls===2 && at==="native") { entered.resolve(); await settle.promise; } return value; };
    const running=f.controller().run(f.session,f.caller.signal,"payload").then((value) => { finished=true; return value; });
    await entered.promise; f.caller.abort(); assert.equal(f.counts.stops,1);
    await Promise.resolve(); await Promise.resolve(); assert.equal(finished,false);
    settle.resolve(); const outcome=await running;
    assert.equal(outcome.state,"closed"); if (outcome.state==="closed") assert.equal(outcome.authorityLost,true);
    assert.equal(f.commits.length,at==="native" ? 2 : 1);
  }
});

it("a native failed or terminated receipt preserves exact stop evidence but denies result authority",async () => {
  for (const change of [{ failed:true },{ terminated:true,exitCode:137 }]) {
    const f=fixture(),exit={ ...f.exit,...change }; f.session.release=() => f.receipt.resolve(exit);
    assert.deepEqual(await f.controller().run(f.session,f.caller.signal,"payload"),{ state:"closed",exit,authorityLost:true });
  }
});

it("changing the supplied store owner cannot transfer a controller's original authority",async () => {
  const f=fixture(),controller=f.controller();
  f.writers.authority.sessionId=createStableId("workerHostSession");
  f.lease={ ...f.lease,ownerSessionId:f.writers.authority.sessionId };
  const outcome=await controller.run(f.session,f.caller.signal,"payload");
  assert.equal(outcome.state,"closed"); if (outcome.state==="closed") assert.equal(outcome.authorityLost,true);
  assert.equal(f.commits.length,0); assert.equal(f.counts.releases,0);
});
