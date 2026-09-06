import assert from "node:assert/strict";
import { EventEmitter,getEventListeners } from "node:events";
import { PassThrough,Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { it } from "node:test";
import { WindowsProvisionerProcessOwner } from "../src/windows-provisioner-process.ts";
import { provisionerChannelBinding,snapshotNativeProvisionerPlan } from "../src/native-provisioner-plan.ts";
import { provisionerPlanFixture } from "./provisioner-plan-fixture.ts";
import type { ProvisionerAdmissionAcknowledgement,ProvisionerAdmissionRequest,ProvisionerStopRecordInput } from "@acp/storage";

const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
function fixture(options:{holdWrite?:boolean;throwWrite?:boolean;throwKill?:boolean;grace?:number}={}) {
  const plan=snapshotNativeProvisionerPlan(provisionerPlanFixture()),binding=provisionerChannelBinding(plan),abort=new AbortController();
  const child=new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout=new PassThrough(),stderr=new PassThrough();const writes:string[]=[];let killed=0,finishWrite:((error?:Error|null)=>void)|undefined;
  const stdin=new Writable({write(chunk:Buffer,_encoding,done){writes.push(chunk.toString("utf8"));if(options.throwWrite)done(new Error("synthetic pipe failure"));else if(options.holdWrite)finishWrite=done;else done();}});
  Object.assign(child,{stdout,stderr,stdin,pid:1234,exitCode:null,signalCode:null,kill(){killed++;if(options.throwKill)throw new Error("synthetic kill failed");physical(137);return true;}});
  function physical(code=0,signal:NodeJS.Signals|null=null){Object.assign(child,{exitCode:code,signalCode:signal});child.emit("exit",code,signal);stdin.destroy();stdout.destroy();stderr.destroy();child.emit("close",code,signal);}
  const request:ProvisionerAdmissionRequest={attemptId:plan.attemptId,fence:{...plan.fencePlan,directoryIdentity:"win32-dir:12345678:0000000000000001",
    scope:{machineFingerprint:plan.machineFingerprint,bootedAt:"2026-09-06T00:00:00.000Z",sessionId:1}},
    root:{processId:5678,processStartToken:"win32-filetime:134331300001234567",startedAt:"2026-09-06T01:00:00.1234567Z"},challenge:{nonce:"c".repeat(32),epoch:1}};
  const stop:ProvisionerStopRecordInput={attemptId:plan.attemptId,fence:request.fence,observation:{state:"terminated",sealed:true,reason:"exact_owned_tree_terminated",root:request.root,exitCode:0}};
  const pids:number[]=[];
  const owner=new WindowsProvisionerProcessOwner(binding,'{"fixture":true}',{startupTimeoutMilliseconds:100,drainGraceMilliseconds:options.grace??10,maximumOutputBytes:65536,onSpawn:pid=>pids.push(pid)});
  const handle=owner.attach(child,abort.signal);
  const feed=(frame:unknown)=>stdout.write(JSON.stringify(frame)+"\n");
  async function ready(){feed({type:"ready",request});return handle.ready;}
  async function accepted(){const session=await ready();const admittedAt=new Date(Date.parse(plan.deadlineAt)-10000).toISOString().replace("Z","000Z");
    const ack:ProvisionerAdmissionAcknowledgement={...request,...binding.expectedPlan,fresh:true,hostIdentifier:plan.hostIdentifier,ownerSessionId:plan.ownerSessionId,
      applicationVersion:plan.applicationVersion,treeIdentifier:`Local\\ACP.Provisioner.${plan.attemptId}`,rootClaimOwnerId:plan.attemptId,admittedAt,durationMilliseconds:10000};
    const pending=session.acceptAdmission(ack);feed({type:"accepted",acceptance:{...request,reservationRevision:plan.reservationRevision}});await pending;return session;}
  return {plan,binding,child,stdout,stderr,stdin,writes,owner,handle,abort,request,stop,feed,ready,accepted,physical,pids,
    get killed(){return killed;},finishWrite(){finishWrite?.();}};
}
it("provisioner process ownership sends one launch frame, reports both identities and awaits actual child close",async t=>{
  // This case controls pre-deadline closure. A real event-loop turn can exceed
  // the fixture's 10 ms grace under load and correctly force an abort instead.
  t.mock.timers.enable({apis:["setTimeout"]});
  const f=fixture(),session=await f.accepted();session.go();let settled=false;void session.closed.then(()=>{settled=true;});
  assert.equal(getEventListeners(f.abort.signal,"abort").length,1);
  f.feed({type:"closed",failed:false,stop:f.stop});await Promise.resolve();assert.equal(settled,false);assert.deepEqual(f.pids,[1234,5678]);
  t.mock.timers.tick(9);assert.equal(settled,false);assert.equal(f.killed,0);
  assert.equal(f.writes.map(line=>(JSON.parse(line) as {type?:string}).type).includes("stop"),false);
  f.stdout.end();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(settled,false);assert.equal(f.handle.signal.aborted,false);
  f.physical();assert.deepEqual(await session.closed,f.stop);assert.equal(f.handle.signal.aborted,false);assert.equal(getEventListeners(f.abort.signal,"abort").length,0);t.mock.timers.tick(15);assert.equal(f.killed,0);
});
it("provisioner process owner bounds a stalled bridge after valid provisional closure without another command",async()=>{
  const f=fixture(),session=await f.accepted();session.go();f.feed({type:"closed",failed:false,stop:f.stop});
  assert.deepEqual(await session.closed,f.stop);assert.equal(f.killed,1);assert.equal(f.handle.signal.aborted,true);
  assert.equal(f.writes.some(line=>(JSON.parse(line) as {type?:string}).type==="stop"),false);
});
it("provisioner process owner aborts before READY, accepts only late owned identity and clears listeners",async()=>{
  const f=fixture();f.abort.abort();const session=await f.ready();assert.equal(f.handle.signal.aborted,true);
  assert.equal(f.writes.filter(line=>(JSON.parse(line) as {type?:string}).type==="stop").length,1);assert.throws(()=>session.go());
  f.feed({type:"closed",failed:true,stop:f.stop});f.physical();await session.closed;assert.equal(f.killed,0);assert.equal(getEventListeners(f.abort.signal,"abort").length,0);
});
it("provisioner process owner rejects missing READY only after physical cleanup",async()=>{
  const f=fixture();f.abort.abort();await assert.rejects(f.handle.ready);await assert.rejects(f.handle.closed);assert.equal(f.killed,1);
});
it("provisioner process owner bounds initialization silence and never invents rooted closure",async()=>{
  const f=fixture();await assert.rejects(f.handle.ready);await assert.rejects(f.handle.closed);assert.equal(f.killed,1);assert.equal(f.handle.signal.aborted,true);
});
it("provisioner process owner drains pending write completion at child close",async()=>{
  const f=fixture({holdWrite:true}),session=await f.ready();f.feed({type:"closed",failed:true,stop:f.stop});f.physical();
  assert.deepEqual(await session.closed,f.stop);f.finishWrite();assert.equal(f.handle.signal.aborted,true);await pause(15);assert.equal(f.killed,0);
});
it("provisioner process owner handles stdin failure and bounded stderr without leaking diagnostics",async()=>{
  for(const failure of ["stdin","stderr","process error"]){
    const f=fixture({throwWrite:failure==="stdin"});if(failure==="stderr")f.stderr.write(Buffer.alloc(65537));if(failure==="process error")f.child.emit("error",new Error("private credential-shaped diagnostic"));
    await assert.rejects(f.handle.closed,/unconfirmed/u);await assert.rejects(f.handle.ready);assert.equal(f.killed,1);
  }
});
it("provisioner process owner immediately revokes authority on stdout EOF without claiming process closure",async()=>{
  const f=fixture({grace:250});await f.ready();let closed=false;
  void f.handle.closed.then(()=>{closed=true;},()=>{closed=true;});
  try {
    f.stdout.end();await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(f.handle.signal.aborted,true);
    assert.equal(f.writes.filter(line=>(JSON.parse(line) as {type?:string}).type==="stop").length,1);
    assert.equal(closed,false);assert.equal(f.killed,0);
  } finally {f.physical();await f.handle.closed.catch(()=>{});}
});
it("provisioner process owner does not invent closure when OS termination throws",async()=>{
  const f=fixture({throwKill:true});await f.ready();let closed=false;
  void f.handle.closed.then(()=>{closed=true;},()=>{closed=true;});
  try {
    f.abort.abort();await pause(30);
    assert.equal(f.killed,1);assert.equal(closed,false);assert.equal(f.handle.signal.aborted,true);
    assert.equal(f.stdout.destroyed,true);assert.equal(f.stderr.destroyed,true);assert.equal(f.stdin.destroyed,true);
  } finally {f.physical();await f.handle.closed.catch(()=>{});}
});
