import assert from "node:assert/strict";
import { it } from "node:test";
import { assembleRequestBrief, requestBriefMissionLimit, type RequestBriefSources } from "../src/request-brief.ts";
import { createStableId } from "../src/ids.ts";

const projectId = createStableId("project"), requestId = createStableId("request"), missionId = createStableId("mission");
const at = "2026-09-08T12:00:00.000001Z";
function sources(): RequestBriefSources {
  const query = { projectId, requestId };
  return { query, assembledAt: "2026-09-08T12:01:00.000001Z", historyPinBefore: "history-revision-1", historyPinAfter: "history-revision-1",
    history: { schemaVersion: "1.0.0", asOf: at, request: { ...query, sourceIntakeId: createStableId("intake"), title: "Keep my exact title",
      summary: "Keep the reporter's original wording, not an approved destination." }, recordedAt: "2026-09-08T11:00:00.000001Z",
      missionAssociations: [{ missionId, reason: "Recorded investigation link", recordedAt: at }], coverage: "recorded_associations_only",
      freshness: "not_assessed", authority: "not_granted" },
    missionObservations: [{ projectId, missionId, state: "executing", observedAt: at, freshness: "unknown", pinBefore: "mission-revision-1",
      pinAfter: "mission-revision-1", evidence: [{ source: "mission_status", projectId, requestId, missionId, observedAt: at,
        pin: "mission-revision-1", fields: ["state", "evidence"] }] }],
    attention: [{ schemaVersion: "1.0.0", projectId, missionId, afterItemId: null, limit: 20, asOf: at,
      coverage: "recorded_items_only", freshness: "not_assessed", authority: "not_granted", items: [], nextCursor: null }] };
}

it("assembles an immutable brief preserving known identity, wording, pins, times, coverage and evidence paths", () => {
  const input = sources(), brief = assembleRequestBrief(input);
  assert.equal(brief.originalRequest.summary, input.history.request.summary);
  assert.deepEqual(brief.missions[0]?.association, input.history.missionAssociations[0]);
  assert.deepEqual(brief.coverage, { history: "recorded_associations_only", missionStatus: "selected_observations_only", attention: "selected_recorded_items_only" });
  assert.ok(brief.evidence.some(reference => reference.source === "mission_status" && reference.pin === "mission-revision-1"));
  assert.ok(Object.isFrozen(brief)); assert.ok(Object.isFrozen(brief.missions));
});

it("keeps unsupported records and every action authority explicitly unavailable", () => {
  const brief = assembleRequestBrief(sources());
  assert.deepEqual(brief.unavailable, ["destination_decisions", "obligations", "communications"]);
  assert.equal(brief.supportedNextAction, "unavailable"); assert.equal(brief.authority, "not_granted");
  assert.equal("priority" in brief, false); assert.equal("approval" in brief, false); assert.equal("ready" in brief, false); assert.equal("completed" in brief, false);
});

it("denies cross-project, unassociated, and mismatched-mission observations", () => {
  const cross = sources(); (cross.missionObservations[0] as unknown as { projectId: string }).projectId = createStableId("project");
  assert.throws(() => assembleRequestBrief(cross), /project mismatch/u);
  const unrelated = sources(), other = createStableId("mission");
  (unrelated.missionObservations[0] as unknown as { missionId: string }).missionId = other;
  (unrelated.missionObservations[0]!.evidence[0] as unknown as { missionId: string }).missionId = other;
  assert.throws(() => assembleRequestBrief(unrelated), /match distinct request associations/u);
  const attention = sources(); (attention.attention[0] as unknown as { missionId: string }).missionId = createStableId("mission");
  assert.throws(() => assembleRequestBrief(attention), /match distinct request missions/u);
});

it("distinguishes missing observations, stale evidence, and changed incoherent sources", () => {
  const missing = sources(); Object.assign(missing, { missionObservations: [], attention: [] });
  assert.equal(assembleRequestBrief(missing).freshness, "missing_observations");
  const stale = sources(); (stale.missionObservations[0] as unknown as { freshness: string }).freshness = "stale";
  assert.equal(assembleRequestBrief(stale).freshness, "stale_evidence");
  const changed = sources(); Object.assign(changed, { historyPinAfter: "history-revision-2" });
  (changed.missionObservations[0] as unknown as { pinAfter: string }).pinAfter = "mission-revision-2";
  const brief = assembleRequestBrief(changed); assert.equal(brief.freshness, "incoherent_source_snapshot");
  assert.equal(brief.originalRequest.title, "Keep my exact title"); assert.ok(brief.evidence.length > 0);
});

it("reports bounded overflow with a scoped continuation instead of silent truncation", () => {
  const input = sources(); Object.assign(input, { missionObservations: [], attention: [] });
  Object.assign(input.history, { missionAssociations: Array.from({ length: requestBriefMissionLimit + 1 }, (_, index) => ({
    missionId: `mis_00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` as typeof missionId,
    reason: `Association ${index}`, recordedAt: at })) });
  const brief = assembleRequestBrief(input); assert.equal(brief.missions.length, requestBriefMissionLimit);
  assert.equal(brief.omitted.missionAssociations, 1); assert.equal(brief.omitted.continuation?.source, "request_history");
  assert.deepEqual(brief.omitted.continuation?.fields, ["missionAssociations"]);
});
