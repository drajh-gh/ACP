import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { createStableId, parseRequestRegistration, requestHistoryMaximumAssociations, requestHistoryMaximumBytes, type RequestRegistration, type StableId } from "@acp/domain";
import { PostgresRequestStore } from "../../src/request-store.ts";
import { getRequestHistory, requestHistorySql } from "../../src/request-history.ts";
import type { QueryExecutor } from "../../src/database.ts";

const port = Number(process.argv[2]), phase = process.argv[3];
assert.ok(Number.isInteger(port) && port > 1023 && port < 65536 && ["core", "races", "upgrade", "history"].includes(phase ?? ""));
const configuration = { connectionString: `postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test`, max: 4,
  connectionTimeoutMillis: 3000, statement_timeout: 5000, lock_timeout: 2000 };
const pool = new Pool(configuration), legacy = (prefix: string, suffix = "001") => `${prefix}_00000000-0000-4000-8000-000000000${suffix}`;
const projectId = legacy("prj") as StableId<"project">, missionId = legacy("mis") as StableId<"mission">,
  provenanceId = legacy("prv") as StableId<"provenance">, store = new PostgresRequestStore(pool, { provenanceId });
const pending = new Set<Promise<unknown>>();
let checks = 0;
async function check(name: string, action: () => Promise<void>) { await action(); checks++; process.stdout.write(`PASS request identity: ${name}\n`); }
function tracked<T>(promise: Promise<T>): Promise<T> { pending.add(promise); void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise; }
async function intake(project: string | null = projectId) {
  const id = createStableId("intake");
  await pool.query("INSERT INTO acp.intake_records(intake_id,project_id,origin,immutable_source_ref,received_at,envelope) VALUES($1,$2,'codex',$3,clock_timestamp(),'{}'::jsonb)", [id, project, `synthetic-request:${id}`]);
  return id;
}
async function request(change: Partial<RequestRegistration> = {}) {
  return parseRequestRegistration({ requestId: createStableId("request"), projectId, sourceIntakeId: await intake(),
    title: "Retain the original question ž 🚀", summary: "Original matter.\nNo scope or execution has been approved.", ...change });
}
function link(input: RequestRegistration, mission = missionId) { return { requestId: input.requestId, projectId: input.projectId, missionId: mission, reason: "Investigation associated with this original matter." }; }
async function counts() { return (await pool.query(`SELECT jsonb_build_object('requests',(SELECT count(*) FROM acp.request_records),
  'links',(SELECT count(*) FROM acp.request_mission_associations),'missions',(SELECT count(*) FROM acp.missions),
  'runs',(SELECT count(*) FROM acp.worker_runs),'effects',(SELECT count(*) FROM acp.effect_proposals),
  'approvals',(SELECT count(*) FROM acp.approval_envelopes),'events',(SELECT count(*) FROM acp.mission_events)) AS counts`)).rows[0].counts as Record<string, number>; }
