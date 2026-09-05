import { expectIsoTimestamp,expectOnlyKeys,expectRecord,parseStableId,type StableId } from "@acp/domain";
import { parseCanonicalWindowsBindingPath,parseWindowsDirectoryBinding,type WindowsDirectoryBinding } from "./repository-binding.ts";

/** A recorded plan, not permission to execute a provisioner or Git. */
export interface WorktreeProvisionerAttemptInput {
  readonly attemptId:StableId<"worktreeProvisionerAttempt">;
  readonly reservationId:StableId<"worktreeReservation">;
  readonly reservationRevision:number;
  readonly baseRevision:string;
  readonly reportedParent:WindowsDirectoryBinding&{ readonly observedAt:string };
  readonly fencePlan:{ readonly namespace:"acp-worktree-provisioner-v1";readonly directory:string };
  readonly deadlineAt:string;
}
export interface WorktreeProvisionerAttempt extends WorktreeProvisionerAttemptInput {
  readonly repositoryBindingId:StableId<"repositoryBinding">;
  readonly repositoryId:StableId<"repository">;
  readonly projectId:StableId<"project">;
  readonly projectProfileId:StableId<"projectProfile">;
  readonly projectProfileVersion:string;
  readonly missionId:StableId<"mission">;
  readonly nodeId:StableId<"node">;
  readonly graphRevision:string;
  readonly dispatchRunId:StableId<"run">;
  readonly dispatchGeneration:number;
  readonly workspacePath:string;
  readonly branchRef:string;
  readonly commonGitDirectory:WindowsDirectoryBinding;
  readonly hostIdentifier:string;
  readonly ownerSessionId:StableId<"workerHostSession">;
  readonly applicationVersion:string;
  readonly machineFingerprint:string;
  readonly provenanceId:StableId<"provenance">;
  readonly fenceKey:string;
  readonly createdAt:string;
  /** Bookkeeping only. Even a planned item grants no native/Git permission. */
  readonly state:"planned"|"recovering";
}
export function parseWorktreeProvisionerAttempt(value:unknown):WorktreeProvisionerAttemptInput {
  const input=exact(value,["attemptId","reservationId","reservationRevision","baseRevision","reportedParent","fencePlan","deadlineAt"]);
  const parent=exact(input.reportedParent,["path","identity","observedAt"]),fence=exact(input.fencePlan,["namespace","directory"]);
  if(!Number.isInteger(input.reservationRevision) || (input.reservationRevision as number)<1 || (input.reservationRevision as number)>2147483647) {
    throw new TypeError("provisioner reservation revision must be a positive PostgreSQL integer");
  }
  if(typeof input.baseRevision!=="string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(input.baseRevision)) throw new TypeError("exact full provisioner base revision required");
  if(fence.namespace!=="acp-worktree-provisioner-v1") throw new TypeError("distinct planned provisioner fence namespace required");
  const observedAt=timestamp(parent.observedAt),deadlineAt=timestamp(input.deadlineAt);
  if(microseconds(deadlineAt)<=microseconds(observedAt)) throw new TypeError("provisioner deadline must follow reported parent observation");
  return { attemptId:parseStableId(input.attemptId,"worktreeProvisionerAttempt"),reservationId:parseStableId(input.reservationId,"worktreeReservation"),
    reservationRevision:input.reservationRevision as number,baseRevision:input.baseRevision,
    reportedParent:{ ...parseWindowsDirectoryBinding({ path:parent.path,identity:parent.identity }),observedAt },
    fencePlan:{ namespace:fence.namespace,directory:parseCanonicalWindowsBindingPath(fence.directory) },deadlineAt };
}
function exact(value:unknown,keys:readonly string[]):Record<string,unknown> {
  const row=expectRecord(value,"provisioner plan"); expectOnlyKeys(row,keys,"provisioner plan");
  if(keys.some((key)=>!Object.hasOwn(row,key))) throw new TypeError("every exact provisioner plan field is required");
  return row;
}
function timestamp(value:unknown):string {
  const result=expectIsoTimestamp(value,"provisioner timestamp");
  if((/\.(\d+)/u.exec(result)?.[1]?.length??0)>6) throw new TypeError("provisioner timestamp exceeds PostgreSQL microsecond precision");
  return result;
}
function microseconds(value:string):bigint {
  const fraction=/\.(\d+)/u.exec(value)?.[1]??"";
  return BigInt(Date.parse(value))*1000n+BigInt(fraction.slice(3).padEnd(3,"0"));
}
