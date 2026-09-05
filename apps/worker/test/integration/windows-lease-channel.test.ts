import assert from "node:assert/strict";
import { it } from "node:test";
import { leaseChannelFixture } from "./lease-channel-fixture.ts";
import { gone } from "./native-lease-probe.ts";
import { createStableId } from "@acp/domain";
import { WindowsWorkerLauncher } from "../../src/windows-worker-launcher.ts";

it("private lease channel never sends GO after a failed fresh database acknowledgement",{ timeout:15000 },async () => {
  const f=await leaseChannelFixture(); let heartbeatCalls=0;
  f.writers.heartbeat=async () => { heartbeatCalls++; throw new Error("synthetic committed acknowledgement loss"); };
  const worker=await f.launcher.launch(f.request);
  try {
    assert.deepEqual(f.counts,{ loads:0,renewals:0 });
    worker.release(JSON.stringify({ text:"must not execute" }));
    const exit=await worker.closed;
    assert.equal(exit.failed,true); assert.equal(exit.treeEmpty,true); assert.equal(exit.output,"");
    assert.equal(heartbeatCalls,1);
  } finally { await f.cleanup(worker); }
});

it("leased launcher stays suspended before public release and privately acknowledges authority before normal output",{ timeout:15000 },async () => {
  // Isolate the first-epoch path from the separately conservative natural-exit /
  // periodic-renewal race; timed renewal cases use their own shorter cadence.
  const f=await leaseChannelFixture(5000),worker=await f.launcher.launch(f.request);
  try {
    let closed=false; void worker.closed.then(() => { closed=true; },() => { closed=true; });
    await new Promise((done) => setTimeout(done,100));
    assert.equal(closed,false); assert.deepEqual(f.counts,{ loads:0,renewals:0 });
    assert.equal("acceptLease" in worker,false); assert.equal("requestLeaseChallenge" in worker,false); assert.equal("leaseIdentity" in worker,false);
    worker.release(JSON.stringify({ text:"guarded ž 🚀" }));
    assert.throws(() => worker.release("{}"));
    const exit=await worker.closed;
    assert.equal(exit.failed,false,JSON.stringify({ exit,counts:f.counts })); assert.equal(exit.terminated,false); assert.equal(exit.exitCode,0);
    assert.deepEqual(JSON.parse(exit.output),{ processId:worker.processId,text:"guarded ž 🚀",leaked:false });
    assert.deepEqual(f.counts,{ loads:1,renewals:1 });
  } finally { await f.cleanup(worker); }
});

it("public termination before lease release stops the suspended tree without database work",{ timeout:15000 },async () => {
  const f=await leaseChannelFixture(),worker=await f.launcher.launch(f.request);
  try {
    const exit=await worker.terminate();
    assert.equal(exit.treeEmpty,true); assert.equal(exit.terminated,true); assert.equal(exit.failed,true); assert.equal(exit.output,"");
    assert.deepEqual(f.counts,{ loads:0,renewals:0 }); assert.throws(() => worker.release("{}"));
  } finally { await f.cleanup(worker); }
});

it("public terminate kills native ownership during a held database ACK but closure waits for that transaction",{ timeout:15000 },async () => {
  const f=await leaseChannelFixture(),entered=Promise.withResolvers<void>(),pending=Promise.withResolvers<void>(),heartbeat=f.writers.heartbeat;
  f.writers.heartbeat=async () => { const value=await heartbeat(); entered.resolve(); await pending.promise; return value; };
  const worker=await f.launcher.launch(f.request); let settled=false;
  try {
    worker.release(JSON.stringify({ text:"never GO" }));
    await entered.promise;
    const stopping=worker.terminate().then((exit) => { settled=true; return exit; });
    await gone(worker.processId,4000); assert.equal(settled,false);
    pending.resolve(); const exit=await stopping;
    assert.equal(exit.failed,true); assert.equal(exit.terminated,true); assert.equal(exit.treeEmpty,true); assert.equal(exit.output,"");
    assert.deepEqual(f.counts,{ loads:1,renewals:1 });
  } finally { pending.resolve(); await f.cleanup(worker); }
});

it("leased public launcher rejects missing or changed persisted targets before spawning",{ timeout:15000 },async () => {
  const f=await leaseChannelFixture(),before=f.pids.size;
  try {
    const { launchFence:_fence,...withoutFence }=f.request;
    const { filesystemWriterController:_controller,...withoutController }=f.options;
    await assert.rejects(f.launcher.launch(withoutFence),/launch binding/u);
    await assert.rejects(new WindowsWorkerLauncher(withoutController).launch(f.request),/configured controller/u);
    for (const change of [
      { workspace:f.request.workspace+"-other" },{ deadlineAt:new Date(Date.parse(f.request.deadlineAt)+1).toISOString() },
      { launchFence:{ ...f.request.launchFence,directory:f.request.launchFence.directory+"-other" } },
      { launchFence:{ ...f.request.launchFence,directoryIdentity:"win32-dir:12345678:0000000000000001" } },
      { launchFence:{ ...f.request.launchFence,scope:{ ...f.request.launchFence.scope,sessionId:f.request.launchFence.scope.sessionId+1 } } },
      { filesystemLease:{ ...f.request.filesystemLease,runId:createStableId("run") } },
      { filesystemLease:{ ...f.request.filesystemLease,workerProcessId:createStableId("workerProcess") } },
    ]) await assert.rejects(f.launcher.launch({ ...f.request,...change }),/launch binding|exact process identity/u);
    f.caller.abort(); await assert.rejects(f.launcher.launch(f.request),/cancelled/u);
    assert.equal(f.pids.size,before); assert.deepEqual(f.counts,{ loads:0,renewals:0 });
  } finally { await f.cleanup(); }
});

it("persisted launch seal prevents a second native root before the database stop receipt",{ timeout:15000 },async () => {
  const f=await leaseChannelFixture(5000),worker=await f.launcher.launch(f.request);
  try {
    worker.release(JSON.stringify({ text:"first and only" }));
    const exit=await worker.closed;
    assert.equal(exit.failed,false); assert.equal(exit.launchSealed,true);
    assert.equal(f.lease.state,"active");
    await assert.rejects(f.launcher.launch(f.request));
    assert.deepEqual(f.counts,{ loads:1,renewals:1 }); assert.equal(f.bindingReads,2);
  } finally { await f.cleanup(worker); }
});

it("public leased launch snapshots its caller fence and workspace before the database await",{ timeout:15000 },async () => {
  const f=await leaseChannelFixture(5000),pending=Promise.withResolvers<void>(),read=f.writers.loadLaunchBinding;
  f.writers.loadLaunchBinding=async () => { const value=await read(); await pending.promise; return value; };
  const launching=f.launcher.launch(f.request);
  f.request.workspace+="-changed"; Object.assign(f.request.launchFence.scope,{ sessionId:f.request.launchFence.scope.sessionId+1 });
  pending.resolve(); const worker=await launching;
  try {
    worker.release(JSON.stringify({ text:"original binding" }));
    const exit=await worker.closed;
    assert.equal(exit.failed,false); assert.equal(exit.launchSealed,true);
  } finally { pending.resolve(); await f.cleanup(worker); }
});
