import assert from "node:assert/strict";
import { it } from "node:test";
import { createStableId } from "@acp/domain";
import type { FilesystemWriterLease } from "@acp/storage";
import { FilesystemWriterGuard } from "../src/filesystem-writer-guard.ts";

function fixture() {
  const controller = new AbortController();
  const authority = { hostIdentifier:"host:writer-guard",sessionId:createStableId("workerHostSession"),applicationVersion:"guard-test" };
  let lease: FilesystemWriterLease = { leaseId:createStableId("lease"),runId:createStableId("run"),workerProcessId:createStableId("workerProcess"),
    worktreeBindingId:createStableId("worktreeBinding"),repositoryBindingId:createStableId("repositoryBinding"),provenanceId:createStableId("provenance"),
    hostIdentifier:authority.hostIdentifier,ownerSessionId:authority.sessionId,applicationVersion:authority.applicationVersion,
    workspaceKey:"logical-workspace",physicalWorkspaceKey:"physical-workspace",physicalRepositoryKey:"physical-repository",branchKey:"logical-branch",
    acquiredAt:"2000-01-01T00:00:00.000Z",heartbeatAt:"2000-01-01T00:00:00.000Z",expiresAt:"2000-01-01T00:00:20.000Z",
    revision:1,releasedAt:null,state:"active" };
  let renewals = 0, loads = 0, monotonic = 0;
  const writers = { authority,async load(): Promise<FilesystemWriterLease | undefined> { loads++; return { ...lease }; },
    async heartbeat(): Promise<FilesystemWriterLease> { renewals++; lease={ ...lease,revision:lease.revision+1 }; return { ...lease }; } };
  const options = { renewalIntervalMs:5,monotonicNow:() => monotonic };
  return { writers,options,controller,guard:() => new FilesystemWriterGuard(writers,options),
    get lease() { return lease; },set lease(value) { lease=value; },get counts() { return { loads,renewals }; },
    set monotonic(value: number) { monotonic=value; } };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes,no) => { resolve=yes; reject=no; });
  return { promise,resolve,reject };
}
const unconfirmed = { state:"unconfirmed" };

it("writer guard brackets one trusted operation with acknowledged exact-owner renewals",async () => {
  const f=fixture(); let calls=0;
  const result=await f.guard().run(f.lease.leaseId,f.controller.signal,async (scope) => {
    calls++; assert.equal(scope.signal.aborted,false); assert.equal(scope.lease.revision,2);
    assert.equal(Object.isFrozen(scope.lease),true); return "validated output";
  });
  assert.deepEqual(result,{ state:"completed",value:"validated output" });
  assert.equal(calls,1); assert.deepEqual(f.counts,{ loads:1,renewals:2 });
});

it("writer guard rejects invalid IDs and interval configuration before I/O",async () => {
  const f=fixture();
  for (const renewalIntervalMs of [0,5001,1.5,NaN,Infinity]) assert.throws(() => new FilesystemWriterGuard(f.writers,{ renewalIntervalMs }),TypeError);
  await assert.rejects(f.guard().run(createStableId("run") as never,f.controller.signal,async () => true),TypeError);
  assert.deepEqual(f.counts,{ loads:0,renewals:0 });
});

it("missing, inactive, released, invalid-revision and foreign-owner snapshots never enter the operation",async () => {
  for (const change of [{ state:"recovering" as const },{ state:"released" as const },{ releasedAt:"2000-01-01T00:00:01.000Z" },
    { revision:0 },{ revision:1.5 },{ ownerSessionId:createStableId("workerHostSession") },{ hostIdentifier:"other" },{ applicationVersion:"other" }]) {
    const f=fixture(); f.lease={ ...f.lease,...change };
    assert.deepEqual(await f.guard().run(f.lease.leaseId,f.controller.signal,async () => assert.fail("entered")),unconfirmed);
    assert.equal(f.counts.renewals,0);
  }
  for (const mode of ["missing","wrong-id","error"]) {
    const f=fixture(); f.writers.load=async () => {
      if (mode==="error") throw new Error("read unavailable");
      return mode==="missing" ? undefined : { ...f.lease,leaseId:createStableId("lease") };
    };
    assert.deepEqual(await f.guard().run(f.lease.leaseId,f.controller.signal,async () => assert.fail("entered")),unconfirmed);
    assert.equal(f.counts.renewals,0);
  }
});

it("cancellation before admission or during load/initial ACK cannot enter work",async () => {
  for (const at of ["before","load","initial"]) {
    const f=fixture(),load=f.writers.load,heartbeat=f.writers.heartbeat;
    if (at==="before") f.controller.abort();
    f.writers.load=async () => { const value=await load(); if (at==="load") f.controller.abort(); return value; };
    f.writers.heartbeat=async () => { const value=await heartbeat(); if (at==="initial") f.controller.abort(); return value; };
    assert.deepEqual(await f.guard().run(f.lease.leaseId,f.controller.signal,async () => assert.fail("entered")),unconfirmed);
    assert.equal(f.counts.renewals,at==="initial" ? 1 : 0);
    if (at==="before") assert.equal(f.counts.loads,0);
  }
});

