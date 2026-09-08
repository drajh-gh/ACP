import { performance } from "node:perf_hooks";
import { readRequestBrief, type RequestBriefReaders } from "../../src/request-brief-reader.ts";
import { recoveryExpectedFacts as expected, recoveryHistory, recoveryIds, recoveryReaders } from "../fixtures/request-brief-recovery.ts";

const encoder = new TextEncoder();
type Candidate = Record<string, unknown>;
const factIds = ["original_wording", "exact_ids", "decisive_detail", "missing_observation", "stale_observation", "source_change",
  "unavailable_records", "next_action", "authority_limits", "overflow"] as const;

function facts(candidate: Candidate): Set<string> {
  const text = JSON.stringify(candidate);
  const found = new Set<string>();
  if (text.includes(expected.originalWording)) found.add("original_wording");
  if ([expected.exactRequestId, ...expected.exactMissionIds].every(id => text.includes(id))) found.add("exact_ids");
  if (text.includes(expected.decisiveDetail)) found.add("decisive_detail");
  if (text.includes("missing_mission_status") && text.includes("missing_attention")) found.add("missing_observation");
  if (text.includes(expected.staleObservation) && text.includes('"freshness":"unknown"')) found.add("stale_observation");
  if (text.includes('"source":"mission_status"') && text.includes("source_changed_during_assembly")) found.add("source_change");
  if (expected.unavailable.every(value => text.includes(value))) found.add("unavailable_records");
  if (text.includes('"supportedNextAction":"unavailable"')) found.add("next_action");
  if (text.includes('"authority":"not_granted"')) found.add("authority_limits");
  if (text.includes('"nextCursor"') && text.includes(recoveryIds.overflowCursor)) found.add("overflow");
  return found;
}

function score(candidate: Candidate) { const found = facts(candidate); return factIds.filter(id => !found.has(id)); }
function bytes(value: unknown) { return encoder.encode(JSON.stringify(value)).byteLength; }

function instrument(source: RequestBriefReaders) {
  let readerCalls = 0, returnedUtf8Bytes = 0;
  const wrap = <A extends unknown[]>(read: (...args: A) => Promise<unknown>) => async (...args: A) => {
    readerCalls += 1; const value = await read(...args); returnedUtf8Bytes += value === undefined ? 0 : bytes(value); return value;
  };
  return { readers: { getRequestHistory: wrap(source.getRequestHistory.bind(source)),
    getMissionStatus: wrap(source.getMissionStatus.bind(source)), getAttentionQueue: wrap(source.getAttentionQueue.bind(source)) },
    metrics: () => ({ readerCalls, returnedUtf8Bytes }) };
}

export async function runSyntheticRecoveryExercise() {
  const historyStart = performance.now(); const history = recoveryHistory(); const historyLatency = performance.now() - historyStart;
  const measured = instrument(recoveryReaders()); const briefStart = performance.now();
  const brief = await readRequestBrief(measured.readers, { projectId: recoveryIds.projectId, requestId: recoveryIds.requestId },
    { now: (() => { const samples = ["2026-09-08T10:59:00.000001Z", "2026-09-08T12:00:00.000001Z"]; let i = 0;
      return () => samples[Math.min(i++, 1)]!; })() });
  if (!brief) throw new Error("synthetic retained history unexpectedly unavailable");
  const briefLatency = performance.now() - briefStart;
  const altered = structuredClone(brief) as unknown as Candidate;
  (altered.originalRequest as Record<string, unknown>).summary = "Altered wording";
  const noAttention = structuredClone(brief) as unknown as Candidate;
  ((noAttention.missions as Candidate[])[0]!.attention as Candidate).items = [];
  const noChange = structuredClone(brief) as unknown as Candidate; noChange.sourceChanges = []; noChange.issues = (noChange.issues as string[]).filter(x => x !== "source_changed_during_assembly");
  return { label: "synthetic_offline_exercise_not_fresh_reader_acceptance",
    historyOnly: { missingFactIds: score(history), readerCalls: 1, returnedUtf8Bytes: bytes(history), harnessLatencyMs: historyLatency },
    brief: { missingFactIds: score(brief as unknown as Candidate), ...measured.metrics(), harnessLatencyMs: briefLatency },
    negativeControls: [
      { name: "alter_original_wording", detectedMissingFactIds: score(altered).filter(x => x === "original_wording") },
      { name: "drop_decisive_attention", detectedMissingFactIds: score(noAttention).filter(x => x === "decisive_detail") },
      { name: "drop_source_change", detectedMissingFactIds: score(noChange).filter(x => x === "source_change") },
    ], unavailableMeasurements: ["model_usage", "coordinator_usage", "worker_usage", "retry_usage", "escalation_usage",
      "human_recovery_time", "fresh_worker_performance", "accepted_product_outcomes"] };
}
