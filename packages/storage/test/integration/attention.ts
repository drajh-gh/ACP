import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { attentionTypes, createStableId, parseAttentionItem, type AttentionItem, type StableId } from "@acp/domain";
import { getAttentionQueue, PostgresAttentionStore } from "../../src/attention-store.ts";
import { attentionQueueSql } from "../../src/attention-query.ts";

const port = Number(process.argv[2]), phase = process.argv[3];
assert.ok(Number.isInteger(port) && port > 1023 && port < 65536 && ["core", "races", "references", "snapshot", "upgrade"].includes(phase ?? ""));
const configuration = { connectionString: `postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test`, max: 4,
  connectionTimeoutMillis: 3000, statement_timeout: 5000, lock_timeout: 2000 };
const pool = new Pool(configuration), legacy = (prefix: string) => `${prefix}_00000000-0000-4000-8000-000000000001`;
const projectId = legacy("prj") as StableId<"project">, missionId = legacy("mis") as StableId<"mission">,
  provenanceId = legacy("prv") as StableId<"provenance">, store = new PostgresAttentionStore(pool, { provenanceId });
let checks = 0;
const pending = new Set<Promise<unknown>>();
async function check(name: string, action: () => Promise<void>) { await action(); checks++; process.stdout.write(`PASS attention: ${name}\n`); }
function tracked<T>(promise: Promise<T>): Promise<T> { pending.add(promise); void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise; }
function item(change: Partial<AttentionItem> = {}): AttentionItem {
  return parseAttentionItem({ itemId: createStableId("attentionItem"), projectId, missionIds: [missionId], type: "material_ambiguity", urgency: "normal",
    title: "Confirm a synthetic decision ž 🚀", explanation: "Recorded descriptions differ.\nNo current source wins.", whyHumanIsNeeded: "The intended outcome requires a person.",
    evidenceIds: [], effectPreviewIds: [], allowedResponses: ["Clarify"], deduplicationKey: createStableId("event"), quietHoursDisposition: "Not evaluated.", ...change });
}
async function counts() { return (await pool.query(`SELECT jsonb_build_object('items',(SELECT count(*) FROM acp.attention_items),
  'requests',(SELECT count(*) FROM acp.attention_requests),'missionRefs',(SELECT count(*) FROM acp.attention_item_missions),
  'evidenceRefs',(SELECT count(*) FROM acp.attention_item_evidence),'previewRefs',(SELECT count(*) FROM acp.attention_item_effect_previews),
  'missions',(SELECT count(*) FROM acp.missions),'runs',(SELECT count(*) FROM acp.worker_runs),'effects',(SELECT count(*) FROM acp.effect_proposals),
  'approvals',(SELECT count(*) FROM acp.approval_envelopes),'events',(SELECT count(*) FROM acp.mission_events)) AS counts`)).rows[0].counts as Record<string, number>; }
