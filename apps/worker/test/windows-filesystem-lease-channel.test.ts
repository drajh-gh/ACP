import assert from "node:assert/strict";
import { it } from "node:test";
import { createStableId } from "@acp/domain";
import { WindowsFilesystemLeaseChannel, guardFilesystemOwnedWorker } from "../src/windows-filesystem-lease-channel.ts";
import type { NativeFilesystemWriterController, NativeFilesystemWriterOutcome, NativeFilesystemWriterSession } from "../src/native-filesystem-writer-controller.ts";
import type { OwnedWorker, OwnedWorkerExit } from "../src/windows-worker-launcher.ts";
import { WorkerTerminationUnconfirmedError } from "../src/worker-manager.ts";

function fixture() {
  const identity={ leaseId:createStableId("lease"),runId:createStableId("run"),workerProcessId:createStableId("workerProcess") };
  const first={ nonce:"1".repeat(32),epoch:1 },frames: unknown[]=[]; let stops=0;
  const channel=new WindowsFilesystemLeaseChannel(identity,first,(frame) => frames.push(frame),() => { stops++; },30);
  const commit={ ...identity,...first,revision:2,durationMilliseconds:20000 };
  return { identity,first,frames,channel,commit,get stops() { return stops; } };
}

it("private channel freezes exact identity and first challenge without sending or renewing",() => {
  const f=fixture();
  assert.equal(Object.isFrozen(f.channel.identity),true); assert.equal(Object.isFrozen(f.channel.initialChallenge),true);
  f.identity.runId=createStableId("run"); f.first.epoch=99;
  assert.notEqual(f.channel.identity.runId,f.identity.runId); assert.equal(f.channel.initialChallenge.epoch,1);
  assert.deepEqual(f.frames,[]); f.channel.close();
});

it("private channel rejects malformed bootstrap, identity and timeout configuration",() => {
  const f=fixture(),send=() => {},stop=() => {};
  for (const initial of [undefined,null,[],{ ...f.first,nonce:"bad" },{ ...f.first,epoch:2 },{ ...f.first,extra:true }]) {
    assert.throws(() => new WindowsFilesystemLeaseChannel(f.identity,initial,send,stop));
  }
  for (const identity of [{ ...f.identity,leaseId:createStableId("run") },{ ...f.identity,extra:true }]) {
    assert.throws(() => new WindowsFilesystemLeaseChannel(identity as never,f.first,send,stop));
  }
  for (const timeout of [0,5001,1.5,NaN,Infinity]) assert.throws(() => new WindowsFilesystemLeaseChannel(f.identity,f.first,send,stop,timeout));
  f.channel.close();
});

it("initial native acceptance requires its exact nonce, epoch and DB revision",async () => {
  const f=fixture(),pending=f.channel.accept(f.commit);
  assert.deepEqual(f.frames,[{ type:"lease-commit",...f.commit }]);
  f.channel.receive({ type:"lease-accepted",nonce:f.first.nonce,epoch:1,revision:2 });
  assert.deepEqual(await pending,{ nonce:f.first.nonce,epoch:1,revision:2 }); assert.equal(f.stops,0); f.channel.close();
});

it("private native wait is registered before a synchronous challenge reply can arrive",async () => {
  const f=fixture();
  const channel=new WindowsFilesystemLeaseChannel(f.identity,f.first,(frame) => {
    assert.deepEqual(frame,{ type:"lease-challenge" }); channel.receive({ type:"lease-challenge",nonce:"2".repeat(32),epoch:2 });
  },() => assert.fail("unexpected stop"));
  assert.deepEqual(await channel.requestChallenge(),{ nonce:"2".repeat(32),epoch:2 }); channel.close(); f.channel.close();
});

it("duplicate native requests reject the old and new wait and stop without a second frame",async () => {
  const f=fixture(),first=assert.rejects(f.channel.requestChallenge(),/already pending/u);
  await assert.rejects(f.channel.requestChallenge(),/already pending/u); await first;
  assert.deepEqual(f.frames,[{ type:"lease-challenge" }]); assert.equal(f.stops,1);
});

it("lost native ACK has a bounded timeout that stops ownership independently of awaiting the rejection",async () => {
  const f=fixture();
  await assert.rejects(f.channel.accept(f.commit),/timed out/u); assert.equal(f.stops,1);
  await new Promise((done) => setTimeout(done,50)); assert.equal(f.stops,1);
});

