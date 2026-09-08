import { parseAttentionQueue, type AttentionQueue, type RecordedAttentionItem } from "./attention.ts";
import { parseStableId, type StableId } from "./ids.ts";
import { parseRequestHistory, type RecordedRequestAssociation, type RequestHistory, type RequestHistoryQuery } from "./request-history.ts";
import { snapshotJsonData } from "./json-snapshot.ts";
import { missionStates, type MissionState } from "./lifecycle.ts";
import { expectArray, expectEnum, expectOnlyKeys, expectRecord, parseCanonicalTimestamp } from "./validation.ts";

export const requestBriefSchemaVersion = "1.0.0";
export const requestBriefMaximumBytes = 65_536;
export const requestBriefMissionLimit = 50;

export interface ScopedEvidenceReference {
  readonly source: "request_history" | "mission_status" | "attention";
  readonly projectId: StableId<"project">;
  readonly requestId: StableId<"request">;
  readonly missionId: StableId<"mission"> | null;
  readonly observedAt: string;
  readonly pin: string;
  readonly fields: readonly string[];
}
export interface RequestBriefMission {
  readonly association: RecordedRequestAssociation;
  readonly observation: null | {
    readonly state: MissionState;
    readonly observedAt: string;
    readonly freshness: "current" | "stale" | "unknown";
    readonly evidence: readonly ScopedEvidenceReference[];
  };
  readonly attention: readonly RecordedAttentionItem[];
}
export interface RequestBrief {
  readonly schemaVersion: typeof requestBriefSchemaVersion;
  readonly projectId: StableId<"project">;
  readonly requestId: StableId<"request">;
  readonly originalRequest: RequestHistory["request"];
  readonly recordedAt: string;
  readonly assembledAt: string;
  readonly missions: readonly RequestBriefMission[];
  readonly evidence: readonly ScopedEvidenceReference[];
  readonly coverage: {
    readonly history: "recorded_associations_only";
    readonly missionStatus: "selected_observations_only";
    readonly attention: "selected_recorded_items_only";
  };
  readonly freshness: "not_assessed" | "stale_evidence" | "missing_observations" | "incoherent_source_snapshot";
  readonly omitted: { readonly missionAssociations: number; readonly continuation: ScopedEvidenceReference | null };
  readonly unavailable: readonly ["destination_decisions", "obligations", "communications"];
  readonly supportedNextAction: "unavailable";
  readonly authority: "not_granted";
}

export interface MissionBriefObservation {
  readonly projectId: StableId<"project">;
  readonly missionId: StableId<"mission">;
  readonly state: MissionState;
  readonly observedAt: string;
  readonly freshness: "current" | "stale" | "unknown";
  readonly pinBefore: string;
  readonly pinAfter: string;
  readonly evidence: readonly ScopedEvidenceReference[];
}
export interface RequestBriefSources {
  readonly query: RequestHistoryQuery;
  readonly assembledAt: string;
  readonly history: RequestHistory;
  readonly historyPinBefore: string;
  readonly historyPinAfter: string;
  readonly missionObservations: readonly MissionBriefObservation[];
  readonly attention: readonly AttentionQueue[];
}

/** Deterministic projection over already-read records. It grants no effect,
 * approval, priority, readiness, next-action, or closure authority. */
export function assembleRequestBrief(value: unknown): RequestBrief {
  const source = parseSources(value), { query, history } = source;
  const associations = history.missionAssociations.slice(0, requestBriefMissionLimit);
  const associated = new Set(history.missionAssociations.map(item => item.missionId));
  const observations = new Map(source.missionObservations.map(item => [item.missionId, item]));
  if (observations.size !== source.missionObservations.length || source.missionObservations.some(item => !associated.has(item.missionId))) {
    throw new TypeError("mission observations must match distinct request associations");
  }
  const queues = new Map(source.attention.map(item => [item.missionId, item]));
  if (queues.size !== source.attention.length || source.attention.some(item => item.missionId === null || !associated.has(item.missionId))) {
    throw new TypeError("attention observations must match distinct request missions");
  }
  let changed = source.historyPinBefore !== source.historyPinAfter;
  let stale = false;
  let missing = false;
  const evidence: ScopedEvidenceReference[] = [reference("request_history", query, null, history.asOf, source.historyPinBefore,
    ["request", "recordedAt", "missionAssociations", "coverage", "freshness", "authority"])];
  const missions = associations.map((association): RequestBriefMission => {
    const status = observations.get(association.missionId), queue = queues.get(association.missionId);
    if (!status) missing = true;
    else { changed ||= status.pinBefore !== status.pinAfter; stale ||= status.freshness === "stale"; evidence.push(...status.evidence); }
    if (!queue) missing = true;
    else evidence.push(reference("attention", query, association.missionId, queue.asOf, attentionPin(queue),
      ["items", "nextCursor", "coverage", "freshness", "authority"]));
    return Object.freeze({ association, observation: status ? Object.freeze({ state: status.state, observedAt: status.observedAt,
      freshness: status.freshness, evidence: status.evidence }) : null, attention: queue?.items ?? Object.freeze([]) });
  });
  const omitted = history.missionAssociations.length - associations.length;
  const continuation = omitted ? reference("request_history", query, associations.at(-1)?.missionId ?? null, history.asOf,
    source.historyPinBefore, ["missionAssociations"]): null;
  const output: RequestBrief = { schemaVersion: requestBriefSchemaVersion, projectId: query.projectId, requestId: query.requestId,
    originalRequest: history.request, recordedAt: history.recordedAt, assembledAt: source.assembledAt, missions: Object.freeze(missions),
    evidence: Object.freeze(evidence), coverage: { history: "recorded_associations_only", missionStatus: "selected_observations_only",
      attention: "selected_recorded_items_only" }, freshness: changed ? "incoherent_source_snapshot" : stale ? "stale_evidence"
        : missing ? "missing_observations" : "not_assessed", omitted: { missionAssociations: omitted, continuation },
    unavailable: ["destination_decisions", "obligations", "communications"], supportedNextAction: "unavailable", authority: "not_granted" };
  snapshotJsonData(output, { maximumBytes: requestBriefMaximumBytes });
  return freeze(output);
}

