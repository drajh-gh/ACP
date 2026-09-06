import { parseStableId, type StableId } from "./ids.ts";
import { parseRequestMissionLink, parseRequestRegistration, type RequestRegistration } from "./requests.ts";
import { snapshotJsonData } from "./json-snapshot.ts";
import { expectOnlyKeys, expectRecord, parseCanonicalTimestamp, timestampMicroseconds } from "./validation.ts";

export const requestHistorySchemaVersion = "1.0.0";
export const requestHistoryMaximumBytes = 65_536;
export const requestHistoryMaximumAssociations = 100;
export interface RequestHistoryQuery { readonly projectId: StableId<"project">; readonly requestId: StableId<"request">; }
export interface RecordedRequestAssociation { readonly missionId: StableId<"mission">; readonly reason: string; readonly recordedAt: string; }
export interface RequestHistory {
  readonly schemaVersion: typeof requestHistorySchemaVersion;
  readonly asOf: string;
  readonly request: RequestRegistration;
  readonly recordedAt: string;
  readonly missionAssociations: readonly RecordedRequestAssociation[];
  readonly coverage: "recorded_associations_only";
  readonly freshness: "not_assessed";
  readonly authority: "not_granted";
}
export function parseRequestHistoryQuery(value: unknown): RequestHistoryQuery {
  const input = exact(snapshotJsonData(value, { maximumBytes: 1024 }), ["projectId", "requestId"]);
  return Object.freeze({ projectId: parseStableId(input.projectId, "project"), requestId: parseStableId(input.requestId, "request") });
}
/** Whole historical snapshot only. Empty links do not establish completed work,
 * source coverage, current mission state or permission to act. */
export function parseRequestHistory(queryValue: unknown, value: unknown): RequestHistory {
  const query = parseRequestHistoryQuery(queryValue), input = exact(snapshotJsonData(value, { maximumBytes: requestHistoryMaximumBytes }),
    ["schemaVersion", "asOf", "request", "recordedAt", "missionAssociations", "coverage", "freshness", "authority"]);
  if (input.schemaVersion !== requestHistorySchemaVersion || input.coverage !== "recorded_associations_only"
    || input.freshness !== "not_assessed" || input.authority !== "not_granted") throw new TypeError("recorded request history labels required");
  const request = parseRequestRegistration(input.request), asOf = parseCanonicalTimestamp(input.asOf), recordedAt = parseCanonicalTimestamp(input.recordedAt);
  if (request.projectId !== query.projectId || request.requestId !== query.requestId) throw new TypeError("request history scope mismatch");
  const start = timestampMicroseconds(recordedAt), end = timestampMicroseconds(asOf);
  if (start > end) throw new TypeError("request history cannot precede its original record");
  if (!Array.isArray(input.missionAssociations) || input.missionAssociations.length > requestHistoryMaximumAssociations) throw new TypeError("bounded complete associations required");
  let previous = "";
  const missionAssociations = input.missionAssociations.map(value => {
    const row = exact(value, ["missionId", "reason", "recordedAt"]);
    const link = parseRequestMissionLink({ ...query, missionId: row.missionId, reason: row.reason }), at = parseCanonicalTimestamp(row.recordedAt);
    const time = timestampMicroseconds(at);
    if (link.missionId <= previous || time < start || time > end) throw new TypeError("canonical request association order and chronology required");
    previous = link.missionId;
    return Object.freeze({ missionId: link.missionId, reason: link.reason, recordedAt: at });
  });
  return Object.freeze({ schemaVersion: requestHistorySchemaVersion, asOf, request, recordedAt,
    missionAssociations: Object.freeze(missionAssociations), coverage: "recorded_associations_only", freshness: "not_assessed", authority: "not_granted" });
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const input = expectRecord(value, "request history data"); expectOnlyKeys(input, keys, "request history data");
  if (keys.some(key => !Object.hasOwn(input, key))) throw new TypeError("complete request history data required");
  return input;
}
