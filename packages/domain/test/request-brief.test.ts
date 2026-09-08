import assert from "node:assert/strict";
import { it } from "node:test";
import {
  assembleRequestBrief,
  requestBriefMissionLimit,
  requestBriefSourceMaximumBytes,
  type RequestBriefSources,
} from "../src/request-brief.ts";
import { createStableId, type StableId } from "../src/ids.ts";

const projectId = createStableId("project");
const requestId = createStableId("request");
const missionId = createStableId("mission");
const observedAt = "2026-09-08T12:00:00.000001Z";
const assembledAt = "2026-09-08T12:01:00.000001Z";

function missionStatusReference(id: StableId<"mission"> = missionId, pin = "mission-revision-1", at = observedAt) {
  return {
    read: "get_mission_status" as const,
    selectors: { missionId: id },
    observedAt: at,
    pin,
    fields: ["state", "assessment"] as const,
  };
}

function sources(): RequestBriefSources {
  const query = { projectId, requestId };
  return {
    query,
    assembledAt,
    historyPinBefore: "history-revision-1",
    historyPinAfter: "history-revision-1",
    history: {
      schemaVersion: "1.0.0",
      asOf: observedAt,
      request: {
        ...query,
        sourceIntakeId: createStableId("intake"),
        title: "Keep my exact title",
        summary: "Keep the reporter's original wording, not an approved destination.",
      },
      recordedAt: "2026-09-08T11:00:00.000001Z",
      missionAssociations: [{ missionId, reason: "Recorded investigation link", recordedAt: observedAt }],
      coverage: "recorded_associations_only",
      freshness: "not_assessed",
      authority: "not_granted",
    },
    missionObservations: [{
      projectId,
      missionId,
      state: "executing",
      observedAt,
      freshness: "unknown",
      pinBefore: "mission-revision-1",
      pinAfter: "mission-revision-1",
      sourceReference: missionStatusReference(),
    }],
    attention: [attentionSource()],
  };
}

function attentionPage(change: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1.0.0" as const,
    projectId,
    missionId,
    afterItemId: null,
    limit: 20,
    asOf: observedAt,
    coverage: "recorded_items_only" as const,
    freshness: "not_assessed" as const,
    authority: "not_granted" as const,
    items: [],
    nextCursor: null,
    ...change,
  };
}

function attentionSource(change: Record<string, unknown> = {}, pinAfter = "attention-revision-1") {
  return { queue: attentionPage(change), pinBefore: "attention-revision-1", pinAfter };
}

it("preserves identity, wording, source coverage and executable scoped read references", () => {
  const input = sources();
  const brief = assembleRequestBrief(input);
  assert.equal(brief.originalRequest.summary, input.history.request.summary);
  assert.deepEqual(brief.missions[0]?.association, input.history.missionAssociations[0]);
  assert.equal(brief.freshness, "not_assessed");
  assert.deepEqual(brief.issues, []);
  assert.deepEqual(brief.evidence[0], {
    read: "get_request_history",
    selectors: { projectId, requestId },
    observedAt,
    pin: "history-revision-1",
    fields: ["request", "recordedAt", "missionAssociations", "coverage", "freshness", "authority"],
  });
  assert.ok(Object.isFrozen(brief));
});

it("distinguishes unavailable attention from an observed empty page", () => {
  const missing = sources();
  Object.assign(missing, { attention: [] });
  const unavailable = assembleRequestBrief(missing);
  assert.deepEqual(unavailable.missions[0]?.attention, { availability: "unavailable" });
  assert.ok(unavailable.issues.includes("missing_attention"));

  const empty = assembleRequestBrief(sources());
  assert.equal(empty.missions[0]?.attention.availability, "observed");
  if (empty.missions[0]?.attention.availability === "observed") {
    assert.deepEqual(empty.missions[0].attention.items, []);
    assert.equal(empty.missions[0].attention.nextCursor, null);
    assert.equal(empty.missions[0].attention.coverage, "recorded_items_only");
  }
});

