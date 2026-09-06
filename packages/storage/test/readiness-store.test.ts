import assert from "node:assert/strict";
import { it } from "node:test";
import { createStableId } from "@acp/domain";
import type { Pool } from "pg";
import { getProjectReadiness, PostgresReadinessAssessmentStore } from "../src/readiness-store.ts";

const authority = { provenanceId: createStableId("provenance"), evaluatorVersion: "synthetic:1" };
const key = { capability: "run_tests", resourceKey: "repository:fixture", resourceVersion: "1" };
const query = { projectId: createStableId("project"), profileId: createStableId("projectProfile"), profileVersion: "1.0.0", keys: [key] };
const terms = { assessmentId: createStableId("capabilityReadinessAssessment"), projectId: query.projectId, profileId: query.profileId,
  profileVersion: query.profileVersion, ...key, recordedState: "unconfigured" as const, recordedReason: "No synthetic runner configured.",
  assessedAt: "2026-09-06T00:00:00.000001Z", validUntil: "2026-09-06T01:00:00.000001Z", evidenceIds: [], supersedesAssessmentId: null };

it("readiness writer pins trusted provenance/evaluator and requires bounded pool settings", async () => {
  let calls = 0;
  const pool = { options: { max: 4, connectionTimeoutMillis: 3000, statement_timeout: 5000, lock_timeout: 2000 },
    async query() { calls++; return { rows: [] }; }, async connect() { calls++; throw new Error("unexpected connection"); } } as unknown as Pool;
  assert.throws(() => new PostgresReadinessAssessmentStore({ ...pool, options: {} } as unknown as Pool, authority));
  assert.throws(() => new PostgresReadinessAssessmentStore({ ...pool, options: { ...pool.options, max: 100 } } as unknown as Pool, authority));
  assert.throws(() => new PostgresReadinessAssessmentStore(pool, { ...authority, evaluatorVersion: " " }));
  const store = new PostgresReadinessAssessmentStore(pool, authority);
  for (const extra of ["provenanceId", "evaluatorVersion", "authority", "recordedAt", "evidencePins"]) {
    await assert.rejects(store.record({ ...terms, [extra]: "injected" }));
  }
  await assert.rejects(store.record({ ...terms, validUntil: terms.assessedAt }));
  assert.equal(calls, 0);
});

it("readiness read uses one statement and never opens a write transaction", async () => {
  const seen: { text: string; values: unknown[] | undefined }[] = [];
  const executor = { async query(text: string, values?: unknown[]) {
    seen.push({ text, values });
    return { rows: [{ readiness_error: null, snapshot: { ...query, asOf: "2026-09-06T00:00:00.000001+00:00", latest: [], evidence: [], identityMatches: [] } }], rowCount: 1, command: "SELECT", oid: 0, fields: [] };
  } };
  const matrix = await getProjectReadiness(executor as unknown as Pool, query);
  assert.equal(matrix?.entries[0]?.currentState, "unknown");
  assert.equal(matrix?.asOf, "2026-09-06T00:00:00.000001Z");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.values?.[0], query.projectId);
  assert.equal(JSON.parse(seen[0]?.values?.[3] as string)[0].resourceKey, key.resourceKey);
});

it("readiness read rejects bad query before I/O and denies all partial or wrong-scope payloads", async () => {
  let calls = 0;
  let row: unknown;
  const executor = { async query() { calls++; return { rows: row === undefined ? [] : [row] }; } } as unknown as Pool;
  await assert.rejects(getProjectReadiness(executor, { ...query, keys: [] }));
  assert.equal(calls, 0);
  assert.equal(await getProjectReadiness(executor, query), undefined);
  for (const error of ["invalid_references", "too_large", "unexpected"]) {
    row = { readiness_error: error, snapshot: { forbidden: "must never disclose partial data" } };
    await assert.rejects(getProjectReadiness(executor, query));
  }
  row = { readiness_error: null, snapshot: { ...query, projectId: createStableId("project"), asOf: terms.assessedAt, latest: [], evidence: [] } };
  await assert.rejects(getProjectReadiness(executor, query), /identity/u);
});

it("readiness write replays exact canonical history without checking current admission or renewing it", async () => {
  const seen: string[] = [];
  let returned = { ...terms, ...authority };
  let released = false;
  const client = { async query(text: string) { seen.push(text); return { rows: text.includes("readiness_assessment_json") ? [{ assessment: returned }] : [] }; }, release() { released = true; } };
  const pool = { options: { max: 4, connectionTimeoutMillis: 3000, statement_timeout: 5000, lock_timeout: 2000 },
    async connect() { return client; } } as unknown as Pool;
  const store = new PostgresReadinessAssessmentStore(pool, authority);
  const replay = await store.record({ ...terms, assessedAt: "2026-09-06T02:00:00.000001+02:00" });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.assessment, returned);
  assert.ok(!seen.some(text => /INSERT|UPDATE|DELETE/u.test(text)));
  assert.equal(seen.at(-1), "COMMIT");
  assert.equal(released, true);
  returned = { ...returned, recordedReason: "A different immutable reason." };
  await assert.rejects(store.record(terms), /different terms/u);
  assert.equal(seen.at(-1), "ROLLBACK");
});

it("readiness writer destroys uncertain BEGIN and failed rollback sessions without fabricating a replay", async () => {
  for (const fault of ["BEGIN", "ROLLBACK"] as const) {
    const releases: unknown[] = [], seen: string[] = [];
    let readbacks = 0;
    const client = { async query(sql: string) {
      seen.push(sql);
      if (sql === fault) throw new Error(`synthetic ${fault} failure`);
      if (sql.startsWith("INSERT")) throw new Error("synthetic insert failure");
      return { rows: [] };
    }, release(discard?: unknown) { releases.push(discard); } };
    const pool = { options: { max: 4, connectionTimeoutMillis: 3000, statement_timeout: 5000, lock_timeout: 2000 },
      async connect() { return client; }, async query() { readbacks++; return { rows: [] }; } } as unknown as Pool;
    await assert.rejects(new PostgresReadinessAssessmentStore(pool, authority).record(terms), fault === "BEGIN" ? /BEGIN failure/u : /insert failure/u);
    assert.deepEqual(releases, [true]); assert.ok(seen.includes("ROLLBACK"));
    assert.equal(readbacks, fault === "BEGIN" ? 0 : 1);
    assert.equal(seen.includes("COMMIT"), false);
  }
});
