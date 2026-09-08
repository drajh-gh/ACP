import {
  parseAttentionQueue,
  type AttentionQueue,
  type AttentionQueueQuery,
  type RecordedAttentionItem,
} from "./attention.ts";
import { parseStableId, type StableId } from "./ids.ts";
import { missionStates, type MissionState } from "./lifecycle.ts";
import {
  parseRequestHistory,
  type RecordedRequestAssociation,
  type RequestHistory,
  type RequestHistoryQuery,
} from "./request-history.ts";
import { snapshotJsonData } from "./json-snapshot.ts";
import { canonicalJsonDigest } from "./effects.ts";
import type { JsonValue } from "./validation.ts";
import {
  expectArray,
  expectEnum,
  expectOnlyKeys,
  expectRecord,
  parseCanonicalTimestamp,
  timestampMicroseconds,
} from "./validation.ts";

export const requestBriefSchemaVersion = "1.0.0";
export const requestBriefMaximumBytes = 65_536;
export const requestBriefSourceMaximumBytes = 196_608;
export const requestBriefMissionLimit = 50;

export type RequestBriefIssue =
  | "missing_mission_status"
  | "missing_attention"
  | "stale_mission_status"
  | "source_changed_during_assembly";

export interface RequestBriefSourceChange {
  readonly source: "request_history" | "mission_status" | "attention";
  readonly missionId: StableId<"mission"> | null;
  readonly pinBefore: string;
  readonly pinAfter: string;
}

export type ScopedEvidenceReference =
  | Readonly<{
      read: "get_request_history";
      selectors: RequestHistoryQuery;
      observedAt: string;
      pin: string;
      fields: readonly ["request", "recordedAt", "missionAssociations", "coverage", "freshness", "authority"];
    }>
  | Readonly<{
      read: "get_mission_status";
      selectors: Readonly<{ missionId: StableId<"mission"> }>;
      observedAt: string;
      pin: string;
      fields: readonly ["state", "assessment"];
    }>
  | Readonly<{
      read: "get_mission_attention";
      selectors: AttentionQueueQuery;
      observedAt: string;
      pin: string;
      fields: readonly ["items", "nextCursor", "coverage", "freshness", "authority"];
    }>;

export interface MissionBriefObservation {
  readonly projectId: StableId<"project">;
  readonly missionId: StableId<"mission">;
  readonly state: MissionState;
  readonly observedAt: string;
  readonly freshness: "current" | "stale" | "unknown";
  readonly pinBefore: string;
  readonly pinAfter: string;
  readonly sourceReference: Extract<ScopedEvidenceReference, { read: "get_mission_status" }>;
}

export type RequestBriefAttention =
  | Readonly<{ availability: "unavailable" }>
  | Readonly<{
      availability: "observed";
      query: AttentionQueueQuery;
      asOf: string;
      coverage: AttentionQueue["coverage"];
      freshness: AttentionQueue["freshness"];
      authority: AttentionQueue["authority"];
      items: readonly RecordedAttentionItem[];
      nextCursor: StableId<"attentionItem"> | null;
      sourceReference: Extract<ScopedEvidenceReference, { read: "get_mission_attention" }>;
    }>;

export interface RequestBriefMission {
  readonly association: RecordedRequestAssociation;
  readonly observation: null | Readonly<{
    state: MissionState;
    observedAt: string;
    freshness: MissionBriefObservation["freshness"];
    sourceReference: Extract<ScopedEvidenceReference, { read: "get_mission_status" }>;
  }>;
  readonly attention: RequestBriefAttention;
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
  readonly coverage: Readonly<{
    history: "recorded_associations_only";
    missionStatus: "selected_observations_only";
    attention: "selected_recorded_pages_only";
  }>;
  readonly freshness: "not_assessed";
  readonly issues: readonly RequestBriefIssue[];
  readonly sourceChanges: readonly RequestBriefSourceChange[];
  readonly overflow: "none";
  readonly unavailable: readonly ["destination_decisions", "obligations", "communications"];
  readonly supportedNextAction: "unavailable";
  readonly authority: "not_granted";
}