it("preserves attention pagination selectors, envelope and actionable continuation", () => {
  const afterItemId = createStableId("attentionItem");
  const nextCursor = createStableId("attentionItem");
  const item = {
    itemId: nextCursor, projectId, missionIds: [missionId], type: "material_ambiguity", urgency: "normal",
    title: "Confirm scope", explanation: "Recorded descriptions differ.", whyHumanIsNeeded: "Policy does not resolve the difference.",
    evidenceIds: [], allowedResponses: ["Review"], deduplicationKey: "scope:1", quietHoursDisposition: "Not assessed.",
  };
  const input = sources();
  Object.assign(input, { attention: [attentionSource({ afterItemId, limit: 1, nextCursor,
    items: [{ item, recordedAt: observedAt, expiry: "not_expiring" }] })] });
  const attention = assembleRequestBrief(input).missions[0]?.attention;
  assert.equal(attention?.availability, "observed");
  if (attention?.availability === "observed") {
    assert.deepEqual(attention.query, { projectId, missionId, afterItemId, limit: 1 });
    assert.equal(attention.nextCursor, nextCursor);
    assert.deepEqual(attention.sourceReference.selectors, attention.query);
  }
});

it("retains independent missing, stale and changed-source issues", () => {
  const input = sources();
  const missingMissionId = "mis_00000000-0000-4000-8000-000000000099" as StableId<"mission">;
  Object.assign(input.history, { missionAssociations: [
    input.history.missionAssociations[0],
    { missionId: missingMissionId, reason: "Second link", recordedAt: observedAt },
  ].sort((left, right) => left!.missionId.localeCompare(right!.missionId)) });
  Object.assign(input.missionObservations[0]!, { freshness: "stale", pinAfter: "mission-revision-2" });
  Object.assign(input, { attention: [attentionSource({}, "attention-revision-2")] });
  const brief = assembleRequestBrief(input);
  assert.deepEqual(brief.issues, [
    "missing_attention",
    "missing_mission_status",
    "source_changed_during_assembly",
    "stale_mission_status",
  ]);
  assert.deepEqual(brief.sourceChanges.map(change => change.source), ["mission_status", "attention"]);
  assert.equal(brief.sourceChanges[0]?.pinAfter, "mission-revision-2");
});

it("requires the primary mission reference and binds its supported fields, pin and time", () => {
  const empty = sources();
  Object.assign(empty.missionObservations[0]!, { sourceReference: [] });
  assert.throws(() => assembleRequestBrief(empty), /request brief data/u);

  for (const sourceReference of [
    missionStatusReference(missionId, "wrong-pin"),
    missionStatusReference(missionId, "mission-revision-1", "2026-09-08T11:59:00.000001Z"),
    { ...missionStatusReference(), fields: ["state", "evidence"] },
  ]) {
    const input = sources();
    Object.assign(input.missionObservations[0]!, { sourceReference });
    assert.throws(() => assembleRequestBrief(input), /primary observation pin and time/u);
  }
});

it("denies cross-project, unassociated and mismatched-mission observations", () => {
  const cross = sources();
  Object.assign(cross.missionObservations[0]!, { projectId: createStableId("project") });
  assert.throws(() => assembleRequestBrief(cross), /project mismatch/u);

  const other = createStableId("mission");
  const unrelated = sources();
  Object.assign(unrelated.missionObservations[0]!, { missionId: other, sourceReference: missionStatusReference(other) });
  assert.throws(() => assembleRequestBrief(unrelated), /distinct request missions/u);

  const wrongAttention = sources();
  Object.assign(wrongAttention, { attention: [attentionSource({ missionId: other })] });
  assert.throws(() => assembleRequestBrief(wrongAttention), /distinct request missions/u);
});

