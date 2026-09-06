import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { createStableId, type ReadinessKey, type StableId } from "@acp/domain";
import { getProjectReadiness, PostgresReadinessAssessmentStore, type ReadinessAssessmentWrite } from "../../src/readiness-store.ts";
import { projectReadinessSql } from "../../src/readiness-query.ts";

const port = Number(process.argv[2]), phase = process.argv[3];
if (!Number.isInteger(port) || port < 1024 || port > 65535 || !["core", "races", "expiry", "limits", "snapshot", "upgrade"].includes(phase ?? "")) {
  throw new Error("owned database port and exact readiness phase required");
}
const pool = new Pool({ connectionString: `postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test`, max: 4,
  connectionTimeoutMillis: 3000, statement_timeout: 5000, lock_timeout: 3000, application_name: "acp-readiness-fixture" });
const legacy = (prefix: string) => `${prefix}_00000000-0000-4000-8000-000000000001`;
const projectId = legacy("prj") as StableId<"project">, profileId = legacy("pro") as StableId<"projectProfile">;
const provenanceId = legacy("prv") as StableId<"provenance">, authority = { provenanceId, evaluatorVersion: "synthetic-readiness:1" };
const store = new PostgresReadinessAssessmentStore(pool, authority);
let checks = 0;
async function check(name: string, action: () => Promise<void>) { await action(); checks++; process.stdout.write(`PASS readiness: ${name}\n`); }
async function clone(table: string, key: string, source: string, overrides: object) {
  const result = await pool.query(`INSERT INTO acp.${table} SELECT (jsonb_populate_record(NULL::acp.${table},to_jsonb(source)||$1::jsonb)).*
    FROM acp.${table} source WHERE ${key}=$2`, [JSON.stringify(overrides), source]);
  assert.equal(result.rowCount, 1);
}
async function evidence(overrides: object = {}) {
  const evidenceId = createStableId("evidence");
  await clone("evidence_records", "evidence_id", legacy("evd"), { evidence_id: evidenceId, project_id: projectId,
    observed_at: "2026-09-04T00:00:00Z", retrieved_at: "2026-09-04T00:00:01Z", content_hash: "sha256:synthetic-readiness",
    freshness: "current", accessibility: "available", sensitivity: "project_confidential", ...overrides });
  return evidenceId;
}
async function terms(overrides: Partial<ReadinessAssessmentWrite> = {}): Promise<ReadinessAssessmentWrite> {
  const clock = (await pool.query("SELECT acp.readiness_timestamp(clock_timestamp()) AS assessed,acp.readiness_timestamp(clock_timestamp()+interval '1 hour') AS until")).rows[0];
  return { assessmentId: createStableId("capabilityReadinessAssessment"), projectId, profileId, profileVersion: "1.0.0",
    capability: "run_required_tests", resourceKey: `repository:${createStableId("repository")}`, resourceVersion: "binding:1",
    recordedState: "unconfigured", recordedReason: "Synthetic configuration is absent.", assessedAt: clock.assessed as string,
    validUntil: clock.until as string, evidenceIds: [], supersedesAssessmentId: null, ...overrides };
}
function query(keys: readonly ReadinessKey[], scope: object = {}) { return { projectId, profileId, profileVersion: "1.0.0", keys: keys.map(({ capability, resourceKey, resourceVersion }) => ({ capability, resourceKey, resourceVersion })), ...scope }; }
async function snapshot(row: ReadinessKey) { const result = await getProjectReadiness(pool, query([row])); assert.ok(result); return result; }
async function counts() {
  return (await pool.query(`SELECT jsonb_build_object('assessments',(SELECT count(*) FROM acp.capability_readiness_assessments),
    'pins',(SELECT count(*) FROM acp.capability_readiness_evidence),'grants',(SELECT count(*) FROM acp.capability_grants),
    'runs',(SELECT count(*) FROM acp.worker_runs),'effects',(SELECT count(*) FROM acp.effect_proposals),'missions',(SELECT count(*) FROM acp.missions)) AS counts`)).rows[0].counts;
}
async function insertDirect(client: { query(text: string, values?: unknown[]): Promise<unknown> }, row: ReadinessAssessmentWrite, identity = authority) {
  await client.query(`INSERT INTO acp.capability_readiness_assessments
    (assessment_id,project_id,profile_id,profile_version,capability,resource_key,resource_version,recorded_state,recorded_reason,
      assessed_at,valid_until,evidence_ids,evaluator_version,provenance_id,supersedes_assessment_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15)`,
  [row.assessmentId,row.projectId,row.profileId,row.profileVersion,row.capability,row.resourceKey,row.resourceVersion,row.recordedState,row.recordedReason,
    row.assessedAt,row.validUntil,JSON.stringify(row.evidenceIds),identity.evaluatorVersion,identity.provenanceId,row.supersedesAssessmentId]);
}

