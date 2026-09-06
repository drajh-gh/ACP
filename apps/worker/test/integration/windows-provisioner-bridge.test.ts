import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir,readFile,rename,stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { createStableId } from "@acp/domain";
import { parseProvisionerStopRecord,type ProvisionerAdmissionAcknowledgement } from "@acp/storage";
import { provisionerBridgeProbe,pause } from "./native-provisioner-bridge-probe.ts";
import { minimalCodexEnvironment } from "../../src/codex-sdk-transport.ts";
import { sealWindowsProvisionerAttempt } from "../../src/windows-launch-fence.ts";
import { gone } from "./native-lease-probe.ts";
import type { Frame } from "./native-lease-probe.ts";

it("provisioner bridge core: exact suspended identity is fenced before fresh acceptance and GO",{timeout:20000},async()=>{
  const p=await provisionerBridgeProbe();
  try {
    await p.next("ready"); assert.deepEqual(p.request.fence,p.fence); assert.equal(p.request.attemptId,p.attemptId);
    assert.match(p.request.root.startedAt,/\.\d{7}Z$/u);
    const recorded=await readFile(p.fenceFile,"utf8"); assert.match(recorded,/\nclaimed\nroot\t/u); assert.doesNotMatch(recorded,/\nsealed\n/u);
    await pause(75); assert.equal(p.frames.some(frame=>frame.type==="output"),false);
    await p.accept(); p.send({type:"go"});
    const frame=await p.next("closed"); assert.equal(frame.failed,false);
    const stop=parseProvisionerStopRecord(frame.stop); await p.closed;
    assert.equal(stop.observation.state,"terminated"); assert.equal("exitCode" in stop.observation && stop.observation.exitCode,0);
    assert.deepEqual("root" in stop.observation && stop.observation.root,p.request.root); assert.deepEqual(stop.fence,p.fence);
    assert.match(await readFile(p.fenceFile,"utf8"),/\nsealed\n$/u);
    const output=Buffer.concat(p.frames.filter(frame=>frame.type==="output").map(frame=>Buffer.from(frame.data as string,"base64"))).toString("utf8");
    assert.deepEqual(JSON.parse(output),{processId:p.request.root.processId,text:"native ž 🚀",leaked:false});
  } finally {await p.cleanup();}
});