async function denied(action: () => Promise<unknown>) { const before = await counts(); await assert.rejects(action); assert.deepEqual(await counts(), before); }
async function clone(table: string, key: string, source: string, overrides: object) {
  assert.equal((await pool.query(`INSERT INTO acp.${table} SELECT (jsonb_populate_record(NULL::acp.${table},to_jsonb(source)||$1::jsonb)).*
    FROM acp.${table} source WHERE ${key}=$2`, [JSON.stringify(overrides), source])).rowCount, 1);
}
async function migration(direction: "up" | "down") {
  const sql = await readFile(new URL(`../../migrations/0024_request_identity${direction === "down" ? ".down" : ""}.sql`, import.meta.url), "utf8"), client = await pool.connect();
  try { await client.query("BEGIN"); await client.query(sql); await client.query("COMMIT"); }
  catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; }
  finally { client.release(true); }
}
async function until(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) { if (await condition()) return; await new Promise(done => setTimeout(done, 10)); }
  assert.fail("bounded request fixture condition did not become observable");
}
try {
  const baseline = await counts();
  if (phase === "core") {
    await check("exact registration and replay preserve original words, producer and server time", async () => {
      const input = await request(), first = await store.recordRequest(input), repeat = await store.recordRequest(input);
      assert.deepEqual(first.record, input); assert.equal(first.replayed, false); assert.equal(first.authority, "not_granted");
      assert.equal(first.provenanceId, provenanceId); assert.deepEqual(repeat, { ...first, replayed: true });
      await denied(() => store.recordRequest({ ...input, summary: "Different original terms" }));
      await denied(() => store.recordRequest({ ...input, sourceIntakeId: createStableId("intake") }));
      const otherProducer = createStableId("provenance"); await clone("runtime_provenance", "provenance_id", provenanceId, { provenance_id: otherProducer });
      await denied(() => new PostgresRequestStore(pool, { provenanceId: otherProducer }).recordRequest(input));
    });
    await check("one intake can retain distinct requests without semantic merging", async () => {
      const first = await request(); await store.recordRequest(first);
      const second = { ...first, requestId: createStableId("request") }; await store.recordRequest(second);
      assert.equal((await pool.query("SELECT 1 FROM acp.request_records WHERE source_intake_id=$1", [first.sourceIntakeId])).rowCount, 2);
    });
    await check("one request links multiple existing missions and rejects rewriting an association", async () => {
      const input = await request(); await store.recordRequest(input); const first = await store.associateMission(link(input));
      assert.deepEqual(await store.associateMission(link(input)), { ...first, replayed: true });
      const secondMission = createStableId("mission");
      await clone("missions", "mission_id", missionId, { mission_id: secondMission, state: "ready", completed_by_evaluation_id: null });
      await store.associateMission(link(input, secondMission));
      assert.equal((await pool.query("SELECT 1 FROM acp.request_mission_associations WHERE request_id=$1", [input.requestId])).rowCount, 2);
      await denied(() => store.associateMission({ ...link(input), reason: "Different reason" }));
      // Fixture-only mission creation is not a side effect of recording a link.
      baseline.missions!++;
    });
    await check("missing, unassigned and cross-project source, mission and producer fail atomically", async () => {
      const input = await request(); await store.recordRequest(input);
      for (const sourceIntakeId of [createStableId("intake"), await intake(null), await intake(legacy("prj", "900"))]) {
        await denied(() => store.recordRequest({ ...input, requestId: createStableId("request"), sourceIntakeId }));
      }
      await denied(() => store.associateMission(link(input, createStableId("mission"))));
      await denied(() => store.associateMission(link(input, legacy("mis", "900") as StableId<"mission">)));
      await denied(() => store.associateMission({ ...link(input), requestId: createStableId("request") }));
      await denied(() => new PostgresRequestStore(pool, { provenanceId: legacy("prv", "900") }).recordRequest({ ...input, requestId: createStableId("request") }));
      await denied(() => pool.query("UPDATE acp.intake_records SET project_id=$1 WHERE intake_id=$2", [legacy("prj", "900"), input.sourceIntakeId]));
    });
    await check("direct SQL rejects malformed terms, forged timestamps and retained-history mutation", async () => {
      const input = await request(); await store.recordRequest(input); await store.associateMission(link(input));
      for (const body of [{ ...input, requestId: createStableId("request"), title: " padded " }, { ...input, authority: "granted" }, { ...input, summary: null }])
        await denied(() => pool.query("SELECT acp.record_request_identity($1::jsonb,$2)", [JSON.stringify(body), provenanceId]));
      await denied(() => pool.query("INSERT INTO acp.request_records(request_id,project_id,source_intake_id,title,summary,provenance_id,recorded_at) VALUES($1,$2,$3,'Title','Summary',$4,clock_timestamp())", [createStableId("request"), projectId, input.sourceIntakeId, provenanceId]));
      await denied(() => pool.query("INSERT INTO acp.request_mission_associations(request_id,project_id,mission_id,reason,provenance_id,recorded_at) VALUES($1,$2,$3,'Reason',$4,clock_timestamp())", [input.requestId, projectId, missionId, provenanceId]));
      for (const table of ["request_records", "request_mission_associations"])
        for (const sql of [`UPDATE acp.${table} SET request_id=request_id`, `DELETE FROM acp.${table}`, `TRUNCATE acp.${table}`]) await denied(() => pool.query(sql));
    });
    await check("invalid fresh provenance is denied and retired producer only replays its exact history", async () => {
      for (const recordedAt of ["9999-12-31T00:00:00Z", "infinity", "-infinity", "0001-12-31 BC"]) {
        const p = createStableId("provenance"); await clone("runtime_provenance", "provenance_id", provenanceId, { provenance_id: p, recorded_at: recordedAt });
        const input = await request(); await denied(() => new PostgresRequestStore(pool, { provenanceId: p }).recordRequest(input));
      }
      const input = await request(); const original = await store.recordRequest(input), association = await store.associateMission(link(input));
      const unlinked = await request(); await store.recordRequest(unlinked);
      await pool.query("UPDATE acp.project_workflow_bindings SET retired_at=clock_timestamp() WHERE binding_id=$1", [legacy("wfb")]);
      assert.deepEqual(await store.recordRequest(input), { ...original, replayed: true });
      assert.deepEqual(await store.associateMission(link(input)), { ...association, replayed: true });
      await denied(() => store.recordRequest({ ...input, requestId: createStableId("request") }));
      await denied(() => store.associateMission(link(unlinked)));
    });
  } else if (phase === "races") {
    await check("concurrent identical registrations and links each retain one row and one replay", async () => {
      const input = await request();
      for (const action of [() => store.recordRequest(input), () => store.associateMission(link(input))]) {
        const result = await Promise.all([tracked<Awaited<ReturnType<typeof action>>>(action()), tracked<Awaited<ReturnType<typeof action>>>(action())]);
        assert.equal(result.filter(row => !row.replayed).length, 1); assert.deepEqual(result[0]?.record, result[1]?.record);
        assert.equal(result[0]?.recordedAt, result[1]?.recordedAt);
      }
    });
    await check("competing terms at one identity or association have exactly one winner", async () => {
      const input = await request(), registrations = await Promise.allSettled([tracked(store.recordRequest(input)), tracked(store.recordRequest({ ...input, summary: "Other terms" }))]);
      assert.equal(registrations.filter(row => row.status === "fulfilled").length, 1);
      const association = link(input), links = await Promise.allSettled([tracked(store.associateMission(association)), tracked(store.associateMission({ ...association, reason: "Other reason" }))]);
      assert.equal(links.filter(row => row.status === "fulfilled").length, 1);
    });
    await check("lost actual COMMIT remains uncertain until explicit exact replay without automatic recovery", async () => {
      const input = await request(); let connects = 0, reads = 0, ended: Promise<void> | undefined; const discarded: unknown[] = [];
      const fault = { options: pool.options, async query() { reads++; throw new Error("unexpected readback"); }, async connect() {
        connects++; const client = await pool.connect(); ended = new Promise<void>(resolve => client.once("end", resolve));
        return { on: client.on.bind(client), off: client.off.bind(client), release(discard?: boolean | Error) { discarded.push(discard); client.release(discard); },
          async query<R extends QueryResultRow>(sql: string, args?: unknown[]): Promise<QueryResult<R>> {
            const result = await client.query<R>(sql, args); if (sql === "COMMIT") throw new Error("synthetic lost actual request COMMIT reply"); return result;
          } };
      } } as unknown as Pool;
      await assert.rejects(new PostgresRequestStore(fault, { provenanceId }).recordRequest(input), /lost actual request COMMIT/u);
      assert.ok(ended); await ended; assert.equal(connects, 1); assert.equal(reads, 0); assert.deepEqual(discarded, [true]);
      const before = await counts(), recovered = await store.recordRequest(input); assert.equal(recovered.replayed, true);
      assert.deepEqual(recovered.record, input); assert.deepEqual(await counts(), before);
    });
  } else if (phase === "history") {
    await check("exact recorded history distinguishes absent scope, empty links and authored meaning", async () => {
      const input = await request(), q = { projectId, requestId: input.requestId };
      assert.equal(await getRequestHistory(pool, q), undefined);
      const receipt = await store.recordRequest(input), empty = await getRequestHistory(pool, q); assert.ok(empty);
      assert.deepEqual(empty.request, input); assert.equal(empty.recordedAt, receipt.recordedAt); assert.deepEqual(empty.missionAssociations, []);
      assert.equal(empty.coverage, "recorded_associations_only"); assert.equal(empty.freshness, "not_assessed"); assert.equal(empty.authority, "not_granted");
      const association = await store.associateMission(link(input)), result = await getRequestHistory(pool, q); assert.ok(result);
      assert.deepEqual(result.missionAssociations, [{ missionId, reason: association.record.reason, recordedAt: association.recordedAt }]);
      assert.equal(JSON.stringify(result).includes(provenanceId), false);
      assert.equal(await getRequestHistory(pool, { ...q, projectId: legacy("prj", "900") }), undefined);
      assert.equal(await getRequestHistory(pool, { ...q, projectId: createStableId("project") }), undefined);
    });
    await check("SELECT-only request reader works without write privileges or runtime provenance access", async () => {
      const input = await request(); await store.recordRequest(input); await store.associateMission(link(input));
      await pool.query("CREATE ROLE request_history_reader LOGIN PASSWORD 'synthetic_request_history_password'");
      await pool.query("GRANT USAGE ON SCHEMA acp TO request_history_reader");
      await pool.query("GRANT SELECT ON acp.request_records,acp.request_mission_associations TO request_history_reader");
      const reader = new Pool({ ...configuration, connectionString: `postgresql://request_history_reader:synthetic_request_history_password@127.0.0.1:${port}/acp_test`, options: "-c default_transaction_read_only=on" });
      try {
        const before = await counts(); assert.equal((await getRequestHistory(reader, { projectId, requestId: input.requestId }))?.missionAssociations.length, 1);
        await assert.rejects(reader.query("SELECT * FROM acp.runtime_provenance"));
        await assert.rejects(new PostgresRequestStore(reader, { provenanceId }).recordRequest({ ...input, requestId: createStableId("request") }));
        assert.deepEqual(await counts(), before);
      } finally { await reader.end(); }
    });
    await check("one history statement retains its MVCC snapshot during a concurrent mission association", async () => {
      const input = await request(); await store.recordRequest(input); const q = { projectId, requestId: input.requestId };
      const lock = await pool.connect(), reader = await pool.connect(), key = `acp-request-history-${input.requestId}`;
      let result: ReturnType<typeof getRequestHistory> | undefined;
      try {
        await lock.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [key]); const pid = (await reader.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        // Test-only lock delays execution after this statement's snapshot is fixed.
        const executor = { query(sql: string, args: unknown[]) {
          return reader.query(sql.replace("WITH\nscope", "WITH held AS MATERIALIZED (SELECT pg_advisory_xact_lock(hashtextextended($5::text,0))),\nscope")
            .replace("FROM payload", "FROM payload CROSS JOIN held"), [...args, key]);
        } } as QueryExecutor;
        result = tracked(getRequestHistory(executor, q));
        await until(async () => (await pool.query("SELECT wait_event FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.wait_event === "advisory");
        await store.associateMission(link(input));
        await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]);
        assert.deepEqual((await result)?.missionAssociations, []);
        assert.equal((await getRequestHistory(pool, q))?.missionAssociations.length, 1);
      } finally {
        try { await lock.query("SELECT pg_advisory_unlock_all()"); } finally { lock.release(true); }
        if (result) await Promise.allSettled([result]); reader.release(true);
      }
    });
    await check("100 short associations are complete; the 101st and oversized bodies deny whole histories", async () => {
      const missionIds = Array.from({ length: requestHistoryMaximumAssociations + 1 }, () => createStableId("mission")).sort();
      await pool.query(`INSERT INTO acp.missions SELECT (jsonb_populate_record(NULL::acp.missions,to_jsonb(source)||
        jsonb_build_object('mission_id',id,'state','ready','completed_by_evaluation_id',NULL))).*
        FROM acp.missions source CROSS JOIN unnest($1::text[]) id WHERE source.mission_id=$2`, [missionIds, missionId]);
      baseline.missions! += missionIds.length;
      const input = await request(); await store.recordRequest(input); const q = { projectId, requestId: input.requestId };
      await pool.query("SELECT acp.record_request_mission_link(body,$2::acp.stable_id) FROM jsonb_array_elements($1::jsonb) body",
        [JSON.stringify(missionIds.slice(0, 100).map(id => link(input, id))), provenanceId]);
      assert.deepEqual((await getRequestHistory(pool, q))?.missionAssociations.map(row => row.missionId), missionIds.slice(0, 100));
      await store.associateMission(link(input, missionIds[100]!));
      const overflow = await pool.query(requestHistorySql, [projectId, input.requestId, requestHistoryMaximumAssociations, requestHistoryMaximumBytes]);
      assert.equal(overflow.rows[0].request_error, "too_many"); assert.equal(overflow.rows[0].snapshot, null);
      await denied(() => getRequestHistory(pool, q));
      const large = await request(); await store.recordRequest(large);
      await pool.query("SELECT acp.record_request_mission_link(body,$2::acp.stable_id) FROM jsonb_array_elements($1::jsonb) body",
        [JSON.stringify(missionIds.slice(0, 70).map(id => ({ ...link(large, id), reason: "x".repeat(1000) }))), provenanceId]);
      const bytes = await pool.query(requestHistorySql, [projectId, large.requestId, requestHistoryMaximumAssociations, requestHistoryMaximumBytes]);
      assert.equal(bytes.rows[0].request_error, "too_large"); assert.equal(bytes.rows[0].snapshot, null);
      await denied(() => getRequestHistory(pool, { projectId, requestId: large.requestId }));
    });
    await check("retired recording authority does not hide or refresh original request history", async () => {
      const input = await request(); await store.recordRequest(input); await store.associateMission(link(input));
      const q = { projectId, requestId: input.requestId }, before = await getRequestHistory(pool, q); assert.ok(before);
      await pool.query("UPDATE acp.project_workflow_bindings SET retired_at=clock_timestamp() WHERE binding_id=$1", [legacy("wfb")]);
      const after = await getRequestHistory(pool, q); assert.ok(after);
      assert.deepEqual({ ...after, asOf: before.asOf }, before); assert.equal(after.authority, "not_granted");
    });
  } else {
    await check("empty downgrade and re-upgrade preserve existing intake and mission history", async () => {
      const existing = await intake(); await migration("down");
      assert.equal((await pool.query("SELECT 1 FROM acp.intake_records WHERE intake_id=$1", [existing])).rowCount, 1);
      assert.equal((await pool.query("SELECT to_regclass('acp.request_records') AS value")).rows[0].value, null);
      await migration("up"); assert.deepEqual(await counts(), baseline);
    });
    await check("populated downgrade refuses rather than deleting requests or links", async () => {
      const input = await request(); await store.recordRequest(input); await store.associateMission(link(input));
      const before = await counts(); await assert.rejects(migration("down"), /history requires preservation/u); assert.deepEqual(await counts(), before);
      assert.equal((await store.recordRequest(input)).replayed, true); assert.equal((await store.associateMission(link(input))).replayed, true);
    });
  }
  await check("recording creates no missions, runs, effects, approvals or lifecycle events", async () => {
    const after = await counts(); for (const key of ["missions", "runs", "effects", "approvals", "events"]) assert.equal(after[key], baseline[key], key);
  });
  process.stdout.write(`Request identity ${phase}: ${checks} checks passed.\n`);
} finally { await Promise.allSettled([...pending]); await pool.end(); }
