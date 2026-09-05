import assert from "node:assert/strict";
import { it } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createStableId } from "@acp/domain";
import { probe,gone,commit,accept,challenge,type Frame } from "./native-lease-probe.ts";

const delay=(ms: number) => new Promise<void>((done) => setTimeout(done,ms));

it("native lease launch requires ACP UUIDv4 identities before creating a root",{ timeout:16000 },async () => {
  for (const invalid of [{ leaseId:"lea_00000000-0000-0000-0000-000000000000" },
    { runId:"run_00000000-0000-1000-8000-000000000000" },{ workerProcessId:"wpr_00000000-0000-4000-0000-000000000000" }]) {
    const p=await probe("nonreading-owned-runner.ts",30000,undefined,invalid);
    try {
      const first=await p.next(["ready","failure"]); assert.equal(first.type,"failure");
      assert.equal(p.rootPid,undefined); await p.exited;
    } finally { await p.close(); }
  }
});

it("leased native root is suspended until its first one-use challenge is accepted",{ timeout:16000 },async () => {
  const p=await probe("synthetic-owned-runner.ts");
  try {
    const first=(await p.next("ready")).filesystemLeaseChallenge as Frame;
    assert.match(first.nonce as string,/^[0-9a-f]{32}$/u); assert.equal(first.epoch,1);
    p.send({ type:"go",input:JSON.stringify({ text:"must not run" }) });
    const failure=await p.next("failure"); assert.equal(failure.treeEmpty,true);
    await p.exited; assert.equal(p.frames.some((frame) => frame.type==="output"),false); await gone(p.rootPid!);
  } finally { await p.close(); }
});

it("a first accepted native epoch permits one normal result and exact owned closure",{ timeout:16000 },async () => {
  const p=await probe("synthetic-owned-runner.ts");
  try {
    await accept(p,(await p.next("ready")).filesystemLeaseChallenge as Frame,1,5000);
    p.send({ type:"go",input:JSON.stringify({ text:"leased result" }) });
    const closed=await p.next("closed"); assert.equal(closed.treeEmpty,true); assert.equal(closed.terminated,false); assert.equal(closed.exitCode,0);
    await p.exited;
    const output=Buffer.concat(p.frames.filter((f) => f.type==="output").map((f) => Buffer.from(f.data as string,"base64"))).toString("utf8");
    assert.deepEqual(JSON.parse(output),{ processId:p.rootPid,text:"leased result",leaked:false }); await gone(p.rootPid!);
  } finally { await p.close(); }
});

it("native lease silence kills a live root and detached descendant while the later run deadline and pipes remain live",{ timeout:16000 },async () => {
  const p=await probe("synthetic-owned-runner.ts");
  try {
    await accept(p,(await p.next("ready")).filesystemLeaseChallenge as Frame,1,1500);
    const began=performance.now(); p.send({ type:"go",input:JSON.stringify({ mode:"hold-descendant" }) });
    const output=await p.next("output"),childId=(JSON.parse(Buffer.from(output.data as string,"base64").toString("utf8")) as { childId:number }).childId;
    assert.ok(Number.isSafeInteger(childId) && childId>0); process.stdout.write(`Owned PID ${childId}: leased detached descendant\n`);
    assert.doesNotThrow(() => process.kill(childId,0));
    const closed=await p.next("closed"); assert.equal(closed.treeEmpty,true); assert.equal(closed.terminated,true); assert.equal(closed.exitCode,137);
    assert.ok(performance.now()-began<4000); await gone(p.rootPid!); await gone(childId);
  } finally { await p.close(); }
});

it("a pending challenge does not extend the last accepted native epoch",{ timeout:16000 },async () => {
  const p=await probe();
  try {
    await accept(p,(await p.next("ready")).filesystemLeaseChallenge as Frame,1,1000);
    p.send({ type:"go",input:"{}" }); const next=await challenge(p); assert.equal(next.epoch,2);
    const began=performance.now(); assert.equal((await p.next("closed")).terminated,true);
    assert.ok(performance.now()-began<4000); await gone(p.rootPid!);
  } finally { await p.close(); }
});

it("queued acknowledgement time is charged from challenge issuance rather than frame arrival",{ timeout:16000 },async () => {
  const p=await probe();
  try {
    await accept(p,(await p.next("ready")).filesystemLeaseChallenge as Frame,1,5000);
    p.send({ type:"go",input:"{}" }); const next=await challenge(p);
    await delay(500); commit(p,next,2,600);
    assert.equal((await p.next("failure")).treeEmpty,true); await p.exited; await gone(p.rootPid!);
    assert.equal(p.frames.some((f) => f.type==="lease-accepted"),false);
  } finally { await p.close(); }
});

it("an expired old epoch cannot be revived by a late long-duration reply",{ timeout:16000 },async () => {
  const p=await probe();
  try {
    await accept(p,(await p.next("ready")).filesystemLeaseChallenge as Frame,1,750);
    p.send({ type:"go",input:"{}" }); const next=await challenge(p);
    await gone(p.rootPid!,4000); commit(p,next,2,20000); await p.exited;
    assert.equal(p.frames.some((f) => f.type==="lease-accepted"),false);
  } finally { await p.close(); }
});