it("rejects future history, mission and attention observations at microsecond precision", () => {
  const future = "2026-09-08T12:01:00.000002Z";
  const history = sources();
  Object.assign(history.history, { asOf: future });
  assert.throws(() => assembleRequestBrief(history), /request history cannot be later/u);

  const mission = sources();
  Object.assign(mission.missionObservations[0]!, {
    observedAt: future,
    sourceReference: missionStatusReference(missionId, "mission-revision-1", future),
  });
  assert.throws(() => assembleRequestBrief(mission), /mission observation cannot be later/u);

  const attention = sources();
  Object.assign(attention, { attention: [attentionSource({ asOf: future })] });
  assert.throws(() => assembleRequestBrief(attention), /attention observation cannot be later/u);
});

it("refuses association overflow without advertising an unusable continuation", () => {
  const input = sources();
  Object.assign(input, { missionObservations: [], attention: [] });
  Object.assign(input.history, { missionAssociations: Array.from({ length: requestBriefMissionLimit + 1 }, (_, index) => ({
    missionId: `mis_00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` as StableId<"mission">,
    reason: `Association ${index}`,
    recordedAt: observedAt,
  })) });
  assert.throws(() => assembleRequestBrief(input), /whole-result refusal/u);
  assert.equal("continuation" in assembleRequestBrief(sources()), false);
});

it("refuses source-byte overflow as a whole result", () => {
  const input = sources();
  const largeItem = {
    itemId: createStableId("attentionItem"), projectId, missionIds: [missionId], type: "material_ambiguity", urgency: "normal",
    title: "Bounded item", explanation: "x".repeat(4000), whyHumanIsNeeded: "Review is required.", evidenceIds: [],
    allowedResponses: ["Review"], deduplicationKey: "byte-boundary", quietHoursDisposition: "Not assessed.",
  };
  Object.assign(input, { attention: Array.from({ length: 50 }, () => attentionSource({
    items: [{ item: largeItem, recordedAt: observedAt, expiry: "not_expiring" }],
  })) });
  assert.throws(() => assembleRequestBrief(input), /bounded snapshot/u);
  assert.ok(JSON.stringify(input).length > requestBriefSourceMaximumBytes);
});

it("refuses output-byte overflow even when the source envelope is within its separate bound", () => {
  const input = sources();
  const missionIds = Array.from({ length: 20 }, (_, index) =>
    `mis_00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` as StableId<"mission">);
  Object.assign(input.history, { missionAssociations: missionIds.map((id, index) => ({
    missionId: id, reason: `Association ${index}`, recordedAt: observedAt,
  })) });
  Object.assign(input, { missionObservations: [], attention: missionIds.map((id, index) => ({
    queue: attentionPage({ missionId: id, items: [{ item: {
      itemId: `ati_00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` as StableId<"attentionItem">,
      projectId, missionIds: [id], type: "material_ambiguity", urgency: "normal", title: `Review ${index}`,
      explanation: "x".repeat(3500), whyHumanIsNeeded: "Review is required.", evidenceIds: [], allowedResponses: ["Review"],
      deduplicationKey: `output:${index}`, quietHoursDisposition: "Not assessed.",
    }, recordedAt: observedAt, expiry: "not_expiring" }] }),
    pinBefore: `attention-${index}`, pinAfter: `attention-${index}`,
  })) });
  assert.ok(JSON.stringify(input).length < requestBriefSourceMaximumBytes);
  assert.throws(() => assembleRequestBrief(input), /bounded snapshot/u);
});

it("reports a history-pin-only change", () => {
  const input = sources();
  Object.assign(input, { historyPinAfter: "history-revision-2" });
  const brief = assembleRequestBrief(input);
  assert.deepEqual(brief.sourceChanges, [{
    source: "request_history", missionId: null, pinBefore: "history-revision-1", pinAfter: "history-revision-2",
  }]);
  assert.ok(brief.issues.includes("source_changed_during_assembly"));
});

it("keeps unsupported records and every action authority explicitly unavailable", () => {
  const brief = assembleRequestBrief(sources());
  assert.deepEqual(brief.unavailable, ["destination_decisions", "obligations", "communications"]);
  assert.equal(brief.supportedNextAction, "unavailable");
  assert.equal(brief.authority, "not_granted");
  for (const field of ["priority", "approval", "ready", "completed"]) assert.equal(field in brief, false);
});
