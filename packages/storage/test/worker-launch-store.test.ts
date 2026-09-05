import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { createStableId } from "@acp/domain";
import { PostgresWorkerLaunchStore, type WorkerLaunchClaim } from "../src/worker-launch-store.ts";

function fixture() {
  const claim: WorkerLaunchClaim = { runId: createStableId("run"), workerProcessId: createStableId("workerProcess"),
    reconciliationId: createStableId("reconciliation"), provenanceId: createStableId("provenance"),
    claimedAt: "2026-09-05 15:00:00.123456+00", expiresAt: "2026-09-05 15:00:20.123456+00",
    intent: { workerProcessId: createStableId("workerProcess"), fence: { directory: "C:\\ACP-test\\seals",
      directoryIdentity: "win32-dir:12345678:0000000000000002", scope: { machineFingerprint: "b".repeat(64),
        bootedAt: "2026-09-01T00:00:00.000Z", sessionId: 1 } } } };
  const persisted = { ...claim, intent: { ...claim.intent, workerProcessId: claim.workerProcessId } };
  const row = { run_id: persisted.runId, worker_process_id: persisted.workerProcessId, reconciliation_id: persisted.reconciliationId,
    provenance_id: persisted.provenanceId, directory_path: persisted.intent.fence.directory,
    directory_identity: persisted.intent.fence.directoryIdentity, supervision_scope: persisted.intent.fence.scope,
    claimed_at_exact: persisted.claimedAt, expires_at_exact: persisted.expiresAt, remaining_ms: 10000 };
  class Client extends EventEmitter {
    readonly options = { connectionTimeoutMillis: 1000, statement_timeout: 1000, lock_timeout: 1000 };
    readonly queries: { text: string; values: unknown[] }[] = [];
    acquired = true; unlocked = true; stale = false; failAt = ""; releasedBroken = false; connections = 0;
    async connect() { this.connections++; return this; }
    release(broken: boolean) { this.releasedBroken = broken; }
    async query(text: string, values: unknown[] = []) {
      this.queries.push({ text, values });
      if (this.failAt && text.includes(this.failAt)) throw new Error("lost acknowledgement");
      const rows = text.includes("pg_try_advisory_lock") ? [{ acquired: this.acquired }]
        : text.includes("pg_advisory_unlock") ? [{ released: this.unlocked }]
        : text.includes("SELECT i.*, c.reconciliation_id") ? this.stale ? [] : [row] : [];
      return { rows, rowCount: rows.length };
    }
  }
  const client = new Client();
  const store = new PostgresWorkerLaunchStore(client as unknown as Pool, { hostIdentifier: "host:test",
    sessionId: createStableId("workerHostSession"), applicationVersion: "test", bindings: [] });
  return { client, store, claim, persisted, row };
}
const observation = () => ({ state: "lost" as const, sealed: true as const, reason: "sealed_launch_job_absent" });
const signal = () => new AbortController().signal;

describe("PostgresWorkerLaunchStore observation session", () => {
  it("uses persisted descriptors and exact timestamps, then commits before unlocking", async () => {
    const f = fixture();
    assert.equal(await f.store.observe(f.claim, async (actual) => { assert.deepEqual(actual, f.persisted); return observation(); }, signal()), "stopped");
    const commands = f.client.queries.map((q) => q.text);
    assert.ok(commands.indexOf("COMMIT") > commands.findIndex((q) => q.includes("INSERT INTO acp.worker_launch_stops")));
    assert.ok(commands.findIndex((q) => q.includes("pg_advisory_unlock")) > commands.indexOf("COMMIT"));
    assert.equal(f.client.connections, 1); assert.equal(f.client.releasedBroken, false);
  });
  it("does not inspect a busy or stale claim", async () => {
    for (const state of ["busy", "stale_claim"] as const) {
      const f = fixture(); f.client.acquired = state !== "busy"; f.client.stale = state === "stale_claim";
      assert.equal(await f.store.observe(f.claim, async () => { assert.fail("must not inspect"); }, signal()), state);
      assert.equal(f.client.queries.some((q) => q.text === "BEGIN"), false);
    }
  });
  it("destroys a session whose lock acquisition or release acknowledgement is uncertain", async () => {
    const acquiring = fixture(); acquiring.client.failAt = "pg_try_advisory_lock";
    await assert.rejects(acquiring.store.observe(acquiring.claim, async () => { assert.fail("must not inspect"); }, signal()), /lost acknowledgement/u);
    assert.equal(acquiring.client.releasedBroken, true);
    const releasing = fixture(); releasing.client.unlocked = false;
    await assert.rejects(releasing.store.observe(releasing.claim, async () => observation(), signal()), /release unconfirmed/u);
    assert.equal(releasing.client.releasedBroken, true);
  });
  it("rolls back a lost BEGIN acknowledgement and failed receipt insertion", async () => {
    for (const failAt of ["BEGIN", "INSERT INTO acp.worker_launch_stops"]) {
      const f = fixture(); f.client.failAt = failAt;
      await assert.rejects(f.store.observe(f.claim, async () => observation(), signal()), /lost acknowledgement/u);
      assert.ok(f.client.queries.some((q) => q.text === "ROLLBACK"));
      assert.ok(f.client.queries.some((q) => q.text.includes("pg_advisory_unlock")));
      assert.equal(f.client.queries.some((q) => q.text === "COMMIT"), false);
    }
  });
  it("does not persist an unconfirmed observation", async () => {
    const f = fixture();
    await assert.rejects(f.store.observe(f.claim, async () => ({ state: "unconfirmed" }), signal()), /unconfirmed/u);
    assert.equal(f.client.queries.some((q) => q.text === "BEGIN"), false);
  });
  it("awaits inspector cleanup after cancellation or lease expiry", async () => {
    for (const mode of ["cancel", "expiry"] as const) {
      const f = fixture(), external = new AbortController(); let cleaned = false;
      if (mode === "expiry") f.row.remaining_ms = 20;
      await assert.rejects(f.store.observe(f.claim, async (_claim, lease) => {
        const aborted = new Promise<void>((resolve) => lease.addEventListener("abort", () => resolve(), { once: true }));
        if (mode === "cancel") external.abort();
        await aborted; await new Promise((resolve) => setTimeout(resolve, 5)); cleaned = true; return observation();
      }, external.signal), /authority ended/u);
      assert.equal(cleaned, true); assert.equal(f.client.queries.some((q) => q.text === "BEGIN"), false);
    }
  });
  it("destroys a lost database session and never publishes its cached observation", async () => {
    const f = fixture(); let cleaned = false;
    await assert.rejects(f.store.observe(f.claim, async (_claim, lease) => {
      const aborted = new Promise<void>((resolve) => lease.addEventListener("abort", () => resolve(), { once: true }));
      f.client.emit("error", new Error("synthetic connection loss"));
      await aborted; cleaned = true; return observation();
    }, signal()), /authority ended/u);
    assert.equal(cleaned, true); assert.equal(f.client.releasedBroken, true); assert.equal(f.client.connections, 1);
    assert.equal(f.client.queries.some((q) => q.text === "BEGIN" || q.text.includes("pg_advisory_unlock")), false);
  });
});
