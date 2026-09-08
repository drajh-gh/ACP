import { performance } from "node:perf_hooks";
import { type RequestBrief, type RequestHistory } from "@acp/domain";
import { readRequestBrief, type RequestBriefReaders } from "../../src/request-brief-reader.ts";
import { recoveryExpected as expected } from "../fixtures/request-brief-recovery-expected.ts";
import { recoveryHistory, recoveryQuery, recoveryReaders } from "../fixtures/request-brief-recovery.ts";

const encoder = new TextEncoder();
const factIds = ["exact_identity", "original_wording", "history_reference", "coverage", "observed_unassessed",
  "missing_observations", "actual_source_change", "decisive_evidence_gap", "overflow", "unavailable_records",
  "next_action", "authority_boundaries"] as const;
type FactId = typeof factIds[number];
type Mutable = Record<string, unknown>;

function sameArray(left: readonly unknown[], right: readonly unknown[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function historyFacts(history: RequestHistory): Set<FactId> {
  const found = new Set<FactId>();
  if (history.request.projectId === expected.projectId && history.request.requestId === expected.requestId
    && sameArray(history.missionAssociations.map(item => item.missionId), expected.missionIds)) found.add("exact_identity");
  if (history.request.summary === expected.originalWording) found.add("original_wording");
  if (history.coverage === "recorded_associations_only" && history.freshness === "not_assessed") found.add("coverage");
  if (history.authority === "not_granted") found.add("authority_boundaries");
  return found;
}

function briefFacts(brief: RequestBrief & Mutable): Set<FactId> {
  const found = new Set<FactId>();
  if (brief.projectId === expected.projectId && brief.requestId === expected.requestId
    && brief.originalRequest.projectId === expected.projectId && brief.originalRequest.requestId === expected.requestId
    && sameArray(brief.missions.map(item => item.association.missionId), expected.missionIds)) found.add("exact_identity");
  if (brief.originalRequest.summary === expected.originalWording) found.add("original_wording");
  const historyRef = brief.evidence[0];
  if (historyRef?.read === "get_request_history" && historyRef.selectors.projectId === expected.projectId
    && historyRef.selectors.requestId === expected.requestId && historyRef.observedAt === expected.observationAt
    && historyRef.pin.length > 0 && sameArray(historyRef.fields,
      ["request", "recordedAt", "missionAssociations", "coverage", "freshness", "authority"])) found.add("history_reference");
  const first = brief.missions[0], second = brief.missions[1];
  if (brief.coverage.history === "recorded_associations_only" && brief.coverage.missionStatus === "selected_observations_only"
    && brief.coverage.attention === "selected_recorded_pages_only" && first?.attention.availability === "observed"
    && first.attention.coverage === "recorded_items_only") found.add("coverage");
  if (first?.observation?.observedAt === expected.observationAt && first.observation.freshness === "unknown"
    && brief.freshness === "not_assessed") found.add("observed_unassessed");
  if (second?.observation === null && second.attention.availability === "unavailable"
    && brief.issues.includes("missing_mission_status") && brief.issues.includes("missing_attention")) found.add("missing_observations");
  const change = brief.sourceChanges.find(item => item.source === "mission_status" && item.missionId === expected.missionIds[0]);
  const missionRef = first?.observation?.sourceReference;
  if (change && change.pinBefore.length > 0 && change.pinAfter.length > 0 && change.pinBefore !== change.pinAfter
    && missionRef?.read === "get_mission_status" && missionRef.selectors.missionId === expected.missionIds[0]
    && missionRef.observedAt === expected.observationAt && missionRef.pin === change.pinBefore
    && sameArray(missionRef.fields, ["state", "assessment"]) && brief.issues.includes("source_changed_during_assembly")) {
    found.add("actual_source_change");
  }
  if (first?.attention.availability === "observed") {
    const gap = first.attention.items.find(entry => entry.item.explanation === expected.evidenceGap);
    const ref = first.attention.sourceReference;
    if (gap && gap.item.evidenceIds.length === 0 && gap.item.allowedResponses.includes("Record explicit evidence gap")
      && ref.read === "get_mission_attention" && ref.selectors.projectId === expected.projectId
      && ref.selectors.missionId === expected.missionIds[0] && ref.pin.length > 0
      && sameArray(ref.fields, ["items", "nextCursor", "coverage", "freshness", "authority"])) found.add("decisive_evidence_gap");
    if (first.attention.nextCursor === expected.overflowCursor && first.attention.query.limit === 20) found.add("overflow");
    if (first.attention.authority === "not_granted") found.add("authority_boundaries");
  }
  if (sameArray(brief.unavailable, expected.unavailable) && !("obligations" in brief)) found.add("unavailable_records");
  if (brief.supportedNextAction === "unavailable") found.add("next_action");
  if (brief.authority !== "not_granted") found.delete("authority_boundaries");
  return found;
}

function missing(found: Set<FactId>) { return factIds.filter(id => !found.has(id)); }
function bytes(value: unknown) { return encoder.encode(JSON.stringify(value)).byteLength; }
function instrument(source: RequestBriefReaders) {
  let sourceReaderCalls = 0, cumulativeSourceReturnedUtf8Bytes = 0;
  const wrap = <A extends unknown[]>(read: (...args: A) => Promise<unknown>) => async (...args: A) => {
    sourceReaderCalls += 1; const value = await read(...args);
    cumulativeSourceReturnedUtf8Bytes += value === undefined ? 0 : bytes(value); return value;
  };
  return { readers: { getRequestHistory: wrap(source.getRequestHistory.bind(source)),
    getMissionStatus: wrap(source.getMissionStatus.bind(source)), getAttentionQueue: wrap(source.getAttentionQueue.bind(source)) },
    metrics: () => ({ sourceReaderCalls, cumulativeSourceReturnedUtf8Bytes }) };
}

function control(name: string, mutate: (brief: Mutable) => void, brief: RequestBrief) {
  const changed = structuredClone(brief) as unknown as Mutable; mutate(changed);
  return { name, missingFactIds: missing(briefFacts(changed as RequestBrief & Mutable)) };
}

export async function runSyntheticRecoveryExercise() {
  const historySource = instrument(recoveryReaders()); const historyStart = performance.now();
  const historyValue = await historySource.readers.getRequestHistory(recoveryQuery); const historyLatency = performance.now() - historyStart;
  if (!historyValue) throw new Error("synthetic history unexpectedly unavailable");
  const history = historyValue as RequestHistory;
  const briefSource = instrument(recoveryReaders()); const briefStart = performance.now();
  const brief = await readRequestBrief(briefSource.readers, recoveryQuery, { now: (() => {
    const samples = ["2026-09-08T10:59:00.000001Z", "2026-09-08T12:00:00.000001Z"]; let index = 0;
    return () => samples[Math.min(index++, 1)]!; })() });
  if (!brief) throw new Error("synthetic retained history unexpectedly unavailable");
  const briefLatency = performance.now() - briefStart;
  return { label: "synthetic_offline_exercise_not_fresh_reader_acceptance",
    historyOnly: { missingFactIds: missing(historyFacts(history)), ...historySource.metrics(), resultUtf8Bytes: bytes(history), harnessLatencyMs: historyLatency },
    brief: { missingFactIds: missing(briefFacts(brief as RequestBrief & Mutable)), ...briefSource.metrics(), resultUtf8Bytes: bytes(brief), harnessLatencyMs: briefLatency },
    negativeControls: [
      control("wrong_path_decoy", value => { const original = value.originalRequest as Mutable; original.summary = "altered"; value.decoy = expected.originalWording; }, brief),
      control("contradictory_authority", value => { value.authority = "granted"; }, brief),
      control("altered_source_pin", value => { (((value.missions as Mutable[])[0]!.observation as Mutable).sourceReference as Mutable).pin = "wrong-pin"; }, brief),
      control("altered_coverage", value => { (value.coverage as Mutable).history = "complete"; }, brief),
      control("drop_decisive_gap", value => { ((((value.missions as Mutable[])[0]!.attention as Mutable).items as Mutable[])[0]!.item as Mutable).explanation = "Review attachment"; }, brief),
      control("misleading_empty_obligations", value => { value.unavailable = ["destination_decisions", "communications"]; value.obligations = []; }, brief),
    ], unavailableMeasurements: ["model_usage", "coordinator_usage", "worker_usage", "retry_usage", "escalation_usage",
      "human_recovery_time", "fresh_worker_performance", "accepted_product_outcomes"] };
}
