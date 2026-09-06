import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { it } from "node:test";
import type { Pool } from "pg";
import { createStableId, parseRequestRegistration, parseRequestMissionLink } from "@acp/domain";
import { PostgresRequestStore } from "../src/request-store.ts";

const provenanceId = createStableId("provenance"), at = "2026-09-06T17:00:00.000123Z";
const source = () => parseRequestRegistration({ requestId: createStableId("request"), projectId: createStableId("project"),
  sourceIntakeId: createStableId("intake"), title: "Retain the original matter", summary: "This identity has no approved destination or execution grant." });
const association = () => parseRequestMissionLink({ requestId: createStableId("request"), projectId: createStableId("project"), missionId: createStableId("mission"), reason: "Recorded investigation association." });
function fixture(record: unknown = source()) {
  const seen: string[] = [], args: (unknown[] | undefined)[] = [], discarded: unknown[] = [], client = new EventEmitter();
  let output: unknown = { schemaVersion: "1.0.0", record, recordedAt: at, provenanceId, replayed: false, authority: "not_granted" };
  let lost: string | undefined, connections = 0, reads = 0, socket = false;
  Object.assign(client, { async query(sql: string, values?: unknown[]) {
    seen.push(sql); args.push(values); assert.equal(client.listenerCount("error"), 1);
    if (sql === lost) throw new Error("synthetic response lost");
    if (socket && sql.startsWith("SELECT")) client.emit("error", new Error("synthetic physical loss"));
    return { rows: sql.startsWith("SELECT") ? [{ receipt: output }] : [] };
  }, release(discard: unknown) { discarded.push(discard); } });
  const pool = { options: { max: 4, connectionTimeoutMillis: 3000, statement_timeout: 5000, lock_timeout: 2000 },
    async connect() { connections++; return client; }, async query() { reads++; throw new Error("unrequested readback"); } } as unknown as Pool;
  return { record, pool, client, seen, args, discarded, set output(value: unknown) { output = value; }, set lost(value: string) { lost = value; },
    set socket(value: boolean) { socket = value; }, get connections() { return connections; }, get reads() { return reads; } };
}
for (const [method, make, procedure] of [["recordRequest", source, "record_request_identity"], ["associateMission", association, "record_request_mission_link"]] as const) {
  it(`${method} records exact immutable terms in an isolated transaction with constructor-owned provenance`, async () => {
    const value = make(), f = fixture(value), owner = { provenanceId }, store = new PostgresRequestStore(f.pool, owner);
    owner.provenanceId = createStableId("provenance");
    const receipt = await store[method](value);
    assert.deepEqual(receipt.record, value); assert.equal(receipt.recordedAt, at); assert.equal(receipt.authority, "not_granted");
    assert.equal(receipt.provenanceId, provenanceId); assert.ok(Object.isFrozen(receipt)); assert.ok(Object.isFrozen(receipt.record));
    assert.deepEqual(f.seen, ["BEGIN", `SELECT acp.${procedure}($1::jsonb,$2::acp.stable_id) AS receipt`, "COMMIT"]);
    assert.deepEqual(JSON.parse(f.args[1]![0] as string), value); assert.equal(f.args[1]![1], provenanceId);
    assert.deepEqual(f.discarded, [true]); assert.equal(f.client.listenerCount("error"), 0);
  });
  it(`${method} accepts exact historical replay but rejects any substituted receipt before COMMIT`, async () => {
    const value = make(), valid = { schemaVersion: "1.0.0", record: value, recordedAt: at, provenanceId, replayed: true, authority: "not_granted" };
    const f = fixture(value); f.output = valid; assert.equal((await new PostgresRequestStore(f.pool, { provenanceId })[method](value)).replayed, true);
    for (const change of [{ record: { ...value, projectId: createStableId("project") } }, { provenanceId: createStableId("provenance") },
      { recordedAt: "invalid" }, { schemaVersion: "2.0.0" }, { authority: "approved" }, { replayed: "true" }, { hidden: "extra" }]) {
      const g = fixture(value); g.output = { ...valid, ...change };
      await assert.rejects(new PostgresRequestStore(g.pool, { provenanceId })[method](value));
      assert.equal(g.seen.includes("COMMIT"), false); assert.equal(g.seen.at(-1), "ROLLBACK"); assert.deepEqual(g.discarded, [true]);
    }
  });
  it(`${method} leaves a lost COMMIT uncertain and never retries or reads back automatically`, async () => {
    const value = make(), f = fixture(value); f.lost = "COMMIT";
    await assert.rejects(new PostgresRequestStore(f.pool, { provenanceId })[method](value), /response lost/u);
    assert.equal(f.connections, 1); assert.equal(f.reads, 0); assert.equal(f.seen.filter(sql => sql.startsWith("SELECT")).length, 1);
    assert.deepEqual(f.discarded, [true]); assert.equal(f.seen.at(-1), "ROLLBACK");
  });
}
it("request recording rejects unsafe input and unbounded pools before acquiring a connection", async () => {
  const f = fixture();
  assert.throws(() => new PostgresRequestStore({ ...f.pool, options: {} } as unknown as Pool, { provenanceId }));
  assert.throws(() => new PostgresRequestStore(f.pool, { provenanceId: "invalid" }));
  const store = new PostgresRequestStore(f.pool, { provenanceId });
  for (const field of ["provenanceId", "recordedAt", "closed", "approve"]) await assert.rejects(store.recordRequest({ ...source(), [field]: true }));
  let called = 0; const getter = Object.defineProperty({ ...source() }, "title", { enumerable: true, get() { called++; return "private"; } });
  await assert.rejects(store.recordRequest(getter)); assert.equal(called, 0); assert.equal(f.connections, 0);
});
it("request socket errors prevent further SQL and discard only the owned physical session", async () => {
  const value = source(), f = fixture(value); f.socket = true;
  await assert.rejects(new PostgresRequestStore(f.pool, { provenanceId }).recordRequest(value), /physical loss/u);
  assert.equal(f.seen.includes("COMMIT"), false); assert.equal(f.seen.includes("ROLLBACK"), false);
  assert.deepEqual(f.discarded, [true]); assert.equal(f.reads, 0);
});