type Probe=Awaited<ReturnType<typeof provisionerBridgeProbe>>;
async function cleanupAll(actions:ReadonlyArray<()=>Promise<unknown>|undefined>) {
  const results=await Promise.allSettled(actions.map(async action=>await action()));
  const errors=results.filter((result):result is PromiseRejectedResult=>result.status==="rejected").map(result=>result.reason as unknown);
  if(errors.length)throw new AggregateError(errors,"all owned fixture cleanups were attempted");
}
async function rejected(p:Probe) {
  const frame=await p.next("closed"); assert.equal(frame.failed,true);
  const stop=parseProvisionerStopRecord(frame.stop); await p.closed;
  assert.deepEqual("root" in stop.observation && stop.observation.root,p.request.root);
  assert.equal("exitCode" in stop.observation && stop.observation.exitCode,137);
  assert.equal(p.frames.some(value=>value.type==="accepted" || value.type==="output"),false);
  assert.match(await readFile(p.fenceFile,"utf8"),/\nsealed\n$/u);
}
const changed:Record<string,Record<string,(ack:ProvisionerAdmissionAcknowledgement)=>unknown>>={
  "ack-owner":{
    fresh:a=>({...a,fresh:false}),host:a=>({...a,hostIdentifier:a.hostIdentifier+"-other"}),
    session:a=>({...a,ownerSessionId:createStableId("workerHostSession")}),version:a=>({...a,applicationVersion:a.applicationVersion+"-other"}),
    "claim owner":a=>({...a,rootClaimOwnerId:createStableId("worktreeProvisionerAttempt")}),tree:a=>({...a,treeIdentifier:a.treeIdentifier+"-other"}),
  },
  "ack-plan":{
    reservation:a=>({...a,reservationId:createStableId("worktreeReservation")}),revision:a=>({...a,reservationRevision:a.reservationRevision+1}),
    provenance:a=>({...a,provenanceId:createStableId("provenance")}),deadline:a=>({...a,deadlineAt:a.deadlineAt.slice(0,-2)+"1Z"}),
    "admission microsecond":a=>({...a,admittedAt:a.admittedAt.slice(0,-2)+"1Z"}),duration:a=>({...a,durationMilliseconds:a.durationMilliseconds+1}),
  },
  "ack-root":{
    attempt:a=>({...a,attemptId:createStableId("worktreeProvisionerAttempt")}),pid:a=>({...a,root:{...a.root,processId:a.root.processId+1}}),
    FILETIME:a=>({...a,root:{...a.root,processStartToken:a.root.processStartToken+"0"}}),
    UTC7:a=>({...a,root:{...a.root,startedAt:a.root.startedAt.slice(0,-2)+String((Number(a.root.startedAt.slice(-2,-1))+1)%10)+"Z"}}),
    nonce:a=>({...a,challenge:{...a.challenge,nonce:"0".repeat(32)}}),epoch:a=>({...a,challenge:{...a.challenge,epoch:2}}),
  },
  "ack-fence":{
    namespace:a=>({...a,fence:{...a.fence,namespace:"acp-worker-v1"}}),directory:a=>({...a,fence:{...a.fence,directory:a.fence.directory+"-other"}}),
    identity:a=>({...a,fence:{...a.fence,directoryIdentity:"win32-dir:00000000:0000000000000000"}}),
    machine:a=>({...a,fence:{...a.fence,scope:{...a.fence.scope,machineFingerprint:"0".repeat(64)}}}),
    boot:a=>({...a,fence:{...a.fence,scope:{...a.fence.scope,bootedAt:"2000-01-01T00:00:00.000Z"}}}),
    session:a=>({...a,fence:{...a.fence,scope:{...a.fence.scope,sessionId:a.fence.scope.sessionId+1}}}),
  },
};
for(const [phase,mutations] of Object.entries(changed)) for(const [name,mutate] of Object.entries(mutations)) {
  it(`provisioner bridge ${phase}: ${name} mismatch cannot acknowledge or execute`,{timeout:20000},async()=>{
    const p=await provisionerBridgeProbe();
    try{await p.next("ready");p.send({type:"admit",acknowledgement:mutate(p.acknowledgement())});await rejected(p);}
    finally{await p.cleanup();}
  });
}

