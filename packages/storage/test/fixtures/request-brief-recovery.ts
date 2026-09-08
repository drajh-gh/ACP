import { createStableId, type StableId } from "@acp/domain";
import { requestBriefAttentionPageSize, type RequestBriefReaders } from "../../src/request-brief-reader.ts";

export const recoveryIds = {
  projectId: "prj_00000000-0000-4000-8000-000000000033" as StableId<"project">,
  requestId: "req_00000000-0000-4000-8000-000000000033" as StableId<"request">,
  intakeId: "int_00000000-0000-4000-8000-000000000033" as StableId<"intake">,
  firstMissionId: "mis_00000000-0000-4000-8000-000000000033" as StableId<"mission">,
  secondMissionId: "mis_00000000-0000-4000-8000-000000000034" as StableId<"mission">,
  attentionItemId: "ati_00000000-0000-4000-8000-000000000033" as StableId<"attentionItem">,
  overflowCursor: "ati_00000000-0000-4000-8000-000000000119" as StableId<"attentionItem">,
};

export const recoveryExpectedFacts = Object.freeze({
  originalWording: "Please recover request req_00000000-0000-4000-8000-000000000033 and identify what is still unknown; do not approve or execute anything.",
  exactRequestId: recoveryIds.requestId,
  exactMissionIds: [recoveryIds.firstMissionId, recoveryIds.secondMissionId],
  staleObservation: "2026-09-08T11:00:00.000001Z",
  decisiveDetail: "Confirm whether the retained scope includes the archived attachment before any proposal.",
  sourceChanged: "mission_status",
  unavailable: ["destination_decisions", "obligations", "communications"],
  nextAction: "unavailable",
  authority: "not_granted",
});

const observedAt = recoveryExpectedFacts.staleObservation;
const secondObservedAt = "2026-09-08T11:00:30.000001Z";

export function recoveryHistory() {
  return { schemaVersion: "1.0.0", asOf: observedAt,
    request: { projectId: recoveryIds.projectId, requestId: recoveryIds.requestId, sourceIntakeId: recoveryIds.intakeId,
      title: "Synthetic retained request", summary: recoveryExpectedFacts.originalWording },
    recordedAt: "2026-09-08T10:00:00.000001Z",
    missionAssociations: [
      { missionId: recoveryIds.firstMissionId, reason: "Recorded investigation", recordedAt: observedAt },
      { missionId: recoveryIds.secondMissionId, reason: "Recorded verification", recordedAt: observedAt },
    ], coverage: "recorded_associations_only", freshness: "not_assessed", authority: "not_granted" };
}

function status(state: "executing" | "verifying", asOf: string) {
  return { missionId: recoveryIds.firstMissionId, projectId: recoveryIds.projectId, state,
    requestedScope: "Inspect retained evidence only; proposal, approval, execution, and closure are outside authority.",
    workflowId: createStableId("workflow"), workflowVersion: "1.0.0", completionContractId: createStableId("completionContract"),
    completionContractVersion: "1.0.0", createdAt: "2026-09-08T10:00:00.000001Z", updatedAt: asOf, nodes: [],
    statusSchemaVersion: "1.0.0", asOf, lifecycle: { candidate: null, deployments: [], acceptance: null, tracker: null,
      effects: [], businessCompletion: null }, completion: { appliedEvaluationId: null, appliedEvaluation: null, latestEvaluation: null },
    assessment: { kind: "recorded_only", freshness: "not_assessed", conflicts: "not_assessed" }, evidence: [] };
}

function attention() {
  const items = Array.from({ length: requestBriefAttentionPageSize }, (_, index) => {
    const itemId = `ati_00000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}` as StableId<"attentionItem">;
    const item = { itemId, projectId: recoveryIds.projectId, missionIds: [recoveryIds.firstMissionId],
      type: "material_ambiguity", urgency: "normal", title: index === 0 ? "Confirm retained scope" : `Retained note ${index}`,
      explanation: index === 0 ? recoveryExpectedFacts.decisiveDetail : `Bounded retained note ${index}.`,
      whyHumanIsNeeded: "Retained records do not resolve this detail.", evidenceIds: [],
      allowedResponses: ["Retrieve scoped attachment evidence", "Record an explicit gap"],
      deduplicationKey: `synthetic:retained-scope:${index}`, quietHoursDisposition: "Not assessed." };
    return { item, recordedAt: observedAt, expiry: "not_expiring" };
  });
  return { schemaVersion: "1.0.0", projectId: recoveryIds.projectId, missionId: recoveryIds.firstMissionId,
    afterItemId: null, limit: requestBriefAttentionPageSize, asOf: observedAt, coverage: "recorded_items_only",
    freshness: "not_assessed", authority: "not_granted", items, nextCursor: recoveryIds.overflowCursor };
}

export function recoveryReaders(): RequestBriefReaders {
  let statusReads = 0;
  return {
    async getRequestHistory() { return recoveryHistory(); },
    async getMissionStatus(id) {
      if (id === recoveryIds.secondMissionId) return undefined;
      statusReads += 1;
      return status(statusReads === 1 ? "executing" : "verifying", statusReads === 1 ? observedAt : secondObservedAt);
    },
    async getAttentionQueue(query) { return query.missionId === recoveryIds.firstMissionId ? attention() : undefined; },
  };
}