async function isolatedAuthority() {
  const bindingId = createStableId("workflowBinding"), provenance = createStableId("provenance");
  await clone("project_workflow_bindings", "binding_id", legacy("wfb"), { binding_id: bindingId, retired_at: null });
  await clone("runtime_provenance", "provenance_id", provenanceId, { provenance_id: provenance, workflow_binding_id: bindingId });
  return { bindingId, identity: { ...authority, provenanceId: provenance } };
}

async function absent(id: string) {
  assert.equal((await pool.query("SELECT count(*)::integer AS n FROM acp.capability_readiness_assessments WHERE assessment_id=$1", [id])).rows[0].n, 0);
  assert.equal((await pool.query("SELECT count(*)::integer AS n FROM acp.capability_readiness_evidence WHERE assessment_id=$1", [id])).rows[0].n, 0);
}

async function migration(direction: "up" | "down") {
  const sql = await readFile(new URL(`../../migrations/0017_capability_readiness${direction === "down" ? ".down" : ""}.sql`, import.meta.url), "utf8");
  const client = await pool.connect();
  try { await client.query("BEGIN"); await client.query(sql); await client.query("COMMIT"); }
  catch (error) { try { await client.query("ROLLBACK"); } catch { /* Exact physical close follows. */ } throw error; }
  finally { client.release(true); }
}