async function fenceActor(p:Probe,operation:"seal"|"hold") {
  const child=spawn("pwsh",["-NoLogo","-NoProfile","-NonInteractive","-File",fileURLToPath(new URL("./synthetic-provisioner-bridge-fence.ps1",import.meta.url))],
    {windowsHide:true,stdio:["pipe","pipe","pipe"],env:minimalCodexEnvironment()});
  assert.ok(child.pid); p.report(child.pid,`provisioner fence ${operation} probe`);
  const exited=once(child,"close"); void exited.catch(()=>{}); child.stdin.on("error",()=>{});
  let diagnostic="";child.stderr.on("data",(chunk:Buffer)=>{diagnostic=(diagnostic+chunk.toString("utf8")).slice(0,8192);});
  let output=""; child.stdout.on("data",(chunk:Buffer)=>{output+=chunk.toString("utf8");});
  const timer=setTimeout(()=>{if(child.exitCode===null && child.signalCode===null)child.kill();},15000);
  async function close() {
    clearTimeout(timer);
    if(child.exitCode===null && child.signalCode===null) {child.stdin.end("release\n");}
    const stop=setTimeout(()=>{if(child.exitCode===null && child.signalCode===null)child.kill();},2000);
    try{await exited;await gone(child.pid!);}finally{clearTimeout(stop);}
  }
  child.stdin.write(JSON.stringify({operation,fence:p.fence,attemptId:p.attemptId})+"\n");
  try {
    const until=Date.now()+7000;
    while(!output.includes("\n") && Date.now()<until && child.exitCode===null && child.signalCode===null)await pause(10);
    assert.ok(output.trim(),`fence actor did not report ready: ${diagnostic}`);
    assert.deepEqual(JSON.parse(output.trim()),{ready:true});
    return {close};
  } catch(error){try{await close();}catch(cleanupError){throw new AggregateError([error,cleanupError],"fence probe failed and cleanup failed");}throw error;}
}
it("provisioner bridge safety: a seal alone prevents GO while the suspended root is still live",{timeout:25000},async(t)=>{
  const p=await provisionerBridgeProbe();let actor:Awaited<ReturnType<typeof fenceActor>>|undefined;
  t.after(()=>cleanupAll([()=>actor?.close(),()=>p.cleanup()]));
    await p.next("ready");await p.accept();actor=await fenceActor(p,"seal");await actor.close();
    assert.doesNotThrow(()=>process.kill(p.request.root.processId,0));assert.ok(Date.parse(p.expectedPlan.deadlineAt)-Date.now()>1500);
    p.send({type:"go"});const frame=await p.next("closed");assert.equal(frame.failed,true);await p.closed;
    const stop=parseProvisionerStopRecord(frame.stop);assert.deepEqual("root" in stop.observation && stop.observation.root,p.request.root);
    assert.equal(p.frames.some(value=>value.type==="output"),false);
});
it("provisioner bridge safety: same-attempt competing and completed replay cannot create another root",{timeout:25000},async(t)=>{
  const p=await provisionerBridgeProbe();let competing:Probe|undefined,replay:Probe|undefined;
  t.after(()=>cleanupAll([()=>competing?.cleanup(),()=>replay?.cleanup(),()=>p.cleanup()]));
    await p.next("ready");const before=await readFile(p.fenceFile,"utf8");
    assert.ok(Date.parse(p.expectedPlan.deadlineAt)-Date.now()>5000,"competing launch has original deadline slack");
    competing=await provisionerBridgeProbe({launch:p.launch,fixture:p.fixture});
    assert.equal((await competing.next(["ready","unconfirmed"])).type,"unconfirmed");await competing.closed;
    assert.ok(Date.parse(p.expectedPlan.deadlineAt)>Date.now(),"competing denial precedes original expiry");
    assert.doesNotThrow(()=>process.kill(p.request.root.processId,0));assert.equal(await readFile(p.fenceFile,"utf8"),before);
    await p.accept();p.send({type:"go"});await p.next("closed");await p.closed;
    const sealed=await readFile(p.fenceFile,"utf8");
    assert.ok(Date.parse(p.expectedPlan.deadlineAt)-Date.now()>5000,"completed replay has original deadline slack");
    replay=await provisionerBridgeProbe({launch:p.launch,fixture:p.fixture});
    assert.equal((await replay.next(["ready","unconfirmed"])).type,"unconfirmed");await replay.closed;
    assert.ok(Date.parse(p.expectedPlan.deadlineAt)>Date.now(),"replay denial precedes original expiry");
    assert.equal(await readFile(p.fenceFile,"utf8"),sealed);
});
it("provisioner bridge safety: a busy seal cannot become closure until independently sealed",{timeout:25000},async(t)=>{
  const p=await provisionerBridgeProbe();let actor:Awaited<ReturnType<typeof fenceActor>>|undefined;
  t.after(()=>cleanupAll([()=>actor?.close(),()=>p.cleanup()]));
    await p.next("ready");actor=await fenceActor(p,"hold");p.send({type:"stop"});
    assert.equal((await p.next(["closed","unconfirmed"])).type,"unconfirmed");await p.closed;await gone(p.request.root.processId);
    assert.equal(p.frames.some(value=>value.type==="closed"),false);
    await actor.close();
    const observed=await sealWindowsProvisionerAttempt(p.fence,p.attemptId,new AbortController().signal,{onSpawn:p.report});
    assert.notEqual(observed.state,"unconfirmed");assert.deepEqual("root" in observed && observed.root,p.request.root);
    parseProvisionerStopRecord({attemptId:p.attemptId,fence:p.fence,observation:observed});
});
it("provisioner bridge loss: bridge death kills its live root and descendant but does not invent a closure frame",{timeout:25000},async(t)=>{
  const p=await provisionerBridgeProbe({input:JSON.stringify({mode:"hold-descendant"})});let childId:number|undefined;
  t.after(()=>cleanupAll([()=>p.cleanup(),()=>childId===undefined?undefined:gone(childId)]));
    await p.next("ready");await p.accept();p.send({type:"go"});
    const output=await p.next("output");childId=(JSON.parse(Buffer.from(output.data as string,"base64").toString("utf8")) as {childId:number}).childId;
    assert.ok(Number.isInteger(childId) && childId>0);p.report(childId,"provisioner bridge-loss descendant");
    assert.doesNotThrow(()=>process.kill(childId!,0));p.bridge.kill();await p.closed;await gone(p.request.root.processId);await gone(childId);
    assert.equal(p.frames.some(value=>value.type==="closed"),false);
    const observed=await sealWindowsProvisionerAttempt(p.fence,p.attemptId,new AbortController().signal,{onSpawn:p.report});
    assert.notEqual(observed.state,"unconfirmed");assert.deepEqual("root" in observed && observed.root,p.request.root);
    parseProvisionerStopRecord({attemptId:p.attemptId,fence:p.fence,observation:observed});
});
it("provisioner bridge loss: suspended root death before GO retains physical evidence but loses authority",{timeout:20000},async()=>{
  const p=await provisionerBridgeProbe();
  try {
    await p.next("ready");assert.ok(Date.parse(p.expectedPlan.deadlineAt)-Date.now()>1500);
    process.kill(p.request.root.processId);
    const frame=await p.next("closed");await p.closed;
    const stop=parseProvisionerStopRecord(frame.stop);
    assert.deepEqual("root" in stop.observation && stop.observation.root,p.request.root);
    assert.match(await readFile(p.fenceFile,"utf8"),/\nsealed\n$/u);
    assert.equal(frame.failed,true);
    assert.equal(p.frames.some(value=>value.type==="accepted" || value.type==="output"),false);
  } finally {await p.cleanup();}
});
it("provisioner bridge loss: EOF before admission stops and seals without acceptance",{timeout:20000},async()=>{
  const p=await provisionerBridgeProbe();
  try {await p.next("ready");p.bridge.stdin.end();await rejected(p);}finally{await p.cleanup();}
});
for(const kind of ["duplicate ACK field","nested duplicate field","unknown frame field","partial EOF","oversized unterminated frame","invalid UTF8"]) {
  it(`provisioner bridge framing: ${kind} denies before execution`,{timeout:20000},async()=>{
    const p=await provisionerBridgeProbe();
    try {
      await p.next("ready"); const ack=p.acknowledgement();
      if(kind==="duplicate ACK field") p.bridge.stdin.write(JSON.stringify({type:"admit",acknowledgement:ack}).replace('"fresh":true','"fresh":true,"fresh":true')+"\n");
      else if(kind==="nested duplicate field") p.bridge.stdin.write(JSON.stringify({type:"admit",acknowledgement:ack}).replace('"epoch":1','"epoch":1,"epoch":1')+"\n");
      else if(kind==="unknown frame field") p.send({type:"admit",acknowledgement:ack,extra:true});
      else if(kind==="partial EOF") p.bridge.stdin.end('{"type":"admit"');
      else if(kind==="oversized unterminated frame") p.bridge.stdin.write("x".repeat(16385)); // Keep stdin OPEN: size must win without EOF.
      else p.bridge.stdin.write(Buffer.from([0xc3,0x28,0x0a]));
      await rejected(p);
    } finally {await p.cleanup();}
  });
}
it("provisioner bridge core: early GO stops and seals without executing",{timeout:20000},async()=>{
  const p=await provisionerBridgeProbe();
  try {
    await p.next("ready"); p.send({type:"go"}); const frame=await p.next("closed"); assert.equal(frame.failed,true);
    const stop=parseProvisionerStopRecord(frame.stop); await p.closed;
    assert.equal(stop.observation.state,"terminated"); assert.equal("exitCode" in stop.observation && stop.observation.exitCode,137);
    assert.deepEqual("root" in stop.observation && stop.observation.root,p.request.root);
    assert.equal(p.frames.some(frame=>frame.type==="output"),false); assert.match(await readFile(p.fenceFile,"utf8"),/\nsealed\n$/u);
  } finally {await p.cleanup();}
});
it("provisioner bridge core: explicit stop before admission preserves exact sealed root evidence",{timeout:20000},async()=>{
  const p=await provisionerBridgeProbe();
  try {
    await p.next("ready"); p.send({type:"stop"}); const frame=await p.next("closed"); assert.equal(frame.failed,true);
    const stop=parseProvisionerStopRecord(frame.stop); await p.closed;
    assert.deepEqual("root" in stop.observation && stop.observation.root,p.request.root);
    assert.equal("exitCode" in stop.observation && stop.observation.exitCode,137);
    assert.equal(p.frames.some(frame=>frame.type==="accepted" || frame.type==="output"),false);
  } finally {await p.cleanup();}
});
it("provisioner bridge core: a nonzero native root exit is preserved rather than replaced with 137",{timeout:20000},async()=>{
  const p=await provisionerBridgeProbe({runner:"./synthetic-provisioner-exit.ts"});
  try {
    await p.next("ready");await p.accept();p.send({type:"go"});
    const frame=await p.next("closed"),stop=parseProvisionerStopRecord(frame.stop);await p.closed;
    assert.equal("exitCode" in stop.observation && stop.observation.exitCode,23);
    assert.deepEqual("root" in stop.observation && stop.observation.root,p.request.root);
  } finally {await p.cleanup();}
});
for(const transition of ["duplicate admission","duplicate GO","stop then GO"]) {
  it(`provisioner bridge core: ${transition} cannot repeat execution`,{timeout:20000},async()=>{
    const p=await provisionerBridgeProbe({runner:"./nonreading-owned-runner.ts"});
    try {
      await p.next("ready");const ack=await p.accept();
      if(transition==="duplicate admission")p.send({type:"admit",acknowledgement:ack});
      else if(transition==="duplicate GO"){p.send({type:"go"});p.send({type:"go"});}
      else{p.send({type:"stop"});p.send({type:"go"});}
      const frame=await p.next("closed");assert.equal(frame.failed,true);
      const stop=parseProvisionerStopRecord(frame.stop);await p.closed;
      assert.equal("exitCode" in stop.observation && stop.observation.exitCode,137);
      assert.equal(p.frames.some(value=>value.type==="accepted" || value.type==="output"),false);
    } finally {await p.cleanup();}
  });
}
it("provisioner bridge bindings: original common metadata identity remains pinned while the real root is suspended and running",{timeout:20000},async(t)=>{
  const p=await provisionerBridgeProbe({runner:"./nonreading-owned-runner.ts"});t.after(p.cleanup);await p.next("ready");
  const common=p.bindings.commonGitDirectory.path;
  await assert.rejects(rename(common,common+"-renamed"));
  await p.accept();p.send({type:"go"});await pause(50);assert.doesNotThrow(()=>process.kill(p.request.root.processId,0));
  await assert.rejects(rename(common,common+"-renamed"));
  p.send({type:"stop"});const frame=await p.next("closed");await p.closed;parseProvisionerStopRecord(frame.stop);
  await rename(common,common+"-released");await rename(common+"-released",common);
});

