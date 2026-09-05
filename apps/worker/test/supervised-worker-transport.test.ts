import assert from "node:assert/strict";
import { it } from "node:test";
import { createContextPacket, createStableId, contextPacketSchemaVersion, workerResultOutputSchemaId } from "@acp/domain";
import type { WorkerProcessRecord, WorkerProcessRegistration } from "@acp/storage";
import { SupervisedWorkerTransport, type SupervisedWorkerTransportOptions } from "../src/supervised-worker-transport.ts";
import { WorkerTerminationUnconfirmedError, type WorkerTransportRequest } from "../src/worker-manager.ts";
import type { OwnedWorkerExit, WorkerLaunchRequest } from "../src/windows-worker-launcher.ts";

function request(): WorkerTransportRequest {
  const version = { version: "1.0.0" };
  return { runId: createStableId("run"), attemptNumber: 1,
    execution: { startedAt: new Date().toISOString(), timeoutAt: new Date(Date.now() + 30000).toISOString(),
      hostIdentifier: "host:supervision", provenanceId: createStableId("provenance"), transitionProvenanceId: createStableId("provenance") },
    packet: createContextPacket({ schemaVersion: contextPacketSchemaVersion, contextPacketId: createStableId("contextPacket"),
      missionId: createStableId("mission"), nodeId: createStableId("node"), projectId: createStableId("project"),
      nodeType: "diagnosis", workerRole: "diagnosis", objective: "Synthetic supervision check.", nonGoals: ["No model call."],
      completionScope: "One bounded result.", projectProfile: { ...version, id: createStableId("projectProfile") },
      workflow: { ...version, id: createStableId("workflow") }, policy: { ...version, id: createStableId("policy") },
      completionContract: { ...version, id: createStableId("completionContract") },
      lifecycle: { mission: { state: "executing" }, deployments: [], acceptance: { state: "not_required" },
        effects: [], businessCompletion: { state: "not_required" } }, behavioralContract: {}, acceptanceCriteria: ["Tree stopped."],
      sourceAuthorityRules: {}, evidence: [], activeClaimIds: [], conflicts: [], unresolvedQuestions: [], previousResultRefs: [],
      approvalIds: [], capabilityGrantId: createStableId("capabilityGrant"), requiredOutputSchema: workerResultOutputSchemaId,
      nextAction: "Return JSON.", retryCount: 0, limits: { wallTimeMs: 30000, maximumTurns: 1, maximumOutputBytes: 4096 } }),
    toolManifest: { operations: ["synthetic.read"], resources: ["synthetic:1"], effectExecutorAccess: false },
    isolation: { profile: "read_only", filesystem: "read_only", workspace: "C:/synthetic", networkDestinations: [], credentials: "none" },
    signal: new AbortController().signal };
}
function harness(input = request()) {
  const order: string[] = [];
  const closed = Promise.withResolvers<OwnedWorkerExit>();
  void closed.promise.catch(() => {});
  const normal: OwnedWorkerExit = { treeEmpty: true, failed: false, terminated: false, exitCode: 0, output: '{"synthetic":true}' };
  let registration: WorkerProcessRegistration | undefined;
  let stored: WorkerProcessRecord | undefined;
  let launched: WorkerLaunchRequest | undefined;
  let released: string | undefined;
  const processes: SupervisedWorkerTransportOptions["processes"] = {
    async recordWorkerProcessFromRun(value) {
      order.push("journal"); registration = value;
      stored = { ...value, missionId: input.packet.missionId, nodeId: input.packet.nodeId,
        hostIdentifier: input.execution.hostIdentifier, resourceClass: "lightweight_read", state: "running",
        recordedAt: input.execution.startedAt, heartbeatAt: input.execution.startedAt, deadlineAt: input.execution.timeoutAt };
      return stored;
    },
    async loadWorkerProcess() { order.push("lookup"); return stored; },
    async heartbeatWorkerProcess(...identity) {
      assert.deepEqual(identity, [registration!.workerProcessId, 42, "win32-filetime:134329999999999999"]);
      order.push("heartbeat"); return new Date().toISOString();
    },
    async finishWorkerProcess(value) {
      assert.equal(value.workerProcessId, registration!.workerProcessId);
      assert.equal(value.processId, 42); assert.equal(value.processStartToken, "win32-filetime:134329999999999999");
      assert.equal(value.transitionProvenanceId, input.execution.transitionProvenanceId);
      order.push("finish"); return true;
    },
  };
  const options: SupervisedWorkerTransportOptions = { processes, launcher: { async launch(value) {
    order.push("launch"); launched = value;
    return { scope: { machineFingerprint: "a".repeat(64), bootedAt: "2026-09-01T00:00:00.000Z", sessionId: 1 },
      processId: 42, processStartToken: "win32-filetime:134329999999999999", startedAt: input.execution.startedAt,
      closed: closed.promise, release(value) { order.push("release"); released = value; },
      async terminate() { order.push("stop"); closed.resolve({ ...normal, terminated: true, exitCode: 137 }); return closed.promise; } };
  } } };
  return { input, order, closed, normal, processes, options, get launched() { return launched; }, get released() { return released; } };
}
async function untilReleased(h: ReturnType<typeof harness>) {
  for (let turn = 0; turn < 50 && !h.released; turn++) await Promise.resolve();
  assert.ok(h.released);
}