export interface RequestBriefSources {
  readonly query: RequestHistoryQuery;
  readonly assembledAt: string;
  readonly history: RequestHistory;
  readonly historyPinBefore: string;
  readonly historyPinAfter: string;
  readonly missionObservations: readonly MissionBriefObservation[];
  readonly attention: readonly AttentionBriefSource[];
}

export interface AttentionBriefSource {
  readonly queue: AttentionQueue;
  readonly pinBefore: string;
  readonly pinAfter: string;
}

/** Builds a bounded derivative projection over already-read records. Oversized
 * inputs are refused whole; the result grants no operational authority. */
export function assembleRequestBrief(value: unknown): RequestBrief {
  const sources = parseSources(value);
  const associatedMissionIds = new Set(sources.history.missionAssociations.map(item => item.missionId));
  const observations = uniqueMissionMap(sources.missionObservations, associatedMissionIds, "mission status", item => item.missionId);
  const attention = uniqueMissionMap(sources.attention, associatedMissionIds, "attention", item => item.queue.missionId);
  const issues = new Set<RequestBriefIssue>();
  const sourceChanges: RequestBriefSourceChange[] = [];
  const evidence: ScopedEvidenceReference[] = [historyReference(sources)];

  if (sources.historyPinBefore !== sources.historyPinAfter) {
    issues.add("source_changed_during_assembly");
    sourceChanges.push({ source: "request_history", missionId: null,
      pinBefore: sources.historyPinBefore, pinAfter: sources.historyPinAfter });
  }

  const missions = sources.history.missionAssociations.map(association => {
    const observation = observations.get(association.missionId);
    const attentionSource = attention.get(association.missionId);

    if (!observation) issues.add("missing_mission_status");
    else {
      evidence.push(observation.sourceReference);
      if (observation.freshness === "stale") issues.add("stale_mission_status");
      if (observation.pinBefore !== observation.pinAfter) {
        issues.add("source_changed_during_assembly");
        sourceChanges.push({ source: "mission_status", missionId: association.missionId,
          pinBefore: observation.pinBefore, pinAfter: observation.pinAfter });
      }
    }

    if (!attentionSource) issues.add("missing_attention");
    else if (attentionSource.pinBefore !== attentionSource.pinAfter) {
      issues.add("source_changed_during_assembly");
      sourceChanges.push({ source: "attention", missionId: association.missionId,
        pinBefore: attentionSource.pinBefore, pinAfter: attentionSource.pinAfter });
    }
    const attentionProjection = attentionSource
      ? observedAttention(sources.query, attentionSource, evidence)
      : unavailableAttention();

    return Object.freeze({
      association,
      observation: observation ? Object.freeze({
        state: observation.state,
        observedAt: observation.observedAt,
        freshness: observation.freshness,
        sourceReference: observation.sourceReference,
      }) : null,
      attention: attentionProjection,
    });
  });

  const output: RequestBrief = {
    schemaVersion: requestBriefSchemaVersion,
    projectId: sources.query.projectId,
    requestId: sources.query.requestId,
    originalRequest: sources.history.request,
    recordedAt: sources.history.recordedAt,
    assembledAt: sources.assembledAt,
    missions: Object.freeze(missions),
    evidence: Object.freeze(evidence),
    coverage: Object.freeze({
      history: "recorded_associations_only",
      missionStatus: "selected_observations_only",
      attention: "selected_recorded_pages_only",
    }),
    freshness: "not_assessed",
    issues: Object.freeze([...issues].sort()),
    sourceChanges: Object.freeze(sourceChanges),
    overflow: "none",
    unavailable: Object.freeze(["destination_decisions", "obligations", "communications"]),
    supportedNextAction: "unavailable",
    authority: "not_granted",
  };
  snapshotJsonData(output, { maximumBytes: requestBriefMaximumBytes });
  return freeze(output);
}

/** Validates a previously assembled private brief against its exact selector.
 * Pins are treated as opaque source identities; this boundary proves only the
 * shape and internal consistency of the supplied projection. */
