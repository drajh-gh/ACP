import { expectOnlyKeys,expectRecord,expectIsoTimestamp,parseStableId,type StableId } from "@acp/domain";
import type { Pool,QueryResultRow } from "pg";
import { withIsolatedTransaction } from "./isolated-transaction.ts";
import { PostgresDispatchStore,type HostRuntimeRegistration } from "./dispatch-store.ts";
import type { WorkerRecoveryAuthority } from "./worker-recovery-store.ts";
import { parseProvisionerProcessRecord,type ProvisionerProcessRecordInput } from "./provisioner-journal.ts";

export interface ProvisionerAdmissionChallenge { readonly nonce:string;readonly epoch:1; }
export interface ProvisionerAdmissionRequest extends ProvisionerProcessRecordInput { readonly challenge:ProvisionerAdmissionChallenge; }
/** Fresh response only, not a persisted bearer capability. Native issuance age,
 * exact suspended ownership, one-shot consumption and closure remain required. */
export interface ProvisionerAdmissionAcknowledgement extends ProvisionerAdmissionRequest {
  readonly fresh:true;
  readonly hostIdentifier:string;
  readonly ownerSessionId:StableId<"workerHostSession">;
  readonly applicationVersion:string;
  readonly provenanceId:StableId<"provenance">;
  readonly treeIdentifier:string;
  readonly rootClaimOwnerId:StableId<"worktreeProvisionerAttempt">;
  readonly reservationId:StableId<"worktreeReservation">;
  readonly reservationRevision:number;
  readonly deadlineAt:string;
  readonly admittedAt:string;
  /** Floor of original deadline minus database admission time, never a renewal.
   * A native consumer must anchor this budget to challenge issuance, not arrival. */
  readonly durationMilliseconds:number;
}
export function parseProvisionerAdmissionRequest(value:unknown):ProvisionerAdmissionRequest {
  const input=expectRecord(value,"provisioner admission"); expectOnlyKeys(input,["attemptId","fence","root","challenge"],"provisioner admission");
  const process=parseProvisionerProcessRecord({ attemptId:input.attemptId,fence:input.fence,root:input.root });
  const challenge=expectRecord(input.challenge,"provisioner challenge"); expectOnlyKeys(challenge,["nonce","epoch"],"provisioner challenge");
  if(typeof challenge.nonce!=="string" || challenge.nonce.length!==32 || !/^[0-9a-f]{32}$/u.test(challenge.nonce) || challenge.epoch!==1) throw new TypeError("exact initial provisioner challenge required");
  return { ...process,challenge:{ nonce:challenge.nonce,epoch:1 } };
}
/** @internal Private fresh-only transaction. There is deliberately no readback,
 * idempotent accepted replay, native effect, renewal, success or hold release. */
export class PostgresProvisionerAdmissionStore {
  private readonly pool:Pool;
  readonly authority:WorkerRecoveryAuthority;
  constructor(pool:Pool,runtime:HostRuntimeRegistration) {
    new PostgresDispatchStore(pool); parseStableId(runtime.sessionId,"workerHostSession");
    if(!runtime.hostIdentifier.trim() || !runtime.applicationVersion.trim()) throw new TypeError("provisioner admission runtime identity required");
    this.pool=pool; this.authority=Object.freeze({ hostIdentifier:runtime.hostIdentifier,sessionId:runtime.sessionId,applicationVersion:runtime.applicationVersion });
  }
  async admit(value:ProvisionerAdmissionRequest):Promise<ProvisionerAdmissionAcknowledgement> {
    const input=parseProvisionerAdmissionRequest(value),a=this.authority,f=input.fence;
    return withIsolatedTransaction(this.pool,async(client)=>{
      await client.query("SELECT acp.lock_provisioner_journal($1)",[input.attemptId]);
      const prior=(await client.query(`SELECT EXISTS(SELECT 1 FROM acp.worktree_provisioner_processes WHERE attempt_id=$1)
        OR EXISTS(SELECT 1 FROM acp.worktree_provisioner_stops WHERE attempt_id=$1)
        OR EXISTS(SELECT 1 FROM acp.worktree_provisioner_admissions WHERE attempt_id=$1) AS already_recorded`,[input.attemptId])).rows[0];
      if(prior?.already_recorded!==false) throw new Error("admission requires a fresh unrecorded provisioner attempt");
      // Never call the historical/idempotent journal API as an admission oracle.
      // Its process hook also inserts the shared exact native root claim.
      await client.query(`INSERT INTO acp.worktree_provisioner_processes(attempt_id,admission_attempt_id,fence_namespace,fence_directory,directory_identity,
        supervision_scope,host_identifier,owner_session_id,application_version,root_process_id,root_process_start_token,root_started_at)
        VALUES($1,$1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)`,[input.attemptId,f.namespace,f.directory,f.directoryIdentity,JSON.stringify(f.scope),
        a.hostIdentifier,a.sessionId,a.applicationVersion,input.root.processId,input.root.processStartToken,input.root.startedAt]);
      const row=(await client.query(`INSERT INTO acp.worktree_provisioner_admissions(attempt_id,challenge_nonce,challenge_epoch)
        VALUES($1,$2,$3) RETURNING to_jsonb(worktree_provisioner_admissions) AS admission`,[input.attemptId,input.challenge.nonce,input.challenge.epoch])).rows[0]?.admission as QueryResultRow|undefined;
      if(!row || row.attempt_id!==input.attemptId || row.challenge_nonce!==input.challenge.nonce || row.challenge_epoch!==1
        || row.host_identifier!==a.hostIdentifier || row.owner_session_id!==a.sessionId || row.application_version!==a.applicationVersion
        || row.root_claim_owner_id!==input.attemptId || !Number.isSafeInteger(row.reservation_revision) || row.reservation_revision<1
        || !Number.isSafeInteger(row.duration_milliseconds) || row.duration_milliseconds<=250 || row.duration_milliseconds>20000) throw new Error("invalid fresh provisioner admission acknowledgement");
      const deadlineAt=expectIsoTimestamp(row.deadline_at,"original provisioner deadline"),admittedAt=expectIsoTimestamp(row.admitted_at,"database admission time");
      if(Date.parse(deadlineAt)<=Date.parse(admittedAt)) throw new Error("invalid provisioner admission time bounds");
      return { ...input,fresh:true,hostIdentifier:a.hostIdentifier,ownerSessionId:a.sessionId,applicationVersion:a.applicationVersion,
        provenanceId:parseStableId(row.provenance_id,"provenance"),treeIdentifier:`Local\\ACP.Provisioner.${input.attemptId}`,rootClaimOwnerId:input.attemptId,
        reservationId:parseStableId(row.reservation_id,"worktreeReservation"),reservationRevision:row.reservation_revision as number,
        deadlineAt,admittedAt,durationMilliseconds:row.duration_milliseconds as number };
    }); // No acknowledgement escapes before the physical COMMIT response.
  }
}
