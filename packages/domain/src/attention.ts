import { canonicalJsonDigest } from "./effects.ts";
import { parseStableId, type EntityKind, type StableId } from "./ids.ts";
import { snapshotJsonData } from "./json-snapshot.ts";
import { expectArray, expectEnum, expectOnlyKeys, expectRecord, parseCanonicalTimestamp, timestampMicroseconds } from "./validation.ts";

export const attentionTypes = Object.freeze([
  "exact_approval_requested", "business_or_product_decision_required", "material_ambiguity", "credible_source_conflict",
  "approval_invalidated_by_drift", "unknown_external_outcome", "repeated_automated_repair_failure", "failed_independent_acceptance",
  "credential_expired_or_revoked", "capability_became_unavailable", "critical_incident_notification", "unrecoverable_coverage_gap",
] as const);
/** Ordering only; critical urgency does not authorize a quiet-hours interruption. */
export const attentionUrgencies = Object.freeze(["critical", "high", "normal", "low"] as const);
export const attentionSchemaVersion = "1.0.0";
export const attentionItemMaximumBytes = 32_768;
export const attentionQueueMaximumBytes = 65_536;
export interface AttentionItem {
  readonly itemId: StableId<"attentionItem">;
  readonly projectId: StableId<"project">;
  readonly missionIds: readonly StableId<"mission">[];
  readonly type: (typeof attentionTypes)[number];
  readonly urgency: (typeof attentionUrgencies)[number];
  readonly title: string;
  readonly explanation: string;
  readonly whyHumanIsNeeded: string;
  readonly recommendation?: string;
  readonly alternatives?: readonly string[];
  readonly consequenceOfNoAction?: string;
  readonly evidenceIds: readonly StableId<"evidence">[];
  /** Existing immutable effect proposals carry previews; this is not approval coverage. */
  readonly effectPreviewIds?: readonly StableId<"effect">[];
  /** Recorded descriptions only, never executable decisions or response grants. */
  readonly allowedResponses: readonly string[];
  readonly expiresAt?: string;
  readonly deduplicationKey: string;
  /** Recorded description only; no policy evaluation, scheduling or notification. */
  readonly quietHoursDisposition: string;
}
export interface AttentionQueueQuery {
  readonly projectId: StableId<"project">;
  readonly missionId?: StableId<"mission">;
  readonly afterItemId?: StableId<"attentionItem">;
  readonly limit: number;
}
export interface RecordedAttentionItem {
  readonly item: AttentionItem;
  readonly recordedAt: string;
  /** Expired items remain recorded and are not automatically resolved. */
  readonly expiry: "not_expiring" | "not_expired" | "expired";
}
export interface AttentionQueue {
  readonly schemaVersion: typeof attentionSchemaVersion;
  readonly projectId: StableId<"project">;
  readonly missionId: StableId<"mission"> | null;
  readonly afterItemId: StableId<"attentionItem"> | null;
  readonly limit: number;
  readonly asOf: string;
  readonly coverage: "recorded_items_only";
  readonly freshness: "not_assessed";
  readonly authority: "not_granted";
  readonly items: readonly RecordedAttentionItem[];
  readonly nextCursor: StableId<"attentionItem"> | null;
}
const requiredFields = ["itemId", "projectId", "missionIds", "type", "urgency", "title", "explanation", "whyHumanIsNeeded",
  "evidenceIds", "allowedResponses", "deduplicationKey", "quietHoursDisposition"];
const optionalFields = ["recommendation", "alternatives", "consequenceOfNoAction", "effectPreviewIds", "expiresAt"];

export function parseAttentionItem(value: unknown): AttentionItem {
  const input = exact(snapshotJsonData(value, { maximumBytes: attentionItemMaximumBytes }), requiredFields, optionalFields);
  const output: AttentionItem = {
    itemId: parseStableId(input.itemId, "attentionItem"), projectId: parseStableId(input.projectId, "project"),
    missionIds: ids(input.missionIds, "mission"), type: expectEnum(input.type, attentionTypes, "attention.type"),
    urgency: expectEnum(input.urgency, attentionUrgencies, "attention.urgency"), title: text(input.title, 240, true),
    explanation: text(input.explanation, 4000), whyHumanIsNeeded: text(input.whyHumanIsNeeded, 4000),
    ...(Object.hasOwn(input, "recommendation") ? { recommendation: text(input.recommendation, 4000) } : {}),
    ...(Object.hasOwn(input, "alternatives") ? { alternatives: texts(input.alternatives, 10, 1000, 0) } : {}),
    ...(Object.hasOwn(input, "consequenceOfNoAction") ? { consequenceOfNoAction: text(input.consequenceOfNoAction, 4000) } : {}),
    evidenceIds: ids(input.evidenceIds, "evidence"),
    ...(Object.hasOwn(input, "effectPreviewIds") ? { effectPreviewIds: ids(input.effectPreviewIds, "effect") } : {}),
    allowedResponses: texts(input.allowedResponses, 10, 200, 1),
    ...(Object.hasOwn(input, "expiresAt") ? { expiresAt: parseCanonicalTimestamp(input.expiresAt) } : {}),
    deduplicationKey: text(input.deduplicationKey, 200, true), quietHoursDisposition: text(input.quietHoursDisposition, 1000),
  };
  snapshotJsonData(output, { maximumBytes: attentionItemMaximumBytes });
  return freeze(output);
}
/** Producer-key exact semantic equivalence, not a classifier of similar prose.
 * Optional-field presence and ordered response/alternative descriptions matter. */
