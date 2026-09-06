import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { createStableId } from "@acp/domain";
import { minimalCodexEnvironment } from "../../src/codex-sdk-transport.ts";
import { gone,type Frame } from "./native-lease-probe.ts";

const delay=(ms:number)=>new Promise<void>((resolve)=>setTimeout(resolve,ms));
async function probe(overrides:Frame={}) {
  const attemptId=overrides.attemptId??createStableId("worktreeProvisionerAttempt"),environment=minimalCodexEnvironment();
  const launch={ attemptId,reservationRevision:7,jobName:`Local\\ACP.Provisioner.${attemptId}`,mode:"provisioner",
    workerProcessId:createStableId("workerProcess"),leaseId:createStableId("lease"),runId:createStableId("run"),
    executable:process.execPath,arguments:["--experimental-strip-types",fileURLToPath(new URL("./nonreading-owned-runner.ts",import.meta.url))],
    workspace:process.cwd(),environment:Object.entries(environment).map(([key,value])=>`${key}=${value}`),
    input:"{}",deadlineMilliseconds:20000,...overrides };
  const bridge=spawn("pwsh",["-NoLogo","-NoProfile","-NonInteractive","-File",fileURLToPath(new URL("./synthetic-provisioner-admission.ps1",import.meta.url))],
    { windowsHide:true,stdio:["pipe","pipe","pipe"],env:environment });
  assert.ok(bridge.pid); process.stdout.write(`Owned PID ${bridge.pid}: native provisioner admission probe\n`);
  const exited=once(bridge,"exit"),closed=once(bridge,"close"); void exited.catch(()=>{}); void closed.catch(()=>{});
  bridge.stdin.on("error",()=>{}); bridge.stderr.resume();
  const frames:Frame[]=[],decoder=new StringDecoder("utf8"); let buffered="",rootPid:number|undefined,parseFailure:unknown;
  bridge.stdout.on("data",(chunk:Buffer)=>{
    try {
      buffered+=decoder.write(chunk); let end:number;
      while((end=buffered.indexOf("\n"))>=0) {
        const frame=JSON.parse(buffered.slice(0,end)) as Frame; buffered=buffered.slice(end+1); frames.push(frame);
        if(frame.type==="ready") { rootPid=frame.processId as number; process.stdout.write(`Owned PID ${rootPid}: synthetic suspended provisioner\n`); }
      }
    } catch(error) { parseFailure=error; }
  });
  const send=(frame:Frame)=>bridge.stdin.write(JSON.stringify(frame)+"\n"); send(launch);
  async function next(types:string|readonly string[],timeout=8000):Promise<Frame> {
    const expected=typeof types==="string"?[types]:types,until=Date.now()+timeout;
    while(Date.now()<until) {
      if(parseFailure) throw parseFailure;
      const index=frames.findIndex((frame)=>expected.includes(frame.type as string));
      if(index>=0) return frames.splice(index,1)[0]!;
      if(bridge.exitCode!==null || bridge.signalCode!==null) throw new Error(`Probe closed before ${expected.join(",")}: ${JSON.stringify(frames)}`);
      await delay(10);
    }
    throw new Error(`Probe frame timed out: ${expected.join(",")}`);
  }
  async function cleanup() {
    bridge.stdout.resume();
    if(bridge.exitCode===null && bridge.signalCode===null) { try { send({ type:"stop" }); bridge.stdin.end(); } catch { bridge.stdin.destroy(); } }
    const timer=setTimeout(()=>{ if(bridge.exitCode===null && bridge.signalCode===null) bridge.kill(); },6500);
    try { await closed; } finally { clearTimeout(timer); }
    if(rootPid!==undefined) await gone(rootPid,3000); await gone(bridge.pid!,3000);
  }
  return { bridge,exited,next,send,cleanup,frames,launch,get rootPid(){return rootPid;} };
}
type Probe=Awaited<ReturnType<typeof probe>>;
async function challenge(p:Probe) { p.send({ type:"challenge" }); return p.next("challenge"); }
function commit(p:Probe,c:Frame,durationMilliseconds=5000,overrides:Frame={}) {
  p.send({ type:"accept",nonce:c.nonce,epoch:c.epoch,attemptId:p.launch.attemptId,reservationRevision:p.launch.reservationRevision,durationMilliseconds,...overrides });
}
async function accept(p:Probe,c:Frame,duration=5000) {
  commit(p,c,duration);
  assert.deepEqual(await p.next("accepted"),{ type:"accepted",nonce:c.nonce,epoch:1,reservationRevision:7 });
}
async function denied(p:Probe) {
  const failure=await p.next("failure");
  assert.equal(failure.nativeDeadlineExpired,true); assert.equal(failure.nativeTreeEmpty,true); assert.equal(failure.treeEmpty,true);
  await p.exited; await gone(p.rootPid!);
}