it("both initial and final ACKs must preserve every immutable lease identity and advance revision",async () => {
  for (const failedCall of [1,2]) for (const kind of ["revision","run","worker","binding","repository","owner","key","state","released","acquired"]) {
    const f=fixture(),heartbeat=f.writers.heartbeat; let calls=0,entered=false;
    f.writers.heartbeat=async () => {
      const before=f.lease,value=await heartbeat();
      if (++calls!==failedCall) return value;
      return { ...value,...(kind==="revision" ? { revision:before.revision } : {}),
        ...(kind==="run" ? { runId:createStableId("run") } : {}),...(kind==="worker" ? { workerProcessId:createStableId("workerProcess") } : {}),
        ...(kind==="binding" ? { worktreeBindingId:createStableId("worktreeBinding") } : {}),
        ...(kind==="repository" ? { repositoryBindingId:createStableId("repositoryBinding") } : {}),
        ...(kind==="owner" ? { ownerSessionId:createStableId("workerHostSession") } : {}),...(kind==="key" ? { branchKey:"other" } : {}),
        ...(kind==="state" ? { state:"recovering" as const } : {}),...(kind==="released" ? { releasedAt:value.heartbeatAt } : {}),
        ...(kind==="acquired" ? { acquiredAt:"2000-01-01T00:00:01.000Z" } : {}) };
    };
    assert.deepEqual(await f.guard().run(f.lease.leaseId,f.controller.signal,async () => { entered=true; return "candidate"; }),unconfirmed);
    assert.equal(entered,failedCall===2);
  }
});

it("periodic renewals continue through delayed validation and never overlap the final ACK",async () => {
  const f=fixture(),heartbeat=f.writers.heartbeat,validated=deferred<void>();
  let calls=0,active=0,maximum=0;
  f.writers.heartbeat=async () => {
    active++; maximum=Math.max(maximum,active);
    try { const value=await heartbeat(); if (++calls===3) validated.resolve(); return value; }
    finally { active--; }
  };
  const result=await f.guard().run(f.lease.leaseId,f.controller.signal,async () => { await validated.promise; return { revision:"validated" }; });
  assert.deepEqual(result,{ state:"completed",value:{ revision:"validated" } });
  assert.equal(maximum,1); assert.equal(active,0); assert.equal(calls,4);
});

it("a pending periodic failure invalidates an already-produced value and is awaited",async () => {
  const f=fixture(),heartbeat=f.writers.heartbeat,entered=deferred<void>(),pending=deferred<FilesystemWriterLease>(),output=deferred<string>();
  let calls=0,settled=false;
  f.writers.heartbeat=async () => { if (++calls===2) { entered.resolve(); return pending.promise; } return heartbeat(); };
  const run=f.guard().run(f.lease.leaseId,f.controller.signal,async () => output.promise).then((value) => { settled=true; return value; });
  await entered.promise; output.resolve("late candidate"); await Promise.resolve(); await Promise.resolve();
  assert.equal(settled,false); pending.reject(new Error("COMMIT acknowledgement lost"));
  assert.deepEqual(await run,unconfirmed); assert.equal(calls,2);
});

it("pending periodic success settles before the final fresh ACK",async () => {
  const f=fixture(),heartbeat=f.writers.heartbeat,entered=deferred<void>(),pending=deferred<FilesystemWriterLease>(),output=deferred<string>();
  let calls=0,settled=false;
  f.writers.heartbeat=async () => { if (++calls===2) { const value=await heartbeat(); entered.resolve(); await pending.promise; return value; } return heartbeat(); };
  const run=f.guard().run(f.lease.leaseId,f.controller.signal,async () => output.promise).then((value) => { settled=true; return value; });
  await entered.promise; output.resolve("candidate"); await Promise.resolve(); await Promise.resolve();
  assert.equal(settled,false); assert.equal(calls,2); pending.resolve(f.lease);
  assert.deepEqual(await run,{ state:"completed",value:"candidate" }); assert.equal(calls,3);
});

it("the old watchdog aborts work during a stalled heartbeat and awaits helper plus database cleanup",async () => {
  const f=fixture(),heartbeat=f.writers.heartbeat,pending=deferred<FilesystemWriterLease>(),aborted=deferred<void>(),cleanup=deferred<string>();
  f.lease={ ...f.lease,expiresAt:"2000-01-01T00:00:00.330Z" };
  let calls=0,settled=false;
  f.writers.heartbeat=async () => { if (++calls===2) return pending.promise; return heartbeat(); };
  const run=f.guard().run(f.lease.leaseId,f.controller.signal,async ({ signal }) => {
    signal.addEventListener("abort",() => aborted.resolve(),{ once:true }); return cleanup.promise;
  }).then((value) => { settled=true; return value; });
  await aborted.promise; assert.equal(settled,false); assert.equal(calls,2);
  cleanup.resolve("ignored late success"); await Promise.resolve(); await Promise.resolve(); assert.equal(settled,false);
  pending.resolve({ ...f.lease,revision:f.lease.revision+1 });
  assert.deepEqual(await run,unconfirmed); assert.equal(calls,2);
});

