import assert from "node:assert/strict";
import { it } from "node:test";
import { createStableId } from "@acp/domain";
import type { ProvisionerAdmissionAcknowledgement,ProvisionerAdmissionRequest,ProvisionerStopRecordInput,WorktreeProvisionerAttempt } from "@acp/storage";
import type { NativeProvisionerSession } from "../src/native-provisioner-controller.ts";
import type { OwnedProvisionerHandle } from "../src/windows-provisioner-process.ts";
import { NativeProvisionerExecutor } from "../src/native-provisioner-executor.ts";
import { provisionerPlanFixture,utc6 } from "./provisioner-plan-fixture.ts";
import { provisionerChannelBinding } from "../src/native-provisioner-plan.ts";

const turn=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
function fixture() {
  const plan=provisionerPlanFixture(),binding=provisionerChannelBinding(plan),authority={...binding.owner};
  const caller=new AbortController(),native=new AbortController(),ready=Promise.withResolvers<NativeProvisionerSession>(),closed=Promise.withResolvers<ProvisionerStopRecordInput>();
  void ready.promise.catch(()=>{});void closed.promise.catch(()=>{});
  const request:ProvisionerAdmissionRequest={attemptId:plan.attemptId,fence:{...plan.fencePlan,directoryIdentity:"win32-dir:12345678:0000000000000001",
    scope:{machineFingerprint:plan.machineFingerprint,bootedAt:"2026-09-06T00:00:00.000Z",sessionId:1}},
    root:{processId:5678,processStartToken:"win32-filetime:134331300001234567",startedAt:"2026-09-06T01:00:00.1234567Z"},challenge:{nonce:"c".repeat(32),epoch:1}};
  const stop:ProvisionerStopRecordInput={attemptId:plan.attemptId,fence:request.fence,observation:{state:"terminated",sealed:true,reason:"exact_owned_tree_terminated",root:request.root,exitCode:0}};
  let loads=0,starts=0,admits=0,accepts=0,goes=0,stops=0,writes=0,loaded:WorktreeProvisionerAttempt|undefined=plan,started:WorktreeProvisionerAttempt|undefined;
  const admissionEntered=Promise.withResolvers<void>(),startedLatch=Promise.withResolvers<void>(),goEntered=Promise.withResolvers<void>(),stopEntered=Promise.withResolvers<void>();
  const ack=():ProvisionerAdmissionAcknowledgement=>({...request,...binding.expectedPlan,fresh:true,hostIdentifier:authority.hostIdentifier,ownerSessionId:authority.sessionId,
    applicationVersion:authority.applicationVersion,treeIdentifier:`Local\\ACP.Provisioner.${plan.attemptId}`,rootClaimOwnerId:plan.attemptId,
    admittedAt:utc6(Date.parse(plan.deadlineAt)-10000),durationMilliseconds:10000});
  const handle:OwnedProvisionerHandle={ready:ready.promise,closed:closed.promise,signal:native.signal,terminate(){stops++;stopEntered.resolve();return closed.promise.then(()=>{});},outputBytes(){return Buffer.alloc(0);}};
  const session:NativeProvisionerSession={request,expectedPlan:binding.expectedPlan,closed:closed.promise,async acceptAdmission(){accepts++;return {...request,reservationRevision:plan.reservationRevision};},
    go(){goes++;goEntered.resolve();},terminate:handle.terminate};
  const plans={authority,async load(){loads++;return loaded;}},runner={authority,async start(value:WorktreeProvisionerAttempt,signal:AbortSignal){
    assert.equal(signal,caller.signal);starts++;started=value;startedLatch.resolve();return handle;}};
  const admissions={authority,async admit(){admits++;admissionEntered.resolve();return ack();}},journal={authority,async recordStop(value:ProvisionerStopRecordInput){writes++;
    return {...value,hostIdentifier:authority.hostIdentifier,ownerSessionId:authority.sessionId,applicationVersion:authority.applicationVersion,
      provenanceId:plan.provenanceId,treeIdentifier:`Local\\ACP.Provisioner.${plan.attemptId}`,recordedAt:utc6(Date.now())};}};
  const executor=()=>new NativeProvisionerExecutor(plans,admissions,journal,runner);
  return {plan,binding,authority,caller,native,ready,closed,request,stop,handle,session,plans,runner,admissions,journal,executor,ack,
    admissionEntered,startedLatch,goEntered,stopEntered,get counts(){return {loads,starts,admits,accepts,goes,stops,writes};},get started(){return started;},
    set loaded(value:WorktreeProvisionerAttempt|undefined){loaded=value;},input:()=>({attemptId:plan.attemptId,signal:caller.signal})};
}
async function drained<T>(work:Promise<T>,observe:()=>Promise<void>,cleanup:()=>void):Promise<T> {
  let primary:unknown,failed=false;
  try{await observe();}catch(error){failed=true;primary=error;}finally{cleanup();}
  try{const result=await work;if(failed)throw primary;return result;}catch(error){if(failed && error!==primary)throw new AggregateError([primary,error],"assertion and owned executor failed");throw error;}
}
it("provisioner executor loads once, freezes the complete plan and persists stop only after fresh admission, GO and physical close",async()=>{
  const f=fixture(),work=f.executor().run(f.input());let settled=false;void work.then(()=>{settled=true;});
  const result=await drained(work,async()=>{
    await f.startedLatch.promise;assert.ok(Object.isFrozen(f.started));assert.ok(Object.isFrozen(f.started?.reportedParent));assert.deepEqual(f.started,f.plan);
    f.ready.resolve(f.session);await f.goEntered.promise;assert.equal(f.counts.writes,0);assert.equal(settled,false);
  },()=>f.closed.resolve(f.stop));
  assert.equal(result.state,"stop_recorded");assert.equal(result.authorityLost,false);assert.equal(result.goAttempted,true);
  assert.deepEqual(f.counts,{loads:1,starts:1,admits:1,accepts:1,goes:1,stops:0,writes:1});
});
it("provisioner executor rejects malformed caller selectors and authority mismatches before any I/O",async()=>{
  const f=fixture(),executor=f.executor();
  for(const input of [{...f.input(),command:"git"},{...f.input(),attemptId:createStableId("run")},{attemptId:f.plan.attemptId},{...f.input(),signal:{}},{signal:f.caller.signal},Object.create(f.input()) as unknown])
    await assert.rejects(executor.run(input as never));
  for(const port of ["plans","admissions","journal","runner"] as const)for(const field of ["hostIdentifier","sessionId","applicationVersion"]){
    const a={...f.authority,[field]:field==="sessionId"?createStableId("workerHostSession"):"different"};
    const ports={plans:f.plans,admissions:f.admissions,journal:f.journal,runner:f.runner};
    assert.throws(()=>new NativeProvisionerExecutor({...ports.plans,...(port==="plans"?{authority:a}:{})},{...ports.admissions,...(port==="admissions"?{authority:a}:{})},
      {...ports.journal,...(port==="journal"?{authority:a}:{})},{...ports.runner,...(port==="runner"?{authority:a}:{})}));
  }
  assert.deepEqual(f.counts,{loads:0,starts:0,admits:0,accepts:0,goes:0,stops:0,writes:0});
});
it("provisioner executor pre-abort does not load and abort during pending load drains it without spawning",async()=>{
  const first=fixture();first.caller.abort();assert.equal((await first.executor().run(first.input())).state,"not_started");assert.equal(first.counts.loads,0);
  const f=fixture(),loaded=Promise.withResolvers<WorktreeProvisionerAttempt>(),entered=Promise.withResolvers<void>();
  f.plans.load=async()=>{entered.resolve();return loaded.promise;};let settled=false;const work=f.executor().run(f.input()).then(result=>{settled=true;return result;});
  const result=await drained(work,async()=>{await entered.promise;f.caller.abort();await turn();assert.equal(settled,false);assert.equal(f.counts.starts,0);},()=>loaded.resolve(f.plan));
  assert.equal(result.state,"not_started");assert.equal(f.counts.starts,0);
});
it("provisioner executor rejects absent, recovering, expired, foreign and substituted stored plans before native launch",async()=>{
  for(const change of [undefined,{state:"recovering"},{deadlineAt:utc6(Date.now()-1)},{deadlineAt:utc6(Date.now()+60000)},
    {hostIdentifier:"other"},{ownerSessionId:createStableId("workerHostSession")},{applicationVersion:"other"},
    {attemptId:createStableId("worktreeProvisionerAttempt")},{permission:"go"}]) {
    const f=fixture();f.loaded=change===undefined?undefined:{...f.plan,...change} as WorktreeProvisionerAttempt;
    const result=await f.executor().run(f.input());assert.equal(result.state,"not_started");assert.equal(f.counts.loads,1);assert.equal(f.counts.starts,0);
  }
});
it("provisioner executor load and pre-spawn failures never retry or pretend a native tree exists",async()=>{
  for(const stage of ["load","start"]){const f=fixture();let calls=0;
    if(stage==="load")f.plans.load=async()=>{calls++;throw new Error("private database error");};else f.runner.start=async()=>{calls++;throw new Error("private spawn error");};
    const result=await f.executor().run(f.input());assert.equal(result.state,"not_started");assert.equal(calls,1);assert.equal(f.counts.stops,0);assert.equal(f.counts.writes,0);
    assert.equal(JSON.stringify(result).includes("private"),false);
  }
});
it("provisioner executor pins port methods and snapshots returned plan before later caller mutation",async()=>{
  const f=fixture(),executor=f.executor();f.plans.load=async()=>{assert.fail("mutated load");};f.runner.start=async()=>{assert.fail("mutated start");};
  f.admissions.admit=async()=>{assert.fail("mutated admit");};f.journal.recordStop=async()=>{assert.fail("mutated stop");};
  const work=executor.run(f.input());const result=await drained(work,async()=>{
    await f.startedLatch.promise;Object.assign(f.plan.reportedParent,{path:"C:\\changed"});assert.equal(f.started?.reportedParent.path,"C:\\ACP-workspaces");
    f.ready.resolve(f.session);await f.goEntered.promise;
  },()=>f.closed.resolve(f.stop));assert.equal(result.state,"stop_recorded");
});
it("provisioner executor abort before late READY stops immediately, drains physical closure and records without admission or GO",async()=>{
  const f=fixture(),work=f.executor().run(f.input());let settled=false;void work.then(()=>{settled=true;});
  const result=await drained(work,async()=>{
    await f.startedLatch.promise;await turn();f.caller.abort();await f.stopEntered.promise;assert.equal(f.counts.stops,1);assert.equal(settled,false);
    f.ready.resolve(f.session);await turn();assert.equal(f.counts.admits,0);assert.equal(f.counts.writes,0);
  },()=>f.closed.resolve(f.stop));
  assert.equal(result.state,"stop_recorded");assert.equal(result.authorityLost,true);assert.equal(result.goAttempted,false);assert.equal(f.counts.stops,1);
});
it("provisioner executor rejects mismatched READY binding before admission and drains the owned handle",async()=>{
  for(const change of ["attempt","plan","directory","machine","closed"]){
    const f=fixture(),work=f.executor().run(f.input());
    const result=await drained(work,async()=>{
      await f.startedLatch.promise;const session={...f.session,request:structuredClone(f.request),expectedPlan:{...f.session.expectedPlan}};
      if(change==="attempt")Object.assign(session.request,{attemptId:createStableId("worktreeProvisionerAttempt")});
      if(change==="plan")Object.assign(session.expectedPlan,{reservationRevision:8});
      if(change==="directory")Object.assign(session.request.fence,{directory:"C:\\elsewhere"});
      if(change==="machine")Object.assign(session.request.fence.scope,{machineFingerprint:"d".repeat(64)});
      if(change==="closed")session.closed=Promise.resolve(f.stop);
      f.ready.resolve(session);await f.stopEntered.promise;assert.equal(f.counts.admits,0);assert.equal(f.counts.writes,0);
    },()=>f.closed.resolve(f.stop));assert.equal(result.state,"unconfirmed");assert.equal(result.goAttempted,false);assert.equal(f.counts.stops,1);
  }
});
it("provisioner executor missing READY cannot return before owned process closure or manufacture a stop journal",async()=>{
  const f=fixture(),work=f.executor().run(f.input());let settled=false;void work.then(()=>{settled=true;});
  const result=await drained(work,async()=>{await f.startedLatch.promise;f.ready.reject(new Error("no valid READY"));await f.stopEntered.promise;await turn();assert.equal(settled,false);},()=>f.closed.reject(new Error("no rooted close")));
  assert.equal(result.state,"unconfirmed");assert.equal(f.counts.writes,0);
});
it("provisioner executor internal native authority loss stops during pending admission and drains its late reply before stop persistence",async()=>{
  const f=fixture(),admitted=Promise.withResolvers<ProvisionerAdmissionAcknowledgement>(),entered=Promise.withResolvers<void>();
  f.admissions.admit=async()=>{entered.resolve();return admitted.promise;};const work=f.executor().run(f.input());let settled=false;void work.then(()=>{settled=true;});
  const result=await drained(work,async()=>{
    await f.startedLatch.promise;f.ready.resolve(f.session);await entered.promise;f.native.abort();await f.stopEntered.promise;
    f.closed.resolve(f.stop);await turn();assert.equal(settled,false);assert.equal(f.counts.writes,0);assert.equal(f.counts.goes,0);
  },()=>{f.closed.resolve(f.stop);admitted.resolve(f.ack());});
  assert.equal(result.state,"stop_recorded");assert.equal(result.authorityLost,true);assert.equal(result.goAttempted,false);assert.equal(f.counts.stops,1);
});
it("provisioner executor lost admission acknowledgement never repairs authority through plan readback",async()=>{
  const f=fixture();f.admissions.admit=async()=>{throw new Error("committed but reply lost");};const work=f.executor().run(f.input());
  const result=await drained(work,async()=>{await f.startedLatch.promise;f.ready.resolve(f.session);await f.stopEntered.promise;assert.equal(f.counts.goes,0);},()=>f.closed.resolve(f.stop));
  assert.equal(result.state,"stop_recorded");assert.equal(result.authorityLost,true);assert.equal(f.counts.loads,1);assert.equal(f.counts.accepts,0);
});
it("provisioner executor retains physical evidence when durable stop acknowledgement is uncertain",async()=>{
  const f=fixture();f.journal.recordStop=async()=>{throw new Error("uncertain durable stop");};const work=f.executor().run(f.input());
  const result=await drained(work,async()=>{await f.startedLatch.promise;f.ready.resolve(f.session);await f.goEntered.promise;},()=>f.closed.resolve(f.stop));
  assert.equal(result.state,"closed_stop_unconfirmed");assert.equal(result.authorityLost,true);assert.equal(result.goAttempted,true);
});
it("provisioner executor cannot persist a substituted handle receipt before the originally owned physical closure",async()=>{
  const f=fixture(),work=f.executor().run(f.input());
  const result=await drained(work,async()=>{
    await f.startedLatch.promise;await turn();const substitute=Promise.resolve(f.stop);
    Object.assign(f.handle,{closed:substitute});f.ready.resolve({...f.session,closed:substitute});
    await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(f.counts.writes,0);
  },()=>f.closed.resolve(f.stop));
  assert.equal(result.state,"unconfirmed");assert.equal(f.counts.admits,0);assert.equal(f.counts.writes,0);
});
it("provisioner executor synchronous termination re-entry calls the owner only once",async()=>{
  const f=fixture(),terminate=f.handle.terminate.bind(f.handle);Object.assign(f.handle,{terminate(){f.native.abort();return terminate();}});
  const work=f.executor().run(f.input());const result=await drained(work,async()=>{
    await f.startedLatch.promise;await turn();f.caller.abort();await f.stopEntered.promise;f.ready.resolve(f.session);await turn();assert.equal(f.counts.stops,1);
  },()=>f.closed.resolve(f.stop));assert.equal(result.state,"stop_recorded");assert.equal(result.authorityLost,true);assert.equal(f.counts.stops,1);
});
it("provisioner executor throwing GO preserves an uncertain GO attempt and still awaits exact stop",async()=>{
  const f=fixture();f.session.go=()=>{throw new Error("uncertain GO delivery");};const work=f.executor().run(f.input());
  const result=await drained(work,async()=>{await f.startedLatch.promise;f.ready.resolve(f.session);await f.stopEntered.promise;assert.equal(f.counts.writes,0);},()=>f.closed.resolve(f.stop));
  assert.equal(result.state,"stop_recorded");assert.equal(result.goAttempted,true);assert.equal(result.authorityLost,true);assert.equal(f.counts.stops,1);
});
