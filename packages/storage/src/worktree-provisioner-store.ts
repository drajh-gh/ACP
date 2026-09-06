import { expectEnum,expectIsoTimestamp,expectString,parseStableId,type StableId } from "@acp/domain";
import type { Pool,QueryResultRow } from "pg";
import type { QueryExecutor } from "./database.ts";
import { withProvisionerPlanTransaction } from "./provisioner-transaction.ts";
import { PostgresDispatchStore,type HostRuntimeRegistration } from "./dispatch-store.ts";
import { parseCanonicalWindowsBindingPath,parseWindowsDirectoryBinding } from "./repository-binding.ts";
import type { WorkerRecoveryAuthority } from "./worker-recovery-store.ts";
import { parseWorktreeProvisionerAttempt,type WorktreeProvisionerAttempt,type WorktreeProvisionerAttemptInput } from "./worktree-provisioner-attempt.ts";

/** Inert durable plans. No native/Git launch, renewal, stop, retry or release API.
 * Reported parent/fence intent must be revalidated by any future native consumer. */
export class PostgresWorktreeProvisionerStore {
  private readonly pool:Pool;
  readonly authority:WorkerRecoveryAuthority;
  constructor(pool:Pool,runtime:HostRuntimeRegistration) {
    new PostgresDispatchStore(pool);
    parseStableId(runtime.sessionId,"workerHostSession");
    if(!runtime.hostIdentifier.trim() || !runtime.applicationVersion.trim()) throw new TypeError("provisioner plan runtime identity required");
    this.pool=pool; this.authority=Object.freeze({ hostIdentifier:runtime.hostIdentifier,sessionId:runtime.sessionId,applicationVersion:runtime.applicationVersion });
  }
  async plan(value:WorktreeProvisionerAttemptInput):Promise<WorktreeProvisionerAttempt> {
    const input=parseWorktreeProvisionerAttempt(value),a=this.authority;
    return withProvisionerPlanTransaction(this.pool,async(client)=>{
      await client.query("SELECT acp.lock_worktree_provisioner_plan($1)",[input.reservationId]);
      const old=await this.row(client,input.attemptId);
      if(old) {
        // Exact timestamp identity is its canonical instant, not timezone spelling.
        // Compare in PostgreSQL to retain all six digits; never map through Date.
        const same=(await client.query(`SELECT reservation_id=$2 AND reservation_revision=$3 AND base_revision=$4
          AND parent_path=$5 AND parent_identity=$6 AND parent_observed_at=$7::timestamptz
          AND fence_namespace=$8 AND fence_directory=$9 AND deadline_at=$10::timestamptz
          AND host_identifier=$11 AND owner_session_id=$12 AND application_version=$13 AS same
          FROM acp.worktree_provisioner_attempts WHERE attempt_id=$1`,[input.attemptId,input.reservationId,input.reservationRevision,input.baseRevision,
          input.reportedParent.path,input.reportedParent.identity,input.reportedParent.observedAt,input.fencePlan.namespace,input.fencePlan.directory,
          input.deadlineAt,a.hostIdentifier,a.sessionId,a.applicationVersion])).rows[0]?.same;
        if(same!==true) throw new Error("provisioner plan aliases different terms or original owner");
        return attemptFromRow(old); // Historical replay never renews any authority.
      }
      await client.query(`INSERT INTO acp.worktree_provisioner_attempts(attempt_id,reservation_id,reservation_revision,base_revision,
        parent_path,parent_identity,parent_observed_at,fence_namespace,fence_directory,deadline_at,host_identifier,owner_session_id,application_version)
        VALUES($1,$2,$3,$4,$5,$6,$7::timestamptz,$8,$9,$10::timestamptz,$11,$12,$13)`,
      [input.attemptId,input.reservationId,input.reservationRevision,input.baseRevision,input.reportedParent.path,input.reportedParent.identity,
        input.reportedParent.observedAt,input.fencePlan.namespace,input.fencePlan.directory,input.deadlineAt,a.hostIdentifier,a.sessionId,a.applicationVersion]);
      const created=await this.row(client,input.attemptId); if(!created) throw new Error("provisioner plan insertion produced no exact record");
      return attemptFromRow(created);
    });
  }
  async load(attemptId:StableId<"worktreeProvisionerAttempt">):Promise<WorktreeProvisionerAttempt|undefined> {
    parseStableId(attemptId,"worktreeProvisionerAttempt");
    const row=await this.row(this.pool,attemptId); return row ? attemptFromRow(row) : undefined;
  }
  /** Host-scoped, bounded history inventory, not reclamation or retry permission. */
  async listRecovery(options:{ readonly limit?:number;readonly afterAttemptId?:StableId<"worktreeProvisionerAttempt"> }={}):Promise<{
    readonly items:readonly WorktreeProvisionerAttempt[];readonly nextCursor?:StableId<"worktreeProvisionerAttempt">;
  }> {
    const limit=options.limit??20;
    if(!Number.isInteger(limit) || limit<1 || limit>100) throw new TypeError("provisioner recovery page limit must be 1 to 100");
    if(options.afterAttemptId!==undefined) parseStableId(options.afterAttemptId,"worktreeProvisionerAttempt");
    const rows=(await this.pool.query(`SELECT to_jsonb(p) AS snapshot FROM acp.worktree_provisioner_status p WHERE host_identifier=$1 AND state='recovering'
      AND ($2::text IS NULL OR attempt_id::text>$2) ORDER BY attempt_id LIMIT $3`,[this.authority.hostIdentifier,options.afterAttemptId??null,limit+1])).rows;
    const items=rows.slice(0,limit).map((r)=>attemptFromRow(r.snapshot as QueryResultRow));
    return { items,...(rows.length>limit ? { nextCursor:items[items.length-1]!.attemptId } : {}) };
  }
  private async row(client:QueryExecutor,id:StableId<"worktreeProvisionerAttempt">):Promise<QueryResultRow|undefined> {
    return (await client.query("SELECT to_jsonb(p) AS snapshot FROM acp.worktree_provisioner_status p WHERE attempt_id=$1 AND host_identifier=$2",
      [id,this.authority.hostIdentifier])).rows[0]?.snapshot as QueryResultRow|undefined;
  }
}
function attemptFromRow(r:QueryResultRow):WorktreeProvisionerAttempt {
  const input=parseWorktreeProvisionerAttempt({ attemptId:r.attempt_id,reservationId:r.reservation_id,reservationRevision:r.reservation_revision,
    baseRevision:r.base_revision,reportedParent:{ path:r.parent_path,identity:r.parent_identity,observedAt:r.parent_observed_at },
    fencePlan:{ namespace:r.fence_namespace,directory:r.fence_directory },deadlineAt:r.deadline_at });
  if(!Number.isInteger(r.dispatch_generation) || (r.dispatch_generation as number)<1 || typeof r.machine_fingerprint!=="string"
    || !/^[0-9a-f]{64}$/u.test(r.machine_fingerprint) || r.fence_key!==`${input.attemptId}.provision`) {
    throw new Error("invalid derived provisioner plan identity");
  }
  return { ...input,repositoryBindingId:parseStableId(r.repository_binding_id,"repositoryBinding"),repositoryId:parseStableId(r.repository_id,"repository"),
    projectId:parseStableId(r.project_id,"project"),projectProfileId:parseStableId(r.project_profile_id,"projectProfile"),projectProfileVersion:expectString(r.project_profile_version,"profile version"),
    missionId:parseStableId(r.mission_id,"mission"),nodeId:parseStableId(r.node_id,"node"),graphRevision:expectString(r.graph_revision,"graph revision"),
    dispatchRunId:parseStableId(r.dispatch_run_id,"run"),dispatchGeneration:r.dispatch_generation as number,
    workspacePath:parseCanonicalWindowsBindingPath(r.workspace_path),branchRef:expectString(r.branch_ref,"branch ref"),
    commonGitDirectory:parseWindowsDirectoryBinding({ path:r.common_git_directory_path,identity:r.common_git_directory_identity }),
    hostIdentifier:expectString(r.host_identifier,"host"),ownerSessionId:parseStableId(r.owner_session_id,"workerHostSession"),applicationVersion:expectString(r.application_version,"application version"),
    machineFingerprint:r.machine_fingerprint,provenanceId:parseStableId(r.provenance_id,"provenance"),fenceKey:r.fence_key as string,
    createdAt:expectIsoTimestamp(r.created_at,"plan creation"),state:expectEnum(r.state,["planned","recovering"],"plan state") };
}
