import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createStableId } from "@acp/domain";
import type { WorkerRecoveryCandidate, WorkerProcessReconciliationClaim } from "@acp/storage";
import { WorkerRecoveryRuntime } from "../src/worker-recovery.ts";

function candidate(processState = "running"): WorkerRecoveryCandidate {
  return { workerProcessId: createStableId("workerProcess"), runId: createStableId("run"), processState };
}
function harness(items: WorkerRecoveryCandidate[]) {
  const authority = { hostIdentifier: "host:recovery", sessionId: createStableId("workerHostSession"), applicationVersion: "recovery-v1" };
  const provenanceId = createStableId("provenance"), reconciliationId = createStableId("reconciliation");
  const events: string[] = [], cursors: unknown[] = [];
  const claimFor = (item: WorkerRecoveryCandidate): WorkerProcessReconciliationClaim => ({ workerProcessId: item.workerProcessId,
    runId: item.runId, reconciliationId, reconciliationOwner: authority.sessionId,
    reconciliationClaimedAt: new Date().toISOString(), reconciliationClaimExpiresAt: new Date(Date.now() + 20000).toISOString(),
    reconciliationProvenanceId: provenanceId, reason: "heartbeat_stale", missionId: createStableId("mission"), nodeId: createStableId("node"),
    processId: 1234, processStartToken: "win32-filetime:134329999999999999", purpose: "Synthetic recovery fixture",
    hostIdentifier: authority.hostIdentifier, resourceClass: "lightweight_read", state: "running", startedAt: new Date().toISOString(),
    recordedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 30000).toISOString(), heartbeatAt: new Date().toISOString(),
    provenanceId, transitionProvenanceId: provenanceId });
  const options: ConstructorParameters<typeof WorkerRecoveryRuntime>[0] = {
    store: { authority, async handoff() { return "handed_off"; }, async listCandidates(after, limit) {
      cursors.push(after); assert.equal(limit, 2); return after === undefined ? items.slice(0, 2) : items.slice(items.findIndex((c) => c.workerProcessId === after) + 1, items.findIndex((c) => c.workerProcessId === after) + 3);
    }, async prepare(item) { events.push(`prepare:${item.workerProcessId}`); return { provenanceId,
      ...(item.processState === "running" ? { claim: claimFor(item) } : {}) }; } },
    workers: { async reconcileClaimedWorkerProcess(id, claimId, observe, a) {
      assert.equal(claimId, reconciliationId); assert.equal(a, authority); events.push(`claim:${id}`);
      const observed = await observe(claimFor(items.find((item) => item.workerProcessId === id)!), new AbortController().signal);
      assert.notEqual(observed.state, "running");
      if (observed.state !== "running") assert.equal(observed.transitionProvenanceId, provenanceId);
      events.push(`stopped:${id}`); return { state: "terminalized", processState: "lost" };
    }, async recoverStoppedRun(input) { assert.equal(input.authority, authority); assert.equal(input.transitionProvenanceId, provenanceId);
      events.push(`project:${input.runId}`); return "recovered"; } },
    inspector: { async stop(record, signal) { assert.equal(signal.aborted, false); events.push(`inspect:${record.workerProcessId}`);
      return { state: "lost", reason: "owned_job_and_original_root_absent" }; } },
  };
  return { options, events, cursors };
}

describe("retired worker recovery", () => {
  it("requires stopped-process persistence before result projection and bypasses OS inspection for a terminal journal", async () => {
    const a = candidate(), b = candidate("terminated"), h = harness([a, b]);
    const result = await new WorkerRecoveryRuntime(h.options).maintain(new AbortController().signal);
    assert.deepEqual(result, { recovered: 2, unconfirmed: 0, errors: [] });
    assert.deepEqual(h.events, [`prepare:${a.workerProcessId}`, `claim:${a.workerProcessId}`, `inspect:${a.workerProcessId}`,
      `stopped:${a.workerProcessId}`, `project:${a.runId}`, `prepare:${b.workerProcessId}`, `project:${b.runId}`]);
  });
  it("advances the cursor across unconfirmed and poisoned items without projecting them", async () => {
    const a = candidate(), b = candidate(), c = candidate("terminated"), h = harness([a, b, c]);
    h.options.inspector.stop = async () => ({ state: "unconfirmed" });
    const runtime = new WorkerRecoveryRuntime(h.options);
    const first = await runtime.maintain(new AbortController().signal);
    assert.equal(first.recovered, 0); assert.equal(first.unconfirmed, 2);
    assert.equal(first.errors.length, 2);
    assert.equal((await runtime.maintain(new AbortController().signal)).recovered, 1);
    assert.equal(h.cursors[1], b.workerProcessId);
    assert.equal(h.events.filter((e) => e.startsWith("project:")).length, 1);
  });
  it("never projects a stale claim", async () => {
    const h = harness([candidate()]);
    h.options.workers.reconcileClaimedWorkerProcess = async () => ({ state: "stale_claim" });
    const result = await new WorkerRecoveryRuntime(h.options).maintain(new AbortController().signal);
    assert.equal(result.recovered, 0); assert.equal(result.unconfirmed, 1);
    assert.ok(!h.events.some((e) => e.startsWith("project:")));
  });
  it("coalesces sweeps and propagates daemon shutdown to an active inspector", async () => {
    const h = harness([candidate()]), controller = new AbortController();
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    h.options.inspector.stop = async (_record, signal) => { entered(); return await new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({ state: "unconfirmed" }), { once: true });
    }); };
    const runtime = new WorkerRecoveryRuntime(h.options), first = runtime.maintain(controller.signal);
    assert.equal(runtime.maintain(controller.signal), first);
    await started; controller.abort(); await first;
    assert.ok(!h.events.some((e) => e.startsWith("project:")));
    const before = h.cursors.length; await runtime.maintain(controller.signal); assert.equal(h.cursors.length, before);
  });
});