it("native close rejects an outstanding wait, clears its timer and denies every later request",async () => {
  const f=fixture(),pending=assert.rejects(f.channel.requestChallenge(),/closed/u);
  f.channel.close(); await pending; await assert.rejects(f.channel.accept(f.commit),/already closed/u);
  await new Promise((done) => setTimeout(done,50)); assert.equal(f.stops,0); assert.equal(f.frames.length,1);
});

it("wrong native ACKs fail closed rather than satisfying another pending operation",async () => {
  for (const change of [{ type:"lease-challenge" },{ nonce:"2".repeat(32) },{ epoch:2 },{ revision:1 },{ revision:"2" },{ extra:true }]) {
    const f=fixture(),pending=assert.rejects(f.channel.accept(f.commit),/invalid native epoch transition/u);
    assert.throws(() => f.channel.receive({ type:"lease-accepted",nonce:f.first.nonce,epoch:1,revision:2,...change }),/invalid native epoch transition/u);
    await pending; assert.equal(f.stops,1);
  }
});

it("unsolicited, duplicate and late native ACKs never revive a closed channel",async () => {
  const f=fixture(),frame={ type:"lease-accepted",nonce:f.first.nonce,epoch:1,revision:2 };
  assert.throws(() => f.channel.receive(frame)); assert.equal(f.stops,1);
  await assert.rejects(f.channel.accept(f.commit)); assert.equal(f.frames.length,0);
  const g=fixture(),pending=g.channel.accept(g.commit);
  g.channel.receive({ ...frame,nonce:g.first.nonce }); await pending;
  assert.throws(() => g.channel.receive(frame)); await assert.rejects(g.channel.requestChallenge()); assert.equal(g.frames.length,1);
});

it("private commits cannot change bound IDs or carry invalid revisions and budgets",async () => {
  for (const change of [{ leaseId:createStableId("lease") },{ runId:createStableId("run") },{ workerProcessId:createStableId("workerProcess") },
    { nonce:"bad" },{ epoch:0 },{ revision:0 },{ revision:1.5 },{ durationMilliseconds:250 },{ durationMilliseconds:20001 },
    { durationMilliseconds:500.5 },{ extra:true }]) {
    const f=fixture(); await assert.rejects(f.channel.accept({ ...f.commit,...change }),/invalid native epoch commit/u);
    assert.equal(f.frames.length,0); assert.equal(f.stops,1);
  }
});

it("synchronous native write errors settle the registered wait and do not leave a timer",async () => {
  const f=fixture(); let stops=0;
  const channel=new WindowsFilesystemLeaseChannel(f.identity,f.first,() => { throw new Error("pipe failure"); },() => { stops++; },20);
  await assert.rejects(channel.requestChallenge(),/delivery failed/u);
  await new Promise((done) => setTimeout(done,40)); assert.equal(stops,1); f.channel.close();
});

function wrappedFixture() {
  const f=fixture(),receipt=Promise.withResolvers<OwnedWorkerExit>(),outcome=Promise.withResolvers<NativeFilesystemWriterOutcome>();
  const signal=new AbortController(),exit: OwnedWorkerExit={ treeEmpty:true,exitCode:0,terminated:false,failed:false,output:"{}" };
  let releases=0,stops=0,runs=0,seen: NativeFilesystemWriterSession | undefined;
  const raw: OwnedWorker={ scope:{ machineFingerprint:"a".repeat(64),bootedAt:"2000-01-01T00:00:00.000Z",sessionId:1 },
    processId:123,processStartToken:"win32-filetime:134000000000000000",startedAt:"2000-01-01T00:00:00.000Z",closed:receipt.promise,
    release() { releases++; },async terminate() { stops++; f.channel.close(); receipt.resolve({ ...exit,terminated:true,exitCode:137 }); return receipt.promise; } };
  const controller={ run(session: NativeFilesystemWriterSession) { runs++; seen=session; session.release("input"); return outcome.promise; } } as unknown as NativeFilesystemWriterController;
  return { ...f,raw,controller,receipt,outcome,signal,exit,wrap:() => guardFilesystemOwnedWorker(raw,f.channel,controller,signal.signal),
    get counts() { return { releases,stops,runs }; },get seen() { return seen; } };
}

