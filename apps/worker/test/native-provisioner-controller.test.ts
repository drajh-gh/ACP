import assert from "node:assert/strict";
import { it } from "node:test";
import { getEventListeners } from "node:events";
import { createStableId } from "@acp/domain";
import type { ProvisionerAdmissionAcknowledgement,ProvisionerAdmissionRequest,ProvisionerStopRecordInput,ProvisionerStopRecord } from "@acp/storage";
import { NativeProvisionerAdmissionController,type NativeProvisionerSession } from "../src/native-provisioner-controller.ts";

function fixture() {
  const abort=new AbortController(),closed=Promise.withResolvers<ProvisionerStopRecordInput>(),trace=["native:challenge"],authority={ hostIdentifier:"host:provisioner-controller",sessionId:createStableId("workerHostSession"),applicationVersion:"controller-test" };
  const request:ProvisionerAdmissionRequest={ attemptId:createStableId("worktreeProvisionerAttempt"),fence:{ namespace:"acp-worktree-provisioner-v1",
    directory:"C:\\ACP-controller-fences",directoryIdentity:"win32-dir:12345678:1234567812345678",
    scope:{ machineFingerprint:"b".repeat(64),bootedAt:"2026-09-06T00:00:00.000Z",sessionId:1 } },
    root:{ processId:1234,processStartToken:"win32-filetime:134331300001234567",startedAt:"2026-09-06T01:00:00.1234567Z" },challenge:{ nonce:"c".repeat(32),epoch:1 } };
  const expectedPlan={ reservationId:createStableId("worktreeReservation"),reservationRevision:1,deadlineAt:"2026-09-06T01:00:15.123456Z",provenanceId:createStableId("provenance") };
  let ack:ProvisionerAdmissionAcknowledgement={ ...structuredClone(request),...expectedPlan,fresh:true,hostIdentifier:authority.hostIdentifier,ownerSessionId:authority.sessionId,
    applicationVersion:authority.applicationVersion,treeIdentifier:`Local\\ACP.Provisioner.${request.attemptId}`,rootClaimOwnerId:request.attemptId,
    admittedAt:"2026-09-06T01:00:01.123456Z",durationMilliseconds:14000 };
  const stop:ProvisionerStopRecordInput={ attemptId:request.attemptId,fence:structuredClone(request.fence),observation:{ state:"terminated",sealed:true,reason:"exact_owned_tree_terminated",exitCode:0,root:structuredClone(request.root) } };
  let admissions=0,acceptances=0,go=0,terminations=0,stops=0;
  const database={ authority,async admit(input:ProvisionerAdmissionRequest){ admissions++; trace.push("db:admit"); assert.deepEqual(input,request); return structuredClone(ack); } };
  const journal={ authority,async recordStop(input:ProvisionerStopRecordInput):Promise<ProvisionerStopRecord>{ stops++; trace.push("db:stop"); assert.deepEqual(input,stop);
    return { ...structuredClone(input),hostIdentifier:authority.hostIdentifier,ownerSessionId:authority.sessionId,applicationVersion:authority.applicationVersion,
      provenanceId:expectedPlan.provenanceId,treeIdentifier:ack.treeIdentifier,recordedAt:"2026-09-06T01:00:16.123456Z" }; } };
  const session:NativeProvisionerSession={ request:structuredClone(request),expectedPlan:{ ...expectedPlan },closed:closed.promise,
    async acceptAdmission(value){ acceptances++; trace.push("native:accept"); assert.deepEqual(value,ack); return { attemptId:value.attemptId,fence:structuredClone(value.fence),root:structuredClone(value.root),challenge:{ ...value.challenge },reservationRevision:value.reservationRevision }; },
    go(){ go++; trace.push("native:go"); closed.resolve(structuredClone(stop)); },
    async terminate(){ terminations++; trace.push("native:terminate"); closed.resolve(structuredClone(stop)); } };
  const controller=(maximumWaitMilliseconds=20000)=>new NativeProvisionerAdmissionController(database,journal,{ maximumWaitMilliseconds });
  return { abort,closed,trace,request,expectedPlan,stop,database,journal,session,controller,
    get ack(){ return ack; },set ack(value){ ack=value; },get counts(){ return { admissions,acceptances,go,terminations,stops }; } };
}
async function turns() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
async function checkedAndDrained<T>(observe:()=>Promise<void>,drain:()=>Promise<T>):Promise<T> {
  let failed=false,primary:unknown;
  try { await observe(); } catch(error) { failed=true; primary=error; }
  let result:T;
  try { result=await drain(); } catch(cleanup) { if(failed) throw new AggregateError([primary,cleanup],"fixture assertion and cleanup failed",{ cause:primary }); throw cleanup; }
  if(failed) throw primary; return result;
}
it("fresh admission and matching native acceptance precede one GO, exact closure and durable stop",async()=>{
  const f=fixture(),result=await f.controller().run(f.session,f.abort.signal);
  assert.equal(result.state,"stop_recorded"); assert.equal(result.authorityLost,false); assert.equal(result.goAttempted,true);
  assert.deepEqual(f.trace,["native:challenge","db:admit","native:accept","native:go","db:stop"]);
  assert.deepEqual(f.counts,{ admissions:1,acceptances:1,go:1,terminations:0,stops:1 });
});
it("pre-abort terminates the already-owned root and records only its confirmed stop",async()=>{
  const f=fixture(); f.abort.abort(); const result=await f.controller().run(f.session,f.abort.signal);
  assert.equal(result.state,"stop_recorded"); assert.equal(result.authorityLost,true); assert.equal(result.goAttempted,false);
  assert.deepEqual(f.counts,{ admissions:0,acceptances:0,go:0,terminations:1,stops:1 });
});
it("abort during pending admission starts termination immediately and drains the late ACK before stop persistence",async()=>{
  const f=fixture(),pending=Promise.withResolvers<ProvisionerAdmissionAcknowledgement>(),admit=f.database.admit; let settled=false;
  f.database.admit=async(input)=>{ await admit(input); return pending.promise; };
  const running=f.controller().run(f.session,f.abort.signal).then((result)=>{ settled=true; return result; });
  const result=await checkedAndDrained(async()=>{
    await turns(); f.abort.abort(); await turns();
    assert.equal(f.counts.terminations,1); assert.equal(f.counts.stops,0); assert.equal(settled,false);
  },async()=>{ pending.resolve(f.ack); return running; });
  assert.equal(result.state,"stop_recorded"); assert.equal(result.authorityLost,true); assert.equal(f.counts.acceptances,0); assert.equal(f.counts.go,0);
});
it("lost admission acknowledgement never causes native acceptance, retry, readback or GO",async()=>{
  const f=fixture(); f.database.admit=async()=>{ f.trace.push("db:uncertain"); throw new Error("lost actual COMMIT"); };
  const result=await f.controller().run(f.session,f.abort.signal);
  assert.equal(result.state,"stop_recorded"); assert.equal(result.authorityLost,true); assert.equal(f.counts.go,0); assert.equal(f.counts.acceptances,0);
  assert.deepEqual(f.trace,["native:challenge","db:uncertain","native:terminate","db:stop"]);
});
it("one owned session cannot be consumed by concurrent or later controller invocations",async()=>{
  const f=fixture(),pending=Promise.withResolvers<ProvisionerAdmissionAcknowledgement>(),admit=f.database.admit;
  f.database.admit=async(input)=>{ await admit(input); return pending.promise; };
  const controller=f.controller(),running=controller.run(f.session,f.abort.signal); await turns();
  await checkedAndDrained(async()=>{
    await assert.rejects(controller.run(f.session,new AbortController().signal),/already consumed/u);
    await assert.rejects(f.controller().run(f.session,f.abort.signal),/already consumed/u); assert.equal(f.counts.terminations,0);
  },async()=>{ pending.resolve(f.ack); return running; });
  await assert.rejects(controller.run(f.session,f.abort.signal),/already consumed/u); assert.equal(f.counts.admissions,1); assert.equal(f.counts.go,1);
});
it("every immutable ACK field and exact microsecond duration are checked before native acceptance",async()=>{
  const changes:Partial<ProvisionerAdmissionAcknowledgement>[]=[{ fresh:false as never },{ attemptId:createStableId("worktreeProvisionerAttempt") },
    { hostIdentifier:"other" },{ ownerSessionId:createStableId("workerHostSession") },{ applicationVersion:"other" },{ provenanceId:createStableId("provenance") },
    { treeIdentifier:"Local\\ACP.Provisioner.other" },{ rootClaimOwnerId:createStableId("worktreeProvisionerAttempt") },{ reservationId:createStableId("worktreeReservation") },
    { reservationRevision:2 },{ deadlineAt:"2026-09-06T01:00:15.123457Z" },{ admittedAt:"2026-09-06T01:00:01.123457Z" },
    { durationMilliseconds:13999 },{ durationMilliseconds:250 },{ durationMilliseconds:20001 },{ durationMilliseconds:14000.5 }];
  for(const change of changes) {
    const f=fixture(); f.ack={ ...f.ack,...change }; const result=await f.controller().run(f.session,f.abort.signal);
    assert.equal(result.authorityLost,true,JSON.stringify(change)); assert.equal(f.counts.acceptances,0); assert.equal(f.counts.go,0); assert.equal(f.counts.terminations,1);
  }
  for(const change of ["root","fence","scope","nonce","epoch","extra"]) {
    const f=fixture(),ack=structuredClone(f.ack);
    if(change==="root") Object.assign(ack.root,{ processId:9999 });
    if(change==="fence") Object.assign(ack.fence,{ directoryIdentity:"win32-dir:12345678:1234567812345679" });
    if(change==="scope") Object.assign(ack.fence.scope,{ sessionId:2 });
    if(change==="nonce") Object.assign(ack.challenge,{ nonce:"d".repeat(32) });
    if(change==="epoch") Object.assign(ack.challenge,{ epoch:2 });
    if(change==="extra") Object.assign(ack,{ permission:"go" });
    f.ack=ack; await f.controller().run(f.session,f.abort.signal); assert.equal(f.counts.acceptances,0,change); assert.equal(f.counts.go,0);
  }
});
it("equivalent timezone spelling retains exact original microseconds without extending the budget",async()=>{
  const f=fixture(); f.ack={ ...f.ack,deadlineAt:"2026-09-06T03:00:15.123456+02:00",admittedAt:"2026-09-06T03:00:01.123456+02:00" };
  f.session.acceptAdmission=async(value)=>({ attemptId:value.attemptId,fence:value.fence,root:value.root,challenge:value.challenge,reservationRevision:value.reservationRevision });
  const result=await f.controller().run(f.session,f.abort.signal); assert.equal(result.state,"stop_recorded"); assert.equal(result.authorityLost,false); assert.equal(f.counts.go,1);
});
it("native acceptance must match the same root, fence, nonce, epoch, attempt and revision",async()=>{
  for(const change of ["attempt","root","fence","nonce","epoch","revision","extra","reject"]) {
    const f=fixture(),accept=f.session.acceptAdmission;
    f.session.acceptAdmission=async(ack)=>{
      const value=await accept(ack);
      if(change==="reject") throw new Error("native bootstrap or epoch expired");
      if(change==="attempt") Object.assign(value,{ attemptId:createStableId("worktreeProvisionerAttempt") });
      if(change==="root") Object.assign(value.root,{ processId:9999 });
      if(change==="fence") Object.assign(value.fence,{ directoryIdentity:"win32-dir:12345678:1234567812345679" });
      if(change==="nonce") Object.assign(value.challenge,{ nonce:"d".repeat(32) });
      if(change==="epoch") Object.assign(value.challenge,{ epoch:2 });
      if(change==="revision") Object.assign(value,{ reservationRevision:value.reservationRevision+1 });
      if(change==="extra") Object.assign(value,{ accepted:true });
      return value;
    };
    const result=await f.controller().run(f.session,f.abort.signal); assert.equal(result.authorityLost,true,change); assert.equal(f.counts.go,0); assert.equal(f.counts.terminations,1);
  }
});
it("abort during native acceptance immediately terminates and drains the late native reply",async()=>{
  const f=fixture(),pending=Promise.withResolvers<Awaited<ReturnType<NativeProvisionerSession["acceptAdmission"]>>>(),entered=Promise.withResolvers<void>(),accept=f.session.acceptAdmission;
  f.session.acceptAdmission=async(ack)=>{ await accept(ack); entered.resolve(); return pending.promise; };
  const running=f.controller().run(f.session,f.abort.signal);
  const result=await checkedAndDrained(async()=>{
    await entered.promise; f.abort.abort(); await turns(); assert.equal(f.counts.terminations,1); assert.equal(f.counts.stops,0); assert.equal(f.counts.go,0);
  },async()=>{ pending.resolve({ ...structuredClone(f.request),reservationRevision:1 }); return running; });
  assert.equal(result.state,"stop_recorded"); assert.equal(result.authorityLost,true); assert.equal(f.counts.go,0);
});
it("already-closed native ownership never starts admission and pending closure cannot cause a late GO",async()=>{
  const f=fixture(); f.closed.resolve(f.stop); const result=await f.controller().run(f.session,f.abort.signal);
  assert.equal(result.state,"stop_recorded"); assert.equal(result.authorityLost,true); assert.equal(f.counts.admissions,0); assert.equal(f.counts.go,0);
  const g=fixture(),pending=Promise.withResolvers<ProvisionerAdmissionAcknowledgement>(),admit=g.database.admit;
  g.database.admit=async(input)=>{ await admit(input); return pending.promise; };
  const running=g.controller().run(g.session,g.abort.signal);
  await checkedAndDrained(async()=>{
    await turns(); g.closed.resolve(g.stop); await turns(); assert.equal(g.counts.stops,0);
  },async()=>{ pending.resolve(g.ack); return running; });
  assert.equal(g.counts.go,0); assert.equal(g.counts.acceptances,0); assert.equal(g.counts.stops,1);
});
it("a GO throw is an uncertain attempt, never a retry or fabricated success",async()=>{
  const f=fixture(); f.session.go=()=>{ f.trace.push("native:go-uncertain"); throw new Error("GO write uncertain"); };
  const result=await f.controller().run(f.session,f.abort.signal); assert.equal(result.goAttempted,true); assert.equal(result.authorityLost,true);
  assert.equal(f.trace.filter((value)=>value==="native:go-uncertain").length,1); assert.equal(f.counts.terminations,1); assert.equal(f.counts.stops,1);
});
it("terminate resolution cannot replace pending or rejected native closure evidence",async()=>{
  const f=fixture(); let terminated=false,settled=false;
  f.session.terminate=async()=>{ terminated=true; }; f.abort.abort();
  const running=f.controller().run(f.session,f.abort.signal).then((result)=>{ settled=true; return result; }); await turns();
  const result=await checkedAndDrained(async()=>{ assert.equal(terminated,true); assert.equal(settled,false); assert.equal(f.counts.stops,0); },
    async()=>{ f.closed.reject(new Error("unconfirmed native descendants")); return running; });
  assert.equal(result.state,"unconfirmed"); assert.equal(f.counts.stops,0); assert.equal(getEventListeners(f.abort.signal,"abort").length,0);
});
it("rootless, malformed or substituted closure cannot be persisted as an owned stop",async()=>{
  for(const change of ["rootless","root","fence","attempt","unsealed","extra"]) {
    const f=fixture(),bad=structuredClone(f.stop);
    if(change==="rootless") Object.assign(bad,{ observation:{ state:"lost",sealed:true,reason:"sealed_launch_job_empty" } });
    if(change==="root") Object.assign((bad.observation as { root:object }).root,{ processId:9999 });
    if(change==="fence") Object.assign(bad.fence,{ directoryIdentity:"win32-dir:12345678:1234567812345679" });
    if(change==="attempt") Object.assign(bad,{ attemptId:createStableId("worktreeProvisionerAttempt") });
    if(change==="unsealed") Object.assign(bad.observation,{ sealed:false });
    if(change==="extra") Object.assign(bad,{ treeEmpty:true });
    f.session.go=()=>{ f.closed.resolve(bad); };
    const result=await f.controller().run(f.session,f.abort.signal); assert.equal(result.state,"unconfirmed",change); assert.equal(f.counts.stops,0); assert.equal(f.counts.terminations,1);
  }
});
it("stop persistence failure retains physical closure without claiming a durable receipt",async()=>{
  for(const kind of ["throw","owner","root","timestamp"]) {
    const f=fixture(),record=f.journal.recordStop;
    f.journal.recordStop=async(input)=>{
      const value=await record(input); if(kind==="throw") throw new Error("lost stop COMMIT");
      if(kind==="owner") Object.assign(value,{ ownerSessionId:createStableId("workerHostSession") });
      if(kind==="root") Object.assign((value.observation as { root:object }).root,{ processId:9999 });
      if(kind==="timestamp") Object.assign(value,{ recordedAt:"tomorrow" });
      return value;
    };
    const result=await f.controller().run(f.session,f.abort.signal); assert.equal(result.state,"closed_stop_unconfirmed",kind);
    if(result.state==="closed_stop_unconfirmed") assert.deepEqual(result.observation,f.stop);
    assert.equal(f.counts.stops,1); assert.equal(getEventListeners(f.abort.signal,"abort").length,0);
  }
});
it("abort during stop persistence drains the request and keeps failure sticky",async()=>{
  const f=fixture(),pending=Promise.withResolvers<ProvisionerStopRecord>(),entered=Promise.withResolvers<ProvisionerStopRecord>(),record=f.journal.recordStop; let settled=false;
  f.journal.recordStop=async(input)=>{ entered.resolve(await record(input)); return pending.promise; };
  const running=f.controller().run(f.session,f.abort.signal).then((result)=>{ settled=true; return result; }); const receipt=await entered.promise;
  const result=await checkedAndDrained(async()=>{ f.abort.abort(); await turns(); assert.equal(settled,false); assert.equal(f.counts.terminations,0); },
    async()=>{ pending.resolve(receipt); return running; });
  assert.equal(result.state,"stop_recorded"); assert.equal(result.authorityLost,true); assert.equal(getEventListeners(f.abort.signal,"abort").length,0);
});
it("local timeout requests stop immediately but does not abandon a pending bounded database operation",async()=>{
  const f=fixture(),pending=Promise.withResolvers<ProvisionerAdmissionAcknowledgement>(),terminated=Promise.withResolvers<void>(),admit=f.database.admit,terminate=f.session.terminate;
  f.database.admit=async(input)=>{ await admit(input); return pending.promise; };
  f.session.terminate=async()=>{ await terminate(); terminated.resolve(); };
  const running=f.controller(10).run(f.session,f.abort.signal);
  const result=await checkedAndDrained(async()=>{ await terminated.promise; assert.equal(f.counts.stops,0); assert.equal(f.counts.go,0); },
    async()=>{ pending.resolve(f.ack); return running; });
  assert.equal(result.authorityLost,true); assert.equal(result.state,"stop_recorded");
});
it("request and expected plan snapshots cannot drift across a pending native session",async()=>{
  const f=fixture(),pending=Promise.withResolvers<ProvisionerAdmissionAcknowledgement>(),admit=f.database.admit;
  f.database.admit=async(input)=>{ await admit(input); return pending.promise; };
  const running=f.controller().run(f.session,f.abort.signal);
  const result=await checkedAndDrained(async()=>{
    await turns(); Object.assign(f.session.request.root,{ processId:9999 }); Object.assign(f.session.request.fence.scope,{ sessionId:2 }); Object.assign(f.session.request.challenge,{ nonce:"d".repeat(32) });
    Object.assign(f.session.expectedPlan,{ deadlineAt:"2099-01-01T00:00:00.000000Z",reservationRevision:2 });
  },async()=>{ pending.resolve(f.ack); return running; });
  assert.equal(result.state,"stop_recorded"); assert.equal(result.authorityLost,false); assert.equal(f.counts.go,1);
});
it("invalid controller owners and timeout options are rejected before any owned-session operation",()=>{
  const f=fixture();
  assert.throws(()=>new NativeProvisionerAdmissionController(f.database,{ ...f.journal,authority:{ ...f.journal.authority,sessionId:createStableId("workerHostSession") } }),/same original owner/u);
  for(const maximumWaitMilliseconds of [0,20001,1.5,NaN,Infinity]) assert.throws(()=>f.controller(maximumWaitMilliseconds),/wait must/u);
  assert.deepEqual(f.counts,{ admissions:0,acceptances:0,go:0,terminations:0,stops:0 });
});
it("synchronous cancellation re-entry during termination requests stop once and drains that same operation",async()=>{
  const f=fixture(),pending=Promise.withResolvers<void>(); let calls=0;
  f.database.admit=async()=>{ throw new Error("admission denied"); };
  f.session.terminate=async()=>{ calls++; f.abort.abort(); await pending.promise; f.closed.resolve(f.stop); };
  const running=f.controller().run(f.session,f.abort.signal);
  await checkedAndDrained(async()=>{ await turns(); assert.equal(calls,1); assert.equal(f.counts.stops,0); },async()=>{ pending.resolve(); return running; });
  assert.equal(f.counts.stops,1); assert.equal(getEventListeners(f.abort.signal,"abort").length,0);
});
it("invalid request or expected-plan values still clean up already-owned native resources",async()=>{
  for(const change of ["root","nonce","plan-id","plan-revision","plan-deadline"]) {
    const f=fixture();
    if(change==="root") Object.assign(f.session.request.root,{ processId:0 });
    if(change==="nonce") Object.assign(f.session.request.challenge,{ nonce:"invalid" });
    if(change==="plan-id") Object.assign(f.session.expectedPlan,{ reservationId:createStableId("run") });
    if(change==="plan-revision") Object.assign(f.session.expectedPlan,{ reservationRevision:0 });
    if(change==="plan-deadline") Object.assign(f.session.expectedPlan,{ deadlineAt:"tomorrow" });
    const result=await f.controller().run(f.session,f.abort.signal);
    assert.equal(result.authorityLost,true,change); assert.equal(f.counts.terminations,1); assert.equal(f.counts.admissions,0); assert.equal(f.counts.go,0);
    assert.equal(result.state,change==="root" || change==="nonce" ? "unconfirmed" : "stop_recorded");
    assert.equal(getEventListeners(f.abort.signal,"abort").length,0);
  }
});
it("the original store owner is snapshotted instead of adopting later mutable port configuration",async()=>{
  const f=fixture(),owner={ ...f.database.authority },pending=Promise.withResolvers<ProvisionerAdmissionAcknowledgement>(),admit=f.database.admit,record=f.journal.recordStop;
  f.database.admit=async(input)=>{ await admit(input); return pending.promise; };
  f.journal.recordStop=async(input)=>({ ...await record(input),hostIdentifier:owner.hostIdentifier,ownerSessionId:owner.sessionId,applicationVersion:owner.applicationVersion });
  const running=f.controller().run(f.session,f.abort.signal);
  const result=await checkedAndDrained(async()=>{
    await turns(); Object.assign(f.database.authority,{ hostIdentifier:"other",sessionId:createStableId("workerHostSession"),applicationVersion:"other" });
  },async()=>{ pending.resolve(f.ack); return running; });
  assert.equal(result.state,"stop_recorded"); assert.equal(result.authorityLost,false); assert.equal(f.counts.go,1);
});