export function parseRequestBrief(queryValue: unknown, value: unknown): RequestBrief {
  const query = parseQuery(snapshotJsonData(queryValue, { maximumBytes: 1024 }));
  const input = exact(snapshotJsonData(value, { maximumBytes: requestBriefMaximumBytes }), [
    "schemaVersion", "projectId", "requestId", "originalRequest", "recordedAt", "assembledAt", "missions",
    "evidence", "coverage", "freshness", "issues", "sourceChanges", "overflow", "unavailable",
    "supportedNextAction", "authority",
  ]);
  if (input.projectId !== query.projectId || input.requestId !== query.requestId) {
    throw new TypeError("request brief scope mismatch");
  }
  const missions = expectArray(input.missions, "request brief missions");
  if (missions.length > requestBriefMissionLimit) throw new TypeError("request brief association overflow requires whole-result refusal");
  const evidence = expectArray(input.evidence, "request brief evidence");
  const changes = expectArray(input.sourceChanges, "request brief source changes");
  const changeMap = new Map<string, string>();
  for (const value of changes) {
    const row = exact(value, ["source", "missionId", "pinBefore", "pinAfter"]);
    const source = expectEnum(row.source, ["request_history", "mission_status", "attention"], "request brief source change");
    const missionId = row.missionId === null ? null : parseStableId(row.missionId, "mission");
    if ((source === "request_history") !== (missionId === null)) throw new TypeError("request brief source change scope mismatch");
    const before = pin(row.pinBefore), after = pin(row.pinAfter), key = `${source}:${missionId ?? ""}`;
    if (before === after || changeMap.has(key)) throw new TypeError("unique actual request brief source changes required");
    changeMap.set(key, after);
  }
  const historyRef = evidence[0] as Record<string, unknown> | undefined;
  const historyPin = referencePin(historyRef, "get_request_history");
  const historyAfter = changedPin(changeMap, "request_history", null, historyPin);
  const missionObservations: unknown[] = [], attention: unknown[] = [];
  const associations: unknown[] = [];
  for (const value of missions) {
    const row = exact(value, ["association", "observation", "attention"]);
    const association = exact(row.association, ["missionId", "reason", "recordedAt"]);
    const missionId = parseStableId(association.missionId, "mission");
    associations.push(association);
    if (row.observation !== null) {
      const observation = exact(row.observation, ["state", "observedAt", "freshness", "sourceReference"]);
      const before = referencePin(observation.sourceReference, "get_mission_status");
      missionObservations.push({ projectId: query.projectId, missionId, ...observation, pinBefore: before,
        pinAfter: changedPin(changeMap, "mission_status", missionId, before) });
    }
    const attentionRow = expectRecord(row.attention, "request brief attention");
    if (attentionRow.availability === "unavailable") exact(attentionRow, ["availability"]);
    else {
      const observed = exact(attentionRow, ["availability", "query", "asOf", "coverage", "freshness", "authority", "items", "nextCursor", "sourceReference"]);
      if (observed.availability !== "observed") throw new TypeError("request brief attention availability required");
      const selector = exact(observed.query, Object.hasOwn(expectRecord(observed.query, "attention query"), "afterItemId")
        ? ["projectId", "missionId", "afterItemId", "limit"] : ["projectId", "missionId", "limit"]);
      const before = referencePin(observed.sourceReference, "get_mission_attention");
      attention.push({ queue: { schemaVersion: "1.0.0", projectId: selector.projectId, missionId: selector.missionId,
        afterItemId: Object.hasOwn(selector, "afterItemId") ? selector.afterItemId : null, limit: selector.limit,
        asOf: observed.asOf, coverage: observed.coverage, freshness: observed.freshness, authority: observed.authority,
        items: observed.items, nextCursor: observed.nextCursor }, pinBefore: before,
        pinAfter: changedPin(changeMap, "attention", missionId, before) });
    }
  }
  if (changeMap.size !== 0) throw new TypeError("request brief source change has no matching source");
  const original = expectRecord(input.originalRequest, "request brief original request");
  const assembled = assembleRequestBrief({ query, assembledAt: input.assembledAt,
    history: { schemaVersion: "1.0.0", asOf: historyRef?.observedAt, request: original, recordedAt: input.recordedAt,
      missionAssociations: associations, coverage: "recorded_associations_only", freshness: "not_assessed", authority: "not_granted" },
    historyPinBefore: historyPin, historyPinAfter: historyAfter, missionObservations, attention });
  if (canonicalJsonDigest(input as JsonValue) !== canonicalJsonDigest(assembled as unknown as JsonValue)) {
    throw new TypeError("request brief conflicts with its canonical assembled projection");
  }
  return assembled;
}

