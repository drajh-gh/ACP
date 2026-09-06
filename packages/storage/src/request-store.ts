import { expectBoolean, expectOnlyKeys, expectRecord, parseCanonicalTimestamp, parseRequestMissionLink,
  parseRequestRegistration, parseStableId, requestIdentityMaximumBytes, requestIdentitySchemaVersion,
  requestMissionLinkDigest, requestRegistrationDigest, snapshotJsonData,
  type RequestMissionLink, type RequestRegistration, type StableId } from "@acp/domain";
import type { Pool } from "pg";
import { withIsolatedTransaction } from "./isolated-transaction.ts";

export interface RequestRecordingReceipt<T extends RequestRegistration | RequestMissionLink> {
  readonly schemaVersion: typeof requestIdentitySchemaVersion;
  readonly record: T;
  readonly recordedAt: string;
  readonly provenanceId: StableId<"provenance">;
  readonly replayed: boolean;
  readonly authority: "not_granted";
}
/** Private recording seam, not an authenticated operator endpoint. Recording
 * never creates workflows, approves scope, evaluates closure or grants effects. */
export class PostgresRequestStore {
  private readonly pool: Pool;
  private readonly provenanceId: StableId<"provenance">;
  constructor(pool: Pool, owner: { readonly provenanceId: unknown }) {
    for (const [key, maximum] of [["max", 8], ["connectionTimeoutMillis", 10_000], ["statement_timeout", 10_000], ["lock_timeout", 5000]] as const) {
      const value = pool.options[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) throw new TypeError(`request pool ${key} must be explicitly bounded`);
    }
    this.pool = pool; this.provenanceId = parseStableId(owner.provenanceId, "provenance");
  }
  async recordRequest(value: unknown): Promise<RequestRecordingReceipt<RequestRegistration>> {
    return this.record(value, "record_request_identity", parseRequestRegistration, requestRegistrationDigest);
  }
  async associateMission(value: unknown): Promise<RequestRecordingReceipt<RequestMissionLink>> {
    return this.record(value, "record_request_mission_link", parseRequestMissionLink, requestMissionLinkDigest);
  }
  private async record<T extends RequestRegistration | RequestMissionLink>(value: unknown,
    procedure: "record_request_identity" | "record_request_mission_link", parse: (value: unknown) => T,
    digest: (value: unknown) => string): Promise<RequestRecordingReceipt<T>> {
    const record = parse(value), exactDigest = digest(record), body = JSON.stringify(record);
    return withIsolatedTransaction(this.pool, async client => {
      const rows = (await client.query(`SELECT acp.${procedure}($1::jsonb,$2::acp.stable_id) AS receipt`, [body, this.provenanceId])).rows;
      if (rows.length !== 1) throw new Error("request recording returned no exact receipt");
      const input = expectRecord(snapshotJsonData(rows[0]?.receipt, { maximumBytes: requestIdentityMaximumBytes + 4096 }), "request receipt");
      const fields = ["schemaVersion", "record", "recordedAt", "provenanceId", "replayed", "authority"];
      expectOnlyKeys(input, fields, "request receipt");
      if (fields.some(key => !Object.hasOwn(input, key))) throw new Error("complete request receipt required");
      const actual = parse(input.record), provenanceId = parseStableId(input.provenanceId, "provenance");
      if (input.schemaVersion !== requestIdentitySchemaVersion || input.authority !== "not_granted"
        || digest(actual) !== exactDigest || provenanceId !== this.provenanceId) throw new Error("request receipt aliases different terms or producer");
      return Object.freeze({ schemaVersion: requestIdentitySchemaVersion, record: actual,
        recordedAt: parseCanonicalTimestamp(input.recordedAt), provenanceId,
        replayed: expectBoolean(input.replayed, "request replayed"), authority: "not_granted" });
    });
  }
}