const observedHost="./synthetic-provisioner-bridge-pins.ps1";
async function closeObserved(p:Probe) {p.bridge.kill();await p.cleanup();}
async function witness(p:Probe,stage:string,moved:boolean) {
  const frame=await p.next("pin-observed");
  assert.equal(frame.stage,stage);assert.equal(frame.moved,moved);
  assert.equal(frame.errorCode,moved?0:32,"ordinary rename is denied specifically by a sharing violation");
}
it("provisioner bridge bindings: pins survive exact tree stop and sealing then release before bridge exit",{timeout:20000},async(t)=>{
  const p=await provisionerBridgeProbe({hostScript:observedHost});t.after(()=>closeObserved(p));
  await p.next("ready");await p.accept();p.send({type:"go"});
  await witness(p,"tree-empty-before-seal",false);await witness(p,"sealed",false);
  await witness(p,"pins-released",true);assert.equal((await p.next("bridge-returned")).result,0);
  const stop=parseProvisionerStopRecord((await p.next("closed")).stop);assert.equal(stop.observation.state,"terminated");
  await gone(p.request.root.processId);assert.match(await readFile(p.fenceFile,"utf8"),/\nsealed\n$/u);
  const common=p.bindings.commonGitDirectory.path;await rename(common,common+"-released");await rename(common+"-released",common);
  assert.doesNotThrow(()=>process.kill(p.bridge.pid!,0),"release is observed while the same bridge helper remains alive");
});
it("provisioner bridge bindings: unconfirmed seal retains pins after Run returns until dedicated helper exit",{timeout:25000},async(t)=>{
  const p=await provisionerBridgeProbe({hostScript:observedHost});let actor:Awaited<ReturnType<typeof fenceActor>>|undefined;
  t.after(()=>cleanupAll([()=>actor?.close(),()=>closeObserved(p)]));
  await p.next("ready");actor=await fenceActor(p,"hold");p.send({type:"stop"});
  // Execute and its error handler each attempt exact sealing; both must retain
  // the same pins while the independently held fence denies access.
  await witness(p,"tree-empty-before-seal",false);await witness(p,"tree-empty-before-seal",false);await p.next("unconfirmed");
  await witness(p,"pins-retained-until-exit",false);assert.equal((await p.next("bridge-returned")).result,1);
  await gone(p.request.root.processId);assert.equal(p.frames.some(f=>f.type==="closed"),false);
  const common=p.bindings.commonGitDirectory.path;await assert.rejects(rename(common,common+"-held"));
  assert.doesNotThrow(()=>process.kill(p.bridge.pid!,0));
  p.bridge.kill();await p.closed;await rename(common,common+"-released");await rename(common+"-released",common);
  await actor.close();
  const observed=await sealWindowsProvisionerAttempt(p.fence,p.attemptId,new AbortController().signal,{onSpawn:p.report});
  assert.notEqual(observed.state,"unconfirmed");
});