function referencePin(value: unknown, read: ScopedEvidenceReference["read"]): string {
  const row = expectRecord(value, "request brief evidence reference");
  if (row.read !== read) throw new TypeError("request brief evidence reference mismatch");
  return pin(row.pin);
}

function changedPin(changes: Map<string, string>, source: RequestBriefSourceChange["source"], missionId: StableId<"mission"> | null, before: string): string {
  const key = `${source}:${missionId ?? ""}`, after = changes.get(key);
  if (after === undefined) return before;
  changes.delete(key);
  return after;
}

function parseSources(value: unknown): RequestBriefSources {
  const detached = snapshotJsonData(value, { maximumBytes: requestBriefSourceMaximumBytes });
  const input = exact(detached, [
    "query", "assembledAt", "history", "historyPinBefore", "historyPinAfter", "missionObservations", "attention",
  ]);
  const query = parseQuery(input.query);
  const assembledAt = parseCanonicalTimestamp(input.assembledAt);
  const history = parseRequestHistory(query, input.history);
  assertNotFuture(history.asOf, assembledAt, "request history");
  if (history.missionAssociations.length > requestBriefMissionLimit) {
    throw new TypeError("request brief association overflow requires whole-result refusal");
  }

  const missionObservations = expectArray(input.missionObservations, "mission observations")
    .map(item => parseMissionObservation(item, query, assembledAt));
  const attention = expectArray(input.attention, "attention observations")
    .map(item => parseAttentionObservation(item, query, assembledAt));

  return {
    query,
    assembledAt,
    history,
    historyPinBefore: pin(input.historyPinBefore),
    historyPinAfter: pin(input.historyPinAfter),
    missionObservations,
    attention,
  };
}

function parseMissionObservation(
  value: unknown,
  query: RequestHistoryQuery,
  assembledAt: string,
): MissionBriefObservation {
  const row = exact(value, [
    "projectId", "missionId", "state", "observedAt", "freshness", "pinBefore", "pinAfter", "sourceReference",
  ]);
  const projectId = parseStableId(row.projectId, "project");
  const missionId = parseStableId(row.missionId, "mission");
  if (projectId !== query.projectId) throw new TypeError("mission observation project mismatch");
  const observedAt = parseCanonicalTimestamp(row.observedAt);
  const pinBefore = pin(row.pinBefore);
  const sourceReference = parseMissionStatusReference(row.sourceReference, missionId, observedAt, pinBefore);
  assertNotFuture(observedAt, assembledAt, "mission observation");
  return {
    projectId,
    missionId,
    state: expectEnum(row.state, missionStates, "mission state"),
    observedAt,
    freshness: expectEnum(row.freshness, ["current", "stale", "unknown"], "mission freshness"),
    pinBefore,
    pinAfter: pin(row.pinAfter),
    sourceReference,
  };
}

function parseAttentionObservation(value: unknown, query: RequestHistoryQuery, assembledAt: string): AttentionBriefSource {
  const source = exact(value, ["queue", "pinBefore", "pinAfter"]);
  const row = expectRecord(source.queue, "attention observation");
  const missionId = parseStableId(row.missionId, "mission");
  const selector = {
    projectId: query.projectId,
    missionId,
    ...(row.afterItemId === null ? {} : { afterItemId: row.afterItemId }),
    limit: row.limit,
  };
  const queue = parseAttentionQueue(selector, source.queue);
  assertNotFuture(queue.asOf, assembledAt, "attention observation");
  return { queue, pinBefore: pin(source.pinBefore), pinAfter: pin(source.pinAfter) };
}

