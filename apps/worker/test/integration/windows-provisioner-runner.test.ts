import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { createStableId } from "@acp/domain";
import type { ProvisionerAdmissionRequest,ProvisionerStopRecordInput } from "@acp/storage";
import { NativeProvisionerAdmissionController } from "../../src/native-provisioner-controller.ts";
import { WindowsProvisionerProcessRunner } from "../../src/windows-provisioner-runner.ts";
import { nativeProvisionerRunnerProbe,syntheticProvisionerAck } from "./native-provisioner-runner-probe.ts";
import { gone } from "./native-lease-probe.ts";
import { utc6 } from "../provisioner-plan-fixture.ts";

it("provisioner runner core: fixed capsule and real channel/controller close before synthetic durable stop",{timeout:25000},async(t)=>{
  const p=await nativeProvisionerRunnerProbe();t.after(p.cleanup);const handle=await p.start();let ready=false;void handle.ready.then(()=>{ready=true;});
  await Promise.resolve();assert.equal(ready,false,"owned handle must not be hidden behind native READY");
  const session=await handle.ready;let admissions=0,writes=0;
  const controller=new NativeProvisionerAdmissionController({authority:p.authority,async admit(request:ProvisionerAdmissionRequest){
    admissions++;assert.match(await readFile(p.fenceFile,"utf8"),/\nclaimed\nroot\t/u);return syntheticProvisionerAck(request,p.plan);
  }},{authority:p.authority,async recordStop(stop:ProvisionerStopRecordInput){
    writes++;for(const pid of p.pids)await gone(pid);assert.match(await readFile(p.fenceFile,"utf8"),/\nsealed\n$/u);
    return {...stop,hostIdentifier:p.plan.hostIdentifier,ownerSessionId:p.plan.ownerSessionId,applicationVersion:p.plan.applicationVersion,
      provenanceId:p.plan.provenanceId,treeIdentifier:`Local\\ACP.Provisioner.${p.plan.attemptId}`,recordedAt:utc6(Date.now())};
  }});
  const outcome=await controller.run(session,AbortSignal.any([p.abort.signal,handle.signal]));assert.equal(outcome.state,"stop_recorded");assert.equal(outcome.authorityLost,false);
  assert.equal(admissions,1);assert.equal(writes,1);const output=JSON.parse(handle.outputBytes().toString("utf8")) as Record<string,unknown>;
  assert.deepEqual(output,{processId:session.request.root.processId,workspace:p.directory,plan:{attemptId:p.plan.attemptId,workspacePath:p.plan.workspacePath,
    branchRef:p.plan.branchRef,baseRevision:p.plan.baseRevision,reportedParent:p.plan.reportedParent,commonGitDirectory:p.plan.commonGitDirectory},leaked:false});
});
it("provisioner runner core: constructor and original-plan snapshots cannot be changed during pre-spawn I/O",{timeout:25000},async(t)=>{
  const p=await nativeProvisionerRunnerProbe();t.after(p.cleanup);const original=structuredClone(p.plan);
  p.options.runnerPath=join(p.directory,"missing.ts");p.options.powershellExecutable=join(p.directory,"missing.exe");p.authority.hostIdentifier="changed";
  const starting=p.start();Object.assign(p.plan,{reservationRevision:8,branchRef:"refs/heads/Changed"});Object.assign(p.plan.reportedParent,{path:"C:\\changed"});
  const handle=await starting,session=await handle.ready;await session.acceptAdmission(syntheticProvisionerAck(session.request,original));session.go();await session.closed;
  const output=JSON.parse(handle.outputBytes().toString("utf8")) as {plan:{branchRef:string}};assert.equal(output.plan.branchRef,original.branchRef);assert.equal(handle.signal.aborted,false);
});
it("provisioner runner core: real root exit 23 survives quiescent transport closure",{timeout:25000},async(t)=>{
  const p=await nativeProvisionerRunnerProbe("./synthetic-provisioner-exit.ts");t.after(p.cleanup);const handle=await p.start(),session=await handle.ready;
  await session.acceptAdmission(syntheticProvisionerAck(session.request,p.plan));session.go();const stop=await session.closed;
  assert.equal("exitCode" in stop.observation && stop.observation.exitCode,23);assert.equal(handle.signal.aborted,false);
});
it("provisioner runner core: pre-abort, foreign owner, recovering or missing artifact spawns no bridge",{timeout:15000},async(t)=>{
  const p=await nativeProvisionerRunnerProbe();t.after(p.cleanup);const count=p.pids.size;
  await assert.rejects(p.owner.start(p.plan,AbortSignal.abort()));
  for(const change of [{state:"recovering"},{ownerSessionId:createStableId("workerHostSession")},{hostIdentifier:"other"},{applicationVersion:"other"}])
    await assert.rejects(p.owner.start({...p.plan,...change} as never,new AbortController().signal));
  const missing=new WindowsProvisionerProcessRunner(p.authority,{...p.options,runnerPath:join(p.directory,"not-present.ts")});
  await assert.rejects(missing.start(p.plan,new AbortController().signal));assert.equal(p.pids.size,count);
});
it("provisioner runner core: completed same-attempt replay is denied before original expiry",{timeout:25000},async(t)=>{
  const p=await nativeProvisionerRunnerProbe();t.after(p.cleanup);const first=await p.start(),session=await first.ready;
  await session.acceptAdmission(syntheticProvisionerAck(session.request,p.plan));session.go();await session.closed;const retained=await readFile(p.fenceFile,"utf8");
  assert.ok(Date.parse(p.plan.deadlineAt)-Date.now()>5000);const replay=await p.start();await assert.rejects(replay.ready);await assert.rejects(replay.closed);
  assert.ok(Date.parse(p.plan.deadlineAt)>Date.now());assert.equal(await readFile(p.fenceFile,"utf8"),retained);
});
it("provisioner runner loss: cancellation before READY still drains a late exact native root without GO",{timeout:25000},async(t)=>{
  const p=await nativeProvisionerRunnerProbe();t.after(p.cleanup);const handle=await p.start();p.abort.abort();const session=await handle.ready;
  assert.equal(handle.signal.aborted,true);assert.throws(()=>session.go());const stop=await session.closed;
  assert.deepEqual("root" in stop.observation && stop.observation.root,session.request.root);assert.equal("exitCode" in stop.observation && stop.observation.exitCode,137);
  assert.equal(handle.outputBytes().length,0);for(const pid of p.pids)await gone(pid);
});
it("provisioner runner loss: cancellation after GO stops the owned non-reading root and closes every process",{timeout:25000},async(t)=>{
  const p=await nativeProvisionerRunnerProbe("./nonreading-owned-runner.ts");t.after(p.cleanup);const handle=await p.start(),session=await handle.ready;
  await session.acceptAdmission(syntheticProvisionerAck(session.request,p.plan));session.go();assert.doesNotThrow(()=>process.kill(session.request.root.processId,0));p.abort.abort();
  const stop=await session.closed;assert.equal("exitCode" in stop.observation && stop.observation.exitCode,137);assert.equal(handle.signal.aborted,true);
  for(const pid of p.pids)await gone(pid);
});
it("provisioner runner expiry: native bootstrap expires an unacknowledged root before its original deadline",{timeout:30000},async(t)=>{
  const p=await nativeProvisionerRunnerProbe();t.after(p.cleanup);const handle=await p.start(),session=await handle.ready,stop=await session.closed;
  assert.ok(Date.now()<Date.parse(p.plan.deadlineAt));assert.equal("exitCode" in stop.observation && stop.observation.exitCode,137);assert.equal(handle.signal.aborted,true);
});
it("provisioner runner expiry: a short original deadline is never replaced by a new twenty-second budget",{timeout:15000},async(t)=>{
  const p=await nativeProvisionerRunnerProbe();t.after(p.cleanup);Object.assign(p.plan,{deadlineAt:utc6(Date.now()+5000)});
  const handle=await p.start(),session=await handle.ready,stop=await session.closed;
  assert.ok(Date.now()<Date.parse(p.plan.deadlineAt)+2000);assert.equal("exitCode" in stop.observation && stop.observation.exitCode,137);assert.equal(handle.signal.aborted,true);
});