type Bindings={workspacePath:string;reportedParent:{path:string;identity:string};commonGitDirectory:{path:string;identity:string}};
const changedBindings:Record<string,Record<string,(launch:Frame)=>Frame>>={
  "bindings-schema":{
    missing:launch=>{delete launch.bindings;return launch;},
    unknown:launch=>({...launch,bindings:{...(launch.bindings as Bindings),extra:true}}),
    "historical parent timestamp":launch=>{const b=launch.bindings as Bindings;return {...launch,bindings:{...b,reportedParent:{...b.reportedParent,observedAt:"2000-01-01T00:00:00.000000Z"}}};},
  },
  "bindings-identity":{
    "parent identity":launch=>{(launch.bindings as Bindings).reportedParent.identity="win32-dir:00000000:0000000000000000";return launch;},
    "common identity":launch=>{(launch.bindings as Bindings).commonGitDirectory.identity="win32-dir:00000000:0000000000000000";return launch;},
    "missing common":launch=>{(launch.bindings as Bindings).commonGitDirectory.path+="-missing";return launch;},
    "different command workspace":launch=>({...launch,command:{...(launch.command as Frame),workspace:(launch.bindings as Bindings).commonGitDirectory.path}}),
    "non-child target":launch=>{(launch.bindings as Bindings).workspacePath+="\\nested";return launch;},
  },
};
async function deniedBindings(p:Probe) {
  await p.next("unconfirmed");assert.equal((await p.next("bridge-returned")).result,1);
  assert.equal(p.frames.some(f=>["ready","accepted","output","closed"].includes(f.type as string)),false);
  await assert.rejects(stat(p.fenceFile),{code:"ENOENT"},"binding denial does not consume a fence or create a native root");
  for(const path of [p.bindings.commonGitDirectory.path,p.bindings.reportedParent.path]) {
    await rename(path,path+"-released");await rename(path+"-released",path);
  }
  assert.doesNotThrow(()=>process.kill(p.bridge.pid!,0),"partial acquisition cleanup is observed before helper exit");
}
for(const [group,cases] of Object.entries(changedBindings))for(const [name,transformLaunch] of Object.entries(cases)) {
  it(`provisioner bridge ${group}: ${name} denies before root creation without leaked pins`,{timeout:20000},async(t)=>{
    const p=await provisionerBridgeProbe({hostScript:observedHost,transformLaunch});t.after(()=>closeObserved(p));await deniedBindings(p);
  });
}
it("provisioner bridge bindings-identity: genuine common directory replacement denies against original identity",{timeout:20000},async(t)=>{
  const p=await provisionerBridgeProbe({hostScript:observedHost,beforeLaunch:async fixture=>{
    const path=fixture.bindings.commonGitDirectory.path;await rename(path,path+"-original");await mkdir(path);
  }});t.after(()=>closeObserved(p));await deniedBindings(p);
});
