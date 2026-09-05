import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createStableId, type ContextPacket, type WorkerResult } from "@acp/domain";
import type { WorkerAssignment } from "@acp/storage";
import { HostDispatchRuntime, hostWorkerQueueName, parseDispatchMessage,
  type HostDispatchOptions } from "../src/host-dispatch.ts";

function harness() {
  const sessionId = createStableId("workerHostSession");
  const provenanceId = createStableId("provenance");
  const a: WorkerAssignment = {
    runId: createStableId("run"), generation: 1, hostSessionId: sessionId,
    missionId: createStableId("mission"), nodeId: createStableId("node"), attemptNumber: 1,
    grantId: createStableId("capabilityGrant"), resourceClass: "lightweight_read",
    hostIdentifier: "host:test", applicationVersion: "test-v1", queueName: "test-queue", workflowId: "test-workflow",
    templateProvenanceId: provenanceId, contextPacketId: createStableId("contextPacket"),
    packetProvenanceId: createStableId("provenance"), operation: "synthetic.read", resource: "test:record",
    mode: "read", workspace: "test-workspace",
  };
  const message = { runId: a.runId, generation: a.generation, hostSessionId: sessionId };
  let admitted = false;
  let abortObserved = false;
  let dispatchCalls = 0;
  let unblock: () => void = () => {};
  const started = new Promise<void>((resolve) => { unblock = resolve; });
  const options: HostDispatchOptions = {
    host: { hostIdentifier: a.hostIdentifier, hostKind: "vps", state: "active", maximumCpuIntensive: 2,
      maximumModerateCompute: 1, maximumLightweightRead: 1, maximumNetworkBound: 1,
      heartbeatTtlSeconds: 5, provenanceId, transitionProvenanceId: provenanceId },
    runtime: { hostIdentifier: a.hostIdentifier, applicationVersion: a.applicationVersion, sessionId,
      bindings: [{ workflowBindingId: createStableId("workflowBinding"), templateProvenanceId: provenanceId }] },
    workers: { async registerHost() {}, async heartbeatHost() { return new Date().toISOString(); } },
    contexts: { async buildAndRecordContextPacket() { return {} as ContextPacket; } },
    dispatches: {
      async registerRuntime() {}, async heartbeatRuntime() { return true; }, async closeRuntime() {},
      async cancellationRequests() { return []; }, async listPending() { return []; }, async assign() { return undefined; },
      async prepare() { return admitted ? { state: "reconciliation_required" } : { state: "ready", assignment: a }; },
      async blockUnstarted() { return true; },
    },
    manager: { async dispatch(request) {
      dispatchCalls++; admitted = true; unblock();
      return new Promise<WorkerResult>((_resolve, reject) => {
        const abort = () => { abortObserved = true; reject(new Error("synthetic termination")); };
        request.signal!.addEventListener("abort", abort, { once: true });
        if (request.signal!.aborted) abort();
      });
    } },
    async enqueue() {},
  };
  return { options, message, started, assignment: a, get aborted() { return abortObserved; }, get calls() { return dispatchCalls; } };
}