export function attentionItemDigest(value: unknown): string {
  const { itemId: _itemId, ...semantic } = parseAttentionItem(value);
  return canonicalJsonDigest(snapshotJsonData(semantic, { maximumBytes: attentionItemMaximumBytes }));
}
export function parseAttentionQueueQuery(value: unknown): AttentionQueueQuery {
  const input = exact(snapshotJsonData(value, { maximumBytes: 4096 }), ["projectId"], ["missionId", "afterItemId", "limit"]);
  const limit = Object.hasOwn(input, "limit") ? input.limit : 20;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new TypeError("attention page limit must be 1 to 50");
  return freeze({ projectId: parseStableId(input.projectId, "project"), limit,
    ...(Object.hasOwn(input, "missionId") ? { missionId: parseStableId(input.missionId, "mission") } : {}),
    ...(Object.hasOwn(input, "afterItemId") ? { afterItemId: parseStableId(input.afterItemId, "attentionItem") } : {}),
  });
}
/** Whole-page validation. Reference disclosure and one-statement snapshot
 * acquisition belong to trusted storage, not this structural parser. */
export function parseAttentionQueue(queryValue: unknown, value: unknown): AttentionQueue {
  const query = parseAttentionQueueQuery(queryValue), input = exact(snapshotJsonData(value, { maximumBytes: attentionQueueMaximumBytes }),
    ["schemaVersion", "projectId", "missionId", "afterItemId", "limit", "asOf", "coverage", "freshness", "authority", "items", "nextCursor"]);
  if (input.schemaVersion !== attentionSchemaVersion || input.projectId !== query.projectId || input.missionId !== (query.missionId ?? null)
    || input.afterItemId !== (query.afterItemId ?? null) || input.limit !== query.limit || input.coverage !== "recorded_items_only"
    || input.freshness !== "not_assessed" || input.authority !== "not_granted") throw new TypeError("exact recorded attention query and boundary required");
  const asOf = parseCanonicalTimestamp(input.asOf), at = timestampMicroseconds(asOf), seen = new Set<string>();
  const items = array(input.items, query.limit, 0).map((value): RecordedAttentionItem => {
    const row = exact(value, ["item", "recordedAt", "expiry"]), item = parseAttentionItem(row.item), recordedAt = parseCanonicalTimestamp(row.recordedAt);
    if (item.projectId !== query.projectId || (query.missionId && !item.missionIds.includes(query.missionId))
      || item.itemId === query.afterItemId || seen.has(item.itemId) || timestampMicroseconds(recordedAt) > at) throw new TypeError("exact unique historical attention item required");
    seen.add(item.itemId);
    const expiry = item.expiresAt === undefined ? "not_expiring" : timestampMicroseconds(item.expiresAt) <= at ? "expired" : "not_expired";
    if (row.expiry !== expiry) throw new TypeError("attention expiry is not resolution or freshness");
    return { item, recordedAt, expiry };
  });
  for (let index = 1; index < items.length; index++) if (compareAttentionItems(items[index - 1]!, items[index]!) >= 0) throw new TypeError("deterministic attention page ordering required");
  const nextCursor = input.nextCursor === null ? null : parseStableId(input.nextCursor, "attentionItem");
  if (nextCursor !== null && (items.length !== query.limit || nextCursor !== items.at(-1)?.item.itemId)) throw new TypeError("exact last-item continuation required");
  const output: AttentionQueue = { schemaVersion: attentionSchemaVersion, projectId: query.projectId, missionId: query.missionId ?? null,
    afterItemId: query.afterItemId ?? null, limit: query.limit, asOf, coverage: "recorded_items_only", freshness: "not_assessed",
    authority: "not_granted", items, nextCursor };
  snapshotJsonData(output, { maximumBytes: attentionQueueMaximumBytes });
  return freeze(output);
}
export function compareAttentionItems(left: RecordedAttentionItem, right: RecordedAttentionItem): number {
  const rank = attentionUrgencies.indexOf(left.item.urgency) - attentionUrgencies.indexOf(right.item.urgency);
  if (rank) return rank;
  const l = timestampMicroseconds(left.recordedAt), r = timestampMicroseconds(right.recordedAt);
  return l < r ? -1 : l > r ? 1 : left.item.itemId < right.item.itemId ? -1 : left.item.itemId > right.item.itemId ? 1 : 0;
}
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const input = expectRecord(value, "attention data"); expectOnlyKeys(input, [...required, ...optional], "attention data");
  if (required.some(key => !Object.hasOwn(input, key))) throw new TypeError("complete attention data required"); return input;
}
function text(value: unknown, maximum: number, singleLine = false): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maximum
    || (singleLine ? /[\p{Cc}\p{Cs}]/u : /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\p{Cs}]/u).test(value)) throw new TypeError("bounded canonical attention text required");
  return value;
}
function array(value: unknown, maximum: number, minimum: number): readonly unknown[] {
  const values = expectArray(value, "attention list"); if (values.length < minimum || values.length > maximum) throw new TypeError("bounded attention list required"); return values;
}
function ids<K extends EntityKind>(value: unknown, kind: K): StableId<K>[] {
  const result = array(value, 50, 0).map(value => parseStableId(value, kind)).sort();
  if (new Set(result).size !== result.length) throw new TypeError("unique attention references required"); return result;
}
function texts(value: unknown, maximum: number, length: number, minimum: number): string[] {
  const result = array(value, maximum, minimum).map(value => text(value, length));
  if (new Set(result).size !== result.length) throw new TypeError("unique attention descriptions required"); return result;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value;
}
