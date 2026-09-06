import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { createStableId } from "@acp/domain";
import { PostgresUnknownOutcomeAttentionStore } from "../../src/unknown-outcome-attention.ts";
import { getAttentionQueue } from "../../src/attention-store.ts";
import { clone, legacy, projectId, provenanceId, reconcile, unknownReceipt } from "./unknown-outcome-attention-fixture.ts";

const port = Number(process.argv[2]), phase = process.argv[3]; assert.ok(Number.isInteger(port) && port > 1023 && port < 65536 && ["core", "races", "upgrade"].includes(phase ?? ""));
const pool = new Pool({ connectionString: `postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test`, max: 4,
  connectionTimeoutMillis: 3000, statement_timeout: 5000, lock_timeout: 2000 });
const store = new PostgresUnknownOutcomeAttentionStore(pool, { provenanceId });
const pending = new Set<Promise<unknown>>(); let checks = 0;
async function check(name: string, action: () => Promise<void>) { await action(); checks++; process.stdout.write(`PASS unknown attention: ${name}\n`); }
function tracked<T>(promise: Promise<T>) { pending.add(promise); void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise; }
function query(source: Awaited<ReturnType<typeof unknownReceipt>>) { return { projectId: source.projectId, receiptId: source.receiptId }; }
async function counts() { return (await pool.query(`SELECT jsonb_build_object('sources',(SELECT count(*) FROM acp.unknown_effect_attention_sources),
  'items',(SELECT count(*) FROM acp.attention_items),'aliases',(SELECT count(*) FROM acp.attention_requests),
  'receipts',(SELECT count(*) FROM acp.effect_receipts),'reconciliations',(SELECT count(*) FROM acp.effect_reconciliations),
  'effects',(SELECT count(*) FROM acp.effect_proposals),'runs',(SELECT count(*) FROM acp.worker_runs),'events',(SELECT count(*) FROM acp.mission_events)) AS counts`)).rows[0].counts; }