for (const [name,overrides] of Object.entries({
  "wrong nonce":{ nonce:"0".repeat(32) },"wrong lease":{ leaseId:createStableId("lease") },"wrong run":{ runId:createStableId("run") },
  "wrong worker":{ workerProcessId:createStableId("workerProcess") },"replayed revision":{ revision:1 },
  "oversized duration":{ durationMilliseconds:20001 },"fractional duration":{ durationMilliseconds:500.5 },"string revision":{ revision:"2" },
})) {
  it(`native epoch denies ${name} and stops the exact owned root`,{ timeout:16000 },async () => {
    const p=await probe();
    try {
      await accept(p,(await p.next("ready")).filesystemLeaseChallenge as Frame,1,5000);
      p.send({ type:"go",input:"{}" }); commit(p,await challenge(p),2,5000,overrides);
      assert.equal((await p.next("failure")).treeEmpty,true); await p.exited; await gone(p.rootPid!);
      assert.equal(p.frames.some((f) => f.type==="lease-accepted"),false);
    } finally { await p.close(); }
  });
}

it("duplicate challenge requests cannot replace the outstanding nonce or keep a suspended root alive",{ timeout:16000 },async () => {
  const p=await probe();
  try {
    await p.next("ready"); p.send({ type:"lease-challenge" }); p.send({ type:"lease-challenge" });
    assert.equal((await p.next("failure")).treeEmpty,true); await p.exited; await gone(p.rootPid!);
    assert.equal(p.frames.some((f) => f.type==="lease-challenge"),false);
  } finally { await p.close(); }
});

it("fresh native epochs survive the first deadline then expire after the last ACK",{ timeout:18000 },async () => {
  const p=await probe();
  try {
    await accept(p,(await p.next("ready")).filesystemLeaseChallenge as Frame,1,2000);
    const began=performance.now(); p.send({ type:"go",input:"{}" });
    for (let revision=2;revision<=5;revision++) { await delay(500); await accept(p,await challenge(p),revision,2000); }
    assert.ok(performance.now()-began>=2000); assert.doesNotThrow(() => process.kill(p.rootPid!,0));
    assert.equal((await p.next("closed")).terminated,true); await gone(p.rootPid!);
  } finally { await p.close(); }
});

it("the persisted run deadline still caps a longer accepted lease epoch",{ timeout:18000 },async () => {
  const p=await probe("nonreading-owned-runner.ts",6000);
  try {
    await accept(p,(await p.next("ready")).filesystemLeaseChallenge as Frame,1,20000);
    p.send({ type:"go",input:"{}" }); const began=performance.now();
    assert.equal((await p.next("closed",8000)).terminated,true); assert.ok(performance.now()-began<7000); await gone(p.rootPid!);
  } finally { await p.close(); }
});

it("no first ACK expires the suspended bootstrap without executing the runner",{ timeout:23000 },async () => {
  const p=await probe("synthetic-owned-runner.ts");
  try {
    await p.next("ready"); const began=performance.now();
    const closed=await p.next("closed",18000); assert.equal(closed.terminated,true); assert.equal(closed.treeEmpty,true);
    assert.ok(performance.now()-began<18000); assert.equal(p.frames.some((f) => f.type==="output"),false); await gone(p.rootPid!);
  } finally { await p.close(); }
});

it("native expiry kills the tree and exits the bridge even when control output is blocked",{ timeout:18000 },async () => {
  const p=await probe("flood-owned-runner.ts");
  try {
    await accept(p,(await p.next("ready")).filesystemLeaseChallenge as Frame,1,1000);
    p.bridge.stdout.pause(); p.send({ type:"go",input:"{}" });
    await gone(p.rootPid!,4000); const [code]=await p.exited; assert.equal(code,137);
  } finally { p.bridge.stdout.resume(); await p.close(); }
});

it("native expiry stops the worker while a sacrificial Node daemon is stalled with pipes open",{ timeout:18000 },async () => {
  const parent=spawn(process.execPath,["--experimental-strip-types",fileURLToPath(new URL("./synthetic-lease-stall.ts",import.meta.url))],
    { windowsHide:true,stdio:["ignore","ignore","ignore","ipc"] });
  assert.ok(parent.pid); process.stdout.write(`Owned PID ${parent.pid}: stalled synthetic daemon\n`);
  const exited=once(parent,"exit");
  const pids=new Set<number>();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const ready=new Promise<{ rootPid: number; bridgePid: number }>((resolve,reject) => {
    parent.on("message",(message: { ready?: boolean; pid?: number; purpose?: string; rootPid: number; bridgePid: number }) => {
      if (message.pid) { pids.add(message.pid); process.stdout.write(`Owned PID ${message.pid}: ${message.purpose}\n`); }
      if (message.ready) resolve(message);
    });
    parent.once("error",reject); parent.once("exit",() => reject(new Error("daemon exited before stall")));
    timeout=setTimeout(() => reject(new Error("daemon stall setup timed out")),8000);
  });
  try {
    const owned=await ready; clearTimeout(timeout);
    assert.deepEqual(pids,new Set([owned.bridgePid,owned.rootPid]));
    await gone(owned.rootPid,4000); await gone(owned.bridgePid,4000);
    assert.doesNotThrow(() => process.kill(parent.pid!,0));
  } finally {
    clearTimeout(timeout); if (parent.exitCode===null && parent.signalCode===null) parent.kill(); await exited;
    const until=Date.now()+6000;
    for (const pid of pids) await gone(pid,Math.max(1,until-Date.now()));
  }
});

it("stop ahead of a queued renewal never acknowledges future authority",{ timeout:16000 },async () => {
  const p=await probe();
  try {
    await accept(p,(await p.next("ready")).filesystemLeaseChallenge as Frame,1,5000);
    const next=await challenge(p); p.send({ type:"stop" }); commit(p,next,2,20000);
    assert.equal((await p.next("closed")).treeEmpty,true); await p.exited;
    assert.equal(p.frames.some((f) => f.type==="lease-accepted"),false); await gone(p.rootPid!);
  } finally { await p.close(); }
});
