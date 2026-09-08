import {
  assembleRequestBrief,
  canonicalJsonDigest,
  parseAttentionQueue,
  parseCanonicalTimestamp,
  parseRequestHistory,
  parseRequestHistoryQuery,
  requestBriefMissionLimit,
  snapshotJsonData,
  timestampMicroseconds,
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
export const requestBriefMaximumReaderCalls = 3 + (requestBriefMissionLimit * 4);
/** Stops this sequential assembler from starting additional pool acquisitions.
 * An already-started reader is still awaited and retains its own database limits. */
export const requestBriefAcquisitionBudgetMilliseconds = 4_000;

/** The deliberately narrow private read boundary used by request-brief assembly. */
export interface RequestBriefReaders {
  getRequestHistory(query: RequestHistoryQuery): Promise<unknown | undefined>;
  getMissionStatus(missionId: StableId<"mission">): Promise<unknown | undefined>;
  getAttentionQueue(query: AttentionQueueQuery): Promise<unknown | undefined>;
  /** Same-database clock sampled only after all retained source reads. */
  getRequestBriefCompletionTimestamp(): Promise<unknown>;
}

export interface RequestBriefClock {
  monotonicMilliseconds(): number;
}

/** Acquires independent recorded snapshots sequentially. The result does not
 * claim transaction-wide atomicity or current freshness. Optional absent reads
 * remain unavailable; malformed, substituted, or failed reads fail closed.
 * Readers own in-flight cancellation and timeouts; this seam checks cancellation
 * between and after calls and awaits every bounded call. */
export async function readRequestBrief(
  readers: RequestBriefReaders,
  queryValue: unknown,
  clock: RequestBriefClock,
  signal?: AbortSignal,
): Promise<RequestBrief | undefined> {
  // Validate the complete selector and acquisition clock before reader I/O.
  const query = parseRequestHistoryQuery(queryValue);
  const acquisitionStartedAt = sampleMonotonicClock(clock);
  const readWithinBudget = <T>(operation: () => Promise<T>, source: string) => {
    assertCanLaunch(clock, acquisitionStartedAt, signal);
    return read(operation, source);
  };

  const firstHistoryValue = await readWithinBudget(() => readers.getRequestHistory(query), "history");
  if (firstHistoryValue === undefined) {
    assertCanReturn(clock, acquisitionStartedAt, signal);
    return undefined;
  }
  const history = parseHistory(query, firstHistoryValue);
  if (history.missionAssociations.length > requestBriefMissionLimit) {
    throw new Error("Request brief history exceeds the bounded mission limit.");
  }

  const missionObservations = [];
  const attention = [];
  for (const association of history.missionAssociations) {
    const missionId = association.missionId;
    const firstStatusValue = await readWithinBudget(() => readers.getMissionStatus(missionId), "mission status");
    if (firstStatusValue !== undefined) {
      const firstStatus = parseStatus(firstStatusValue, query, missionId);
      const firstPin = semanticPin(firstStatus, "asOf");
      const secondStatusValue = await readWithinBudget(() => readers.getMissionStatus(missionId), "mission status");
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
        secondObservedAt: secondStatus.asOf,
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
    const firstAttentionValue = await readWithinBudget(() => readers.getAttentionQueue(attentionQuery), "attention");
    if (firstAttentionValue !== undefined) {
      const firstAttention = parseAttention(attentionQuery, firstAttentionValue);
      const firstPin = semanticPin(firstAttention, "asOf");
      const secondAttentionValue = await readWithinBudget(() => readers.getAttentionQueue(attentionQuery), "attention");
      if (secondAttentionValue === undefined) throw unavailable("attention");
      const secondAttention = parseAttention(attentionQuery, secondAttentionValue);
      attention.push({ queue: firstAttention, pinBefore: firstPin, pinAfter: semanticPin(secondAttention, "asOf"),
        secondObservedAt: secondAttention.asOf });
    }
  }

  const secondHistoryValue = await readWithinBudget(() => readers.getRequestHistory(query), "history");
  if (secondHistoryValue === undefined) throw unavailable("history");
  const secondHistory = parseHistory(query, secondHistoryValue);
  assertCanReturn(clock, acquisitionStartedAt, signal);
  const completionValue = await readWithinBudget(() => readers.getRequestBriefCompletionTimestamp(), "completion clock");
  const assembledAt = parseCompletionTimestamp(completionValue);
  assertCanReturn(clock, acquisitionStartedAt, signal);
  for (const [source, observedAt] of [
    ["history", history.asOf], ["history", secondHistory.asOf],
    ...missionObservations.flatMap(item => [["mission status", item.observedAt], ["mission status", item.secondObservedAt]]),
    ...attention.flatMap(item => [["attention", item.queue.asOf], ["attention", item.secondObservedAt]]),
  ] as const) assertObservedBy(source, observedAt, assembledAt);
  return assembleRequestBrief({
    query,
    assembledAt,
    history,
    historyPinBefore: semanticPin(history, "asOf"),
    historyPinAfter: semanticPin(secondHistory, "asOf"),
    missionObservations: missionObservations.map(({ secondObservedAt: _second, ...item }) => item),
    attention: attention.map(({ secondObservedAt: _second, ...item }) => item),
  });
}

async function read<T>(operation: () => Promise<T>, source: string): Promise<T> {
  try { return await operation(); }
  catch { throw unavailable(source); }
}

function sampleMonotonicClock(clock: RequestBriefClock): number {
  try {
    const value = clock.monotonicMilliseconds();
    if (!Number.isFinite(value)) throw new TypeError("finite clock required");
    return value;
  } catch { throw new Error("Request brief acquisition clock is unavailable or invalid."); }
}

function assertCanLaunch(clock: RequestBriefClock, startedAt: number, signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Request brief acquisition was cancelled.");
  const elapsed = sampleMonotonicClock(clock) - startedAt;
  if (elapsed < 0) throw new Error("Request brief acquisition clock moved backwards.");
  if (elapsed >= requestBriefAcquisitionBudgetMilliseconds) {
    throw new Error("Request brief acquisition budget expired.");
  }
}

function assertCanReturn(clock: RequestBriefClock, startedAt: number, signal: AbortSignal | undefined): void {
  assertCanLaunch(clock, startedAt, signal);
}

function parseCompletionTimestamp(value: unknown): string {
  try { return parseCanonicalTimestamp(value); }
  catch { throw new Error("Request brief completion clock source is invalid."); }
}

function assertObservedBy(source: string, observedAt: string, assembledAt: string): void {
  if (timestampMicroseconds(observedAt) > timestampMicroseconds(assembledAt)) {
    throw new Error(`Request brief ${source} source observation is later than the completion clock.`);
  }
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
