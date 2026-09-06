import { expectIsoTimestamp,expectString,parseStableId,type StableId } from "@acp/domain";
import type { Pool,QueryResultRow } from "pg";
import type { QueryExecutor } from "./database.ts";
import { withIsolatedTransaction } from "./isolated-transaction.ts";
import { PostgresDispatchStore,type HostRuntimeRegistration } from "./dispatch-store.ts";
import type { WorkerRecoveryAuthority } from "./worker-recovery-store.ts";
import { parseProvisionerProcessRecord,parseProvisionerStopRecord,type ProvisionerProcessRecordInput,type ProvisionerStopRecordInput } from "./provisioner-journal.ts";

export interface ProvisionerJournalReceipt {
  readonly hostIdentifier:string;
  readonly ownerSessionId:StableId<"workerHostSession">;
  readonly applicationVersion:string;
  readonly provenanceId:StableId<"provenance">;
  readonly treeIdentifier:string;
  readonly recordedAt:string;
}
export type ProvisionerProcessRecord=ProvisionerProcessRecordInput&ProvisionerJournalReceipt;
export type ProvisionerStopRecord=ProvisionerStopRecordInput&ProvisionerJournalReceipt;
export interface ProvisionerJournalSnapshot {
  readonly attemptId:StableId<"worktreeProvisionerAttempt">;
  /** Row presence only; not an OS observation, execution permission or provisioning result. */
  readonly state:"unrecorded"|"process_recorded"|"stop_recorded";
  readonly process?:ProvisionerProcessRecord;
  readonly stop?:ProvisionerStopRecord;
}
type Kind="processes"|"stops";
/** Private trusted-producer ledger. No native effect, GO, renewal, recovery claim or release API. */
export class PostgresProvisionerJournalStore {
  private readonly pool:Pool;
  readonly authority:WorkerRecoveryAuthority;
  constructor(pool:Pool,runtime:HostRuntimeRegistration) {
    new PostgresDispatchStore(pool); parseStableId(runtime.sessionId,"workerHostSession");
    if(!runtime.hostIdentifier.trim() || !runtime.applicationVersion.trim()) throw new TypeError("provisioner journal runtime identity required");
    this.pool=pool; this.authority=Object.freeze({ hostIdentifier:runtime.hostIdentifier,sessionId:runtime.sessionId,applicationVersion:runtime.applicationVersion });
  }
  async recordProcess(value:ProvisionerProcessRecordInput):Promise<ProvisionerProcessRecord> {
    const input=parseProvisionerProcessRecord(value);
    return withIsolatedTransaction(this.pool,async(client)=>{
      await client.query("SELECT acp.lock_provisioner_journal($1)",[input.attemptId]);
      const existing=await this.row(client,"processes",input.attemptId);
      if(existing) {
        this.sameOwner(existing);
        if(JSON.stringify(processInput(existing))!==JSON.stringify(input)) throw new Error("provisioner process record aliases different native evidence");
        return processRecord(existing);
      }
      await client.query(`INSERT INTO acp.worktree_provisioner_processes(attempt_id,fence_namespace,fence_directory,directory_identity,
        supervision_scope,host_identifier,owner_session_id,application_version,root_process_id,root_process_start_token,root_started_at)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)`,[...this.common(input),input.root.processId,input.root.processStartToken,input.root.startedAt]);
      const created=await this.row(client,"processes",input.attemptId); if(!created) throw new Error("provisioner process record missing after insertion");
      return processRecord(created);
    });
  }
  async recordStop(value:ProvisionerStopRecordInput):Promise<ProvisionerStopRecord> {
    const input=parseProvisionerStopRecord(value),observation=input.observation,root="root" in observation ? observation.root : undefined;
    return withIsolatedTransaction(this.pool,async(client)=>{
      await client.query("SELECT acp.lock_provisioner_journal($1)",[input.attemptId]);
      const existing=await this.row(client,"stops",input.attemptId);
      if(existing) {
        this.sameOwner(existing);
        if(JSON.stringify(stopInput(existing))!==JSON.stringify(input)) throw new Error("provisioner stop record aliases different sealed evidence");
        return stopRecord(existing);
      }
      await client.query(`INSERT INTO acp.worktree_provisioner_stops(attempt_id,fence_namespace,fence_directory,directory_identity,
        supervision_scope,host_identifier,owner_session_id,application_version,launch_sealed,process_state,reason,exit_code,
        root_process_id,root_process_start_token,root_started_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [...this.common(input),observation.sealed,observation.state,observation.reason,"exitCode" in observation ? observation.exitCode : null,
        root?.processId??null,root?.processStartToken??null,root?.startedAt??null]);
      const created=await this.row(client,"stops",input.attemptId); if(!created) throw new Error("provisioner stop record missing after insertion");
      return stopRecord(created);
    });
  }
  async load(attemptId:StableId<"worktreeProvisionerAttempt">):Promise<ProvisionerJournalSnapshot|undefined> {
    parseStableId(attemptId,"worktreeProvisionerAttempt");
    const row=(await this.pool.query(`SELECT a.attempt_id,to_jsonb(p) AS process,to_jsonb(s) AS stop
      FROM acp.worktree_provisioner_attempts a LEFT JOIN acp.worktree_provisioner_processes p USING(attempt_id)
      LEFT JOIN acp.worktree_provisioner_stops s USING(attempt_id) WHERE a.attempt_id=$1 AND a.host_identifier=$2`,[attemptId,this.authority.hostIdentifier])).rows[0];
    if(!row) return undefined;
    if(row.attempt_id!==attemptId) throw new Error("provisioner journal snapshot identity mismatch");
    const process=row.process===null ? undefined : processRecord(row.process as QueryResultRow),stop=row.stop===null ? undefined : stopRecord(row.stop as QueryResultRow);
    for(const record of [process,stop]) if(record && (record.attemptId!==attemptId || record.hostIdentifier!==this.authority.hostIdentifier)) throw new Error("provisioner journal snapshot scope mismatch");
    return { attemptId,state:stop ? "stop_recorded" : process ? "process_recorded" : "unrecorded",...(process ? { process } : {}),...(stop ? { stop } : {}) };
  }
  private common(input:ProvisionerProcessRecordInput|ProvisionerStopRecordInput):unknown[] {
    const a=this.authority,f=input.fence;
    return [input.attemptId,f.namespace,f.directory,f.directoryIdentity,JSON.stringify(f.scope),a.hostIdentifier,a.sessionId,a.applicationVersion];
  }
  private sameOwner(row:QueryResultRow) {
    const a=this.authority;
    if(row.host_identifier!==a.hostIdentifier || row.owner_session_id!==a.sessionId || row.application_version!==a.applicationVersion) throw new Error("provisioner journal replay requires its exact original actor");
  }
  private async row(client:QueryExecutor,kind:Kind,id:StableId<"worktreeProvisionerAttempt">):Promise<QueryResultRow|undefined> {
    return (await client.query(`SELECT to_jsonb(p) AS snapshot FROM acp.worktree_provisioner_${kind} p WHERE attempt_id=$1 AND host_identifier=$2`,
      [id,this.authority.hostIdentifier])).rows[0]?.snapshot as QueryResultRow|undefined;
  }
}
function commonInput(row:QueryResultRow) {
  return { attemptId:row.attempt_id,fence:{ namespace:row.fence_namespace,directory:row.fence_directory,directoryIdentity:row.directory_identity,scope:row.supervision_scope } };
}
function nativeRoot(row:QueryResultRow) { return { processId:row.root_process_id,processStartToken:row.root_process_start_token,startedAt:row.root_started_at }; }
function processInput(row:QueryResultRow) { return parseProvisionerProcessRecord({ ...commonInput(row),root:nativeRoot(row) }); }
function stopInput(row:QueryResultRow) {
  return parseProvisionerStopRecord({ ...commonInput(row),observation:{ state:row.process_state,sealed:row.launch_sealed,reason:row.reason,
    ...(row.root_process_id===null ? {} : { root:nativeRoot(row) }),...(row.exit_code===null ? {} : { exitCode:row.exit_code }) } });
}
function receipt(row:QueryResultRow):ProvisionerJournalReceipt {
  if(row.tree_identifier!==`Local\\ACP.Provisioner.${parseStableId(row.attempt_id,"worktreeProvisionerAttempt")}`) throw new Error("provisioner journal tree identity mismatch");
  return { hostIdentifier:expectString(row.host_identifier,"journal host"),ownerSessionId:parseStableId(row.owner_session_id,"workerHostSession"),
    applicationVersion:expectString(row.application_version,"journal version"),provenanceId:parseStableId(row.provenance_id,"provenance"),
    treeIdentifier:row.tree_identifier as string,recordedAt:expectIsoTimestamp(row.recorded_at,"journal recorded time") };
}
function processRecord(row:QueryResultRow):ProvisionerProcessRecord { return { ...processInput(row),...receipt(row) }; }
function stopRecord(row:QueryResultRow):ProvisionerStopRecord { return { ...stopInput(row),...receipt(row) }; }
