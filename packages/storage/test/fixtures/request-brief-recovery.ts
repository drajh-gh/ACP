import { type StableId } from "@acp/domain";
import { requestBriefAttentionPageSize, type RequestBriefReaders } from "../../src/request-brief-reader.ts";

const projectId = "prj_00000000-0000-4000-8000-000000000033" as StableId<"project">;
const requestId = "req_00000000-0000-4000-8000-000000000033" as StableId<"request">;
const intakeId = "int_00000000-0000-4000-8000-000000000033" as StableId<"intake">;
const firstMissionId = "mis_00000000-0000-4000-8000-000000000033" as StableId<"mission">;
const secondMissionId = "mis_00000000-0000-4000-8000-000000000034" as StableId<"mission">;
const workflowId = "wfl_00000000-0000-4000-8000-000000000033" as StableId<"workflow">;
const contractId = "cct_00000000-0000-4000-8000-000000000033" as StableId<"completionContract">;
const observedAt = "2026-09-08T11:00:00.000001Z";

export const recoveryQuery = Object.freeze({ projectId, requestId });

export function recoveryHistory() {
  return { schemaVersion: "1.0.0", asOf: observedAt,
    request: { projectId, requestId, sourceIntakeId: intakeId, title: "Synthetic retained request",
      summary: "Please recover request req_00000000-0000-4000-8000-000000000033 and identify what is still unknown; do not approve or execute anything." },
    recordedAt: "2026-09-08T10:00:00.000001Z", missionAssociations: [
      { missionId: firstMissionId, reason: "Recorded investigation", recordedAt: observedAt },
      { missionId: secondMissionId, reason: "Recorded verification", recordedAt: observedAt },
    ], coverage: "recorded_associations_only", freshness: "not_assessed", authority: "not_granted" };
}

function status(state: "executing" | "verifying", asOf: string) {
  return { missionId: firstMissionId, projectId, state,
    requestedScope: "Inspect retained evidence only; proposal, approval, execution, and closure are outside authority.",
    workflowId, workflowVersion: "1.0.0", completionContractId: contractId, completionContractVersion: "1.0.0",
    createdAt: "2026-09-08T10:00:00.000001Z", updatedAt: asOf, nodes: [], statusSchemaVersion: "1.0.0", asOf,
    lifecycle: { candidate: null, deployments: [], acceptance: null, tracker: null, effects: [], businessCompletion: null },
    completion: { appliedEvaluationId: null, appliedEvaluation: null, latestEvaluation: null },
    assessment: { kind: "recorded_only", freshness: "not_assessed", conflicts: "not_assessed" }, evidence: [] };
}

function attention() {
  const items = Array.from({ length: requestBriefAttentionPageSize }, (_, index) => {
    const itemId = `ati_00000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}` as StableId<"attentionItem">;
    return { item: { itemId, projectId, missionIds: [firstMissionId], type: "material_ambiguity", urgency: "normal",
      title: index === 0 ? "Archived attachment evidence gap" : `Retained note ${index}`,
      explanation: index === 0
        ? "Archived attachment evidence is unavailable; record an explicit evidence gap before any proposal."
        : `Bounded retained note ${index}.`,
      whyHumanIsNeeded: "Retained records do not resolve this detail.", evidenceIds: [],
      allowedResponses: ["Record explicit evidence gap"], deduplicationKey: `synthetic:retained-scope:${index}`,
      quietHoursDisposition: "Not assessed." }, recordedAt: observedAt, expiry: "not_expiring" };
  });
  return { schemaVersion: "1.0.0", projectId, missionId: firstMissionId, afterItemId: null,
    limit: requestBriefAttentionPageSize, asOf: observedAt, coverage: "recorded_items_only", freshness: "not_assessed",
    authority: "not_granted", items, nextCursor: items.at(-1)!.item.itemId };
}

export function recoveryReaders(): RequestBriefReaders {
  let statusReads = 0;
  return { async getRequestHistory() { return recoveryHistory(); }, async getMissionStatus(id) {
    if (id === secondMissionId) return undefined;
    statusReads += 1; return status(statusReads === 1 ? "executing" : "verifying",
      statusReads === 1 ? observedAt : "2026-09-08T11:00:30.000001Z");
  }, async getAttentionQueue(query) { return query.missionId === firstMissionId ? attention() : undefined; },
  async getRequestBriefCompletionTimestamp() { return "2026-09-08T12:00:00.000001Z"; } };
}
