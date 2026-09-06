import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { it } from "node:test";
import type { Pool } from "pg";
import { createStableId } from "@acp/domain";
import { PostgresUnknownOutcomeAttentionStore } from "../src/unknown-outcome-attention.ts";

const provenanceId = createStableId("provenance"), observedAt = "2026-09-06T15:00:00.000001Z";
function fixture() {
  const query = { projectId: createStableId("project"), receiptId: createStableId("receipt") }, itemId = createStableId("attentionItem");
  const recorded = { kind: "recorded", ...query, itemId, observedAt, provenanceId, replayed: false };
  let output: unknown = recorded, failure: string | undefined, connections = 0, automaticReads = 0;
  const calls: string[] = [], values: unknown[][] = [], discards: unknown[] = [], physical = new EventEmitter();
  Object.assign(physical, { async query(sql: string, args: unknown[] = []) {
    calls.push(sql); values.push(args); assert.equal(physical.listenerCount("error"), 1);
    if (failure === sql) throw new Error("synthetic unknown capture response lost");
    return { rows: sql.startsWith("SELECT") ? [{ capture: output }] : [] };
  }, release(value: unknown) { discards.push(value); } });
  const pool = { options: { max: 4, connectionTimeoutMillis: 3000, statement_timeout: 5000, lock_timeout: 2000 },
    async connect() { connections++; return physical; }, async query() { automaticReads++; throw new Error("unrequested readback"); } } as unknown as Pool;
  return { query, recorded, pool, calls, values, discards, physical, set output(value: unknown) { output = value; }, set failure(value: string) { failure = value; },
    connections: () => connections, automaticReads: () => automaticReads };
}
it("unknown-outcome attention capture delegates one exact retained receipt with constructor-owned provenance", async () => {
  const f = fixture(), owner = { provenanceId }, store = new PostgresUnknownOutcomeAttentionStore(f.pool, owner); owner.provenanceId = createStableId("provenance");
  assert.deepEqual(await store.capture(f.query), f.recorded);
  assert.deepEqual(f.calls, ["BEGIN", "SELECT acp.capture_unknown_effect_attention($1::acp.stable_id,$2::acp.stable_id,$3::acp.stable_id) AS capture", "COMMIT"]);
  assert.deepEqual(f.values[1], [f.query.projectId, f.query.receiptId, provenanceId]); assert.deepEqual(f.discards, [true]);
  assert.equal(f.physical.listenerCount("error"), 0);
});
it("unknown-outcome capture preserves an explicit not-eligible result without claiming attention absence or external outcome", async () => {
  const f = fixture(), result = { kind: "not_eligible", ...f.query }; f.output = result;
  assert.deepEqual(await new PostgresUnknownOutcomeAttentionStore(f.pool, { provenanceId }).capture(f.query), result);
});
it("unknown-outcome exact replay retains original capture attribution without requiring a current producer match", async () => {
  const f = fixture(), result = { ...f.recorded, provenanceId: createStableId("provenance"), replayed: true }; f.output = result;
  assert.deepEqual(await new PostgresUnknownOutcomeAttentionStore(f.pool, { provenanceId }).capture(f.query), result);
});
it("unknown-outcome capture rejects action-shaped queries, getters and unbounded connections before I/O", async () => {
  const f = fixture(); assert.throws(() => new PostgresUnknownOutcomeAttentionStore({ ...f.pool, options: {} } as Pool, { provenanceId }));
  const store = new PostgresUnknownOutcomeAttentionStore(f.pool, { provenanceId });
  for (const change of [{ itemId: createStableId("attentionItem") }, { provenanceId }, { notify: true }, { receiptId: "latest" }, { projectId: "project" }])
    await assert.rejects(store.capture({ ...f.query, ...change }));
  let calls = 0; await assert.rejects(store.capture(Object.defineProperty({ ...f.query }, "receiptId", { enumerable: true, get() { calls++; return f.query.receiptId; } })));
  assert.equal(calls, 0); assert.equal(f.connections(), 0);
});
it("unknown-outcome capture withholds invalid or substituted retained receipts before COMMIT", async () => {
  for (const change of [{ receiptId: createStableId("receipt") }, { projectId: createStableId("project") }, { itemId: "invalid" },
    { observedAt: "invalid" }, { provenanceId: createStableId("provenance") }, { replayed: "true" }, { executionRecord: "private" }, { kind: "resolved" }]) {
    const f = fixture(); f.output = { ...f.recorded, ...change };
    await assert.rejects(new PostgresUnknownOutcomeAttentionStore(f.pool, { provenanceId }).capture(f.query));
    assert.equal(f.calls.includes("COMMIT"), false); assert.deepEqual(f.discards, [true]);
  }
});
it("unknown-outcome lost COMMIT never retries, reads back automatically or replaces the source receipt", async () => {
  const f = fixture(); f.failure = "COMMIT";
  await assert.rejects(new PostgresUnknownOutcomeAttentionStore(f.pool, { provenanceId }).capture(f.query), /response lost/u);
  assert.equal(f.connections(), 1); assert.equal(f.automaticReads(), 0); assert.equal(f.calls.filter(sql => sql.startsWith("SELECT")).length, 1);
  assert.deepEqual(f.discards, [true]);
});
