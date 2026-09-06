import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { it } from "node:test";
import type { Pool } from "pg";
import { createStableId, parseAttentionItem } from "@acp/domain";
import { getAttentionQueue, PostgresAttentionStore } from "../src/attention-store.ts";

function item() { return parseAttentionItem({ itemId: createStableId("attentionItem"), projectId: createStableId("project"), missionIds: [],
  type: "material_ambiguity", urgency: "normal", title: "Confirm the scope", explanation: "Two reports differ.", whyHumanIsNeeded: "No source settles it.",
  evidenceIds: [], allowedResponses: ["Clarify"], deduplicationKey: "scope:v1", quietHoursDisposition: "Not evaluated." }); }
const at = "2026-09-06T14:00:00.000001Z", provenanceId = createStableId("provenance");
function fixture(source = item()) {
  const seen: string[] = [], values: (unknown[] | undefined)[] = [], discarded: unknown[] = [], client = new EventEmitter();
  let output: unknown = { item: source, recordedAt: at, provenanceId, requestId: source.itemId, requestRecordedAt: at, requestProvenanceId: provenanceId, replayed: false };
  let fail: string | undefined, socket: string | undefined, connections = 0, readbacks = 0;
  Object.assign(client, { async query(sql: string, args?: unknown[]) {
    seen.push(sql); values.push(args); assert.equal(client.listenerCount("error"), 1);
    if (sql === fail) throw new Error("synthetic response lost");
    if (sql === socket || (socket === "SELECT" && sql.startsWith("SELECT"))) client.emit("error", new Error("synthetic physical loss"));
    return { rows: sql.startsWith("SELECT") ? [{ receipt: output }] : [] };
  }, release(discard: unknown) { assert.equal(client.listenerCount("error"), 1); discarded.push(discard); } });
  const pool = { options: { max: 4, connectionTimeoutMillis: 3000, statement_timeout: 5000, lock_timeout: 2000 },
    async connect() { connections++; return client; }, async query() { readbacks++; throw new Error("unrequested readback"); } } as unknown as Pool;
  return { source, pool, seen, values, discarded, client, set output(value: unknown) { output = value; }, set fail(value: string) { fail = value; },
    set socket(value: string) { socket = value; }, get connections() { return connections; }, get readbacks() { return readbacks; } };
}
it("attention recording uses one SQL-only isolated transaction with exact constructor-owned provenance", async () => {
  const f = fixture(), owner = { provenanceId }, store = new PostgresAttentionStore(f.pool, owner); owner.provenanceId = createStableId("provenance");
  const result = await store.record(f.source);
  assert.equal(result.replayed, false); assert.deepEqual(result.item, f.source); assert.equal(result.requestId, f.source.itemId);
  assert.deepEqual(f.seen, ["BEGIN", "SELECT acp.record_attention_request($1::jsonb,$2::acp.stable_id) AS receipt", "COMMIT"]);
  assert.deepEqual(JSON.parse(f.values[1]![0] as string), f.source); assert.equal(f.values[1]![1], provenanceId);
  assert.deepEqual(f.discarded, [true]); assert.equal(f.client.listenerCount("error"), 0);
});
it("attention duplicate recording returns the original item while preserving the supplied request alias", async () => {
  const f = fixture(), canonical = { ...f.source, itemId: createStableId("attentionItem") };
  f.output = { item: canonical, recordedAt: at, provenanceId, requestId: f.source.itemId, requestRecordedAt: at, requestProvenanceId: provenanceId, replayed: true };
  const result = await new PostgresAttentionStore(f.pool, { provenanceId }).record(f.source);
  assert.deepEqual(result.item, canonical); assert.equal(result.requestId, f.source.itemId); assert.equal(result.replayed, true);
});
it("fresh attention receipts cannot substitute either producer while exact replays preserve historical producers", async () => {
  const historical = createStableId("provenance");
  for (const field of ["provenanceId", "requestProvenanceId"]) {
    const f = fixture();
    f.output = { item: f.source, recordedAt: at, provenanceId, requestId: f.source.itemId, requestRecordedAt: at,
      requestProvenanceId: provenanceId, replayed: false, [field]: historical };
    await assert.rejects(new PostgresAttentionStore(f.pool, { provenanceId }).record(f.source));
    assert.equal(f.seen.includes("COMMIT"), false);
  }
  const f = fixture();
  f.output = { item: f.source, recordedAt: at, provenanceId: historical, requestId: f.source.itemId, requestRecordedAt: at,
    requestProvenanceId: historical, replayed: true };
  const result = await new PostgresAttentionStore(f.pool, { provenanceId }).record(f.source);
  assert.equal(result.provenanceId, historical); assert.equal(result.requestProvenanceId, historical);
  const g = fixture();
  g.output = { item: g.source, recordedAt: at, provenanceId: historical, requestId: g.source.itemId, requestRecordedAt: at,
    requestProvenanceId: provenanceId, replayed: true };
  await assert.rejects(new PostgresAttentionStore(g.pool, { provenanceId }).record(g.source));
  assert.equal(g.seen.includes("COMMIT"), false);
});
it("attention recording rejects caller-owned authority, unsafe inputs and unbounded pools before I/O", async () => {
  const f = fixture();
  assert.throws(() => new PostgresAttentionStore({ ...f.pool, options: {} } as unknown as Pool, { provenanceId }));
  assert.throws(() => new PostgresAttentionStore(f.pool, { provenanceId: "invalid" as typeof provenanceId }));
  const store = new PostgresAttentionStore(f.pool, { provenanceId });
  for (const change of [{ recordedAt: at }, { provenanceId }, { authority: "approved" }, { itemId: "name" }]) await assert.rejects(store.record({ ...f.source, ...change }));
  let calls = 0; const source = Object.defineProperty({ ...f.source }, "title", { enumerable: true, get() { calls++; return "secret"; } });
  await assert.rejects(store.record(source)); assert.equal(calls, 0); assert.equal(f.connections, 0);
});
it("attention lost COMMIT remains uncertain with no automatic retry, alias replacement or readback", async () => {
  const f = fixture(); f.fail = "COMMIT";
  await assert.rejects(new PostgresAttentionStore(f.pool, { provenanceId }).record(f.source), /response lost/u);
  assert.equal(f.connections, 1); assert.equal(f.readbacks, 0); assert.equal(f.seen.filter(sql => sql.startsWith("SELECT")).length, 1);
  assert.deepEqual(f.discarded, [true]); assert.equal(f.seen.at(-1), "ROLLBACK");
});
it("attention physical connection loss suppresses COMMIT and still discards the exact session", async () => {
  const f = fixture(); f.socket = "SELECT";
  await assert.rejects(new PostgresAttentionStore(f.pool, { provenanceId }).record(f.source), /physical loss/u);
  assert.equal(f.seen.includes("COMMIT"), false); assert.equal(f.seen.includes("ROLLBACK"), false);
  assert.deepEqual(f.discarded, [true]); assert.equal(f.readbacks, 0);
});
it("attention validates the complete retained receipt before COMMIT instead of accepting substituted canonical history", async () => {
  const f = fixture(), valid = { item: f.source, recordedAt: at, provenanceId, requestId: f.source.itemId, requestRecordedAt: at, requestProvenanceId: provenanceId, replayed: true };
  for (const change of [{ private: "secret" }, { item: { ...f.source, title: "Different" } }, { requestId: createStableId("attentionItem") },
    { recordedAt: "invalid" }, { replayed: "true" }, { requestRecordedAt: "2026-09-06T14:00:00.000000Z" }]) {
    const g = fixture(f.source); g.output = { ...valid, ...change };
    await assert.rejects(new PostgresAttentionStore(g.pool, { provenanceId }).record(g.source));
    assert.equal(g.seen.includes("COMMIT"), false); assert.equal(g.seen.at(-1), "ROLLBACK");
  }
});
it("attention reads perform one bounded scope-exact query and return a detached observation-only page", async () => {
  const source = item(), query = { projectId: source.projectId }, seen: { sql: string; args?: unknown[] }[] = [];
  const page = { schemaVersion: "1.0.0", projectId: source.projectId, missionId: null, afterItemId: null, limit: 20, asOf: at,
    coverage: "recorded_items_only", freshness: "not_assessed", authority: "not_granted", items: [{ item: source, recordedAt: at, expiry: "not_expiring" }], nextCursor: null };
  const executor = { async query(sql: string, args?: unknown[]) { seen.push({ sql, ...(args ? { args } : {}) }); return { rows: [{ attention_error: null, snapshot: page }] }; } } as unknown as Pool;
  assert.deepEqual(await getAttentionQueue(executor, query), page); assert.equal(seen.length, 1); assert.match(seen[0]!.sql, /^WITH/u);
  assert.deepEqual(seen[0]!.args, [source.projectId, null, null, 20, 65536]);
});
it("attention reads reject malformed queries before SQL and deny invalid whole snapshots without fallback", async () => {
  let calls = 0, row: unknown;
  const executor = { async query() { calls++; return { rows: row === undefined ? [] : [row] }; } } as unknown as Pool, projectId = createStableId("project");
  await assert.rejects(getAttentionQueue(executor, { projectId, decide: true })); assert.equal(calls, 0);
  assert.equal(await getAttentionQueue(executor, { projectId }), undefined);
  for (const value of [{ attention_error: "invalid_references", snapshot: { secret: true } }, { attention_error: "too_large", snapshot: null },
    { attention_error: null, snapshot: { partial: true } }, { attention_error: "private diagnostic", snapshot: null }]) {
    row = value; const before: number = calls; await assert.rejects(getAttentionQueue(executor, { projectId })); assert.equal(calls, before + 1);
  }
});
