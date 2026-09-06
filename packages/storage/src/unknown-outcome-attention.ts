import { expectBoolean, expectOnlyKeys, expectRecord, parseCanonicalTimestamp, parseStableId, snapshotJsonData, type StableId } from "@acp/domain";
import type { Pool } from "pg";
import { withIsolatedTransaction } from "./isolated-transaction.ts";

export interface UnknownOutcomeAttentionQuery { readonly projectId: StableId<"project">; readonly receiptId: StableId<"receipt">; }
export type UnknownOutcomeAttentionCapture = Readonly<UnknownOutcomeAttentionQuery & (
  { readonly kind: "not_eligible" } |
  { readonly kind: "recorded"; readonly itemId: StableId<"attentionItem">; readonly observedAt: string; readonly provenanceId: StableId<"provenance">; readonly replayed: boolean }
)>;
export interface UnknownOutcomeAttentionPersistence {
  capture(query: UnknownOutcomeAttentionQuery): Promise<UnknownOutcomeAttentionCapture>;
}
function parseQuery(value: unknown): UnknownOutcomeAttentionQuery {
  const row = expectRecord(snapshotJsonData(value, { maximumBytes: 2048 }), "unknown-outcome attention query");
  expectOnlyKeys(row, ["projectId", "receiptId"], "unknown-outcome attention query");
  return Object.freeze({ projectId: parseStableId(row.projectId, "project"), receiptId: parseStableId(row.receiptId, "receipt") });
}
/** Private receipt-driven reporting, never part of the external receipt INSERT.
 * Existing source links replay exact history; nothing executes or reconciles an effect. */
export class PostgresUnknownOutcomeAttentionStore implements UnknownOutcomeAttentionPersistence {
  private readonly pool: Pool;
  private readonly provenanceId: StableId<"provenance">;
  constructor(pool: Pool, owner: { readonly provenanceId: StableId<"provenance"> }) {
    for (const [key, maximum] of [["max", 8], ["connectionTimeoutMillis", 10_000], ["statement_timeout", 10_000], ["lock_timeout", 5000]] as const) {
      const value = pool.options[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) throw new TypeError(`unknown-outcome attention pool ${key} must be explicitly bounded`);
    }
    this.pool = pool; this.provenanceId = parseStableId(owner.provenanceId, "provenance");
  }
  async capture(queryValue: unknown): Promise<UnknownOutcomeAttentionCapture> {
    const query = parseQuery(queryValue);
    return withIsolatedTransaction(this.pool, async client => {
      const rows = (await client.query("SELECT acp.capture_unknown_effect_attention($1::acp.stable_id,$2::acp.stable_id,$3::acp.stable_id) AS capture",
        [query.projectId, query.receiptId, this.provenanceId])).rows;
      if (rows.length !== 1) throw new Error("unknown-outcome attention requires one exact capture result");
      const row = expectRecord(snapshotJsonData(rows[0]?.capture, { maximumBytes: 4096 }), "unknown-outcome attention capture");
      if (row.projectId !== query.projectId || row.receiptId !== query.receiptId) throw new Error("unknown-outcome attention source identity mismatch");
      if (row.kind === "not_eligible") {
        expectOnlyKeys(row, ["kind", "projectId", "receiptId"], "unknown-outcome attention skip");
        return Object.freeze({ kind: "not_eligible", ...query });
      }
      expectOnlyKeys(row, ["kind", "projectId", "receiptId", "itemId", "observedAt", "provenanceId", "replayed"], "unknown-outcome attention capture");
      if (row.kind !== "recorded") throw new Error("unknown-outcome attention result kind invalid");
      const provenanceId = parseStableId(row.provenanceId, "provenance"), replayed = expectBoolean(row.replayed, "capture replayed");
      if (!replayed && provenanceId !== this.provenanceId) throw new Error("unknown-outcome attention producer mismatch");
      return Object.freeze({ kind: "recorded", ...query, itemId: parseStableId(row.itemId, "attentionItem"), observedAt: parseCanonicalTimestamp(row.observedAt), provenanceId, replayed });
    });
  }
}