it("provisioner admission core: GO without fresh native acceptance cannot execute",{ timeout:15000 },async()=>{
  const p=await probe();
  try { await p.next("ready"); p.send({ type:"go" }); await denied(p); assert.equal(p.frames.some((f)=>f.type==="resumed"),false); }
  finally { await p.cleanup(); }
});
it("provisioner admission core: one exact challenge permits one resume, repeated GO permanently stops",{ timeout:15000 },async()=>{
  const p=await probe();
  try {
    const root=await p.next("ready"); assert.match(root.startedAt as string,/\.\d{7}Z$/u); assert.match(root.processStartToken as string,/^win32-filetime:\d+$/u);
    const c=await challenge(p); assert.match(c.nonce as string,/^[0-9a-f]{32}$/u); assert.equal(c.epoch,1);
    await accept(p,c); p.send({ type:"go" }); await p.next("resumed"); assert.doesNotThrow(()=>process.kill(p.rootPid!,0));
    p.send({ type:"go" }); await denied(p);
  } finally { await p.cleanup(); }
});
for(const [name,patch] of Object.entries({ nonce:{ nonce:"0".repeat(32) },epoch:{ epoch:2 },attempt:{ attemptId:createStableId("worktreeProvisionerAttempt") },
  revision:{ reservationRevision:8 },"short duration":{ durationMilliseconds:250 },"long duration":{ durationMilliseconds:20001 } })) {
  it(`provisioner admission core: ${name} substitution stops the exact root`,{ timeout:15000 },async()=>{
    const p=await probe(); try { await p.next("ready"); commit(p,await challenge(p),5000,patch); await denied(p); }
    finally { await p.cleanup(); }
  });
}
it("provisioner admission core: a consumed challenge cannot be replaced or accepted twice",{ timeout:25000 },async()=>{
  for(const action of ["pending-challenge","challenge","accept"]) {
    const p=await probe();
    try {
      await p.next("ready"); const c=await challenge(p); if(action!=="pending-challenge") await accept(p,c);
      if(action!=="accept") p.send({type:"challenge"}); else commit(p,c); await denied(p);
    }
    finally { await p.cleanup(); }
  }
});
it("provisioner admission modes: invalid original identity, revision, namespace and deadline create no root",{ timeout:30000 },async()=>{
  for(const patch of [{ attemptId:"wpa_00000000-0000-0000-0000-000000000000" },{ reservationRevision:0 },{ reservationRevision:2147483648 },
    { jobName:`Local\\ACP.Worker.${createStableId("workerProcess")}` },{ deadlineMilliseconds:21000 },{ deadlineMilliseconds:0 }]) {
    const p=await probe(patch); try { const failure=await p.next(["ready","failure"]); assert.equal(failure.type,"failure"); assert.equal(failure.created,false); assert.equal(p.rootPid,undefined); }
    finally { await p.cleanup(); }
  }
});
it("provisioner admission modes: worker lease APIs cannot admit a provisioner",{ timeout:25000 },async()=>{
  for(const type of ["worker-go","lease-challenge","lease-accept"]) {
    const p=await probe(); try { await p.next("ready"); p.send({type}); await denied(p); } finally { await p.cleanup(); }
  }
});
it("provisioner admission modes: provisioner API cannot admit a legacy or leased worker",{ timeout:25000 },async()=>{
  for(const mode of ["legacy","lease"]) {
    for(const type of ["challenge","go","accept"]) {
      const p=await probe({mode});
      try {
        await p.next("ready");
        if(type==="accept") commit(p,{nonce:"0".repeat(32),epoch:1}); else p.send({type});
        await denied(p);
      } finally { await p.cleanup(); }
    }
  }
});
it("provisioner admission expiry: queued ACK age is charged from challenge issuance",{ timeout:15000 },async()=>{
  const p=await probe();
  try { await p.next("ready"); const c=await challenge(p); await delay(500); commit(p,c,600); await denied(p); assert.equal(p.frames.some((f)=>f.type==="accepted"),false); }
  finally { await p.cleanup(); }
});
it("provisioner admission expiry: accepted budget kills root and detached descendant without a later command",{ timeout:15000 },async()=>{
  const p=await probe({ arguments:["--experimental-strip-types",fileURLToPath(new URL("./synthetic-owned-runner.ts",import.meta.url))],input:JSON.stringify({mode:"hold-descendant"}) });
  let childId:number|undefined;
  try {
    await p.next("ready"); await accept(p,await challenge(p),2000); const began=performance.now(); p.send({type:"go"});
    const out=await p.next("output"); childId=(JSON.parse(Buffer.from(out.data as string,"base64").toString("utf8")) as {childId:number}).childId;
    assert.ok(Number.isInteger(childId) && childId>0); process.stdout.write(`Owned PID ${childId}: synthetic provisioner descendant\n`);
    const closed=await p.next("closed"); assert.equal(closed.deadlineExpired,true); assert.equal(closed.exitCode,137);
    assert.ok(performance.now()-began<4500); await gone(p.rootPid!); await gone(childId);
  } finally { await p.cleanup(); if(childId!==undefined) await gone(childId); }
});
it("provisioner admission expiry: original deadline caps a longer ACK",{ timeout:15000 },async()=>{
  const p=await probe({deadlineMilliseconds:2000});
  try { await p.next("ready"); await accept(p,await challenge(p),20000); p.send({type:"go"}); const began=performance.now(); const closed=await p.next("closed"); assert.equal(closed.deadlineExpired,true); assert.ok(performance.now()-began<4000); }
  finally { await p.cleanup(); }
});
it("provisioner admission expiry: stalled bridge loop cannot extend native root and descendant expiry",{ timeout:20000 },async()=>{
  const p=await probe({ arguments:["--experimental-strip-types",fileURLToPath(new URL("./synthetic-owned-runner.ts",import.meta.url))],input:JSON.stringify({mode:"hold-descendant"}) });
  let childId:number|undefined;
  try {
    await p.next("ready"); await accept(p,await challenge(p),3500); p.send({type:"go"}); await p.next("resumed");
    const out=await p.next("output"); childId=(JSON.parse(Buffer.from(out.data as string,"base64").toString("utf8")) as {childId:number}).childId;
    assert.ok(Number.isInteger(childId) && childId>0); process.stdout.write(`Owned PID ${childId}: stalled-bridge provisioner descendant\n`);
    assert.doesNotThrow(()=>process.kill(childId!,0)); p.send({type:"stall"});
    await gone(p.rootPid!,5000); await gone(childId,1000);
    assert.doesNotThrow(()=>process.kill(p.bridge.pid!,0)); // Before cleanup or six-second last-handle-close grace.
    const [code]=await p.exited; assert.equal(code,137);
  } finally { await p.cleanup(); if(childId!==undefined) await gone(childId); }
});
it("provisioner admission expiry: blocked control output cannot defer native root stop and bridge exit",{ timeout:18000 },async()=>{
  const p=await probe({ arguments:["--experimental-strip-types",fileURLToPath(new URL("./flood-owned-runner.ts",import.meta.url))] });
  try {
    await p.next("ready"); await accept(p,await challenge(p),1500); p.bridge.stdout.pause(); p.send({type:"go"});
    await gone(p.rootPid!,4500); const [code]=await p.exited; assert.equal(code,137);
  } finally { p.bridge.stdout.resume(); await p.cleanup(); }
});
it("provisioner admission bootstrap: no challenge or ACK cannot keep a suspended root alive",{ timeout:25000 },async()=>{
  const p=await probe();
  try { await p.next("ready"); const began=performance.now(); const closed=await p.next("closed",18000); assert.equal(closed.deadlineExpired,true); assert.ok(performance.now()-began<18000); assert.equal(p.frames.some((f)=>f.type==="resumed"),false); }
  finally { await p.cleanup(); }
});
it("provisioner admission bootstrap: valid admission replaces bootstrap but not the original deadline",{ timeout:25000 },async()=>{
  const p=await probe();
  try {
    await p.next("ready"); const began=performance.now(); await delay(13000);
    await accept(p,await challenge(p),5000); p.send({type:"go"}); await p.next("resumed");
    await delay(2500); assert.ok(performance.now()-began>=15500); assert.doesNotThrow(()=>process.kill(p.rootPid!,0));
    const closed=await p.next("closed"); assert.equal(closed.deadlineExpired,true); assert.ok(performance.now()-began<21000);
  } finally { await p.cleanup(); }
});
