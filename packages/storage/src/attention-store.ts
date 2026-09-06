import { attentionItemDigest, attentionQueueMaximumBytes, expectBoolean, expectOnlyKeys, expectRecord, parseAttentionItem,
  parseAttentionQueue, parseAttentionQueueQuery, parseCanonicalTimestamp, parseStableId, snapshotJsonData, timestampMicroseconds,
  type AttentionItem, type AttentionQueue, type AttentionQueueQuery, type StableId } from "@acp/domain";
import type { Pool } from "pg";
import type { QueryExecutor } from "./database.ts";
import { withIsolatedTransaction } from "./isolated-transaction.ts";
import { attentionQueueSql } from "./attention-query.ts";

export interface AttentionQueuePersistence { getAttentionQueue(query: AttentionQueueQuery): Promise<AttentionQueue | undefined>; }
/** Private producer receipt. replayed refers to the canonical item; a fresh
 * duplicate request still appends its own immutable ID alias. */
export interface AttentionRecordingReceipt {
  readonly item: AttentionItem;
  readonly recordedAt: string;
  readonly provenanceId: StableId<"provenance">;
  readonly requestId: StableId<"attentionItem">;
  readonly requestRecordedAt: string;
  readonly requestProvenanceId: StableId<"provenance">;
  readonly replayed: boolean;
}
export class PostgresAttentionStore {
  private readonly pool: Pool;
  private readonly provenanceId: StableId<"provenance">;
  constructor(pool: Pool, owner: { readonly provenanceId: StableId<"provenance"> }) {
    for (const [key, maximum] of [["max", 8], ["connectionTimeoutMillis", 10_000], ["statement_timeout", 10_000], ["lock_timeout", 5000]] as const) {
      const value = pool.options[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) throw new TypeError(`attention pool ${key} must be explicitly bounded`);
    }
    this.provenanceId = parseStableId(owner.provenanceId, "provenance"); this.pool = pool;
  }
  async record(value: unknown): Promise<AttentionRecordingReceipt> {
    const item = parseAttentionItem(value), semanticDigest = attentionItemDigest(item), body = JSON.stringify(item);
    return withIsolatedTransaction(this.pool, async client => {
      const rows = (await client.query("SELECT acp.record_attention_request($1::jsonb,$2::acp.stable_id) AS receipt", [body, this.provenanceId])).rows;
      if (rows.length !== 1) throw new Error("attention recording returned no exact receipt");
      const input = expectRecord(snapshotJsonData(rows[0]?.receipt, { maximumBytes: 49_152 }), "attention receipt");
      const fields = ["item", "recordedAt", "provenanceId", "requestId", "requestRecordedAt", "requestProvenanceId", "replayed"];
      expectOnlyKeys(input, fields, "attention receipt"); if (fields.some(key => !Object.hasOwn(input, key))) throw new Error("complete attention receipt required");
      const actual = parseAttentionItem(input.item), requestId = parseStableId(input.requestId, "attentionItem"), replayed = expectBoolean(input.replayed, "replayed");
      const recordedAt = parseCanonicalTimestamp(input.recordedAt), requestRecordedAt = parseCanonicalTimestamp(input.requestRecordedAt);
      const provenanceId = parseStableId(input.provenanceId, "provenance"), requestProvenanceId = parseStableId(input.requestProvenanceId, "provenance");
      if (requestId !== item.itemId || attentionItemDigest(actual) !== semanticDigest || (!replayed && actual.itemId !== requestId)
        || (!replayed && (provenanceId !== this.provenanceId || requestProvenanceId !== this.provenanceId))
        || (requestId === actual.itemId && provenanceId !== requestProvenanceId)
        || timestampMicroseconds(requestRecordedAt) < timestampMicroseconds(recordedAt)) throw new Error("attention receipt aliases different terms");
      return Object.freeze({ item: actual, recordedAt, provenanceId, requestId, requestRecordedAt, requestProvenanceId, replayed });
    });
  }
}
/** Read-only, one-statement recorded page. A caller supplies bounded connection
 * settings; errors never return a valid prefix or an alternative page. */
export async function getAttentionQueue(executor: QueryExecutor, queryValue: unknown): Promise<AttentionQueue | undefined> {
  const query = parseAttentionQueueQuery(queryValue);
  const rows = (await executor.query(attentionQueueSql, [query.projectId, query.missionId ?? null, query.afterItemId ?? null, query.limit, attentionQueueMaximumBytes])).rows;
  if (!rows.length) return undefined;
  if (rows.length !== 1 || rows[0]?.attention_error !== null) throw new Error("Recorded attention is unavailable; no partial page returned.");
  return parseAttentionQueue(query, rows[0]?.snapshot);
}
