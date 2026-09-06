import assert from "node:assert/strict";
import { it } from "node:test";
import { createStableId } from "@acp/domain";
import type { ProvisionerAdmissionAcknowledgement,ProvisionerAdmissionRequest,ProvisionerStopRecordInput } from "@acp/storage";
import { WindowsProvisionerChannel } from "../src/windows-provisioner-channel.ts";
import { NativeProvisionerAdmissionController } from "../src/native-provisioner-controller.ts";

function fixture(timeout=50) {
  const request:ProvisionerAdmissionRequest={attemptId:createStableId("worktreeProvisionerAttempt"),
    fence:{namespace:"acp-worktree-provisioner-v1",directory:"C:\\ACP ž 🚀",directoryIdentity:"win32-dir:12345678:1234567812345678",
      scope:{machineFingerprint:"b".repeat(64),bootedAt:"2026-09-06T00:00:00.000Z",sessionId:1}},
    root:{processId:1234,processStartToken:"win32-filetime:134331300001234567",startedAt:"2026-09-06T01:00:00.1234567Z"},challenge:{nonce:"c".repeat(32),epoch:1}};
  const expectedPlan={reservationId:createStableId("worktreeReservation"),reservationRevision:7,deadlineAt:"2026-09-06T01:00:15.123456Z",provenanceId:createStableId("provenance")};
  const owner={hostIdentifier:"host:channel",sessionId:createStableId("workerHostSession"),applicationVersion:"channel-test"};
  const binding={attemptId:request.attemptId,expectedPlan:structuredClone(expectedPlan),owner:{...owner},
    fencePlan:{namespace:request.fence.namespace,directory:request.fence.directory},machineFingerprint:request.fence.scope.machineFingerprint};
  const frames:unknown[]=[];let stops=0,drains=0,onSend:((frame:unknown)=>void)|undefined;
  const io={send(frame:unknown){frames.push(frame);onSend?.(frame);},stop(sendStop=true){drains++;if(sendStop)stops++;}};
  const channel=new WindowsProvisionerChannel(binding,io,{acknowledgementTimeoutMilliseconds:timeout,maximumOutputBytes:1024});
  const ack:ProvisionerAdmissionAcknowledgement={...structuredClone(request),...expectedPlan,fresh:true,hostIdentifier:owner.hostIdentifier,
    ownerSessionId:owner.sessionId,applicationVersion:owner.applicationVersion,treeIdentifier:`Local\\ACP.Provisioner.${request.attemptId}`,
    rootClaimOwnerId:request.attemptId,admittedAt:"2026-09-06T01:00:01.123456Z",durationMilliseconds:14000};
  const stop:ProvisionerStopRecordInput={attemptId:request.attemptId,fence:structuredClone(request.fence),
    observation:{state:"terminated",sealed:true,reason:"exact_owned_tree_terminated",root:structuredClone(request.root),exitCode:0}};
  const feed=(frame:unknown)=>channel.feed(Buffer.from(JSON.stringify(frame)+"\n"));
  async function ready(){feed({type:"ready",request});return channel.ready;}
  async function accepted(){const session=await ready(),pending=session.acceptAdmission(ack);feed({type:"accepted",acceptance:{...request,reservationRevision:7}});await pending;return session;}
  return {channel,binding,io,request,expectedPlan,owner,ack,stop,frames,feed,ready,accepted,get stops(){return stops;},get drains(){return drains;},set onSend(callback:(frame:unknown)=>void){onSend=callback;}};
}
const turn=async()=>{await Promise.resolve();await Promise.resolve();};
async function checkedAndDrained<T>(observe:()=>Promise<void>,drain:()=>Promise<T>):Promise<T> {
  let failed=false,primary:unknown;
  try{await observe();}catch(error){failed=true;primary=error;}
  let result:T;
  try{result=await drain();}catch(cleanup){if(failed)throw new AggregateError([primary,cleanup],"assertion and controller drain failed",{cause:primary});throw cleanup;}
  if(failed)throw primary;return result;
}
function controllerFixture(f:ReturnType<typeof fixture>) {
  let writes=0;
  const admissions={authority:f.owner,async admit(){return f.ack;}};
  const journal={authority:f.owner,async recordStop(stop:ProvisionerStopRecordInput){writes++;return {...stop,hostIdentifier:f.owner.hostIdentifier,ownerSessionId:f.owner.sessionId,
    applicationVersion:f.owner.applicationVersion,provenanceId:f.expectedPlan.provenanceId,treeIdentifier:f.ack.treeIdentifier,recordedAt:"2026-09-06T01:00:16.123456Z"};}};
  return {admissions,controller:()=>new NativeProvisionerAdmissionController(admissions,journal),get writes(){return writes;}};
}
it("provisioner channel and controller withhold durable stop until physical close and propagate native failure",async()=>{
  for(const failed of [false,true]) {
    const f=fixture(),session=await f.ready(),c=controllerFixture(f),go=Promise.withResolvers<void>();let settled=false;
    f.onSend=frame=>{
      if((frame as {type:string}).type==="admit")f.feed({type:"accepted",acceptance:{...f.request,reservationRevision:7}});
      else {f.feed({type:"closed",failed,stop:f.stop});go.resolve();}
    };
    const running=c.controller().run(session,AbortSignal.any([new AbortController().signal,f.channel.signal])).then(result=>{settled=true;return result;});
    const result=await checkedAndDrained(async()=>{
      await go.promise;await turn();assert.equal(c.writes,0);assert.equal(settled,false);assert.equal(f.channel.signal.aborted,failed);
    },async()=>{f.channel.transportClosed(failed?1:0,null);return running;});
    assert.equal(result.state,"stop_recorded");assert.equal(result.authorityLost,failed);assert.equal(result.goAttempted,true);assert.equal(c.writes,1);
  }
});
it("provisioner channel and controller drain pending DB admission after immediate cancellation and physical stop",async()=>{
  const f=fixture(),session=await f.ready(),c=controllerFixture(f),admission=Promise.withResolvers<ProvisionerAdmissionAcknowledgement>(),entered=Promise.withResolvers<void>(),abort=new AbortController();
  c.admissions.admit=async()=>{entered.resolve();return admission.promise;};let settled=false;
  const running=c.controller().run(session,AbortSignal.any([abort.signal,f.channel.signal])).then(result=>{settled=true;return result;});
  const result=await checkedAndDrained(async()=>{
    await entered.promise;abort.abort();assert.equal(f.stops,1);f.feed({type:"closed",failed:true,stop:f.stop});f.channel.transportClosed(0,null);
    await turn();assert.equal(settled,false);assert.equal(c.writes,0);assert.deepEqual(f.frames,[]);
  },async()=>{admission.resolve(f.ack);f.channel.transportClosed(0,null);return running;});
  assert.equal(result.state,"stop_recorded");assert.equal(result.authorityLost,true);assert.equal(result.goAttempted,false);assert.equal(c.writes,1);
});
it("provisioner channel protocol corruption after GO cannot become a controller stop receipt",async()=>{
  const f=fixture(),session=await f.ready(),c=controllerFixture(f);
  f.onSend=frame=>{
    if((frame as {type:string}).type==="admit")f.feed({type:"accepted",acceptance:{...f.request,reservationRevision:7}});
    else {f.channel.feed(Buffer.from('{"type":"invalid"}\n'));f.feed({type:"closed",failed:true,stop:f.stop});f.channel.transportClosed(0,null);}
  };
  const result=await c.controller().run(session,f.channel.signal);assert.equal(result.state,"unconfirmed");assert.equal(result.authorityLost,true);assert.equal(result.goAttempted,true);assert.equal(c.writes,0);
});
it("provisioner channel preserves exact READY and snapshots original binding",async()=>{
  const f=fixture();f.binding.expectedPlan.reservationRevision=8;f.binding.owner.applicationVersion="changed";f.binding.fencePlan.directory="C:\\other";
  const session=await f.ready();assert.deepEqual(session.request,f.request);assert.deepEqual(session.expectedPlan,f.expectedPlan);
  assert.ok(Object.isFrozen(session.request.root));assert.ok(Object.isFrozen(session.request.fence.scope));assert.ok(Object.isFrozen(session.expectedPlan));
  const pending=session.acceptAdmission(f.ack);f.feed({type:"accepted",acceptance:{...f.request,reservationRevision:7}});await pending;
  session.go();f.feed({type:"closed",failed:false,stop:f.stop});f.channel.transportClosed(0,null);assert.deepEqual(await session.closed,f.stop);
});
it("provisioner channel valid CLOSED is provisional until physical process and pipe close",async()=>{
  const f=fixture(),session=await f.accepted();session.go();let settled=false;void session.closed.then(()=>{settled=true;});
  f.feed({type:"closed",failed:false,stop:f.stop});await turn();assert.equal(settled,false);assert.equal(f.channel.signal.aborted,false);
  assert.throws(()=>session.go());f.channel.transportClosed(0,null);assert.deepEqual(await session.closed,f.stop);assert.equal(settled,true);
});
it("provisioner channel provisional terminal starts bounded physical drain without another wire command",async()=>{
  const f=fixture(),session=await f.accepted();session.go();f.feed({type:"closed",failed:false,stop:f.stop});
  assert.equal(f.drains,1);assert.equal(f.stops,0);
  let settled=false;void session.closed.catch(()=>{settled=true;});
  f.channel.feed(Buffer.from('{}\n'));f.channel.failTransport();await turn();
  assert.equal(f.drains,1);assert.equal(f.stops,0);assert.equal(settled,false);
  f.channel.transportClosed(1,null);await assert.rejects(session.closed);
});
it("provisioner channel native failure aborts before closure but retains exact stop even with exit one",async()=>{
  const f=fixture(),session=await f.accepted();session.go();let settled=false;void session.closed.then(()=>{settled=true;});
  f.channel.signal.addEventListener("abort",()=>{void session.terminate().catch(()=>{});});
  f.feed({type:"closed",failed:true,stop:f.stop});assert.equal(f.channel.signal.aborted,true);assert.equal(f.stops,0);await turn();assert.equal(settled,false);
  f.channel.transportClosed(1,null);assert.deepEqual(await session.closed,f.stop);
});
it("provisioner channel unexpected bridge exit cannot report authority intact",async()=>{
  const f=fixture(),session=await f.accepted();session.go();f.feed({type:"closed",failed:false,stop:f.stop});f.channel.transportClosed(1,null);
  assert.deepEqual(await session.closed,f.stop);assert.equal(f.channel.signal.aborted,true);
});
it("provisioner channel missing terminal frame and native unconfirmed never manufacture closure",async()=>{
  for(const terminal of [false,true]){
    const f=fixture(),session=await f.ready();if(terminal)f.feed({type:"unconfirmed"});f.channel.transportClosed(0,null);
    await assert.rejects(session.closed);assert.equal(f.channel.signal.aborted,true);
  }
});
it("provisioner channel handles split UTF8 and coalesced frames without rounding native identity",async()=>{
  const f=fixture(),bytes=Buffer.from(JSON.stringify({type:"ready",request:f.request})+"\n");
  for(const byte of bytes)f.channel.feed(Buffer.from([byte]));const session=await f.channel.ready;
  const pending=session.acceptAdmission(f.ack);f.feed({type:"accepted",acceptance:{...f.request,reservationRevision:7}});await pending;session.go();
  f.channel.feed(Buffer.from(JSON.stringify({type:"output",data:Buffer.from("ž 🚀").toString("base64")})+"\n"+JSON.stringify({type:"closed",failed:false,stop:f.stop})+"\n"));
  assert.throws(()=>f.channel.outputBytes());f.channel.transportClosed(0,null);await session.closed;assert.equal(f.channel.outputBytes().toString("utf8"),"ž 🚀");
});
it("provisioner channel rejects escaped duplicate keys, numeric aliases and invalid UTF8",async()=>{
  for(const kind of ["duplicate","number","utf8","partial","oversized","truncated UTF8"]) {
    const f=fixture(),session=await f.ready();
    if(kind==="duplicate")f.channel.feed(Buffer.from('{"type":"unconfirmed","\\u0074ype":"unconfirmed"}\n'));
    else if(kind==="number")f.channel.feed(Buffer.from(JSON.stringify({type:"closed",failed:true,stop:f.stop}).replace('"exitCode":0','"exitCode":0.0000000000000000001')+"\n"));
    else if(kind==="utf8")f.channel.feed(Buffer.from([0xc3,0x28,0x0a]));
    else if(kind==="partial")f.channel.feed(Buffer.from('{"type":"closed"'));
    else if(kind==="oversized") {f.channel.feed(Buffer.from("x".repeat(65537)));assert.equal(f.stops,1);}
    else f.channel.feed(Buffer.from([0xf0,0x9f]));
    f.channel.transportClosed(0,null);await assert.rejects(session.closed,kind);assert.equal(f.channel.signal.aborted,true,kind);
  }
});
it("provisioner channel trailing malformed bytes or a second terminal frame invalidate provisional evidence",async()=>{
  for(const suffix of ["x",'{}\n',JSON.stringify({type:"closed",failed:false})+"\n","\ufffd"]){
    const f=fixture(),session=await f.accepted();session.go();f.feed({type:"closed",failed:false,stop:f.stop});f.channel.feed(Buffer.from(suffix));
    f.channel.transportClosed(0,null);await assert.rejects(session.closed);assert.equal(f.channel.signal.aborted,true);
  }
});
it("provisioner channel READY substitutions deny before any command",async()=>{
  for(const change of ["attempt","namespace","directory","machine","root","epoch","extra"]) {
    const f=fixture(),request=structuredClone(f.request);
    if(change==="attempt")Object.assign(request,{attemptId:createStableId("worktreeProvisionerAttempt")});
    if(change==="namespace")Object.assign(request.fence,{namespace:"acp-worker-v1"});
    if(change==="directory")Object.assign(request.fence,{directory:"C:\\other"});
    if(change==="machine")Object.assign(request.fence.scope,{machineFingerprint:"d".repeat(64)});
    if(change==="root")Object.assign(request.root,{startedAt:"2026-09-06T01:00:00.1234568Z"});
    if(change==="epoch")Object.assign(request.challenge,{epoch:2});
    if(change==="extra")Object.assign(request,{permission:"go"});
    f.feed({type:"ready",request});assert.equal(f.stops,1);f.channel.transportClosed(0,null);await assert.rejects(f.channel.ready);await assert.rejects(f.channel.closed);assert.deepEqual(f.frames,[]);
  }
});
it("provisioner channel checks every outgoing ACK through the shared exact validator",async()=>{
  for(const change of [{fresh:false},{ownerSessionId:createStableId("workerHostSession")},{reservationRevision:8},{durationMilliseconds:14001},{extra:true}]) {
    const f=fixture(),session=await f.ready();await assert.rejects(session.acceptAdmission({...f.ack,...change} as never));
    assert.equal(f.stops,1);assert.deepEqual(f.frames,[]);f.feed({type:"closed",failed:true,stop:f.stop});f.channel.transportClosed(1,null);await session.closed;
  }
});
it("provisioner channel checks matching native acceptance before consuming one GO",async()=>{
  for(const change of [{reservationRevision:8},{root:{processId:9999}},{challenge:{nonce:"d".repeat(32),epoch:1}},{extra:true}]) {
    const f=fixture(),session=await f.ready(),pending=assert.rejects(session.acceptAdmission(f.ack));
    f.feed({type:"accepted",acceptance:{...f.request,reservationRevision:7,...change}});await pending;assert.throws(()=>session.go());
    assert.equal(f.stops,1);f.channel.transportClosed(0,null);await assert.rejects(session.closed);
  }
});
it("provisioner channel snapshots I/O methods and GO is one-shot",async()=>{
  const f=fixture();f.io.send=()=>{throw new Error("mutated method must not be adopted");};const session=await f.accepted();session.go();
  assert.throws(()=>session.go());assert.deepEqual(f.frames.map(frame=>(frame as {type:string}).type),["admit","go"]);
  f.feed({type:"closed",failed:true,stop:f.stop});f.channel.transportClosed(0,null);await session.closed;
});
it("provisioner channel drains a known late native ACK after cancellation without reviving GO or losing stop evidence",async()=>{
  const f=fixture(),session=await f.ready(),pending=assert.rejects(session.acceptAdmission(f.ack));
  const stopping=session.terminate();void stopping.catch(()=>{});await pending;
  f.feed({type:"accepted",acceptance:{...f.request,reservationRevision:7}});assert.throws(()=>session.go());
  f.feed({type:"closed",failed:true,stop:f.stop});f.channel.transportClosed(0,null);
  assert.deepEqual(await session.closed,f.stop);await stopping;assert.equal(f.stops,1);assert.equal(f.channel.signal.aborted,true);
});
it("provisioner channel timeout stops independently and rejects the pending native ACK",async()=>{
  const f=fixture(10),session=await f.ready();await assert.rejects(session.acceptAdmission(f.ack),/timed out/u);
  assert.equal(f.stops,1);assert.equal(f.channel.signal.aborted,true);f.feed({type:"closed",failed:true,stop:f.stop});f.channel.transportClosed(1,null);await session.closed;
});
it("provisioner channel registers ACK wait and GO state before synchronous I/O replies",async()=>{
  const f=fixture(),session=await f.ready();
  f.onSend=frame=>{
    if((frame as {type:string}).type==="admit")f.feed({type:"accepted",acceptance:{...f.request,reservationRevision:7}});
    else f.feed({type:"closed",failed:false,stop:f.stop});
  };
  assert.deepEqual(await session.acceptAdmission(f.ack),{...f.request,reservationRevision:7});session.go();
  assert.equal(f.stops,0);f.channel.transportClosed(0,null);await session.closed;assert.equal(f.channel.signal.aborted,false);
});
it("provisioner channel synchronous send failure rejects the registered wait and preserves later rooted stop",async()=>{
  const f=fixture(),session=await f.ready();f.onSend=()=>{throw new Error("owned pipe failed");};
  await assert.rejects(session.acceptAdmission(f.ack));assert.equal(f.stops,1);
  f.feed({type:"closed",failed:true,stop:f.stop});f.channel.transportClosed(1,null);assert.deepEqual(await session.closed,f.stop);
});
it("provisioner channel physical closure rejects outstanding acceptance without a fabricated ACK",async()=>{
  const f=fixture(),session=await f.ready(),pending=assert.rejects(session.acceptAdmission(f.ack));
  f.feed({type:"closed",failed:true,stop:f.stop});await pending;let settled=false;void session.closed.then(()=>{settled=true;});
  await turn();assert.equal(settled,false);f.channel.transportClosed(1,null);await session.closed;
});
it("provisioner channel duplicate or unsolicited ACK and READY never revive a session",async()=>{
  for(const kind of ["unsolicited ACK","duplicate ACK","duplicate READY"]){
    const f=fixture(),session=kind==="duplicate ACK"?await f.accepted():await f.ready();
    f.feed(kind==="duplicate READY"?{type:"ready",request:f.request}:{type:"accepted",acceptance:{...f.request,reservationRevision:7}});
    assert.equal(f.stops,1);assert.throws(()=>session.go());f.channel.transportClosed(0,null);await assert.rejects(session.closed);
  }
});
it("provisioner channel rejects malformed constructor binding and limits before issuing I/O",()=>{
  const f=fixture();
  for(const change of [{attemptId:createStableId("run")},{owner:{...f.owner,applicationVersion:""}},{expectedPlan:{...f.expectedPlan,reservationRevision:0}},
    {fencePlan:{...f.binding.fencePlan,directory:"C:\\"}},{machineFingerprint:"bad"},{extra:true}])
    assert.throws(()=>new WindowsProvisionerChannel({...f.binding,...change} as never,f.io));
  for(const change of [{acknowledgementTimeoutMilliseconds:0},{acknowledgementTimeoutMilliseconds:5001},{maximumOutputBytes:0},{maximumOutputBytes:1048577}])
    assert.throws(()=>new WindowsProvisionerChannel(f.binding,f.io,change));
  assert.deepEqual(f.frames,[]);assert.equal(f.stops,0);f.channel.transportClosed(0,null);
});
it("provisioner channel cancellation re-entry stops once and cannot settle from a stop request",async()=>{
  const f=fixture(),session=await f.ready();let settled=false;f.channel.signal.addEventListener("abort",()=>{void session.terminate().catch(()=>{});});
  const stopping=session.terminate().then(()=>{settled=true;});await turn();assert.equal(f.stops,1);assert.equal(settled,false);
  f.feed({type:"closed",failed:true,stop:f.stop});await turn();assert.equal(settled,false);f.channel.transportClosed(0,null);await stopping;
});
it("provisioner channel rootless, substituted and extra-field stops cannot certify its owned root",async()=>{
  for(const change of ["rootless","root","fence","extra","flag"]) {
    const f=fixture(),session=await f.ready(),stop=structuredClone(f.stop);
    if(change==="rootless")Object.assign(stop,{observation:{state:"lost",sealed:true,reason:"sealed_launch_job_absent"}});
    if(change==="root")Object.assign(stop.observation,{root:{...f.request.root,processId:9999}});
    if(change==="fence")Object.assign(stop.fence.scope,{sessionId:2});
    f.feed({type:"closed",failed:change==="flag"?"false":true,stop,...(change==="extra"?{extra:true}:{})});
    f.channel.transportClosed(0,null);await assert.rejects(session.closed);
  }
});
it("provisioner channel rejects output before GO and noncanonical or oversized output",async()=>{
  for(const kind of ["before GO","base64","single frame","total","unknown field"]) {
    const f=fixture(),session=await f.accepted();if(kind!=="before GO")session.go();
    const data=kind==="base64"?"AB==":Buffer.alloc(kind==="single frame"?8193:kind==="total"?1025:1).toString("base64");
    f.feed({type:"output",data,...(kind==="unknown field"?{extra:true}:{})});assert.equal(f.stops,1);f.channel.transportClosed(0,null);await assert.rejects(session.closed);
  }
});
