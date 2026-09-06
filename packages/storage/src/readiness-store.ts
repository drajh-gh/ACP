import {
  buildProjectReadiness, canonicalJsonDigest, expectJsonValue, expectOnlyKeys, expectRecord, parseProjectReadinessQuery,
  parseReadinessAssessment, parseStableId, readinessMaximumBytes,
  type ProjectReadiness, type ReadinessAssessment, type StableId,
} from "@acp/domain";
import type { Pool } from "pg";
import type { QueryExecutor } from "./database.ts";
import { projectReadinessSql } from "./readiness-query.ts";

export type ReadinessAssessmentWrite = Omit<ReadinessAssessment, "provenanceId" | "evaluatorVersion">;
export interface ReadinessEvaluatorIdentity {
  readonly provenanceId: StableId<"provenance">;
  readonly evaluatorVersion: string;
}

/** Trusted internal writer only. Runtime provenance is identity, not an evaluator role grant. */
export class PostgresReadinessAssessmentStore {
  private readonly pool: Pool;
  private readonly authority: ReadinessEvaluatorIdentity;

  constructor(pool: Pool, authority: ReadinessEvaluatorIdentity) {
    for (const [key, maximum] of [["max", 8], ["connectionTimeoutMillis", 10_000], ["statement_timeout", 10_000], ["lock_timeout", 5_000]] as const) {
      const value = pool.options[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) {
        throw new TypeError(`readiness pool ${key} must be explicitly bounded from 1 to ${maximum}`);
      }
    }
    const evaluatorVersion = authority.evaluatorVersion;
    if (typeof evaluatorVersion !== "string" || !evaluatorVersion || evaluatorVersion !== evaluatorVersion.trim()
      || evaluatorVersion.length > 200 || /[\p{Cc}\p{Cs}]/u.test(evaluatorVersion)) throw new TypeError("readiness evaluator version must be bounded canonical text");
    this.authority = Object.freeze({ provenanceId: parseStableId(authority.provenanceId, "provenance"), evaluatorVersion });
    this.pool = pool;
  }

  async record(value: ReadinessAssessmentWrite): Promise<{ readonly assessment: ReadinessAssessment; readonly replayed: boolean }> {
    const supplied = expectRecord(value, "readiness assessment write");
    expectOnlyKeys(supplied, ["assessmentId", "projectId", "profileId", "profileVersion", "capability", "resourceKey", "resourceVersion",
      "recordedState", "recordedReason", "assessedAt", "validUntil", "evidenceIds", "supersedesAssessmentId"], "readiness assessment write");
    const input = parseReadinessAssessment({ ...supplied, ...this.authority });
    let attempted = false;
    try { return await withReadinessTransaction(this.pool, async client => {
      // Immutable historical replay is checked before current binding/evidence admission.
      const previous = await load(client, input.assessmentId);
      if (previous) return exactResult(previous, input, true);
      attempted = true;
      const inserted = await client.query(`INSERT INTO acp.capability_readiness_assessments
        (assessment_id,project_id,profile_id,profile_version,capability,resource_key,resource_version,recorded_state,recorded_reason,
          assessed_at,valid_until,evidence_ids,evaluator_version,provenance_id,supersedes_assessment_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz,$12::jsonb,$13,$14,$15)
        RETURNING acp.readiness_assessment_json(capability_readiness_assessments) AS assessment`,
      [input.assessmentId,input.projectId,input.profileId,input.profileVersion,input.capability,input.resourceKey,input.resourceVersion,
        input.recordedState,input.recordedReason,input.assessedAt,input.validUntil,JSON.stringify(input.evidenceIds),input.evaluatorVersion,
        input.provenanceId,input.supersedesAssessmentId]);
      if (!inserted.rows[0]) throw new Error("readiness insertion returned no assessment");
      return exactResult(parseReadinessAssessment(inserted.rows[0].assessment), input, false);
    }); } catch (error) {
      if (!attempted) throw error;
      // A concurrent winner or lost COMMIT may already have retained this exact ID.
      // The failed physical session is closed before this independent readback.
      let recovered: ReadinessAssessment | undefined;
      try { recovered = await load(this.pool, input.assessmentId); } catch { throw error; }
      if (recovered) return exactResult(recovered, input, true);
      throw error;
    }
  }
}

/** Caller supplies a bounded executor; this path uses no transaction, lock, grant or mutation. */
export async function getProjectReadiness(executor: QueryExecutor, queryValue: unknown): Promise<ProjectReadiness | undefined> {
  const query = parseProjectReadinessQuery(queryValue);
  const row = (await executor.query(projectReadinessSql, [query.projectId,query.profileId,query.profileVersion,JSON.stringify(query.keys),readinessMaximumBytes])).rows[0];
  if (!row) return undefined;
  if (row.readiness_error === "too_large") throw new Error("readiness exceeds bounded snapshot; no partial readiness returned");
  if (row.readiness_error !== null) throw new Error("readiness snapshot contains invalid or undisclosable references");
  const snapshot = expectRecord(row.snapshot, "readiness database snapshot");
  expectOnlyKeys(snapshot, ["projectId", "profileId", "profileVersion", "keys", "asOf", "latest", "evidence", "identityMatches"], "readiness database snapshot");
  const actualQuery = parseProjectReadinessQuery({ projectId: snapshot.projectId,profileId: snapshot.profileId,profileVersion: snapshot.profileVersion,keys: snapshot.keys });
  if (canonicalJsonDigest(expectJsonValue(actualQuery, "actual readiness query")) !== canonicalJsonDigest(expectJsonValue(query, "expected readiness query"))) throw new Error("readiness database snapshot identity mismatch");
  return buildProjectReadiness(query, snapshot.asOf, snapshot.latest, snapshot.evidence, snapshot.identityMatches);
}

async function load(client: QueryExecutor, assessmentId: StableId<"capabilityReadinessAssessment">): Promise<ReadinessAssessment | undefined> {
  const row = (await client.query("SELECT acp.readiness_assessment_json(r) AS assessment FROM acp.capability_readiness_assessments r WHERE assessment_id=$1", [assessmentId])).rows[0];
  return row ? parseReadinessAssessment(row.assessment) : undefined;
}

function exactResult(actual: ReadinessAssessment, expected: ReadinessAssessment, replayed: boolean) {
  if (canonicalJsonDigest(expectJsonValue(actual, "actual readiness assessment")) !== canonicalJsonDigest(expectJsonValue(expected, "expected readiness assessment"))) throw new Error("readiness assessment aliases different terms or original evaluator identity");
  return { assessment: actual, replayed };
}

async function withReadinessTransaction<T>(pool: Pool, action: (client: QueryExecutor) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* Physical close below resolves unknown transaction state. */ }
    throw error;
  } finally {
    // No uncertain BEGIN/COMMIT/ROLLBACK state is ever returned to the pool.
    client.release(true);
  }
}
