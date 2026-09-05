import { parseStableId, type StableId } from "@acp/domain";
import { parseCanonicalWindowsBindingPath } from "./repository-binding.ts";

/** Prospective target only: no observed native workspace identity or permission
 * to execute Git, launch a worker, release, transfer or reclaim an old writer. */
export interface WorktreeReservationInput {
  readonly reservationId:StableId<"worktreeReservation">;
  readonly repositoryBindingId:StableId<"repositoryBinding">;
  readonly missionId:StableId<"mission">;
  readonly nodeId:StableId<"node">;
  readonly graphRevision:string;
  readonly workspacePath:string;
  readonly branchRef:string;
  readonly provenanceId:StableId<"provenance">;
}

/** Historical bookkeeping snapshot, never native exclusion or Git authority. */
export interface WorktreeReservation extends WorktreeReservationInput {
  readonly dispatchRunId:StableId<"run">;
  readonly dispatchGeneration:number;
  readonly repositoryId:StableId<"repository">;
  readonly projectId:StableId<"project">;
  readonly projectProfileId:StableId<"projectProfile">;
  readonly projectProfileVersion:string;
  readonly hostIdentifier:string;
  readonly ownerSessionId:StableId<"workerHostSession">;
  readonly applicationVersion:string;
  readonly machineFingerprint:string;
  readonly workspaceKey:string;
  readonly physicalRepositoryKey:string;
  readonly branchKey:string;
  readonly pathKey:string;
  readonly acquiredAt:string;
  readonly heartbeatAt:string;
  readonly expiresAt:string;
  readonly revision:number;
  readonly state:"held"|"recovering";
}

export function parseWorktreeReservation(value:unknown):WorktreeReservationInput {
  const keys=["reservationId","repositoryBindingId","missionId","nodeId","graphRevision","workspacePath","branchRef","provenanceId"];
  if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).length!==keys.length
    || Object.keys(value).some((key) => !keys.includes(key))) throw new TypeError("exact pre-run reservation fields required");
  const input=value as Record<string,unknown>,graphRevision=input.graphRevision,branchRef=input.branchRef;
  if(typeof graphRevision!=="string" || !graphRevision.trim() || graphRevision.length>1024 || /[\u0000-\u001f\u007f]/u.test(graphRevision)
    || typeof branchRef!=="string" || !branchRef.startsWith("refs/heads/") || branchRef.length<=11 || branchRef.length>1024
    || /[\u0000-\u001f\u007f]/u.test(branchRef)) throw new TypeError("bounded exact graph and branch intent required");
  // This matches retained branch spelling, not a Git check-ref-format command.
  // Native provisioning must independently validate branch creation semantics.
  return { reservationId:parseStableId(input.reservationId,"worktreeReservation"),repositoryBindingId:parseStableId(input.repositoryBindingId,"repositoryBinding"),
    missionId:parseStableId(input.missionId,"mission"),nodeId:parseStableId(input.nodeId,"node"),graphRevision,
    workspacePath:parseCanonicalWindowsBindingPath(input.workspacePath),branchRef,provenanceId:parseStableId(input.provenanceId,"provenance") };
}
