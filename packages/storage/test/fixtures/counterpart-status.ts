import { createStableId } from "@acp/domain";

export function statusFixture() {
  return {
    missionId:createStableId("mission"),projectId:createStableId("project"),state:"executing",
    requestedScope:"Prepare one verified candidate; deployment is outside scope.",workflowId:createStableId("workflow"),workflowVersion:"1.0.0",
    completionContractId:createStableId("completionContract"),completionContractVersion:"1.0.0",
    createdAt:"2026-09-06T00:00:00.000001+00:00",updatedAt:"2026-09-06T00:00:00.123456+00:00",nodes:[],
    statusSchemaVersion:"1.0.0",asOf:"2026-09-06T00:01:00.123456+00:00",
    lifecycle:{ candidate:null,deployments:[],acceptance:null,tracker:null,effects:[],businessCompletion:null },
    completion:{ appliedEvaluationId:null,appliedEvaluation:null,latestEvaluation:null },
    assessment:{ kind:"recorded_only",freshness:"not_assessed",conflicts:"not_assessed" },evidence:[],
  };
}
