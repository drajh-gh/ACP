import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createStableId } from "@acp/domain";
import { WorkerLaunchRecoveryRuntime } from "../src/worker-launch-recovery.ts";
import { WorkerRecoveryRuntime } from "../src/worker-recovery.ts";

function fixture() {
  const items = [0, 1, 2].map(() => ({ runId: createStableId("run"), workerProcessId: createStableId("workerProcess") }));
  const authority = { hostIdentifier: "host:test", sessionId: createStableId("workerHostSession"), applicationVersion: "test" };
  const provenanceId = createStableId("provenance"), events: string[] = [], cursors: unknown[] = [];
  const options: ConstructorParameters<typeof WorkerLaunchRecoveryRuntime>[0] = {
    store: { authority, async listCandidates(after, limit) {
      cursors.push(after); assert.equal(limit, 2);
      const start = after === undefined ? 0 : items.findIndex((i) => i.workerProcessId === after) + 1;
      return items.slice(start, start + 2);
    }, async prepare(candidate) {
      events.push(`prepare:${candidate.runId}`);
      return { provenanceId, ...(candidate === items[1] ? {} : { claim: { ...candidate, provenanceId,
        reconciliationId: createStableId("reconciliation"), claimedAt: "exact-db-time", expiresAt: "exact-db-expiry",
        intent: { workerProcessId: candidate.workerProcessId, fence: { directory: "C:\\ACP-test\\seals",
          directoryIdentity: "win32-dir:12345678:0000000000000002", scope: { machineFingerprint: "a".repeat(64),
            bootedAt: "2026-09-01T00:00:00.000Z", sessionId: 1 } } } } }) };
    }, async observe(claim, observer, signal) {
      events.push(`claim:${claim.runId}`); const observed = await observer(claim, signal);
      if (observed.state === "unconfirmed") throw new Error("sensitive native error");
      events.push(`receipt:${claim.runId}`); return "stopped";
    }, async recover(runId, actor) { assert.equal(actor, provenanceId); events.push(`project:${runId}`); return "recovered"; } },
    inspector: { async seal(claim, signal) {
      assert.equal(signal.aborted, false); events.push(`native:${claim.runId}`);
      return { state: "lost", sealed: true, reason: "sealed_launch_job_absent" };
    } },
  };
  return { options, items, events, cursors };
}
describe("launch-intent recovery runtime", () => {
  it("requires receipt persistence before projection and reuses an existing receipt without native I/O", async () => {
    const f = fixture(), runtime = new WorkerLaunchRecoveryRuntime(f.options), [a, b] = f.items;
    assert.deepEqual(await runtime.maintain(new AbortController().signal), { recovered: 2, unconfirmed: 0, errors: [] });
    assert.deepEqual(f.events, [`prepare:${a!.runId}`, `claim:${a!.runId}`, `native:${a!.runId}`, `receipt:${a!.runId}`,
      `project:${a!.runId}`, `prepare:${b!.runId}`, `project:${b!.runId}`]);
  });
  it("advances past poison and stale claims, wraps its cursor and redacts raw errors", async () => {
    const f = fixture(); f.options.inspector.seal = async () => { throw new Error("sensitive native error"); };
    const runtime = new WorkerLaunchRecoveryRuntime(f.options);
    const result = await runtime.maintain(new AbortController().signal);
    assert.equal(result.recovered, 1); assert.equal(result.unconfirmed, 1); assert.doesNotMatch(result.errors[0]!.message, /sensitive/u);
    f.options.store.observe = async () => "stale_claim";
    assert.equal((await runtime.maintain(new AbortController().signal)).unconfirmed, 1);
    assert.equal(f.cursors[1], f.items[1]!.workerProcessId);
    await runtime.maintain(new AbortController().signal);
    assert.deepEqual(f.cursors.slice(-2), [f.items[2]!.workerProcessId, undefined]);
    assert.equal(f.events.filter((e) => e.startsWith("project:")).every((e) => e === `project:${f.items[1]!.runId}`), true);
  });
  it("coalesces maintenance and awaits shutdown cleanup without projecting", async () => {
    const f = fixture(), controller = new AbortController(), entered = Promise.withResolvers<void>(); let cleaned = false;
    f.options.inspector.seal = async (_claim, signal) => {
      const aborted = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      entered.resolve(); await aborted; cleaned = true; return { state: "unconfirmed" };
    };
    const runtime = new WorkerLaunchRecoveryRuntime(f.options), pending = runtime.maintain(controller.signal);
    assert.equal(runtime.maintain(controller.signal), pending);
    await entered.promise; controller.abort(); await pending;
    assert.equal(cleaned, true); assert.equal(f.events.some((e) => e.startsWith("project:")), false);
    const reads = f.cursors.length; await runtime.maintain(controller.signal); assert.equal(f.cursors.length, reads);
  });
  it("alternates legacy and launch passes under the original two-observation budget", async () => {
    const f = fixture(), order: string[] = [];
    const options: ConstructorParameters<typeof WorkerRecoveryRuntime>[0] = {
      store: { authority: f.options.store.authority, async handoff() { return "handed_off"; },
        async listCandidates(_after, limit) { assert.equal(limit, 2); order.push("legacy"); return []; }, async prepare() { return undefined; } },
      workers: { async reconcileClaimedWorkerProcess() { assert.fail("no legacy candidates"); }, async recoverStoppedRun() { return "pending"; } },
      inspector: { async stop() { return { state: "unconfirmed" }; } },
      launches: { authority: f.options.store.authority, async maintain() { order.push("launch"); return { recovered: 0, unconfirmed: 0, errors: [] }; } },
    };
    const runtime = new WorkerRecoveryRuntime(options);
    for (let pass = 0; pass < 4; pass++) await runtime.maintain(new AbortController().signal);
    assert.deepEqual(order, ["launch", "legacy", "launch", "legacy"]);
    assert.throws(() => new WorkerRecoveryRuntime({ ...options, launches: { ...options.launches!,
      authority: { ...f.options.store.authority, sessionId: createStableId("workerHostSession") } } }), /authority mismatch/u);
  });
});