async function until(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail("bounded unknown-attention fixture condition was not observed");
}
async function sourceHistory(source: Awaited<ReturnType<typeof unknownReceipt>>) {
  return (await pool.query(`SELECT jsonb_build_object('effect',to_jsonb(e),'receipt',to_jsonb(r),'control',to_jsonb(c)) AS history
    FROM acp.effect_proposals e JOIN acp.effect_receipts r USING(effect_id) CROSS JOIN acp.runtime_controls c
    WHERE e.effect_id=$1 AND r.receipt_id=$2 AND c.scope_type='global' AND c.scope_id='global'`, [source.effectId, source.receiptId])).rows[0].history;
}
async function migrate(direction: "up" | "down") {
  const client = await pool.connect();
  try { await client.query("BEGIN"); await client.query(await readFile(new URL(`../../migrations/0023_unknown_outcome_attention${direction === "down" ? ".down" : ""}.sql`, import.meta.url), "utf8")); await client.query("COMMIT"); }
  catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; } finally { client.release(true); }
}
try {
  if (phase === "core") {
    await check("genuine guarded unknown receipt creates one source-bound item without changing effect history", async () => {
      const source = await unknownReceipt(pool), before = await counts(), originalHistory = await sourceHistory(source), result = await store.capture(query(source)); assert.equal(result.kind, "recorded");
      if (result.kind !== "recorded") assert.fail("recorded result required"); assert.equal(result.replayed, false);
      const after = await counts(); assert.deepEqual(after, { ...before, sources: before.sources + 1, items: before.items + 1, aliases: before.aliases + 1 });
      assert.deepEqual(await sourceHistory(source), originalHistory);
      const link = (await pool.query(`SELECT s.project_id,s.effect_id,s.mission_id,s.provenance_id,s.item_id,
        r.attempted_at<=a.recorded_at AND a.recorded_at<=s.observed_at AS chronological
        FROM acp.unknown_effect_attention_sources s JOIN acp.effect_receipts r USING(receipt_id) JOIN acp.attention_items a USING(item_id)
        WHERE s.receipt_id=$1`, [source.receiptId])).rows[0];
      assert.deepEqual(link, { project_id: projectId, effect_id: source.effectId, mission_id: legacy("mis"), provenance_id: provenanceId, item_id: result.itemId, chronological: true });
      const page = await getAttentionQueue(pool, { projectId }); assert.ok(page); const item = page.items.find(row => row.item.itemId === result.itemId)?.item; assert.ok(item);
      assert.equal(item.type, "unknown_external_outcome"); assert.equal(item.urgency, "normal"); assert.deepEqual(item.effectPreviewIds, [source.effectId]);
      assert.equal(item.expiresAt, undefined); assert.match(item.explanation, new RegExp(source.receiptId)); assert.match(item.whyHumanIsNeeded, /subsequent reconciliation/u);
      assert.equal(JSON.stringify(page).includes("synthetic-private-execution-must-not-leak"), false);
      const replay = await store.capture(query(source)); assert.deepEqual(replay, { ...result, replayed: true }); assert.deepEqual(await counts(), after);
      await assert.rejects(store.capture({ projectId: createStableId("project"), receiptId: source.receiptId }), /scope mismatch/u);
      for (const ids of [[null, source.receiptId], [projectId, null]]) {
        await assert.rejects(pool.query("SELECT acp.capture_unknown_effect_attention($1,$2,$3)", [...ids, provenanceId]), /exact unknown-outcome source IDs/u);
      }
      assert.deepEqual(await counts(), after);
    });
    await check("missing, wrong-project and already conclusive sources create no attention history", async () => {
      const absent = { projectId, receiptId: createStableId("receipt") }, before = await counts();
      assert.deepEqual(await store.capture(absent), { kind: "not_eligible", ...absent }); assert.deepEqual(await counts(), before);
      for (const outcome of ["applied", "not_applied"] as const) {
        const source = await unknownReceipt(pool); await reconcile(pool, source, outcome); const before = await counts();
        assert.equal((await store.capture(query(source))).kind, "not_eligible"); assert.deepEqual(await counts(), before);
      }
      const source = await unknownReceipt(pool), wrong = { projectId: createStableId("project"), receiptId: source.receiptId }, baseline = await counts();
      assert.deepEqual(await store.capture(wrong), { kind: "not_eligible", ...wrong }); assert.deepEqual(await counts(), baseline);
      assert.equal((await store.capture({ projectId, receiptId: legacy("rcp", "003") as typeof source.receiptId })).kind, "not_eligible");
    });
    await check("a later legitimate failed receipt and a non-unknown source are not fresh unknown attention", async () => {
      const source = await unknownReceipt(pool); await reconcile(pool, source, "not_applied"); const receiptId = createStableId("receipt");
      await pool.query(`INSERT INTO acp.effect_receipts(receipt_id,effect_id,attempt_number,state,execution_record,attempted_at,provenance_id)
        VALUES($1,$2,2,'failed','{}',statement_timestamp(),$3)`, [receiptId, source.effectId, provenanceId]);
      const before = await counts(); assert.equal((await store.capture(query(source))).kind, "not_eligible");
      assert.equal((await store.capture({ projectId, receiptId })).kind, "not_eligible"); assert.deepEqual(await counts(), before);
    });
    await check("inconclusive reconciliation remains eligible without upgrading recorded text into a current decision", async () => {
      const source = await unknownReceipt(pool); await reconcile(pool, source, "inconclusive"); assert.equal((await store.capture(query(source))).kind, "recorded");
    });
    await check("attention disclosure failure preserves the indispensable unknown receipt and can be explicitly retried", async () => {
      const source = await unknownReceipt(pool); await pool.query("UPDATE acp.evidence_records SET sensitivity='restricted' WHERE evidence_id=$1", [source.evidenceId]);
      const before = await counts(); await assert.rejects(store.capture(query(source))); assert.deepEqual(await counts(), before);
      assert.equal((await pool.query("SELECT state FROM acp.effect_receipts WHERE receipt_id=$1", [source.receiptId])).rows[0]?.state, "unknown_outcome");
      await pool.query("UPDATE acp.evidence_records SET sensitivity='public' WHERE evidence_id=$1", [source.evidenceId]);
      assert.equal((await store.capture(query(source))).kind, "recorded");
    });
    await check("exact source replay survives later reconciliation and different producer attribution without a new alias", async () => {
      const source = await unknownReceipt(pool), original = await store.capture(query(source)); assert.equal(original.kind, "recorded");
      await reconcile(pool, source, "applied"); const replacement = createStableId("provenance");
      await clone(pool, "runtime_provenance", "provenance_id", provenanceId, { provenance_id: replacement, recorded_at: "infinity" });
      const before = await counts(), replay = await new PostgresUnknownOutcomeAttentionStore(pool, { provenanceId: replacement }).capture(query(source));
      assert.deepEqual(replay, { ...original, replayed: true }); assert.deepEqual(await counts(), before);
    });
    await check("source attribution rejects rewriting, deletion, truncation and caller-owned derived values", async () => {
      const before = await counts();
      for (const sql of ["UPDATE acp.unknown_effect_attention_sources SET receipt_id=receipt_id", "DELETE FROM acp.unknown_effect_attention_sources", "TRUNCATE acp.unknown_effect_attention_sources"])
        await assert.rejects(pool.query(sql)); assert.deepEqual(await counts(), before);
      const source = await unknownReceipt(pool); const input = query(source); const capture = await store.capture(input); assert.equal(capture.kind, "recorded");
      if (capture.kind !== "recorded") assert.fail("capture required"); const count = await counts();
      await assert.rejects(pool.query("INSERT INTO acp.unknown_effect_attention_sources(receipt_id,item_id,project_id,provenance_id) VALUES($1,$2,$3,$4)",
        [source.receiptId, capture.itemId, projectId, provenanceId]), /server owned/u); assert.deepEqual(await counts(), count);
    });
    await check("direct SQL cannot attribute different attention prose to a source and rolls back new aliases", async () => {
      const source = await unknownReceipt(pool), before = await counts(), client = await pool.connect();
      try {
        await client.query("BEGIN"); const itemId = createStableId("attentionItem");
        await client.query(`SELECT acp.record_attention_request(acp.unknown_effect_attention_body($1,$2)||'{"title":"Different semantic request"}'::jsonb,$3)`,
          [itemId, source.receiptId, provenanceId]);
        await assert.rejects(client.query("INSERT INTO acp.unknown_effect_attention_sources(receipt_id,item_id,provenance_id) VALUES($1,$2,$3)",
          [source.receiptId, itemId, provenanceId]), /exact attributed attention body/u);
      } finally { try { await client.query("ROLLBACK"); } finally { client.release(true); } }
      assert.deepEqual(await counts(), before);
    });
  } else if (phase === "races") {
    await check("concurrent captures converge to one source, canonical item and self-alias", async () => {
      const source = await unknownReceipt(pool), before = await counts(), results = await Promise.all([tracked(store.capture(query(source))), tracked(store.capture(query(source)))]);
      assert.ok(results.every(result => result.kind === "recorded")); const first = results[0]!; if (first.kind !== "recorded") assert.fail("capture required");
      assert.ok(results.every(result => result.kind === "recorded" && result.itemId === first.itemId)); assert.equal(results.filter(result => result.kind === "recorded" && !result.replayed).length, 1);
      assert.deepEqual(await counts(), { ...before, sources: before.sources + 1, items: before.items + 1, aliases: before.aliases + 1 });
    });
    await check("lost actual COMMIT preserves one capture without automatic readback or replacement aliases", async () => {
      const source = await unknownReceipt(pool); let ended: Promise<void> | undefined, connections = 0, readbacks = 0, backend = 0; const discards: unknown[] = [], seen: string[] = [];
      const fault = { options: pool.options, async query() { readbacks++; throw new Error("unrequested readback"); }, async connect() {
        connections++; const client = await pool.connect(); backend = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        ended = new Promise<void>(resolve => client.once("end", resolve));
        return { on: client.on.bind(client), off: client.off.bind(client), release(discard?: boolean | Error) { discards.push(discard); client.release(discard); },
          async query<R extends QueryResultRow>(sql: string, args?: unknown[]): Promise<QueryResult<R>> { seen.push(sql); const result = await client.query<R>(sql, args);
            if (sql === "COMMIT") throw new Error("synthetic lost actual source capture COMMIT"); return result; } };
      } } as unknown as Pool;
      await assert.rejects(new PostgresUnknownOutcomeAttentionStore(fault, { provenanceId }).capture(query(source)), /lost actual/u); assert.ok(ended); await ended;
      await until(async () => (await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1", [backend])).rowCount === 0);
      assert.equal(connections, 1); assert.equal(readbacks, 0); assert.deepEqual(discards, [true]); assert.equal(seen.filter(sql => sql.startsWith("SELECT")).length, 1);
      const before = await counts(), replay = await store.capture(query(source)); assert.equal(replay.kind, "recorded");
      assert.ok(replay.kind === "recorded" && replay.replayed); assert.deepEqual(await counts(), before);
    });
    await check("conclusive reconciliation visible before the source trigger rolls back the provisional item and alias", async () => {
      const source = await unknownReceipt(pool), before = await counts(), key = `unknown-attention-before:${source.receiptId}`, lock = await pool.connect();
      let capture: Promise<unknown> | undefined;
      try {
        await pool.query(`CREATE FUNCTION acp.synthetic_attention_capture_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[0],0)); RETURN NEW; END; $$`);
        await pool.query(`CREATE TRIGGER aaa_synthetic_attention_capture_barrier BEFORE INSERT ON acp.unknown_effect_attention_sources
          FOR EACH ROW EXECUTE FUNCTION acp.synthetic_attention_capture_barrier('${key}')`);
        await lock.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [key]);
        capture = tracked(store.capture(query(source)));
        await until(async () => (await pool.query(`SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
          WHERE l.locktype='advisory' AND NOT l.granted AND a.query LIKE 'SELECT acp.capture_unknown_effect_attention%'`)).rowCount === 1);
        await reconcile(pool, source, "applied");
        await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]);
        await assert.rejects(capture, /no longer eligible/u);
        const after = await counts(); assert.deepEqual(after, { ...before, reconciliations: before.reconciliations + 1 });
      } finally {
        try { await lock.query("SELECT pg_advisory_unlock_all()"); } finally { lock.release(true); }
        if (capture) await Promise.allSettled([capture]);
        await pool.query("DROP TRIGGER IF EXISTS aaa_synthetic_attention_capture_barrier ON acp.unknown_effect_attention_sources");
        await pool.query("DROP FUNCTION IF EXISTS acp.synthetic_attention_capture_barrier()");
      }
    });
    await check("reconciliation after source capture may commit before attention without rewriting historical meaning", async () => {
      const source = await unknownReceipt(pool); let captureObserved = false, release!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      const delayed = { options: pool.options, async connect() {
        const client = await pool.connect(); return { on: client.on.bind(client), off: client.off.bind(client), release: client.release.bind(client),
          async query<R extends QueryResultRow>(sql: string, args?: unknown[]): Promise<QueryResult<R>> {
            const result = await client.query<R>(sql, args); if (sql.startsWith("SELECT acp.capture_unknown_effect_attention")) { captureObserved = true; await barrier; } return result;
          } };
      } } as Pool;
      const capture = tracked(new PostgresUnknownOutcomeAttentionStore(delayed, { provenanceId }).capture(query(source)));
      try {
        await until(async () => captureObserved); await reconcile(pool, source, "applied"); release(); const original = await capture; assert.equal(original.kind, "recorded");
        const before = await counts(); assert.deepEqual(await store.capture(query(source)), { ...original, replayed: true }); assert.deepEqual(await counts(), before);
        if (original.kind !== "recorded") assert.fail("capture required");
        const body = (await getAttentionQueue(pool, { projectId }))?.items.find(row => row.item.itemId === original.itemId)?.item;
        assert.ok(body); assert.match(body.whyHumanIsNeeded, /subsequent reconciliation/u); assert.doesNotMatch(body.explanation, /currently unresolved/u);
      } finally { release(); await Promise.allSettled([capture]); }
    });
  } else if (phase === "upgrade") {
    await check("empty source downgrade and re-upgrade retain the preceding attention schema", async () => { await migrate("down"); await migrate("up"); });
    await check("populated source downgrade refuses to erase attribution", async () => {
      const source = await unknownReceipt(pool); await store.capture(query(source)); const before = await counts();
      await assert.rejects(migrate("down"), /retained unknown-outcome/u); assert.deepEqual(await counts(), before);
    });
  }
  assert.ok(checks > 0); process.stdout.write(`PASS ${checks} actual PostgreSQL unknown-outcome attention ${phase} checks.\n`);
} finally { await Promise.allSettled([...pending]); await pool.end(); }
