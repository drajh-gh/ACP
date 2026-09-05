import assert from "node:assert/strict";
import { it } from "node:test";
import { leaseChannelFixture } from "./lease-channel-fixture.ts";
import { gone } from "./native-lease-probe.ts";

it("public native lease channel sustains serial epochs until caller cancellation",{ timeout:20000 },async () => {
  const f=await leaseChannelFixture(100),renewed=Promise.withResolvers<void>(),heartbeat=f.writers.heartbeat;
  let active=0,maximum=0;
  f.writers.heartbeat=async () => {
    active++; maximum=Math.max(maximum,active);
    try { const value=await heartbeat(); if(f.counts.renewals===4) renewed.resolve(); return value; }
    finally { active--; }
  };
  const worker=await f.launcher.launch(f.request);
  try {
    worker.release(JSON.stringify({ mode:"hold" }));
    await renewed.promise; f.caller.abort();
    const exit=await worker.closed;
    assert.equal(exit.failed,true); assert.equal(exit.terminated,true); assert.equal(exit.treeEmpty,true); assert.equal(exit.launchSealed,true);
    // The fourth challenge can be issued only after all three prior native ACKs.
    assert.deepEqual(f.counts,{ loads:1,renewals:4 }); assert.equal(maximum,1);
  } finally { await f.cleanup(worker); }
});

it("a lost periodic database ACK kills the public root and its detached descendant",{ timeout:20000 },async () => {
  const f=await leaseChannelFixture(1000),heartbeat=f.writers.heartbeat;
  f.writers.heartbeat=async () => {
    const value=await heartbeat();
    if(f.counts.renewals===2) throw new Error("synthetic committed periodic ACK loss");
    return value;
  };
  const worker=await f.launcher.launch(f.request);
  try {
    worker.release(JSON.stringify({ mode:"hold-descendant" }));
    const exit=await worker.closed;
    assert.equal(exit.failed,true); assert.equal(exit.terminated,true); assert.equal(exit.treeEmpty,true); assert.equal(exit.launchSealed,true);
    assert.deepEqual(f.counts,{ loads:1,renewals:2 });
    const output=JSON.parse(exit.output) as { processId:number; childId:number };
    assert.equal(output.processId,worker.processId); assert.ok(Number.isSafeInteger(output.childId));
    process.stdout.write(`Observed owned descendant PID ${output.childId}: synthetic native lease loss test\n`);
    f.pids.add(output.childId); await gone(output.childId,4000);
  } finally { await f.cleanup(worker); }
});

it("native old-epoch expiry stops a public root during a held periodic DB ACK and awaits that ACK",{ timeout:20000 },async () => {
  const f=await leaseChannelFixture(100),entered=Promise.withResolvers<void>(),pending=Promise.withResolvers<void>(),heartbeat=f.writers.heartbeat;
  f.lease={ ...f.lease,expiresAt:"2000-01-01T00:00:03.000Z" };
  f.writers.heartbeat=async () => {
    const value=await heartbeat();
    if(f.counts.renewals===2) { entered.resolve(); await pending.promise; }
    return value;
  };
  const worker=await f.launcher.launch(f.request); let settled=false;
  try {
    worker.release(JSON.stringify({ mode:"hold" }));
    void worker.closed.then(() => { settled=true; },() => { settled=true; });
    await entered.promise; await gone(worker.processId,6000);
    assert.equal(settled,false); // Native stop does not detach the database work.
    pending.resolve(); const exit=await worker.closed;
    assert.equal(exit.failed,true); assert.equal(exit.terminated,true); assert.equal(exit.treeEmpty,true); assert.equal(exit.launchSealed,true);
    assert.deepEqual(f.counts,{ loads:1,renewals:2 });
  } finally { pending.resolve(); await f.cleanup(worker); }
});
