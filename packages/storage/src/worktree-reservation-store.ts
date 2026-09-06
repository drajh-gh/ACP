import { parseStableId, type StableId } from "@acp/domain";
import type { Pool, QueryResultRow } from "pg";
import type { QueryExecutor } from "./database.ts";
import { withIsolatedTransaction } from "./isolated-transaction.ts";
import { PostgresDispatchStore, type HostRuntimeRegistration } from "./dispatch-store.ts";
import type { WorkerRecoveryAuthority } from "./worker-recovery-store.ts";
import { parseWorktreeReservation, type WorktreeReservation, type WorktreeReservationInput } from "./worktree-reservation.ts";

/** Storage-only target holds. No process, native workspace identity, release,
 * conversion, takeover, provisioning success or worker-run fabrication API. */
export class PostgresWorktreeReservationStore {
  private readonly pool:Pool;
  readonly authority:WorkerRecoveryAuthority;
  constructor(pool:Pool,runtime:HostRuntimeRegistration) {
    new PostgresDispatchStore(pool);
    parseStableId(runtime.sessionId,"workerHostSession");
    if(!runtime.hostIdentifier.trim() || !runtime.applicationVersion.trim()) throw new TypeError("pre-run reservation runtime identity required");
    this.pool=pool; this.authority=Object.freeze({ hostIdentifier:runtime.hostIdentifier,sessionId:runtime.sessionId,applicationVersion:runtime.applicationVersion });
  }
  async reserve(value:WorktreeReservationInput):Promise<WorktreeReservation> {
    const input=parseWorktreeReservation(value),a=this.authority;
    return withIsolatedTransaction(this.pool,async (client) => {
      await this.lock(client,input);
      const old=(await client.query("SELECT * FROM acp.worktree_reservation_status WHERE reservation_id=$1",[input.reservationId])).rows[0];
      if(old) {
        const existing=reservationFromRow(old);
        if(Object.entries(input).some(([key,value]) => existing[key as keyof WorktreeReservationInput]!==value)
          || existing.hostIdentifier!==a.hostIdentifier || existing.ownerSessionId!==a.sessionId || existing.applicationVersion!==a.applicationVersion) {
          throw new Error("pre-run reservation aliases different ownership or target");
        }
        return existing; // Exact historical replay never renews or revives.
      }
      await client.query(`INSERT INTO acp.worktree_reservations(reservation_id,repository_binding_id,mission_id,node_id,graph_revision,
        workspace_path,branch_ref,host_identifier,owner_session_id,application_version,provenance_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [input.reservationId,input.repositoryBindingId,input.missionId,input.nodeId,input.graphRevision,input.workspacePath,input.branchRef,
        a.hostIdentifier,a.sessionId,a.applicationVersion,input.provenanceId]);
      return this.required(client,input.reservationId);
    });
  }
  async load(reservationId:StableId<"worktreeReservation">):Promise<WorktreeReservation|undefined> {
    parseStableId(reservationId,"worktreeReservation");
    const row=(await this.pool.query("SELECT * FROM acp.worktree_reservation_status WHERE reservation_id=$1 AND host_identifier=$2",
      [reservationId,this.authority.hostIdentifier])).rows[0];
    return row ? reservationFromRow(row) : undefined;
  }
  async heartbeat(reservationId:StableId<"worktreeReservation">):Promise<WorktreeReservation> {
    parseStableId(reservationId,"worktreeReservation"); const a=this.authority;
    return withIsolatedTransaction(this.pool,async (client) => {
      const before=await this.required(client,reservationId); await this.lock(client,before);
      const changed=await client.query(`UPDATE acp.worktree_reservations SET heartbeat_at=clock_timestamp()
        WHERE reservation_id=$1 AND host_identifier=$2 AND owner_session_id=$3 AND application_version=$4 RETURNING reservation_id`,
      [reservationId,a.hostIdentifier,a.sessionId,a.applicationVersion]);
      if(changed.rowCount!==1) throw new Error("pre-run heartbeat lacks its exact original owner");
      return this.required(client,reservationId);
    });
  }
  /** Read-only bounded inventory. A recovering item grants no reclamation right. */
  async listRecovery(options:{ readonly limit?:number;readonly afterReservationId?:StableId<"worktreeReservation"> }={}):Promise<{
    readonly items:readonly WorktreeReservation[];readonly nextCursor?:StableId<"worktreeReservation">;
  }> {
    const limit=options.limit??20;
    if(!Number.isInteger(limit) || limit<1 || limit>100) throw new TypeError("pre-run recovery page limit must be 1 to 100");
    if(options.afterReservationId!==undefined) parseStableId(options.afterReservationId,"worktreeReservation");
    const rows=(await this.pool.query(`SELECT * FROM acp.worktree_reservation_status WHERE host_identifier=$1 AND state='recovering'
      AND ($2::text IS NULL OR reservation_id::text>$2) ORDER BY reservation_id LIMIT $3`,
    [this.authority.hostIdentifier,options.afterReservationId??null,limit+1])).rows;
    const items=rows.slice(0,limit).map(reservationFromRow);
    return { items,...(rows.length>limit ? { nextCursor:items[items.length-1]!.reservationId } : {}) };
  }
  private async lock(client:QueryExecutor,input:WorktreeReservationInput):Promise<void> {
    await client.query("SELECT acp.lock_worktree_reservation($1,$2,$3,$4)",
      [input.missionId,input.nodeId,input.repositoryBindingId,this.authority.hostIdentifier]);
  }
  private async required(client:QueryExecutor,reservationId:StableId<"worktreeReservation">):Promise<WorktreeReservation> {
    const row=(await client.query("SELECT * FROM acp.worktree_reservation_status WHERE reservation_id=$1 AND host_identifier=$2",
      [reservationId,this.authority.hostIdentifier])).rows[0];
    if(!row) throw new Error("pre-run reservation not found on this host");
    return reservationFromRow(row);
  }
}
function reservationFromRow(row:QueryResultRow):WorktreeReservation {
  const input=parseWorktreeReservation({ reservationId:row.reservation_id,repositoryBindingId:row.repository_binding_id,missionId:row.mission_id,
    nodeId:row.node_id,graphRevision:row.graph_revision,workspacePath:row.workspace_path,branchRef:row.branch_ref,provenanceId:row.provenance_id });
  if(!["held","recovering"].includes(row.state as string) || !Number.isSafeInteger(row.revision) || (row.revision as number)<1
    || !Number.isSafeInteger(row.dispatch_generation) || (row.dispatch_generation as number)<1) {
    throw new Error("invalid pre-run reservation projection");
  }
  return { ...input,dispatchRunId:parseStableId(row.dispatch_run_id,"run"),dispatchGeneration:row.dispatch_generation as number,
    repositoryId:parseStableId(row.repository_id,"repository"),projectId:parseStableId(row.project_id,"project"),
    projectProfileId:parseStableId(row.project_profile_id,"projectProfile"),projectProfileVersion:row.project_profile_version as string,
    hostIdentifier:row.host_identifier as string,ownerSessionId:parseStableId(row.owner_session_id,"workerHostSession"),applicationVersion:row.application_version as string,
    machineFingerprint:row.machine_fingerprint as string,workspaceKey:row.workspace_key as string,physicalRepositoryKey:row.physical_repository_key as string,
    branchKey:row.branch_key as string,pathKey:row.path_key as string,acquiredAt:(row.acquired_at as Date).toISOString(),
    heartbeatAt:(row.heartbeat_at as Date).toISOString(),expiresAt:(row.expires_at as Date).toISOString(),revision:row.revision as number,
    state:row.state as WorktreeReservation["state"] };
}