function parseMissionStatusReference(
  value: unknown,
  missionId: StableId<"mission">,
  observedAt: string,
  sourcePin: string,
): Extract<ScopedEvidenceReference, { read: "get_mission_status" }> {
  const row = exact(value, ["read", "selectors", "observedAt", "pin", "fields"]);
  const selectors = exact(row.selectors, ["missionId"]);
  const fields = expectArray(row.fields, "mission status reference fields");
  if (row.read !== "get_mission_status"
    || parseStableId(selectors.missionId, "mission") !== missionId
    || parseCanonicalTimestamp(row.observedAt) !== observedAt
    || pin(row.pin) !== sourcePin
    || fields.length !== 2
    || fields[0] !== "state"
    || fields[1] !== "assessment") {
    throw new TypeError("mission status reference must bind the primary observation pin and time");
  }
  return freeze({ read: "get_mission_status", selectors: { missionId }, observedAt, pin: sourcePin, fields: ["state", "assessment"] });
}

function observedAttention(
  query: RequestHistoryQuery,
  source: AttentionBriefSource,
  evidence: ScopedEvidenceReference[],
): Extract<RequestBriefAttention, { availability: "observed" }> {
  const queue = source.queue;
  const selectors = freeze({
    projectId: query.projectId,
    missionId: queue.missionId!,
    ...(queue.afterItemId === null ? {} : { afterItemId: queue.afterItemId }),
    limit: queue.limit,
  });
  const sourceReference = freeze({
    read: "get_mission_attention" as const,
    selectors,
    observedAt: queue.asOf,
    pin: source.pinBefore,
    fields: ["items", "nextCursor", "coverage", "freshness", "authority"] as const,
  });
  evidence.push(sourceReference);
  return freeze({
    availability: "observed",
    query: selectors,
    asOf: queue.asOf,
    coverage: queue.coverage,
    freshness: queue.freshness,
    authority: queue.authority,
    items: queue.items,
    nextCursor: queue.nextCursor,
    sourceReference,
  });
}

function historyReference(sources: RequestBriefSources): Extract<ScopedEvidenceReference, { read: "get_request_history" }> {
  return freeze({
    read: "get_request_history",
    selectors: sources.query,
    observedAt: sources.history.asOf,
    pin: sources.historyPinBefore,
    fields: ["request", "recordedAt", "missionAssociations", "coverage", "freshness", "authority"],
  });
}

function unavailableAttention(): Extract<RequestBriefAttention, { availability: "unavailable" }> {
  return Object.freeze({ availability: "unavailable" });
}

function uniqueMissionMap<T>(
  values: readonly T[],
  associatedMissionIds: ReadonlySet<StableId<"mission">>,
  label: string,
  missionIdOf: (value: T) => StableId<"mission"> | null,
): Map<StableId<"mission">, T> {
  const result = new Map<StableId<"mission">, T>();
  for (const value of values) {
    const missionId = missionIdOf(value);
    if (missionId === null || !associatedMissionIds.has(missionId) || result.has(missionId)) {
      throw new TypeError(`${label} observations must match distinct request missions`);
    }
    result.set(missionId, value);
  }
  return result;
}

function parseQuery(value: unknown): RequestHistoryQuery {
  const row = exact(value, ["projectId", "requestId"]);
  return freeze({
    projectId: parseStableId(row.projectId, "project"),
    requestId: parseStableId(row.requestId, "request"),
  });
}

function assertNotFuture(observedAt: string, assembledAt: string, label: string): void {
  if (timestampMicroseconds(observedAt) > timestampMicroseconds(assembledAt)) {
    throw new TypeError(`${label} cannot be later than request brief assembly`);
  }
}

function pin(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 512) throw new TypeError("bounded source pin required");
  return value;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = expectRecord(value, "request brief data");
  expectOnlyKeys(row, keys, "request brief data");
  if (keys.some(key => !Object.hasOwn(row, key))) throw new TypeError("complete request brief data required");
  return row;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