function parseSources(value: unknown): RequestBriefSources {
  const input = exact(snapshotJsonData(value, { maximumBytes: 262_144 }), ["query", "assembledAt", "history", "historyPinBefore", "historyPinAfter", "missionObservations", "attention"]);
  const query = { projectId: parseStableId(exact(input.query, ["projectId", "requestId"]).projectId, "project"),
    requestId: parseStableId(exact(input.query, ["projectId", "requestId"]).requestId, "request") };
  const history = parseRequestHistory(query, input.history), assembledAt = parseCanonicalTimestamp(input.assembledAt);
  const missionObservations = expectArray(input.missionObservations, "mission observations").map(value => {
    const row = exact(value, ["projectId", "missionId", "state", "observedAt", "freshness", "pinBefore", "pinAfter", "evidence"]);
    const projectId = parseStableId(row.projectId, "project"), missionId = parseStableId(row.missionId, "mission");
    if (projectId !== query.projectId) throw new TypeError("mission observation project mismatch");
    const evidence = expectArray(row.evidence, "evidence references").map(item => parseReference(item, query, missionId));
    return { projectId, missionId, state: expectEnum(row.state, missionStates, "mission state"), observedAt: parseCanonicalTimestamp(row.observedAt),
      freshness: expectEnum(row.freshness, ["current", "stale", "unknown"], "mission freshness"), pinBefore: pin(row.pinBefore), pinAfter: pin(row.pinAfter), evidence };
  });
  const attention = expectArray(input.attention, "attention observations").map(value => {
    const row = expectRecord(value, "attention observation"), missionId = parseStableId(row.missionId, "mission");
    return parseAttentionQueue({ projectId: query.projectId, missionId, ...(row.afterItemId === null ? {} : { afterItemId: row.afterItemId }), limit: row.limit }, value);
  });
  return { query, assembledAt, history, historyPinBefore: pin(input.historyPinBefore), historyPinAfter: pin(input.historyPinAfter), missionObservations, attention };
}
function parseReference(value: unknown, query: RequestHistoryQuery, missionId: StableId<"mission">): ScopedEvidenceReference {
  const row = exact(value, ["source", "projectId", "requestId", "missionId", "observedAt", "pin", "fields"]);
  if (row.projectId !== query.projectId || row.requestId !== query.requestId || row.missionId !== missionId) throw new TypeError("evidence reference scope mismatch");
  const fields = expectArray(row.fields, "evidence fields").map(field => pin(field));
  return { source: expectEnum(row.source, ["mission_status"], "evidence source"), projectId: query.projectId, requestId: query.requestId,
    missionId, observedAt: parseCanonicalTimestamp(row.observedAt), pin: pin(row.pin), fields };
}
function reference(source: ScopedEvidenceReference["source"], query: RequestHistoryQuery, missionId: StableId<"mission"> | null,
  observedAt: string, sourcePin: string, fields: readonly string[]): ScopedEvidenceReference {
  return Object.freeze({ source, ...query, missionId, observedAt, pin: sourcePin, fields: Object.freeze([...fields]) });
}
function attentionPin(queue: AttentionQueue): string { return `${queue.asOf}:${queue.afterItemId ?? "start"}:${queue.nextCursor ?? "end"}`; }
function pin(value: unknown): string { if (typeof value !== "string" || !value || value.length > 512) throw new TypeError("bounded source pin required"); return value; }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> { const row = expectRecord(value, "request brief data"); expectOnlyKeys(row, keys, "request brief data"); if (keys.some(key => !Object.hasOwn(row, key))) throw new TypeError("complete request brief data required"); return row; }
function freeze<T>(value: T): T { if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