async function clone(table: string, key: string, source: string, overrides: object) {
  assert.equal((await pool.query(`INSERT INTO acp.${table} SELECT (jsonb_populate_record(NULL::acp.${table},to_jsonb(source)||$1::jsonb)).*
    FROM acp.${table} source WHERE ${key}=$2`, [JSON.stringify(overrides), source])).rowCount, 1);
}
async function evidence(change: object = {}) {
  const evidenceId = createStableId("evidence");
  await clone("evidence_records", "evidence_id", legacy("evd"), { evidence_id: evidenceId, project_id: projectId,
    observed_at: "2026-09-04T00:00:00Z", retrieved_at: "2026-09-04T00:00:01Z", sensitivity: "project_confidential",
    freshness: "stale", accessibility: "inaccessible", ...change }); return evidenceId;
}
async function denied(input: AttentionItem) { const before = await counts(); await assert.rejects(store.record(input)); assert.deepEqual(await counts(), before); }
async function migration(direction: "up" | "down") {
  const sql = await readFile(new URL(`../../migrations/0022_attention_items${direction === "down" ? ".down" : ""}.sql`, import.meta.url), "utf8");
  const client = await pool.connect();
  try { await client.query("BEGIN"); await client.query(sql); await client.query("COMMIT"); }
  catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; }
  finally { client.release(true); }
}
async function until(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) { if (await condition()) return; await new Promise(done => setTimeout(done, 10)); }
  assert.fail("bounded attention fixture condition did not become observable");
}
try {
  if (phase === "core") {
    await check("empty recorded queue is not readiness or authority", async () => {
      const result = await getAttentionQueue(pool, { projectId }); assert.ok(result);
      assert.deepEqual(result.items, []); assert.equal(result.authority, "not_granted"); assert.equal(result.coverage, "recorded_items_only");
      assert.equal(await getAttentionQueue(pool, { projectId: createStableId("project") }), undefined);
    });
    await check("canonical creation and both exact replays retain one item and every accepted alias", async () => {
      const input = item(), a = await store.record(input), same = await store.record(input), alias = { ...input, itemId: createStableId("attentionItem") };
      assert.equal(a.replayed, false); assert.equal(same.replayed, true); assert.deepEqual(a.item, same.item);
      const b = await store.record(alias); assert.equal(b.replayed, true); assert.deepEqual(b.item, a.item); assert.equal(b.requestId, alias.itemId);
      const before = await counts(); assert.deepEqual(await store.record(alias), b); assert.deepEqual(await counts(), before);
      assert.equal((await pool.query("SELECT 1 FROM acp.attention_requests WHERE item_id=$1", [a.item.itemId])).rowCount, 2);
      await denied({ ...alias, deduplicationKey: "new key cannot reuse an alias" });
      await denied({ ...input, itemId: createStableId("attentionItem"), title: "A materially different decision" });
    });
    await check("all specified types and expired items retain independent recorded meanings", async () => {
      for (const type of attentionTypes) await store.record(item({ type, expiresAt: "2026-09-04T00:00:00.000001Z" }));
      const page = await getAttentionQueue(pool, { projectId, missionId, limit: 50 }); assert.ok(page);
      assert.equal(page.items.filter(row => row.expiry === "expired").length, 12); assert.equal(page.freshness, "not_assessed");
      assert.equal(new Set(page.items.map(row => row.item.type)).size, 12);
    });
    await check("project-only items do not leak into mission-filtered pages", async () => {
      const created = await store.record(item({ missionIds: [] }));
      assert.ok((await getAttentionQueue(pool, { projectId, limit: 50 }))?.items.some(row => row.item.itemId === created.item.itemId));
      assert.equal((await getAttentionQueue(pool, { projectId, missionId, limit: 50 }))?.items.some(row => row.item.itemId === created.item.itemId), false);
      await assert.rejects(getAttentionQueue(pool, { projectId, missionId, afterItemId: created.item.itemId }));
    });
    await check("read-only priority/time/ID pagination is complete with exact canonical anchors", async () => {
      await store.record(item({ urgency: "critical" })); await store.record(item({ urgency: "low" }));
      const all = await getAttentionQueue(pool, { projectId, limit: 50 }); assert.ok(all);
      const ids: string[] = []; let afterItemId: StableId<"attentionItem"> | undefined;
      for (let pages = 0; pages < 20; pages++) {
        const page = await getAttentionQueue(pool, { projectId, limit: 2, ...(afterItemId ? { afterItemId } : {}) }); assert.ok(page);
        ids.push(...page.items.map(row => row.item.itemId)); if (!page.nextCursor) break; afterItemId = page.nextCursor;
      }
      assert.deepEqual(ids, all.items.map(row => row.item.itemId)); assert.equal(new Set(ids).size, ids.length);
      await assert.rejects(getAttentionQueue(pool, { projectId, afterItemId: createStableId("attentionItem") }));
    });
    await check("all retained tables reject update/delete/truncate and unrelated lifecycle counts stay unchanged", async () => {
      const before = await counts();
      for (const table of ["attention_items", "attention_requests", "attention_item_missions", "attention_item_evidence", "attention_item_effect_previews"])
        for (const sql of [`UPDATE acp.${table} SET item_id=item_id`, `DELETE FROM acp.${table}`, `TRUNCATE acp.${table}`]) await assert.rejects(pool.query(sql));
      assert.deepEqual(await counts(), before);
    });
    await check("an oversized selected page is denied as a whole without an automatic smaller replacement", async () => {
      for (let index = 0; index < 3; index++) await store.record(item({ explanation: "x".repeat(4000), whyHumanIsNeeded: "y".repeat(4000),
        recommendation: "z".repeat(4000), consequenceOfNoAction: "c".repeat(4000), alternatives: Array.from({ length: 10 }, (_, at) => `${at}${"a".repeat(999)}`) }));
      const before = await counts();
      const raw = await pool.query(attentionQueueSql, [projectId, null, null, 50, 65536]);
      assert.equal(raw.rows[0]?.attention_error, "too_large"); assert.equal(raw.rows[0]?.snapshot, null);
      await assert.rejects(getAttentionQueue(pool, { projectId, limit: 50 }));
      assert.equal((await getAttentionQueue(pool, { projectId, limit: 1 }))?.items.length, 1);
      assert.deepEqual(await counts(), before);
    });
  } else if (phase === "races") {
    await check("concurrent different IDs with the same key converge to one canonical item and two aliases", async () => {
      const input = item(), other = { ...input, itemId: createStableId("attentionItem") };
      const [a, b] = await Promise.all([tracked(store.record(input)), tracked(store.record(other))]);
      assert.equal(a.item.itemId, b.item.itemId); assert.equal([a, b].filter(row => !row.replayed).length, 1);
      assert.equal((await pool.query("SELECT 1 FROM acp.attention_requests WHERE item_id=$1", [a.item.itemId])).rowCount, 2);
    });
    await check("concurrent one ID with different keys has one winner and no second canonical history", async () => {
      const input = item(), results = await Promise.allSettled([tracked(store.record(input)), tracked(store.record({ ...input, deduplicationKey: "different-key" }))]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      assert.equal((await pool.query("SELECT 1 FROM acp.attention_requests WHERE request_id=$1", [input.itemId])).rowCount, 1);
      assert.equal((await pool.query("SELECT 1 FROM acp.attention_items WHERE item_id=$1", [input.itemId])).rowCount, 1);
    });
    await check("direct SQL cannot promote an already accepted alias into unrelated canonical history", async () => {
      const input = item(), alias = { ...input, itemId: createStableId("attentionItem") }; await store.record(input); await store.record(alias);
      const before = await counts(), changed = { ...alias, deduplicationKey: "direct-alias-reuse" };
      await assert.rejects(pool.query("INSERT INTO acp.attention_items(item_id,body,provenance_id) VALUES($1,$2::jsonb,$3)", [alias.itemId, JSON.stringify(changed), provenanceId]));
      assert.deepEqual(await counts(), before);
    });
    await check("lost actual COMMIT has no automatic readback and exact alias replay recovers original history", async () => {
      const input = item(); await store.record(input); const alias = { ...input, itemId: createStableId("attentionItem") };
      let backend = 0, connects = 0, reads = 0, ended: Promise<void> | undefined; const seen: string[] = [], discarded: unknown[] = [];
      const fault = { options: pool.options, async query() { reads++; throw new Error("unexpected automatic readback"); }, async connect() {
        connects++; const client = await pool.connect();
        try {
          backend = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
          ended = new Promise<void>(resolve => client.once("end", resolve));
          return { on: client.on.bind(client), off: client.off.bind(client), release(discard?: boolean | Error) { discarded.push(discard); client.release(discard); },
            async query<R extends QueryResultRow>(sql: string, args?: unknown[]): Promise<QueryResult<R>> {
              seen.push(sql); const result = await client.query<R>(sql, args); if (sql === "COMMIT") throw new Error("synthetic lost actual attention COMMIT reply"); return result;
            } };
        } catch (error) { client.release(true); throw error; }
      } } as unknown as Pool;
      await assert.rejects(new PostgresAttentionStore(fault, { provenanceId }).record(alias), /lost actual attention COMMIT/u);
      assert.ok(ended); await ended; await until(async () => (await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1", [backend])).rowCount === 0);
      assert.equal(connects, 1); assert.equal(reads, 0); assert.deepEqual(discarded, [true]); assert.equal(seen.filter(sql => sql === "COMMIT").length, 1);
      const before = await counts(), replay = await store.record(alias); assert.equal(replay.item.itemId, input.itemId); assert.equal(replay.replayed, true);
      assert.deepEqual(await counts(), before); await denied({ ...alias, title: "different terms after uncertainty" });
    });
    await check("repeatable-read producer transactions are rejected before history", async () => {
      const client = await pool.connect(), before = await counts();
      try { await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ"); await assert.rejects(client.query("SELECT acp.record_attention_request($1::jsonb,$2::acp.stable_id)", [JSON.stringify(item()), provenanceId])); }
      finally { try { await client.query("ROLLBACK"); } finally { client.release(true); } }
      assert.deepEqual(await counts(), before);
    });
  } else if (phase === "references") {
    await check("new canonical items and new aliases reject future or non-finite producer provenance while exact history remains replayable", async () => {
      const source = item(); await store.record(source);
      for (const recordedAt of ["9999-12-31T00:00:00Z", "infinity", "-infinity", "0001-12-31 BC"]) {
        const invalidProvenance = createStableId("provenance");
        await clone("runtime_provenance", "provenance_id", provenanceId, { provenance_id: invalidProvenance, recorded_at: recordedAt });
        const invalid = new PostgresAttentionStore(pool, { provenanceId: invalidProvenance }), before = await counts();
        await assert.rejects(invalid.record(item()), /producer provenance/u);
        await assert.rejects(invalid.record({ ...source, itemId: createStableId("attentionItem") }), /producer provenance/u);
        assert.equal((await invalid.record(source)).provenanceId, provenanceId);
        assert.deepEqual(await counts(), before);
      }
    });
    await check("missing and cross-project missions, evidence and producer provenance reject atomically", async () => {
      await denied(item({ missionIds: [createStableId("mission")] })); await denied(item({ evidenceIds: [createStableId("evidence")] }));
      await denied(item({ missionIds: ["mis_00000000-0000-4000-8000-000000000900" as StableId<"mission">] }));
      const foreign = createStableId("project"); await pool.query("INSERT INTO acp.projects(project_id,display_name) VALUES($1,'Other synthetic project')", [foreign]);
      const e = await evidence({ project_id: foreign }); await denied(item({ evidenceIds: [e] }));
      await denied(item({ projectId: foreign })); await denied(item({ projectId: foreign, missionIds: [] }));
    });
    await check("restricted lookahead evidence cannot disclose continuation behind an otherwise valid page", async () => {
      const first = item({ urgency: "critical" }), e = await evidence(), second = item({ urgency: "critical", evidenceIds: [e] });
      await store.record(first); await store.record(second);
      const valid = await getAttentionQueue(pool, { projectId, limit: 1 });
      assert.equal(valid?.items[0]?.item.itemId, first.itemId); assert.equal(valid?.nextCursor, first.itemId);
      await pool.query("UPDATE acp.evidence_records SET sensitivity='restricted' WHERE evidence_id=$1", [e]);
      try { await assert.rejects(getAttentionQueue(pool, { projectId, limit: 1 })); }
      finally { await pool.query("UPDATE acp.evidence_records SET sensitivity='project_confidential' WHERE evidence_id=$1", [e]); }
    });
    await check("stale inaccessible evidence remains recorded while restricted or malformed evidence denies", async () => {
      const e = await evidence(), source = item({ evidenceIds: [e] }); await store.record(source);
      assert.ok((await getAttentionQueue(pool, { projectId }))?.items.some(row => row.item.itemId === source.itemId));
      await denied(item({ evidenceIds: [await evidence({ sensitivity: "restricted" })] }));
      await denied(item({ evidenceIds: [await evidence({ source_ref: " " })] }));
      await pool.query("UPDATE acp.evidence_records SET sensitivity='restricted' WHERE evidence_id=$1", [e]);
      await assert.rejects(getAttentionQueue(pool, { projectId }));
      const before = await counts(); assert.equal((await store.record(source)).replayed, true); assert.deepEqual(await counts(), before);
      await denied({ ...source, itemId: createStableId("attentionItem") });
      await pool.query("UPDATE acp.evidence_records SET sensitivity='project_confidential' WHERE evidence_id=$1", [e]);
    });
    await check("effect preview references must exist and name an included mission in the same project", async () => {
      await denied(item({ effectPreviewIds: [createStableId("effect")] }));
      await denied(item({ effectPreviewIds: ["eff_00000000-0000-4000-8000-000000000900" as StableId<"effect">] }));
      // The legacy invariant seed intentionally contains an unresolved evd_test reference.
      // Retain it and create one valid, non-executing proposal for this qualification.
      const effectId = createStableId("effect"), e = await evidence();
      await clone("effect_proposals", "effect_id", legacy("eff"), { effect_id: effectId, idempotency_key: effectId, state: "proposed",
        execution_fencing_token: null, execution_precondition_evaluation_id: null, verification_receipt_id: null,
        provenance_id: provenanceId, transition_provenance_id: provenanceId, evidence_ids: [e] });
      const source = item({ effectPreviewIds: [effectId] });
      await store.record(source); await denied({ ...source, itemId: createStableId("attentionItem"), missionIds: [] });
      assert.deepEqual(source.evidenceIds, []);
      assert.ok((await getAttentionQueue(pool, { projectId }))?.items.some(row => row.item.itemId === source.itemId));
      await pool.query("UPDATE acp.evidence_records SET sensitivity='restricted' WHERE evidence_id=$1", [e]);
      try {
        await assert.rejects(getAttentionQueue(pool, { projectId }));
        await denied({ ...source, itemId: createStableId("attentionItem") });
        assert.equal((await store.record(source)).replayed, true);
      } finally { await pool.query("UPDATE acp.evidence_records SET sensitivity='project_confidential' WHERE evidence_id=$1", [e]); }
    });
    await check("default deferred guard rejects same-transaction evidence restriction after insertion", async () => {
      const e = await evidence(), source = item({ evidenceIds: [e] }), before = await counts(), client = await pool.connect();
      try {
        await client.query("BEGIN"); await client.query("SELECT acp.record_attention_request($1::jsonb,$2::acp.stable_id)", [JSON.stringify(source), provenanceId]);
        await client.query("UPDATE acp.evidence_records SET sensitivity='restricted' WHERE evidence_id=$1", [e]);
        await assert.rejects(client.query("COMMIT"));
      } finally { try { await client.query("ROLLBACK"); } finally { client.release(true); } }
      assert.deepEqual(await counts(), before);
    });
    await check("unknown, alias and cross-project cursors never masquerade as an empty page", async () => {
      const source = item(), alias = { ...source, itemId: createStableId("attentionItem") }; await store.record(source); await store.record(alias);
      await assert.rejects(getAttentionQueue(pool, { projectId, afterItemId: alias.itemId }));
      const foreign = createStableId("project"); await pool.query("INSERT INTO acp.projects(project_id,display_name) VALUES($1,'Other cursor project')", [foreign]);
      await assert.rejects(getAttentionQueue(pool, { projectId: foreign, afterItemId: source.itemId }));
    });
  } else if (phase === "snapshot") {
    await check("SELECT-only read-only role returns pages without changing any durable state", async () => {
      await store.record(item()); await pool.query("CREATE ROLE attention_reader LOGIN PASSWORD 'synthetic_attention_reader_password'");
      await pool.query("GRANT USAGE ON SCHEMA acp TO attention_reader"); await pool.query("GRANT SELECT ON ALL TABLES IN SCHEMA acp TO attention_reader");
      const readPool = new Pool({ ...configuration, connectionString: `postgresql://attention_reader:synthetic_attention_reader_password@127.0.0.1:${port}/acp_test`, options: "-c default_transaction_read_only=on" });
      try {
        assert.equal((await readPool.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "on"); const before = await counts();
        assert.ok(await getAttentionQueue(readPool, { projectId })); await assert.rejects(new PostgresAttentionStore(readPool, { provenanceId }).record(item()));
        await assert.rejects(readPool.query("CREATE TABLE acp.attention_forbidden(value text)")); assert.deepEqual(await counts(), before);
      } finally { await readPool.end(); }
    });
    await check("one page keeps its MVCC evidence disclosure across a concurrent restriction", async () => {
      const e = await evidence(), source = item({ evidenceIds: [e] }); await store.record(source);
      const lock = await pool.connect(), reader = await pool.connect(), key = "acp-attention-snapshot-" + source.itemId;
      let result: Promise<QueryResult> | undefined;
      try {
        await lock.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [key]); const pid = (await reader.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        const sql = attentionQueueSql.replace("WITH\nq AS", "WITH held AS MATERIALIZED (SELECT pg_advisory_xact_lock(hashtextextended($6::text,0))),\nq AS");
        // Make the final read depend on a materialized lock in this same SELECT.
        result = tracked(reader.query(sql.replace("FROM payload", "FROM payload CROSS JOIN held"), [projectId, null, null, 20, 65536, key]));
        await until(async () => (await pool.query("SELECT wait_event FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.wait_event === "advisory");
        await pool.query("UPDATE acp.evidence_records SET sensitivity='restricted' WHERE evidence_id=$1", [e]);
        await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]);
        const read = await result; assert.equal(read.rows[0]?.attention_error, null);
        assert.ok(read.rows[0]?.snapshot.items.some((row: { item: AttentionItem }) => row.item.itemId === source.itemId));
        await assert.rejects(getAttentionQueue(pool, { projectId }));
      } finally {
        try { await lock.query("SELECT pg_advisory_unlock_all()"); } finally { lock.release(true); }
        if (result) await Promise.allSettled([result]); reader.release(true);
      }
    });
  } else if (phase === "upgrade") {
    await check("empty downgrade and re-upgrade preserve the declared schema boundary", async () => { await migration("down"); await migration("up"); });
    await check("populated downgrade refuses canonical and alias history without changing it", async () => {
      const source = item(); await store.record(source); await store.record({ ...source, itemId: createStableId("attentionItem") });
      const before = await counts(); await assert.rejects(migration("down"), /retained attention history/u); assert.deepEqual(await counts(), before);
      assert.equal((await getAttentionQueue(pool, { projectId }))?.items[0]?.item.itemId, source.itemId);
    });
  }
  assert.ok(checks > 0); process.stdout.write(`PASS ${checks} actual PostgreSQL attention ${phase} checks; no decisions or notifications executed.\n`);
} finally { await Promise.allSettled([...pending]); await pool.end(); }
