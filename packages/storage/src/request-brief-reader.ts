import {
  assembleRequestBrief,
  canonicalJsonDigest,
  parseAttentionQueue,
  parseCanonicalTimestamp,
  parseRequestHistory,
  parseRequestHistoryQuery,
  requestBriefMissionLimit,
  snapshotJsonData,
  type AttentionQueue,
  type AttentionQueueQuery,
  type JsonValue,
  type RequestBrief,
  type RequestHistory,
  type RequestHistoryQuery,
  type StableId,
} from "@acp/domain";
import { parseCounterpartMissionStatus, type CounterpartMissionStatus } from "./counterpart-status.ts";

export const requestBriefAttentionPageSize = 20;
export const requestBriefMaximumReaderCalls = 2 + (requestBriefMissionLimit * 4);

/** The deliberately narrow private read boundary used by request-brief assembly. */
export interface RequestBriefReaders {
  getRequestHistory(query: RequestHistoryQuery): Promise<unknown | undefined>;
  getMissionStatus(missionId: StableId<"mission">): Promise<unknown | undefined>;
  getAttentionQueue(query: AttentionQueueQuery): Promise<unknown | undefined>;
}

/** Acquires independent recorded snapshots sequentially. The result does not
 * claim transaction-wide atomicity or current freshness. Optional absent reads
 * remain unavailable; malformed, substituted, or failed reads fail closed. */
export async function readRequestBrief(
  readers: RequestBriefReaders,
  queryValue: unknown,
  assembledAt: string,
): Promise<RequestBrief | undefined> {
  // Validate the complete selector and clock before the first reader call.
  const query = parseRequestHistoryQuery(queryValue);
  const parsedAssembledAt = parseCanonicalTimestamp(assembledAt);

  const firstHistoryValue = await read(readers.getRequestHistory(query), "history");
  if (firstHistoryValue === undefined) return undefined;
  const history = parseHistory(query, firstHistoryValue);
  if (history.missionAssociations.length > requestBriefMissionLimit) {
    throw new Error("Request brief history exceeds the bounded mission limit.");
  }

  const missionObservations = [];
  const attention = [];
  for (const association of history.missionAssociations) {
    const missionId = association.missionId;
    const firstStatusValue = await read(readers.getMissionStatus(missionId), "mission status");
    if (firstStatusValue !== undefined) {
      const firstStatus = parseStatus(firstStatusValue, query, missionId);
      const firstPin = semanticPin(firstStatus, "asOf");
      const secondStatusValue = await read(readers.getMissionStatus(missionId), "mission status");
      if (secondStatusValue === undefined) throw unavailable("mission status");
      const secondStatus = parseStatus(secondStatusValue, query, missionId);
      missionObservations.push({
        projectId: query.projectId,
        missionId,
        state: firstStatus.state,
        observedAt: firstStatus.asOf,
        freshness: "unknown" as const,
        pinBefore: firstPin,
        pinAfter: semanticPin(secondStatus, "asOf"),
        sourceReference: {
          read: "get_mission_status" as const,
          selectors: { missionId },
          observedAt: firstStatus.asOf,
          pin: firstPin,
          fields: ["state", "assessment"] as const,
        },
      });
    }

    const attentionQuery = { projectId: query.projectId, missionId, limit: requestBriefAttentionPageSize };
    const firstAttentionValue = await read(readers.getAttentionQueue(attentionQuery), "attention");
    if (firstAttentionValue !== undefined) {
      const firstAttention = parseAttention(attentionQuery, firstAttentionValue);
      const firstPin = semanticPin(firstAttention, "asOf");
      const secondAttentionValue = await read(readers.getAttentionQueue(attentionQuery), "attention");
      if (secondAttentionValue === undefined) throw unavailable("attention");
      const secondAttention = parseAttention(attentionQuery, secondAttentionValue);
      attention.push({ queue: firstAttention, pinBefore: firstPin, pinAfter: semanticPin(secondAttention, "asOf") });
    }
  }

  const secondHistoryValue = await read(readers.getRequestHistory(query), "history");
  if (secondHistoryValue === undefined) throw unavailable("history");
  const secondHistory = parseHistory(query, secondHistoryValue);
  return assembleRequestBrief({
    query,
    assembledAt: parsedAssembledAt,
    history,
    historyPinBefore: semanticPin(history, "asOf"),
    historyPinAfter: semanticPin(secondHistory, "asOf"),
    missionObservations,
    attention,
  });
}

async function read<T>(pending: Promise<T>, source: string): Promise<T> {
  try { return await pending; }
  catch { throw unavailable(source); }
}

function unavailable(source: string): Error {
  return new Error(`Request brief ${source} source is unavailable.`);
}

function invalid(source: string): Error {
  return new Error(`Request brief ${source} source is invalid or outside the requested scope.`);
}

function parseHistory(query: RequestHistoryQuery, value: unknown): RequestHistory {
  try { return parseRequestHistory(query, value); } catch { throw invalid("history"); }
}

function parseStatus(value: unknown, query: RequestHistoryQuery, missionId: StableId<"mission">): CounterpartMissionStatus {
  try {
    const status = parseCounterpartMissionStatus(value);
    if (status.projectId !== query.projectId || status.missionId !== missionId) throw new TypeError("scope mismatch");
    return status;
  } catch { throw invalid("mission status"); }
}

function parseAttention(query: AttentionQueueQuery, value: unknown): AttentionQueue {
  try { return parseAttentionQueue(query, value); } catch { throw invalid("attention"); }
}

function semanticPin(value: object, volatileKey: string): string {
  const detached = snapshotJsonData(value, { maximumBytes: 65_536 }) as Record<string, JsonValue>;
  const { [volatileKey]: _volatile, ...semantic } = detached;
  return canonicalJsonDigest(semantic as JsonValue);
}