it("public worker exposes no raw epoch methods and only the controller sends actual GO",async () => {
  const f=wrappedFixture(),worker=f.wrap();
  assert.equal("acceptLease" in worker,false); assert.equal("requestLeaseChallenge" in worker,false);
  worker.release("input"); assert.throws(() => worker.release("input"));
  assert.equal(f.seen?.closed,f.raw.closed); assert.equal(f.seen?.terminate,f.raw.terminate);
  assert.deepEqual(f.counts,{ releases:1,stops:0,runs:1 });
  f.receipt.resolve(f.exit); f.outcome.resolve({ state:"closed",exit:f.exit,authorityLost:false });
  assert.deepEqual(await worker.closed,f.exit); f.channel.close();
});

it("public close waits for controller quiescence after raw native closure",async () => {
  const f=wrappedFixture(),worker=f.wrap(); let settled=false;
  void worker.closed.then(() => { settled=true; }); worker.release("input");
  f.receipt.resolve(f.exit); await Promise.resolve(); await Promise.resolve(); assert.equal(settled,false);
  f.outcome.resolve({ state:"closed",exit:f.exit,authorityLost:true });
  assert.deepEqual(await worker.closed,{ ...f.exit,failed:true }); f.channel.close();
});

it("public termination stops raw ownership immediately without awaiting controller completion",async () => {
  const f=wrappedFixture(),worker=f.wrap(); let settled=false;
  worker.release("input"); const stopped=worker.terminate().then((exit) => { settled=true; return exit; });
  assert.equal(f.counts.stops,1); await Promise.resolve(); await Promise.resolve(); assert.equal(settled,false);
  f.outcome.resolve({ state:"closed",exit:f.exit,authorityLost:false });
  assert.equal((await stopped).failed,true);
});

it("pre-release native closure settles public completion without starting a controller",async () => {
  const f=wrappedFixture(),worker=f.wrap();
  f.receipt.resolve({ ...f.exit,terminated:true,exitCode:137 });
  assert.deepEqual(await worker.closed,{ ...f.exit,terminated:true,exitCode:137,failed:true });
  assert.equal(f.counts.runs,0); assert.throws(() => worker.release("input")); f.channel.close();
});

it("pre-release termination performs no DB/controller operation and cannot deadlock on itself",async () => {
  const f=wrappedFixture(),worker=f.wrap();
  assert.equal((await worker.terminate()).treeEmpty,true); assert.deepEqual(f.counts,{ releases:0,stops:1,runs:0 });
});

it("unconfirmed controller outcome is not converted into a public success",async () => {
  const f=wrappedFixture(),worker=f.wrap(); worker.release("input");
  f.receipt.resolve(f.exit); f.outcome.resolve({ state:"unconfirmed" });
  await assert.rejects(worker.closed,WorkerTerminationUnconfirmedError); f.channel.close();
});

it("unexpected controller failure still stops and awaits raw native cleanup",async () => {
  for (const sync of [false,true]) {
    const f=wrappedFixture(),cleanup=Promise.withResolvers<OwnedWorkerExit>(); let stopped=false,settled=false;
    f.raw.terminate=async () => { stopped=true; const exit=await cleanup.promise; f.receipt.resolve(exit); return exit; };
    f.controller.run=() => { if (sync) throw new Error("controller failed"); return Promise.reject(new Error("controller failed")); };
    const worker=f.wrap(); const rejected=assert.rejects(worker.closed,WorkerTerminationUnconfirmedError).then(() => { settled=true; });
    worker.release("input"); await Promise.resolve(); await Promise.resolve(); assert.equal(stopped,true); assert.equal(settled,false);
    cleanup.resolve({ ...f.exit,terminated:true,exitCode:137 }); await rejected; f.channel.close();
  }
});

it("oversized or pre-aborted public release does not enter the controller",async () => {
  for (const abort of [false,true]) {
    const f=wrappedFixture(),worker=f.wrap(); if (abort) f.signal.abort();
    assert.throws(() => worker.release(abort ? "input" : "x".repeat(524288)));
    assert.equal(f.counts.runs,0); await worker.terminate();
  }
});