it("supervisor journals native identity before release, then persists tree closure before result", async () => {
  const h = harness(); const pending = new SupervisedWorkerTransport(h.options).run(h.input);
  await untilReleased(h);
  assert.deepEqual(h.order, ["launch", "journal", "release"]);
  assert.equal(h.launched?.deadlineAt, h.input.execution.timeoutAt);
  assert.equal(h.launched?.maximumOutputBytes, h.input.packet.limits.maximumOutputBytes);
  const ipc = JSON.parse(h.released!); assert.equal(Object.hasOwn(ipc, "signal"), false);
  assert.deepEqual(ipc.execution, h.input.execution);
  h.closed.resolve(h.normal); assert.deepEqual(await pending, { synthetic: true });
  assert.deepEqual(h.order, ["launch", "journal", "release", "finish"]);
});

it("journal rejection stops a suspended tree without releasing it", async () => {
  const h = harness(); h.processes.recordWorkerProcessFromRun = async () => { h.order.push("reject"); throw new Error("admission denied"); };
  await assert.rejects(new SupervisedWorkerTransport(h.options).run(h.input), /admission denied/);
  assert.deepEqual(h.order, ["launch", "reject", "stop", "lookup"]);
});

it("lost journal acknowledgement recovers only the matching row after tree stop", async () => {
  const h = harness(), record = h.processes.recordWorkerProcessFromRun;
  h.processes.recordWorkerProcessFromRun = async (value) => { await record(value); throw new Error("acknowledgement lost"); };
  await assert.rejects(new SupervisedWorkerTransport(h.options).run(h.input), /acknowledgement lost/);
  assert.deepEqual(h.order, ["launch", "journal", "stop", "lookup", "finish"]);
});

it("cancellation while journal admission is pending never releases the runner", async () => {
  const controller = new AbortController(); const h = harness({ ...request(), signal: controller.signal });
  const record = h.processes.recordWorkerProcessFromRun;
  h.processes.recordWorkerProcessFromRun = async (value) => { const row = await record(value); controller.abort(); return row; };
  await assert.rejects(new SupervisedWorkerTransport(h.options).run(h.input), /cancelled before release/);
  assert.deepEqual(h.order, ["launch", "journal", "stop", "finish"]);
});

it("unconfirmed native termination never records a terminal journal or result", async () => {
  const h = harness(); const pending = new SupervisedWorkerTransport(h.options).run(h.input);
  await untilReleased(h); h.closed.reject(new WorkerTerminationUnconfirmedError());
  await assert.rejects(pending, WorkerTerminationUnconfirmedError);
  assert.equal(h.order.includes("finish"), false);
});

it("journal completion failure fences an otherwise valid result", async () => {
  const h = harness(); h.processes.finishWorkerProcess = async () => { throw new Error("claim won"); };
  const pending = new SupervisedWorkerTransport(h.options).run(h.input);
  await untilReleased(h); h.closed.resolve(h.normal);
  await assert.rejects(pending, WorkerTerminationUnconfirmedError);
});

it("heartbeat failure stops and journals the tree before rejecting output", { timeout: 5000 }, async () => {
  const h = harness(); h.processes.heartbeatWorkerProcess = async () => { h.order.push("heartbeat-failed"); throw new Error("connection lost"); };
  await assert.rejects(new SupervisedWorkerTransport(h.options).run(h.input), /heartbeat failed/);
  assert.deepEqual(h.order, ["launch", "journal", "release", "heartbeat-failed", "stop", "finish"]);
});

it("a heartbeat rejection arriving during successful cleanup cannot return a result", { timeout: 5000 }, async () => {
  const h = harness(), started = Promise.withResolvers<void>(), renewal = Promise.withResolvers<string>();
  h.processes.heartbeatWorkerProcess = () => { started.resolve(); return renewal.promise; };
  const pending = new SupervisedWorkerTransport(h.options).run(h.input);
  await started.promise; h.closed.resolve(h.normal);
  for (let tick = 0; tick < 10; tick++) await Promise.resolve();
  renewal.reject(new Error("late connection loss"));
  await assert.rejects(pending, /heartbeat failed/);
  assert.equal(h.order.at(-1), "finish");
});

it("hanging journal admission is bounded and a suspended root is stopped", { timeout: 1000 }, async () => {
  const h = harness(); h.processes.recordWorkerProcessFromRun = () => new Promise(() => {});
  await assert.rejects(new SupervisedWorkerTransport({ ...h.options, journalOperationTimeoutMs: 10 }).run(h.input), /timed out/);
  assert.deepEqual(h.order, ["launch", "stop", "lookup"]);
});

it("malformed child JSON still journals tree closure before rejection", async () => {
  const h = harness(); const pending = new SupervisedWorkerTransport(h.options).run(h.input);
  await untilReleased(h); h.closed.resolve({ ...h.normal, output: "not-json" });
  await assert.rejects(pending, SyntaxError); assert.equal(h.order.at(-1), "finish");
});
