import { win32 } from "node:path";
import { expectOnlyKeys,expectRecord,parseCanonicalTimestamp,parseStableId } from "@acp/domain";
import { parseWorktreeProvisionerAttempt,parseWorktreeReservation,parseWindowsDirectoryBinding,
  type WorktreeProvisionerAttempt,type WorkerRecoveryAuthority } from "@acp/storage";
import { parseWindowsProvisionerTargetInput } from "./windows-repository-observer.ts";
import type { NativeProvisionerChannelBinding } from "./windows-provisioner-channel.ts";

/** @internal Complete owned snapshot of retained metadata, not current authority. */
export function snapshotNativeProvisionerPlan(value:unknown):WorktreeProvisionerAttempt {
  const row=exact(value,["attemptId","reservationId","reservationRevision","baseRevision","reportedParent","fencePlan","deadlineAt",
    "repositoryBindingId","repositoryId","projectId","projectProfileId","projectProfileVersion","missionId","nodeId","graphRevision",
    "dispatchRunId","dispatchGeneration","workspacePath","branchRef","commonGitDirectory","hostIdentifier","ownerSessionId","applicationVersion",
    "machineFingerprint","provenanceId","fenceKey","createdAt","state"]);
  const input=parseWorktreeProvisionerAttempt({attemptId:row.attemptId,reservationId:row.reservationId,reservationRevision:row.reservationRevision,
    baseRevision:row.baseRevision,reportedParent:row.reportedParent,fencePlan:row.fencePlan,deadlineAt:row.deadlineAt});
  const reservation=parseWorktreeReservation({reservationId:row.reservationId,repositoryBindingId:row.repositoryBindingId,missionId:row.missionId,
    nodeId:row.nodeId,graphRevision:row.graphRevision,workspacePath:row.workspacePath,branchRef:row.branchRef,provenanceId:row.provenanceId});
  const target=parseWindowsProvisionerTargetInput({workspacePath:reservation.workspacePath,branchRef:reservation.branchRef,baseRevision:input.baseRevision});
  const commonGitDirectory=parseWindowsDirectoryBinding(row.commonGitDirectory);
  if(win32.dirname(target.workspacePath)!==input.reportedParent.path || input.reportedParent.identity===commonGitDirectory.identity
    || overlaps(target.workspacePath,commonGitDirectory.path) || !Number.isSafeInteger(row.dispatchGeneration) || (row.dispatchGeneration as number)<1
    || (row.dispatchGeneration as number)>2147483647 || typeof row.machineFingerprint!=="string" || !/^[0-9a-f]{64}$/u.test(row.machineFingerprint)
    || row.fenceKey!==input.attemptId+".provision" || (row.state!=="planned" && row.state!=="recovering"))throw new TypeError("invalid complete retained provisioner plan");
  const owner=parseNativeProvisionerOwner({hostIdentifier:row.hostIdentifier,sessionId:row.ownerSessionId,applicationVersion:row.applicationVersion});
  return freeze({...input,...reservation,deadlineAt:parseCanonicalTimestamp(input.deadlineAt),reportedParent:{...input.reportedParent,observedAt:parseCanonicalTimestamp(input.reportedParent.observedAt)},
    repositoryId:parseStableId(row.repositoryId,"repository"),projectId:parseStableId(row.projectId,"project"),projectProfileId:parseStableId(row.projectProfileId,"projectProfile"),
    projectProfileVersion:text(row.projectProfileVersion),dispatchRunId:parseStableId(row.dispatchRunId,"run"),dispatchGeneration:row.dispatchGeneration as number,
    commonGitDirectory,hostIdentifier:owner.hostIdentifier,ownerSessionId:owner.sessionId,applicationVersion:owner.applicationVersion,
    machineFingerprint:row.machineFingerprint,fenceKey:row.fenceKey as string,createdAt:parseCanonicalTimestamp(row.createdAt),state:row.state});
}
export function parseNativeProvisionerOwner(value:unknown):WorkerRecoveryAuthority {
  const row=exact(value,["hostIdentifier","sessionId","applicationVersion"]);
  return Object.freeze({hostIdentifier:text(row.hostIdentifier),sessionId:parseStableId(row.sessionId,"workerHostSession"),applicationVersion:text(row.applicationVersion)});
}
/** Derive only the private binding from an already validated retained snapshot. */
export function provisionerChannelBinding(plan:WorktreeProvisionerAttempt):NativeProvisionerChannelBinding {
  return freeze({attemptId:plan.attemptId,expectedPlan:{reservationId:plan.reservationId,reservationRevision:plan.reservationRevision,deadlineAt:plan.deadlineAt,provenanceId:plan.provenanceId},
    owner:{hostIdentifier:plan.hostIdentifier,sessionId:plan.ownerSessionId,applicationVersion:plan.applicationVersion},fencePlan:{...plan.fencePlan},machineFingerprint:plan.machineFingerprint});
}
function text(value:unknown):string {
  if(typeof value!=="string" || !value.trim() || value.length>1024 || /[\u0000-\u001f\u007f]/u.test(value))throw new TypeError("bounded original plan text required");return value;
}
function exact(value:unknown,keys:readonly string[]):Record<string,unknown> {
  const row=expectRecord(value,"retained provisioner plan");expectOnlyKeys(row,keys,"retained provisioner plan");
  if(keys.some(key=>!Object.hasOwn(row,key)))throw new TypeError("complete exact retained plan required");return row;
}
function overlaps(left:string,right:string):boolean {
  const a=left.toLowerCase(),b=right.toLowerCase();return a===b || a.startsWith(b+"\\") || b.startsWith(a+"\\");
}
function freeze<T>(value:T):T {
  if(value!==null && typeof value==="object"){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;
}
