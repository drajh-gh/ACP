// Genuine 0007 history: no triggers are disabled and no scope column exists yet.
import assert from "node:assert/strict";
import { Pool } from "pg";
import { createStableId } from "@acp/domain";
import { PostgresContextStore,PostgresDispatchStore,PostgresWorkerRuntimeStore } from "../../src/index.ts";
const port=Number(process.argv[2]),phase=process.argv[3];
if(!Number.isInteger(port) || port<1024 || port>65535 || !["before","after"].includes(phase??"")) throw new Error("owned legacy-root fixture phase required");
const pool=new Pool({ connectionString:`postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test`,max:3,connectionTimeoutMillis:3000,statement_timeout:5000,lock_timeout:2000 });
const hostIdentifier="host:root-claim-legacy",applicationVersion="root-legacy-v1",legacy=(prefix:string)=>`${prefix}_00000000-0000-4000-8000-000000000001`;
const workers=new PostgresWorkerRuntimeStore(pool),contexts=new PostgresContextStore(pool),dispatches=new PostgresDispatchStore(pool);
async function clone(table:string,key:string,source:string,overrides:object) {
  await pool.query(`INSERT INTO acp.${table} SELECT (jsonb_populate_record(NULL::acp.${table},to_jsonb(s)||$1::jsonb)).* FROM acp.${table} s WHERE ${key}=$2`,[JSON.stringify(overrides),source]);
}
try {
  if(phase==="before") {
    assert.equal((await pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema='acp' AND table_name='worker_processes' AND column_name='supervision_scope'")).rowCount,0);
    const profile=createStableId("projectProfile"),binding=createStableId("workflowBinding"),template=createStableId("provenance");
    const missionId=createStableId("mission"),nodeId=createStableId("node"),grantId=createStableId("capabilityGrant"),evaluation=createStableId("capabilityGrantEvaluation");
    await clone("project_profiles","profile_id",legacy("pro"),{ profile_id:profile,profile:{ sourceAuthorityRules:{ synthetic:"canonical" } } });
    await clone("project_workflow_bindings","binding_id",legacy("wfb"),{ binding_id:binding,profile_id:profile });
    await clone("runtime_provenance","provenance_id",legacy("prv"),{ provenance_id:template,workflow_binding_id:binding,project_profile_id:profile,host_identifier:hostIdentifier,database_schema_version:"0007" });
    await clone("missions","mission_id",legacy("mis"),{ mission_id:missionId,workflow_binding_id:binding,state:"executing",requested_scope:"Retain genuine unscoped history.",completed_by_evaluation_id:null,transition_provenance_id:template });
    await clone("mission_nodes","node_id",legacy("nod"),{ node_id:nodeId,mission_id:missionId,state:"runnable",dependencies:[],graph_revision:"legacy-root",started_at:null,completed_at:null,provenance_id:template,transition_provenance_id:template });
    const fields={ mission_id:missionId,node_id:nodeId,provenance_id:template,maximum_attempts:3,valid_from:"2000-01-01",expires_at:"2099-01-01" };
    await clone("capability_grant_evaluations","evaluation_id",legacy("cge"),{ ...fields,evaluation_id:evaluation });
    await clone("capability_grants","grant_id",legacy("cgr"),{ ...fields,grant_id:grantId,evaluation_id:evaluation });
    const runtime={ hostIdentifier,sessionId:createStableId("workerHostSession"),applicationVersion,bindings:[{ workflowBindingId:binding,templateProvenanceId:template }] };
    await dispatches.registerRuntime(runtime,{ hostIdentifier,hostKind:"vps",state:"active",maximumCpuIntensive:1,maximumModerateCompute:1,maximumLightweightRead:1,maximumNetworkBound:1,heartbeatTtlSeconds:300,provenanceId:template,transitionProvenanceId:template });
    await contexts.publishNodeContext({ contextRevisionId:createStableId("nodeContextRevision"),missionId,nodeId,expectedRevision:0,graphRevision:"legacy-root",provenanceId:template,
      content:{ objective:"Preserve unscoped history.",nonGoals:["No OS operation."],behavioralContract:{},acceptanceCriteria:[],conflicts:[],unresolvedQuestions:[],nextAction:"Retain history.",
        evidenceIds:[],activeClaimIds:[],previousRunIds:[],approvalIds:[],limits:{ wallTimeMs:30000,maximumTurns:1,maximumOutputBytes:4096 } } });
    const runId=createStableId("run"); await dispatches.request({ runId,missionId,nodeId,grantId,attemptNumber:1,applicationVersion,operation:"synthetic.read",resource:"synthetic:record:1",preferredHostIdentifier:hostIdentifier,provenanceId:template });
    const a=await dispatches.assign(runId,async()=>{}); assert.ok(a);
    assert.equal((await dispatches.prepare({ runId,generation:a.generation,hostSessionId:runtime.sessionId },hostIdentifier,applicationVersion,runtime.sessionId)).state,"ready");
    const packet=await contexts.buildAndRecordContextPacket({ contextPacketId:a.contextPacketId,missionId,nodeId,capabilityGrantId:grantId,runtimeTemplateProvenanceId:template,provenanceId:a.packetProvenanceId });
    assert.equal(packet.schemaVersion,"1.0.0"); const grant=await workers.loadCapabilityGrant(grantId); assert.ok(grant);
    await workers.startRun({ runId,dispatchGeneration:a.generation,packet,attemptNumber:1,hostIdentifier,resourceClass:grant.resourceClass,wallTimeMs:packet.limits.wallTimeMs,provenanceId:a.packetProvenanceId,
      request:{ missionId,nodeId,projectId:packet.projectId,role:packet.workerRole,resourceClass:grant.resourceClass,operation:a.operation,resource:a.resource,mode:grant.mode,workspace:grant.workspace,networkAccess:"none",at:new Date().toISOString() } });
    const workerProcessId=createStableId("workerProcess");
    await pool.query(`INSERT INTO acp.worker_processes(worker_process_id,run_id,mission_id,node_id,process_id,process_start_token,purpose,host_identifier,
      resource_class,state,started_at,deadline_at,heartbeat_at,provenance_id,transition_provenance_id,supervision_kind,tree_identifier)
      SELECT $1,run_id,mission_id,node_id,2147483650,'win32-filetime:0134329999999999999','Synthetic legacy history; no native root',host_identifier,
        resource_class,'running',statement_timestamp(),timeout_at,statement_timestamp(),provenance_id,provenance_id,'windows_job',$3
      FROM acp.worker_runs WHERE run_id=$2`,[workerProcessId,runId,`Local\\ACP.Worker.${workerProcessId}`]);
    const record=await workers.loadWorkerProcess(workerProcessId); assert.ok(record);
    await workers.finishWorkerProcess({ ...record,state:"terminated",exitCode:0,terminationReason:"Synthetic pre-scope closure." });
    await dispatches.closeRuntime(hostIdentifier,runtime.sessionId);
    process.stdout.write("PASS native root legacy: genuine 0007 admitted supervised history retains bigint PID and original token without a scope column\n");
  } else {
    const rows=(await pool.query("SELECT * FROM acp.worker_processes WHERE host_identifier=$1",[hostIdentifier])).rows; assert.equal(rows.length,1);
    const row=rows[0]!; assert.equal(row.supervision_scope,null); assert.equal(row.process_id,"2147483650"); assert.equal(row.process_start_token,"win32-filetime:0134329999999999999");
    assert.equal((await pool.query("SELECT 1 FROM acp.windows_native_root_claims WHERE owner_id=$1",[row.worker_process_id])).rowCount,0);
    assert.equal((await pool.query("SELECT 1 FROM acp.windows_native_root_source('worker',$1)",[row.worker_process_id])).rowCount,0);
    assert.equal((await workers.loadWorkerProcess(row.worker_process_id))?.supervision?.scope,undefined);
    process.stdout.write("PASS native root legacy: 0020 preserves unscoped history without inventing a global claim or recovery scope\n");
  }
} finally { await pool.end(); }