try {
  if (phase === "core") {
    await check("exact existing profile returns unknown; phantom profile/version never becomes a matrix", async () => {
      const row = await terms(), before = await counts(), s = await snapshot(row);
      assert.equal(s.entries[0]?.currentState, "unknown"); assert.equal(s.entries[0]?.recorded, null);
      assert.deepEqual(await counts(), before);
      assert.equal(await getProjectReadiness(pool, query([row], { profileVersion: "2.0.0" })), undefined);
      assert.equal(await getProjectReadiness(pool, query([row], { profileId: createStableId("projectProfile") })), undefined);
    });
    await check("seven independent states persist and read without creating grants, runs or effects", async () => {
      const evd = await evidence(), before = await counts();
      const states = ["available", "degraded", "unconfigured", "blocked", "stale", "revoked", "unknown"] as const;
      const rows: ReadinessAssessmentWrite[] = [];
      for (const state of states) {
        const row = await terms({ recordedState: state, evidenceIds: [evd] });
        assert.equal((await store.record(row)).replayed, false); rows.push(row);
      }
      const s = await getProjectReadiness(pool, query(rows)); assert.ok(s);
      assert.equal(s.schemaVersion, "2.0.0");
      assert.deepEqual(s.entries.map(entry => entry.currentState), states);
      assert.ok(s.entries.every(entry => entry.evidenceIdentityMatches === true));
      const after = await counts();
      for (const table of ["grants", "runs", "effects", "missions"]) assert.equal(after[table], before[table]);
      assert.equal(after.assessments, before.assessments + 7); assert.equal(after.pins, before.pins + 7);
      assert.equal(s.assessment.authority, "none");
    });
    await check("exact canonical history replays while changed terms or evaluator identity reject", async () => {
      const row = await terms(), saved = await store.record(row);
      assert.equal((await store.record({ ...row, assessedAt: row.assessedAt.replace("Z", "+00:00") })).replayed, true);
      await assert.rejects(store.record({ ...row, recordedReason: "Conflicting reason." }), /different terms/u);
      await assert.rejects(new PostgresReadinessAssessmentStore(pool, { ...authority, evaluatorVersion: "different:1" }).record(row), /different terms/u);
      assert.deepEqual((await store.record(row)).assessment, saved.assessment);
    });
    await check("explicit later supersession clears revocation but omission, wrong predecessor and ties reject", async () => {
      const first = await terms({ recordedState: "revoked" }); await store.record(first);
      const evd = await evidence(), second = await terms({ ...first, assessmentId: createStableId("capabilityReadinessAssessment"),
        assessedAt: (await terms()).assessedAt, recordedState: "available", evidenceIds: [evd], supersedesAssessmentId: first.assessmentId });
      await assert.rejects(store.record({ ...second, supersedesAssessmentId: null }), /exact latest/u);
      await assert.rejects(store.record({ ...second, assessedAt: first.assessedAt }), /later instant/u);
      await store.record(second);
      const s = await snapshot(first); assert.equal(s.entries[0]?.currentState, "available");
      assert.equal(s.entries[0]?.recorded?.assessmentId, second.assessmentId);
      assert.equal((await store.record(first)).replayed, true);
    });
    await check("current metadata deterioration and same-ID content replacement are different stale causes", async () => {
      const evd = await evidence(), row = await terms({ recordedState: "available", evidenceIds: [evd] }); await store.record(row);
      await pool.query("UPDATE acp.evidence_records SET freshness='stale' WHERE evidence_id=$1", [evd]);
      let s = await snapshot(row); assert.equal(s.entries[0]?.currentReasonCode, "supporting_evidence_unusable");
      assert.equal(s.entries[0]?.evidenceIdentityMatches, true);
      await pool.query("UPDATE acp.evidence_records SET freshness='current',content_hash='sha256:replaced' WHERE evidence_id=$1", [evd]);
      s = await snapshot(row); assert.equal(s.entries[0]?.currentReasonCode, "supporting_evidence_identity_changed");
      assert.equal(s.entries[0]?.evidenceIdentityMatches, false); assert.equal(s.evidence[0]?.freshness, "current");
      assert.equal(s.evidence[0]?.contentHashPresent, true);
      assert.equal((await store.record(row)).replayed, true);
    });
    await check("restricted or cross-project evidence denies the entire SQL payload without disclosure", async () => {
      const otherProject = createStableId("project"); await pool.query("INSERT INTO acp.projects(project_id,display_name) VALUES($1,'Other synthetic readiness project')", [otherProject]);
      for (const override of [{ sensitivity: "restricted" }, { project_id: otherProject }]) {
        const evd = await evidence(), row = await terms({ recordedState: "available", evidenceIds: [evd] }); await store.record(row);
        await pool.query("UPDATE acp.evidence_records SET sensitivity=coalesce($2,sensitivity),project_id=coalesce($3,project_id) WHERE evidence_id=$1",
          [evd, "sensitivity" in override ? override.sensitivity : null, "project_id" in override ? override.project_id : null]);
        await assert.rejects(snapshot(row), /invalid or undisclosable/u);
        const raw = (await pool.query(projectReadinessSql, [projectId,profileId,"1.0.0",JSON.stringify(query([row]).keys),65536])).rows[0];
        assert.equal(raw.snapshot, null); assert.equal(raw.readiness_error, "invalid_references");
      }
    });
    await check("records and derived evidence pins resist update, deletion, truncation and pin injection", async () => {
      const evd = await evidence(), row = await terms({ evidenceIds: [evd] }); await store.record(row);
      for (const sql of ["UPDATE acp.capability_readiness_assessments SET recorded_state='available'", "DELETE FROM acp.capability_readiness_assessments",
        "TRUNCATE acp.capability_readiness_assessments CASCADE", "UPDATE acp.capability_readiness_evidence SET identity_digest='forged'",
        "DELETE FROM acp.capability_readiness_evidence", "TRUNCATE acp.capability_readiness_evidence"]) await assert.rejects(pool.query(sql));
      await assert.rejects(pool.query("DELETE FROM acp.evidence_records WHERE evidence_id=$1", [evd]), /foreign key/u);
      await assert.rejects(pool.query("INSERT INTO acp.capability_readiness_evidence(assessment_id,evidence_id,ordinal,identity_digest) VALUES($1,$2,2,'forged')", [row.assessmentId,evd]), /exact recorded evidence/u);
    });
    await check("readiness works in a read-only transaction and preserves UTC microseconds across session timezones", async () => {
      const row = await terms({ recordedState: "available", evidenceIds: [await evidence()] }); await store.record(row);
      const expected = await snapshot(row), before = await counts(), client = await pool.connect();
      try {
        await client.query("BEGIN READ ONLY"); await client.query("SET LOCAL TIME ZONE 'Europe/Ljubljana'");
        const actual = await getProjectReadiness(client, query([row])); assert.ok(actual);
        assert.deepEqual(actual.entries, expected.entries); assert.deepEqual(actual.evidence, expected.evidence);
        assert.equal(actual.entries[0]?.recorded?.assessedAt, row.assessedAt);
        await client.query("COMMIT");
      } finally { client.release(true); }
      assert.deepEqual(await counts(), before);
      for (const secretField of ['"sourceRef":', '"rawContentRef":', '"contentHash":', '"identityDigest":', "sha256:synthetic-readiness"]) {
        assert.equal(JSON.stringify(expected).includes(secretField), false);
      }
    });
  }
  if (phase === "races") {
    await check("concurrent same-ID insertion converges to one exact historical record", async () => {
      const row = await terms({ recordedState: "available", evidenceIds: [await evidence()] });
      const results = await Promise.all([store.record(row), store.record(row)]);
      assert.equal(results.filter(result => result.replayed === false).length, 1);
      assert.deepEqual(results[0]?.assessment, results[1]?.assessment);
    });
    await check("concurrent roots and successors cannot fork an exact subject", async () => {
      const root = await terms(), competingRoot = { ...root, assessmentId: createStableId("capabilityReadinessAssessment") };
      const roots = await Promise.allSettled([store.record(root), store.record(competingRoot)]);
      assert.equal(roots.filter(result => result.status === "fulfilled").length, 1);
      const winner = roots.find(result => result.status === "fulfilled"); assert.ok(winner?.status === "fulfilled");
      const second = await terms({ ...root, assessmentId: createStableId("capabilityReadinessAssessment"), assessedAt: (await terms()).assessedAt,
        recordedState: "revoked", supersedesAssessmentId: winner.value.assessment.assessmentId });
      const successors = await Promise.allSettled([store.record(second), store.record({ ...second, assessmentId: createStableId("capabilityReadinessAssessment"), recordedState: "blocked" })]);
      assert.equal(successors.filter(result => result.status === "fulfilled").length, 1);
      const next = successors.find(result => result.status === "fulfilled"); assert.ok(next?.status === "fulfilled");
      assert.equal((await snapshot(root)).entries[0]?.recorded?.assessmentId, next.value.assessment.assessmentId);
    });
    await check("repeatable-read stale snapshot cannot insert a second root after a concurrent commit", async () => {
      const row = await terms(), client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ"); await client.query("SELECT count(*) FROM acp.capability_readiness_assessments");
        await store.record(row);
        await assert.rejects(insertDirect(client, { ...row, assessmentId: createStableId("capabilityReadinessAssessment") }));
      } finally { await client.query("ROLLBACK"); client.release(true); }
      assert.equal((await snapshot(row)).entries[0]?.recorded?.assessmentId, row.assessmentId);
    });
    await check("same-transaction evidence deterioration or identity mutation rolls back parent and pins at deferred commit", async () => {
      for (const change of ["freshness='stale'", "content_hash='sha256:late-change'"]) {
        const evd = await evidence(), row = await terms({ recordedState: "available", evidenceIds: [evd] }), client = await pool.connect();
        try {
          await client.query("BEGIN"); await insertDirect(client, row);
          await client.query(`UPDATE acp.evidence_records SET ${change} WHERE evidence_id=$1`, [evd]);
          await assert.rejects(client.query("COMMIT"), /readiness/u);
        } finally { client.release(true); }
        await absent(row.assessmentId);
      }
    });
    await check("same-transaction binding retirement denies the default deferred commit", async () => {
      const isolated = await isolatedAuthority(), row = await terms(), client = await pool.connect();
      try {
        await client.query("BEGIN"); await insertDirect(client, row, isolated.identity);
        await client.query("UPDATE acp.project_workflow_bindings SET retired_at=clock_timestamp() WHERE binding_id=$1", [isolated.bindingId]);
        await assert.rejects(client.query("COMMIT"), /current binding/u);
      } finally { client.release(true); }
      await absent(row.assessmentId);
    });
    await check("caller-forced early constraint checks cannot hide later evidence drift from the read path", async () => {
      const isolated = await isolatedAuthority(), evd = await evidence(), row = await terms({ recordedState: "available", evidenceIds: [evd] }), client = await pool.connect();
      try {
        await client.query("BEGIN"); await insertDirect(client, row, isolated.identity);
        await client.query("SET CONSTRAINTS acp.capability_readiness_commit IMMEDIATE");
        await client.query("UPDATE acp.evidence_records SET content_hash='sha256:after-early-check' WHERE evidence_id=$1", [evd]);
        await client.query("UPDATE acp.project_workflow_bindings SET retired_at=clock_timestamp() WHERE binding_id=$1", [isolated.bindingId]);
        await client.query("COMMIT");
      } finally { client.release(true); }
      const s = await snapshot(row); assert.equal(s.entries[0]?.currentState, "stale"); assert.equal(s.entries[0]?.evidenceIdentityMatches, false);
    });
    await check("lost real COMMIT acknowledgement closes its backend then confirms only the immutable exact record", async () => {
      const row = await terms(), releases: unknown[] = [], pids: number[] = [];
      const intercepted = { options: pool.options, query: pool.query.bind(pool), async connect() {
        const client = await pool.connect(); pids.push((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number);
        return { async query<R extends QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<R>> {
          const result = await client.query<R>(sql, values); if (sql === "COMMIT") throw new Error("synthetic lost readiness COMMIT response"); return result;
        }, release(discard?: Error | boolean) { releases.push(discard); client.release(discard); } };
      } } as unknown as Pool;
      const result = await new PostgresReadinessAssessmentStore(intercepted, authority).record(row);
      assert.equal(result.replayed, true); assert.equal(result.assessment.assessmentId, row.assessmentId); assert.deepEqual(releases, [true]);
      const until = Date.now() + 2000; let remaining = true;
      while (Date.now() < until) {
        remaining = (await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=ANY($1::integer[])) AS remains", [pids])).rows[0].remains as boolean;
        if (!remaining) break; await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(remaining, false);
    });
    await check("failed independent readback is not absence or replay and later explicit replay retains the original", async () => {
      const row = await terms();
      const intercepted = { options: pool.options, async query() { throw new Error("synthetic readback failure"); }, async connect() {
        const client = await pool.connect(); return { async query(sql: string, values?: unknown[]) {
          const result = await client.query(sql, values); if (sql === "COMMIT") throw new Error("synthetic uncertain COMMIT"); return result;
        }, release(discard?: Error | boolean) { client.release(discard); } };
      } } as unknown as Pool;
      await assert.rejects(new PostgresReadinessAssessmentStore(intercepted, authority).record(row), /uncertain COMMIT/u);
      assert.equal((await store.record(row)).replayed, true);
    });
  }
  if (phase === "expiry") {
    await check("expired positive/negative assessments become stale while revocation and unknown remain explicit", async () => {
      const rows: ReadinessAssessmentWrite[] = [];
      for (const state of ["available", "blocked", "revoked", "unknown"] as const) {
        const validUntil = (await pool.query("SELECT acp.readiness_timestamp(clock_timestamp()+interval '300 milliseconds') AS t")).rows[0].t as string;
        const row = await terms({ recordedState: state, validUntil, evidenceIds: [await evidence()] });
        await store.record(row); rows.push(row);
      }
      await pool.query("SELECT pg_sleep(0.32)");
      for (const row of rows) {
        const s = await snapshot(row); assert.equal(s.entries[0]?.currentState, row.recordedState === "revoked" || row.recordedState === "unknown" ? row.recordedState : "stale");
        assert.equal((await store.record(row)).replayed, true);
      }
    });
    await check("validity elapsed before default deferred commit denies insertion and retains no pins", async () => {
      const validUntil = (await pool.query("SELECT acp.readiness_timestamp(clock_timestamp()+interval '200 milliseconds') AS t")).rows[0].t as string;
      const row = await terms({ validUntil }), client = await pool.connect();
      try { await client.query("BEGIN"); await insertDirect(client, row); await client.query("SELECT pg_sleep(0.22)"); await assert.rejects(client.query("COMMIT"), /current binding and validity/u); }
      finally { client.release(true); }
      await absent(row.assessmentId);
    });
    await check("future, pre-provenance, expired and over-24-hour first assessments reject", async () => {
      const bad = (await pool.query(`SELECT acp.readiness_timestamp(clock_timestamp()+interval '1 hour') AS future,
        acp.readiness_timestamp(clock_timestamp()-interval '1 second') AS expired,
        acp.readiness_timestamp(clock_timestamp()+interval '25 hours') AS far`)).rows[0];
      const base = await terms();
      for (const overrides of [{ assessedAt: bad.future as string, validUntil: bad.far as string },
        { assessedAt: "2026-09-03T00:00:00.000000Z", validUntil: "2026-09-03T01:00:00.000000Z" },
        { assessedAt: (await pool.query("SELECT acp.readiness_timestamp(clock_timestamp()-interval '1 hour') AS t")).rows[0].t as string, validUntil: bad.expired as string },
        { validUntil: bad.far as string }]) {
        const row = { ...base, ...overrides, assessmentId: createStableId("capabilityReadinessAssessment") };
        await assert.rejects(store.record(row)); await absent(row.assessmentId);
      }
    });
    await check("exact 24-hour ceiling is accepted and stored without millisecond rounding", async () => {
      const row = await terms();
      const until = (await pool.query("SELECT acp.readiness_timestamp($1::timestamptz+interval '24 hours') AS t", [row.assessedAt])).rows[0].t as string;
      const saved = await store.record({ ...row, validUntil: until }); assert.equal(saved.assessment.validUntil, until);
      assert.equal(saved.assessment.assessedAt, row.assessedAt);
    });
    await check("retired binding permits historical replay and read but not a new assessment", async () => {
      const isolated = await isolatedAuthority(), localStore = new PostgresReadinessAssessmentStore(pool, isolated.identity), row = await terms();
      await localStore.record(row);
      await pool.query("UPDATE acp.project_workflow_bindings SET retired_at=clock_timestamp() WHERE binding_id=$1", [isolated.bindingId]);
      assert.equal((await localStore.record(row)).replayed, true);
      assert.equal((await snapshot(row)).entries[0]?.recorded?.provenanceId, isolated.identity.provenanceId);
      await assert.rejects(localStore.record(await terms()), /current binding/u);
    });
    await check("provenance cannot assess another project/profile or before its binding activation", async () => {
      await assert.rejects(store.record(await terms({ projectId: createStableId("project") })), /exact project profile/u);
      await assert.rejects(store.record(await terms({ profileId: createStableId("projectProfile") })), /exact project profile/u);
      const isolated = await isolatedAuthority(), localStore = new PostgresReadinessAssessmentStore(pool, isolated.identity);
      const row = await terms({ assessedAt: "2026-09-03T23:59:59.999999Z", validUntil: "2026-09-04T00:00:00.000001Z" });
      await assert.rejects(localStore.record(row), /current binding/u);
    });
  }
  if (phase === "limits") {
    await check("positive insertion rejects unusable, missing, restricted, malformed and out-of-range evidence", async () => {
      for (const override of [{ freshness: "stale" }, { accessibility: "missing" }, { sensitivity: "restricted" }, { content_hash: null },
        { content_hash: " " }, { source_ref: "\n" }, { source_type: " " }, { source_version: "" }, { raw_content_ref: " " },
        { observed_at: "0001-01-01 BC", retrieved_at: "0001-01-02 BC" }, { retrieved_at: "10000-01-01" }]) {
        await assert.rejects(store.record(await terms({ recordedState: "available", evidenceIds: [await evidence(override)] })));
      }
      await assert.rejects(store.record(await terms({ evidenceIds: [createStableId("evidence")] })), /invalid or undisclosable/u);
    });
    await check("source identity replacement and newly malformed evidence cannot retain positive readiness", async () => {
      for (const value of ["different:source", "x".repeat(2001), ""]) {
        const evd = await evidence(), row = await terms({ recordedState: "available", evidenceIds: [evd] }); await store.record(row);
        await pool.query("UPDATE acp.evidence_records SET source_ref=$2 WHERE evidence_id=$1", [evd,value]);
        if (value === "different:source") assert.equal((await snapshot(row)).entries[0]?.currentReasonCode, "supporting_evidence_identity_changed");
        else await assert.rejects(snapshot(row), /invalid or undisclosable/u);
      }
    });
    await check("unknown latest is not replaced by an older favorable assessment", async () => {
      const first = await terms({ recordedState: "available", evidenceIds: [await evidence()] }); await store.record(first);
      const second = await terms({ ...first, assessmentId: createStableId("capabilityReadinessAssessment"), assessedAt: (await terms()).assessedAt,
        supersedesAssessmentId: first.assessmentId, recordedState: "unknown", evidenceIds: [] });
      await store.record(second);
      const s = await snapshot(first); assert.equal(s.entries[0]?.recorded?.assessmentId, second.assessmentId); assert.equal(s.entries[0]?.currentState, "unknown");
    });
    await check("new exact profile/resource versions and case variants do not inherit an assessment", async () => {
      const row = await terms({ recordedState: "available", evidenceIds: [await evidence()] }); await store.record(row);
      await clone("project_profiles", "profile_id", profileId, { version: "1.0.1" });
      assert.equal((await getProjectReadiness(pool, query([row], { profileVersion: "1.0.1" })))?.entries[0]?.currentState, "unknown");
      assert.equal((await snapshot({ ...row, resourceVersion: "binding:2" })).entries[0]?.currentState, "unknown");
      assert.equal((await snapshot({ ...row, resourceKey: row.resourceKey.toUpperCase() })).entries[0]?.currentState, "unknown");
    });
    await check("database text and evidence-set limits agree with UTF-16 input units and reject malformed direct inserts", async () => {
      const text = (await pool.query("SELECT acp.readiness_canonical_text($1,512) AS fits,acp.readiness_canonical_text($2,512) AS exceeds", ["😀".repeat(256),"😀".repeat(257)])).rows[0];
      assert.equal(text.fits, true); assert.equal(text.exceeds, false);
      const row = await terms();
      await assert.rejects(insertDirect(pool, { ...row, capability: "x".repeat(201) }));
      await assert.rejects(insertDirect(pool, { ...row, evidenceIds: Array.from({ length: 21 }, () => createStableId("evidence")) }));
      const evd = await evidence(); await assert.rejects(insertDirect(pool, { ...row, evidenceIds: [evd,evd] }));
      await absent(row.assessmentId);
    });
    await check("whole UTF-8 snapshot bound rejects rather than returning favorable partial rows", async () => {
      const rows: ReadinessAssessmentWrite[] = [];
      for (let i = 0; i < 30; i++) { const row = await terms({ recordedReason: "界".repeat(1000) }); await store.record(row); rows.push(row); }
      await assert.rejects(getProjectReadiness(pool, query(rows)), /bounded snapshot/u);
      const raw = (await pool.query(projectReadinessSql, [projectId,profileId,"1.0.0",JSON.stringify(query(rows).keys),65536])).rows[0];
      assert.equal(raw.snapshot, null); assert.equal(raw.readiness_error, "too_large");
    });
  }
  if (phase === "snapshot") {
    for (const mutation of ["successor", "evidence"] as const) {
      await check(`one MVCC snapshot remains coherent across a concurrent ${mutation} commit`, async () => {
        const evd = await evidence(), first = await terms({ recordedState: "available", evidenceIds: [evd] }); await store.record(first);
        const gate = Math.floor(Math.random() * 1_000_000_000) + 1_000_000_000, holder = await pool.connect();
        let pending: ReturnType<typeof getProjectReadiness> | undefined;
        try {
          await holder.query("SELECT pg_advisory_lock($1::bigint)", [gate]);
          const intercepted = { async query<R extends QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<R>> {
            const blocked = sql.replace("WITH\n", "WITH fixture_gate AS MATERIALIZED(SELECT pg_advisory_xact_lock($6::bigint)),\n")
              .replace("FROM acp.project_profiles\n", "FROM acp.project_profiles CROSS JOIN fixture_gate\n");
            return pool.query<R>(blocked, [...values!,gate]);
          } };
          pending = getProjectReadiness(intercepted, query([first])); void pending.catch(() => {});
          const until = Date.now() + 1500; let waiting = false;
          while (Date.now() < until) {
            waiting = (await pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=$1 AND NOT granted) AS waiting", [gate])).rows[0].waiting as boolean;
            if (waiting) break; await new Promise(resolve => setTimeout(resolve, 10));
          }
          assert.equal(waiting, true);
          if (mutation === "successor") await store.record(await terms({ ...first, assessmentId: createStableId("capabilityReadinessAssessment"),
            assessedAt: (await terms()).assessedAt, supersedesAssessmentId: first.assessmentId, recordedState: "blocked" }));
          else await pool.query("UPDATE acp.evidence_records SET content_hash='sha256:concurrent-replacement' WHERE evidence_id=$1", [evd]);
          await holder.query("SELECT pg_advisory_unlock($1::bigint)", [gate]);
          const observed = await pending; assert.ok(observed); assert.equal(observed.entries[0]?.currentState, "available");
          assert.equal(observed.entries[0]?.recorded?.assessmentId, first.assessmentId); assert.equal(observed.entries[0]?.evidenceIdentityMatches, true);
          assert.equal((await snapshot(first)).entries[0]?.currentState, mutation === "successor" ? "blocked" : "stale");
        } finally { holder.release(true); if (pending) await Promise.allSettled([pending]); }
      });
    }
  }
  if (phase === "upgrade") {
    await check("empty readiness downgrade/re-upgrade preserves all predecessor tables", async () => {
      const before = (await pool.query("SELECT (SELECT count(*) FROM acp.worktree_reservations)::text AS holds,(SELECT count(*) FROM acp.evidence_records)::text AS evidence")).rows[0];
      await migration("down");
      assert.equal((await pool.query("SELECT to_regclass('acp.capability_readiness_assessments') IS NULL AS absent")).rows[0].absent, true);
      await migration("up");
      assert.deepEqual((await pool.query("SELECT (SELECT count(*) FROM acp.worktree_reservations)::text AS holds,(SELECT count(*) FROM acp.evidence_records)::text AS evidence")).rows[0], before);
      assert.equal((await snapshot(await terms())).entries[0]?.currentState, "unknown");
    });
    await check("populated downgrade refuses and preserves exact history and evidence pins", async () => {
      const row = await terms({ recordedState: "available", evidenceIds: [await evidence()] }); await store.record(row);
      const before = await counts(); await assert.rejects(migration("down"), /retained readiness assessment history/u);
      assert.deepEqual(await counts(), before); assert.equal((await snapshot(row)).entries[0]?.recorded?.assessmentId, row.assessmentId);
    });
  }
  if (checks === 0) throw new Error("requested readiness phase has no implemented checks");
  process.stdout.write(`Readiness integration: ${checks} checks passed.\n`);
} finally { await pool.end(); }