it("a late ACK beyond the old monotonic budget never rearms authority even before the timer runs",async () => {
  const f=fixture(),heartbeat=f.writers.heartbeat;
  let calls=0;
  f.writers.heartbeat=async () => { const value=await heartbeat(); if (++calls===2) f.monotonic=20000; return value; };
  assert.deepEqual(await f.guard().run(f.lease.leaseId,f.controller.signal,async ({ signal }) => new Promise((resolve) => {
    signal.addEventListener("abort",() => resolve("late success"),{ once:true });
  })),unconfirmed);
  assert.equal(calls,2);
});

it("the initial budget subtracts the whole ACK roundtrip and fixed margin",async () => {
  const f=fixture(),heartbeat=f.writers.heartbeat;
  f.lease={ ...f.lease,expiresAt:"2000-01-01T00:00:00.500Z" };
  f.writers.heartbeat=async () => { const value=await heartbeat(); f.monotonic=251; return value; };
  assert.deepEqual(await f.guard().run(f.lease.leaseId,f.controller.signal,async () => assert.fail("entered")),unconfirmed);
});

it("invalid, excessive and shortened final database durations cannot validate output",async () => {
  for (const expiresAt of ["invalid","2000-01-01T00:00:00.000Z","2000-01-01T00:00:21.000Z","2000-01-01T00:00:00.250Z"]) {
    const f=fixture(),heartbeat=f.writers.heartbeat; let calls=0;
    f.writers.heartbeat=async () => { const value=await heartbeat(); return ++calls===2 ? { ...value,expiresAt } : value; };
    assert.deepEqual(await f.guard().run(f.lease.leaseId,f.controller.signal,async () => true),unconfirmed);
    assert.equal(calls,2);
  }
});

it("cancellation or lost acknowledgement during final renewal cannot publish a result",async () => {
  for (const mode of ["cancel","lost"]) {
    const f=fixture(),heartbeat=f.writers.heartbeat; let calls=0;
    f.writers.heartbeat=async () => {
      const value=await heartbeat(); if (++calls===2) {
        if (mode==="lost") throw new Error("ACK lost");
        f.controller.abort(); await Promise.resolve();
      } return value;
    };
    assert.deepEqual(await f.guard().run(f.lease.leaseId,f.controller.signal,async () => "value"),unconfirmed);
  }
});

it("callback failure cancels the scope and still drains a pending renewal without a final ACK",async () => {
  const f=fixture(),heartbeat=f.writers.heartbeat,pending=deferred<FilesystemWriterLease>(),entered=deferred<void>(),output=deferred<string>();
  let calls=0,settled=false,scopeSignal: AbortSignal | undefined;
  f.writers.heartbeat=async () => { if (++calls===2) { entered.resolve(); return pending.promise; } return heartbeat(); };
  const run=f.guard().run(f.lease.leaseId,f.controller.signal,async ({ signal }) => { scopeSignal=signal; return output.promise; })
    .then((value) => { settled=true; return value; });
  await entered.promise; output.reject(new Error("local validation failed"));
  for (let tick=0;tick<5;tick++) await Promise.resolve();
  assert.equal(scopeSignal?.aborted,true); assert.equal(settled,false);
  pending.reject(new Error("database lost too")); assert.deepEqual(await run,unconfirmed); assert.equal(calls,2);
});

it("external abort awaits cooperative operation cleanup and never performs a final renewal",async () => {
  const f=fixture(),entered=deferred<void>(),cleanup=deferred<string>(); let scopeSignal: AbortSignal | undefined,settled=false;
  const run=f.guard().run(f.lease.leaseId,f.controller.signal,async ({ signal }) => { scopeSignal=signal; entered.resolve(); return cleanup.promise; })
    .then((value) => { settled=true; return value; });
  await entered.promise; f.controller.abort(); assert.equal(scopeSignal?.aborted,true);
  await Promise.resolve(); assert.equal(settled,false); cleanup.resolve("late success");
  assert.deepEqual(await run,unconfirmed); assert.equal(f.counts.renewals,1);
});

it("non-finite and regressing monotonic clocks fail closed",async () => {
  for (const value of [NaN,Infinity,-1]) {
    const f=fixture(),heartbeat=f.writers.heartbeat;
    f.writers.heartbeat=async () => { const renewed=await heartbeat(); f.monotonic=value; return renewed; };
    assert.deepEqual(await f.guard().run(f.lease.leaseId,f.controller.signal,async () => assert.fail("entered")),unconfirmed);
  }
});

it("a callback failure never requests a success-dependent final ACK",async () => {
  const f=fixture();
  assert.deepEqual(await f.guard().run(f.lease.leaseId,f.controller.signal,async () => { throw new Error("invalid result"); }),unconfirmed);
  assert.equal(f.counts.renewals,1);
});