describe("host-affine worker dispatch", () => {
  it("hands off only an invocation whose own manager rejected, never initial replay", async () => {
    const h = harness(); let handoffs = 0, admitted = false;
    h.options.dispatches.prepare = async () => admitted ? { state: "reconciliation_required" } : { state: "ready", assignment: h.assignment };
    h.options.manager.dispatch = async () => { admitted = true; throw new Error("unconfirmed manager failure"); };
    const runtime = new HostDispatchRuntime({ ...h.options, recovery: { authority: h.options.runtime,
      async handoff(message) { assert.deepEqual(message, h.message); handoffs++; return "handed_off"; },
      async maintain() { return { recovered: 0, unconfirmed: 0, errors: [] }; } } });
    assert.equal((await runtime.execute(h.message)).state, "reconciliation_required");
    assert.equal(handoffs, 1);
    assert.equal((await runtime.execute(h.message)).state, "reconciliation_required");
    assert.equal(handoffs, 1);
    await runtime.stop();
  });
  it("retries an uncertain handoff acknowledgement by exact identity without another transport", async () => {
    const h = harness(); let attempts = 0, calls = 0, admitted = false;
    h.options.dispatches.prepare = async () => admitted ? { state: "reconciliation_required" } : { state: "ready", assignment: h.assignment };
    h.options.manager.dispatch = async () => { calls++; admitted = true; throw new Error("unconfirmed manager failure"); };
    const runtime = new HostDispatchRuntime({ ...h.options, recovery: { authority: h.options.runtime,
      async handoff(message) { assert.deepEqual(message, h.message); if (++attempts === 1) throw new Error("lost acknowledgement"); return "handed_off"; },
      async maintain() { return { recovered: 0, unconfirmed: 0, errors: [] }; } } });
    await runtime.execute(h.message); assert.equal(attempts, 1);
    await runtime.maintain(); await runtime.maintain();
    assert.equal(attempts, 2); assert.equal(calls, 1); await runtime.stop();
  });
  it("keeps a missing journal pending and does not infer termination from the failed invocation", async () => {
    const h = harness(); let attempts = 0, admitted = false;
    h.options.dispatches.prepare = async () => admitted ? { state: "reconciliation_required" } : { state: "ready", assignment: h.assignment };
    h.options.manager.dispatch = async () => { admitted = true; throw new Error("unconfirmed manager failure"); };
    const runtime = new HostDispatchRuntime({ ...h.options, recovery: { authority: h.options.runtime,
      async handoff() { return ++attempts < 3 ? "pending" : "handed_off"; },
      async maintain() { return { recovered: 0, unconfirmed: 0, errors: [] }; } } });
    await runtime.execute(h.message); await runtime.maintain(); await runtime.maintain(); await runtime.maintain();
    assert.equal(attempts, 3); await runtime.stop();
  });
  it("does not request a handoff for context failure or an untouched healthy-owner replay", async () => {
    const h = harness(); let handoffs = 0;
    const recovery = { authority: h.options.runtime, async handoff() { handoffs++; return "handed_off" as const; },
      async maintain() { return { recovered: 0, unconfirmed: 0, errors: [] }; } };
    h.options.dispatches.prepare = async () => ({ state: "reconciliation_required" });
    const runtime = new HostDispatchRuntime({ ...h.options, recovery });
    await runtime.execute(h.message); assert.equal(handoffs, 0);
    h.options.dispatches.prepare = async () => ({ state: "ready", assignment: h.assignment });
    h.options.contexts.buildAndRecordContextPacket = async () => { throw new Error("context unavailable"); };
    await runtime.execute(h.message); assert.equal(handoffs, 0); await runtime.stop();
  });
  it("rotates pending handoffs fairly with at most two retries per maintenance pass", async () => {
    const h = harness(), admitted = new Set<string>(), attempted: string[] = [];
    h.options.dispatches.prepare = async (message) => admitted.has(message.runId) ? { state: "reconciliation_required" }
      : { state: "ready", assignment: { ...h.assignment, runId: message.runId } };
    h.options.manager.dispatch = async (input) => { admitted.add(input.runId); throw new Error("unconfirmed manager failure"); };
    const runtime = new HostDispatchRuntime({ ...h.options, recovery: { authority: h.options.runtime,
      async handoff(message) { attempted.push(message.runId); return "pending"; },
      async maintain() { return { recovered: 0, unconfirmed: 0, errors: [] }; } } });
    const messages = Array.from({ length: 3 }, () => ({ ...h.message, runId: createStableId("run") }));
    for (const message of messages) await runtime.execute(message);
    attempted.length = 0;
    await runtime.maintain(); await runtime.maintain();
    assert.deepEqual(attempted, [messages[0]!.runId, messages[1]!.runId, messages[2]!.runId, messages[0]!.runId]);
    await runtime.stop();
  });
  it("fences execution and lease renewal when its bounded handoff backlog is exhausted", async () => {
    const h = harness(), admitted = new Set<string>(); let handoffs = 0, renewals = 0;
    h.options.dispatches.prepare = async (message) => admitted.has(message.runId) ? { state: "reconciliation_required" }
      : { state: "ready", assignment: { ...h.assignment, runId: message.runId } };
    h.options.dispatches.heartbeatRuntime = async () => { renewals++; return true; };
    h.options.manager.dispatch = async (input) => { admitted.add(input.runId); throw new Error("unconfirmed manager failure"); };
    const runtime = new HostDispatchRuntime({ ...h.options, recovery: { authority: h.options.runtime,
      async handoff() { handoffs++; return "pending"; },
      async maintain() { return { recovered: 0, unconfirmed: 0, errors: [] }; } } });
    await runtime.heartbeat();
    for (let i = 0; i < 1000; i++) await runtime.execute({ ...h.message, runId: createStableId("run") });
    await assert.rejects(runtime.execute({ ...h.message, runId: createStableId("run") }), /unconfirmed manager failure/);
    await runtime.heartbeat(); await runtime.maintain();
    assert.equal(handoffs, 1000); assert.equal(renewals, 1);
    assert.equal((await runtime.execute(h.message)).state, "obsolete");
    await runtime.stop();
  });
  it("binds recovery to the exact daemon and waits for abort cleanup during shutdown", async () => {
    const h = harness();
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let observedSignal: AbortSignal | undefined;
    const recovery = { authority: h.options.runtime, async maintain(signal: AbortSignal) {
      observedSignal = signal; entered(); await new Promise<void>((resolve) => { finish = resolve; });
      return { recovered: 0, unconfirmed: 1, errors: [] };
    } };
    assert.throws(() => new HostDispatchRuntime({ ...h.options,
      recovery: { ...recovery, authority: { ...h.options.runtime, sessionId: createStableId("workerHostSession") } } }), /identity mismatch/);
    const runtime = new HostDispatchRuntime({ ...h.options, recovery });
    const sweep = runtime.maintain(); await started;
    let stopped = false; const stopping = runtime.stop().then(() => { stopped = true; });
    await Promise.resolve(); assert.equal(observedSignal?.aborted, true); assert.equal(stopped, false);
    finish(); await stopping; await sweep; assert.equal(stopped, true);
  });
  it("queues bind exact host, resource class, and daemon session", () => {
    const a = createStableId("workerHostSession"), b = createStableId("workerHostSession");
    const queue = hostWorkerQueueName("host:a", "lightweight_read", a);
    assert.equal(queue, hostWorkerQueueName("host:a", "lightweight_read", a));
    assert.notEqual(queue, hostWorkerQueueName("host:b", "lightweight_read", a));
    assert.notEqual(queue, hostWorkerQueueName("host:a", "cpu_intensive", a));
    assert.notEqual(queue, hostWorkerQueueName("host:a", "lightweight_read", b));
    assert.match(queue, /^acp-worker-v1:[0-9a-f]{64}:whs_/);
  });

  it("rejects extra message fields and unsafe generations", () => {
    const h = harness();
    assert.deepEqual(parseDispatchMessage(h.message), h.message);
    for (const generation of [0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1, "1"]) {
      assert.throws(() => parseDispatchMessage({ ...h.message, generation }));
    }
    assert.throws(() => parseDispatchMessage({ ...h.message, hostIdentifier: "override" }));
    assert.throws(() => parseDispatchMessage({ ...h.message, hostSessionId: createStableId("run") }));
  });

  it("derives heartbeat cadence from the supported TTL and caps cancellation latency", () => {
    const h = harness();
    assert.equal(new HostDispatchRuntime(h.options).heartbeatIntervalMilliseconds, 1666);
    assert.equal(new HostDispatchRuntime({ ...h.options, host: { ...h.options.host, heartbeatTtlSeconds: 300 } })
      .heartbeatIntervalMilliseconds, 5000);
    assert.throws(() => new HostDispatchRuntime({ ...h.options, host: { ...h.options.host, heartbeatTtlSeconds: 4 } }));
  });

  it("deduplicates a local run and bridges durable cancellation to its exact signal", async () => {
    const h = harness();
    h.options.dispatches.cancellationRequests = async (ids) => { assert.deepEqual(ids, [h.message.runId]); return ids; };
    const runtime = new HostDispatchRuntime(h.options);
    const pending = runtime.execute(h.message);
    assert.equal(runtime.execute(h.message), pending);
    await h.started;
    await runtime.heartbeat();
    assert.equal((await pending).state, "reconciliation_required");
    assert.equal(h.aborted, true);
    assert.equal(h.calls, 1);
    await runtime.stop();
  });

  it("a replacement session fences the daemon and aborts admitted work", async () => {
    const h = harness();
    h.options.dispatches.heartbeatRuntime = async () => false;
    const runtime = new HostDispatchRuntime(h.options);
    const pending = runtime.execute(h.message); await h.started;
    await assert.rejects(runtime.heartbeat(), /fenced/);
    await pending;
    assert.equal(h.aborted, true);
    assert.equal((await runtime.execute(h.message)).state, "obsolete");
    await runtime.stop();
  });

  it("the local watchdog aborts work even while a database renewal never settles", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness();
    const runtime = new HostDispatchRuntime(h.options);
    await runtime.heartbeat();
    let finishRenewal: (value: boolean) => void = () => {};
    h.options.dispatches.heartbeatRuntime = () => new Promise<boolean>((resolve) => { finishRenewal = resolve; });
    const pending = runtime.execute(h.message); await h.started;
    const heartbeat = runtime.heartbeat();
    t.mock.timers.tick(5001);
    assert.equal(h.aborted, true);
    await pending;
    finishRenewal(true); await heartbeat;
    assert.equal((await runtime.execute(h.message)).state, "obsolete");
    await runtime.stop();
  });

  it("database close failure cannot prevent local worker termination", async () => {
    const h = harness();
    h.options.dispatches.closeRuntime = async () => { throw new Error("database unavailable"); };
    const runtime = new HostDispatchRuntime(h.options);
    const pending = runtime.execute(h.message); await h.started;
    await assert.rejects(runtime.stop(), /database unavailable/);
    assert.equal(h.aborted, true);
    assert.equal((await pending).state, "reconciliation_required");
  });

  it("failed context assembly blocks the unstarted assignment without invoking a transport", async () => {
    const h = harness(); let blocked = false;
    h.options.contexts.buildAndRecordContextPacket = async () => { throw new Error("stale source"); };
    h.options.dispatches.blockUnstarted = async (message) => { assert.deepEqual(message, h.message); blocked = true; return true; };
    const runtime = new HostDispatchRuntime(h.options);
    assert.equal((await runtime.execute(h.message)).state, "reconciliation_required");
    assert.equal(blocked, true);
    assert.equal(h.calls, 0);
    await runtime.stop();
  });

  it("does not prepare or dispatch work addressed to another daemon session", async () => {
    const h = harness();
    h.options.dispatches.prepare = async () => { throw new Error("must not prepare"); };
    const runtime = new HostDispatchRuntime(h.options);
    assert.equal((await runtime.execute({ ...h.message, hostSessionId: createStableId("workerHostSession") })).state, "obsolete");
    assert.equal(h.calls, 0);
    await runtime.stop();
  });
});
