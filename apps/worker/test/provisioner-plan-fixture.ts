import { createStableId } from "@acp/domain";
import type { WorktreeProvisionerAttempt } from "@acp/storage";

export const utc6=(instant:number)=>new Date(instant).toISOString().replace("Z","000Z");
/** Synthetic retained metadata, never a filesystem/database authority source. */
export function provisionerPlanFixture(changes:Partial<WorktreeProvisionerAttempt>={}):WorktreeProvisionerAttempt {
  const attemptId=createStableId("worktreeProvisionerAttempt"),now=Date.now();
  return {attemptId,reservationId:createStableId("worktreeReservation"),reservationRevision:7,baseRevision:"b".repeat(40),
    reportedParent:{path:"C:\\ACP-workspaces",identity:"win32-dir:12345678:0000000000000003",observedAt:utc6(now-1000)},
    fencePlan:{namespace:"acp-worktree-provisioner-v1",directory:"C:\\ACP-fences"},deadlineAt:utc6(now+20000),
    repositoryBindingId:createStableId("repositoryBinding"),repositoryId:createStableId("repository"),projectId:createStableId("project"),
    projectProfileId:createStableId("projectProfile"),projectProfileVersion:"1.0.0",missionId:createStableId("mission"),nodeId:createStableId("node"),
    graphRevision:"graph-1",dispatchRunId:createStableId("run"),dispatchGeneration:1,workspacePath:"C:\\ACP-workspaces\\FutureCase",
    branchRef:"refs/heads/Feature/ExactCase",commonGitDirectory:{path:"C:\\ACP-repository\\.git",identity:"win32-dir:12345678:0000000000000002"},
    hostIdentifier:"host:private-provisioner",ownerSessionId:createStableId("workerHostSession"),applicationVersion:"fixture",
    machineFingerprint:"a".repeat(64),provenanceId:createStableId("provenance"),fenceKey:attemptId+".provision",createdAt:utc6(now),state:"planned",...changes};
}
