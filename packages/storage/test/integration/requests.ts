import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { createStableId, parseRequestRegistration, type RequestRegistration, type StableId } from "@acp/domain";
import { PostgresRequestStore } from "../../src/request-store.ts";

const port = Number(process.argv[2]), phase = process.argv[3];
assert.ok(Number.isInteger(port) && port > 1023 && port < 65536 && ["core", "races", "upgrade"].includes(phase ?? ""));
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
