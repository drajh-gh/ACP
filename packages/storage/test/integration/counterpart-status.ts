import assert from "node:assert/strict";
import { Pool,type QueryResult,type QueryResultRow } from "pg";
import { createStableId,type StableId } from "@acp/domain";
import { PostgresCounterpartMissionStore,type ConnectionPool,type CounterpartMissionStatus } from "../../src/index.ts";
import { counterpartMissionStatusSql } from "../../src/counterpart-status-query.ts";
import { launchRecoveryFixture } from "./launch-recovery-fixture.ts";

const port=Number(process.argv[2]),phase=process.argv[3];
if(!Number.isInteger(port) || port<1024 || port>65535 || !["core","limits","snapshot"].includes(phase??"")) throw new Error("owned database port and exact status phase required");
const pool=new Pool({ connectionString:`postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test`,max:4,
  connectionTimeoutMillis:3000,statement_timeout:5000,lock_timeout:3000 });
const legacy=(prefix:string)=>`${prefix}_00000000-0000-4000-8000-000000000001`;
const provenance=legacy("prv") as StableId<"provenance">,store=new PostgresCounterpartMissionStore(pool,provenance);
let checks=0;
async function check(name:string,action:()=>Promise<void>) { await action(); checks++; process.stdout.write(`PASS counterpart status: ${name}\n`); }
async function clone(table:string,key:string,source:string,overrides:object) {
  const inserted=await pool.query(`INSERT INTO acp.${table} SELECT (jsonb_populate_record(NULL::acp.${table},to_jsonb(source)||$1::jsonb)).*
    FROM acp.${table} source WHERE ${key}=$2`,[JSON.stringify(overrides),source]);
  assert.equal(inserted.rowCount,1,"fixture must clone exactly its known synthetic source");
}
async function mission(requestedScope="Synthetic read-only lifecycle status.") {
  const id=createStableId("mission");
  await clone("missions","mission_id",legacy("mis"),{ mission_id:id,state:"executing",requested_scope:requestedScope,
    completed_by_evaluation_id:null,transition_provenance_id:provenance });
  return id;
}
async function evidence(overrides:object={}) {
  const id=createStableId("evidence");
  await clone("evidence_records","evidence_id",legacy("evd"),{ evidence_id:id,freshness:"stale",accessibility:"inaccessible",sensitivity:"public",...overrides });
  return id;
}
async function candidate(missionId:string,evidenceId:string,options:{ state?:string;head?:string;recordId?:string;candidateId?:string;at?:string }={}) {
  const id=options.recordId??createStableId("event");
  await pool.query(`INSERT INTO acp.candidate_records(record_id,mission_id,candidate_id,state,repository_id,worktree_path,branch,head_sha,evidence_ids,observed_at,provenance_id)
    VALUES($1,$2,$3,$4,$5,'C:\\status-only-synthetic','Feature/ExactCase',$6,$7::jsonb,coalesce($8::timestamptz,statement_timestamp()),$9)`,
  [id,missionId,options.candidateId??createStableId("candidate"),options.state??"merged",createStableId("repository"),options.head??"a".repeat(40),JSON.stringify([evidenceId]),options.at??null,provenance]);
  return id;
}
async function deployment(missionId:string,environment:string,state:string,digest:string|null=null,ids:readonly string[]=[]) {
  const id=createStableId("event");
  await pool.query(`INSERT INTO acp.deployment_records(record_id,mission_id,environment,state,artifact_digest,evidence_ids,observed_at,provenance_id)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,statement_timestamp(),$7)`,[id,missionId,environment,state,digest,JSON.stringify(ids),provenance]);
  return id;
}
async function tracker(missionId:string,sourceVersion="version:1",semanticCategory:string|null="on_development") {
  const id=createStableId("event");
  await pool.query(`INSERT INTO acp.tracker_records(record_id,mission_id,adapter_id,external_id,native_state,semantic_category,source_version,observed_at,provenance_id)
    VALUES($1,$2,'synthetic','ISSUE-1','On development',$3,$4,statement_timestamp(),$5)`,[id,missionId,semanticCategory,sourceVersion,provenance]);
  return id;
}
async function evaluation(missionId:string,status:"passed"|"failed",options:{ legacy?:boolean;receipts?:boolean;freshness?:boolean;disqualifiers?:readonly string[] }={}) {
  const id=createStableId("completionEvaluation");
  await pool.query(`INSERT INTO acp.completion_evaluations(evaluation_id,mission_id,contract_id,contract_version,status,reasons,disqualifiers,
    evaluated_at,provenance_id,required_receipts_verified,evidence_freshness_verified,lifecycle_digest)
    SELECT $1,mission_id,completion_contract_id,completion_contract_version,$2,'[]',$3::jsonb,statement_timestamp(),$4,$6,$7,$8
    FROM acp.missions WHERE mission_id=$5`,[id,status,JSON.stringify(options.disqualifiers??(status==="passed" ? [] : ["Historical failed synthetic evaluation."])),
    provenance,missionId,options.legacy ? false : options.receipts??true,options.legacy ? false : options.freshness??true,
    options.legacy ? `legacy-unverified:${id}` : "synthetic-status-only"]);
  return id;
}
async function counts() {
  const tables=["missions","mission_events","completion_evaluations","candidate_records","deployment_records","acceptance_records","tracker_records",
    "business_completion_records","effect_proposals","worker_runs","worker_launch_intents","filesystem_writer_leases","worktree_reservations"];
  const result:Record<string,string>={};
  for(const table of tables) result[table]=(await pool.query(`SELECT count(*)::text AS n FROM acp.${table}`)).rows[0].n as string;
  return result;
}
try {
  if(phase==="core") {
    await check("exact migration-backfilled evaluation history remains readable without applied authority",async()=>{
      for(const state of ["passed","failed"] as const) {
        const id=await mission(),record=await evaluation(id,state,{ legacy:true,disqualifiers:[] }),s=await store.getMissionStatus(id);
        assert.ok(s); assert.equal(s.completion.appliedEvaluation,null); assert.equal(s.completion.latestEvaluation?.status,state);
        assert.equal(s.completion.latestEvaluation?.evaluationId,record); assert.equal(s.completion.latestEvaluation?.requiredReceiptsVerified,false);
        assert.equal(s.completion.latestEvaluation?.evidenceFreshnessVerified,false);
        assert.equal(s.completion.latestEvaluation?.lifecycleDigest,`legacy-unverified:${record}`);
        assert.equal(s.assessment.kind,"recorded_only");
      }
    });
    await check("mission with no grant, worker or observations returns explicit unobserved fields",async()=>{
      const id=await mission(),before=await counts(),snapshot=await store.getMissionStatus(id); assert.ok(snapshot);
      assert.equal(snapshot.missionId,id); assert.deepEqual(snapshot.nodes,[]);
      assert.deepEqual(snapshot.lifecycle,{ candidate:null,deployments:[],acceptance:null,tracker:null,effects:[],businessCompletion:null });
      assert.deepEqual(snapshot.completion,{ appliedEvaluationId:null,appliedEvaluation:null,latestEvaluation:null });
      assert.deepEqual(snapshot.assessment,{ kind:"recorded_only",freshness:"not_assessed",conflicts:"not_assessed" });
      assert.deepEqual(await counts(),before); assert.equal(await store.getMissionStatus(createStableId("mission")),undefined);
    });
    await check("completed mission keeps all recorded dimensions independent and applied evaluation distinct from later failure",async()=>{
      const id=await mission(),evd=await evidence(),applied=await evaluation(id,"passed");
      await pool.query("UPDATE acp.missions SET state='verifying',transition_provenance_id=$2 WHERE mission_id=$1",[id,provenance]);
      await pool.query("UPDATE acp.missions SET state='complete_for_scope',completed_by_evaluation_id=$2,transition_provenance_id=$3 WHERE mission_id=$1",[id,applied,provenance]);
      const latest=await evaluation(id,"failed"),record=await candidate(id,evd); await deployment(id,"production","failed",null,[evd]); await tracker(id);
      const acceptance=createStableId("event"),business=createStableId("event");
      await pool.query(`INSERT INTO acp.acceptance_records(record_id,mission_id,state,candidate_revision,evidence_ids,observed_at,provenance_id)
        VALUES($1,$2,'passed',$3,$4::jsonb,statement_timestamp(),$5)`,[acceptance,id,"b".repeat(40),JSON.stringify([evd]),provenance]);
      await pool.query(`INSERT INTO acp.business_completion_records(record_id,mission_id,state,evidence_ids,observed_at,provenance_id)
        VALUES($1,$2,'pending','[]',statement_timestamp(),$3)`,[business,id,provenance]);
      const effect=createStableId("effect");
      await clone("effect_proposals","effect_id",legacy("eff"),{ effect_id:effect,mission_id:id,idempotency_key:effect,state:"proposed",
        execution_fencing_token:null,execution_precondition_evaluation_id:null,verification_receipt_id:null,
        provenance_id:provenance,transition_provenance_id:provenance });
      const before=await counts(),s=await store.getMissionStatus(id); assert.ok(s);
      assert.equal(s.state,"complete_for_scope"); assert.equal(s.lifecycle.candidate?.state,"merged");
      assert.equal(s.lifecycle.candidate?.observation?.recordId,record); assert.equal(s.lifecycle.deployments[0]?.state,"failed");
      assert.deepEqual(s.lifecycle.deployments[0]?.artifactVersion,{ status:"unknown" });
      assert.equal(s.lifecycle.acceptance?.candidateRevision,"b".repeat(40)); assert.equal(s.lifecycle.tracker?.semanticCategory,"on_development");
      assert.equal(s.lifecycle.businessCompletion?.state,"pending"); assert.deepEqual(s.lifecycle.effects,[{ effectId:effect,state:"proposed" }]);
      assert.equal(s.completion.appliedEvaluationId,applied); assert.equal(s.completion.appliedEvaluation?.status,"passed");
      assert.equal(s.completion.latestEvaluation?.evaluationId,latest); assert.equal(s.completion.latestEvaluation?.status,"failed");
      assert.equal(s.evidence[0]?.freshness,"stale"); assert.equal(s.evidence[0]?.accessibility,"inaccessible");
      assert.deepEqual(await counts(),before);
      for(const forbidden of ["raw_content_ref","redacted_summary","proposal_digest","verification_plan"]) assert.equal(JSON.stringify(s).includes(forbidden),false);
    });
    await check("latest per-environment state and unknown artifact do not erase observations or invent tracker mapping",async()=>{
      const id=await mission(); await deployment(id,"production","not_deployed"); await deployment(id,"staging","failed","sha256:old");
      const latest=await deployment(id,"staging","verified"); await tracker(id,"unmapped:1",null);
      const s=await store.getMissionStatus(id); assert.ok(s); assert.equal(s.lifecycle.deployments.length,2);
      const staging=s.lifecycle.deployments.find((d)=>d.environment==="staging"); assert.equal(staging?.observation?.recordId,latest);
      assert.equal(staging?.state,"verified"); assert.deepEqual(staging?.artifactVersion,{ status:"unknown" });
      assert.equal(s.lifecycle.tracker?.nativeState,"On development"); assert.equal(s.lifecycle.tracker?.semanticCategory,undefined);
    });
    await check("same-timestamp records use stable ID ordering and preserve all six fractional digits",async()=>{
      const id=await mission(),evd=await evidence(),at="2026-09-01T00:00:00.123456+00:00";
      const ids=[createStableId("event"),createStableId("event")].sort();
      await candidate(id,evd,{ recordId:ids[1]!,state:"superseded",at }); await candidate(id,evd,{ recordId:ids[0]!,state:"merged",at });
      const s=await store.getMissionStatus(id); assert.ok(s); assert.equal(s.lifecycle.candidate?.observation?.recordId,ids[1]);
      assert.equal(s.lifecycle.candidate?.state,"superseded"); assert.equal(s.lifecycle.candidate?.observation?.observedAt,at);
    });
    await check("historical expired waiver stays recorded and does not become live approval",async()=>{
      const id=await mission(),evd=await evidence(),waiver={ authority:"test:operator",reason:"Historical synthetic waiver",scope:"Exact old candidate",
        candidateRevision:"b".repeat(40),waivedAt:"2026-09-01T00:00:00Z",expiresAt:"2026-09-02T00:00:00Z" };
      await pool.query(`INSERT INTO acp.acceptance_records(record_id,mission_id,state,candidate_revision,evidence_ids,waiver,observed_at,provenance_id)
        VALUES($1,$2,'waived',$3,$4::jsonb,$5::jsonb,statement_timestamp(),$6)`,[createStableId("event"),id,waiver.candidateRevision,JSON.stringify([evd]),JSON.stringify(waiver),provenance]);
      const s=await store.getMissionStatus(id); assert.ok(s); assert.equal(s.lifecycle.acceptance?.state,"waived");
      assert.deepEqual(s.lifecycle.acceptance?.state==="waived" ? s.lifecycle.acceptance.waiver : undefined,waiver);
      assert.equal(s.assessment.kind,"recorded_only");
    });
    await check("status succeeds inside a PostgreSQL read-only transaction",async()=>{
      const id=await mission(),client=await pool.connect();
      try {
        await client.query("BEGIN READ ONLY");
        const readonlyStore=new PostgresCounterpartMissionStore({ query:client.query.bind(client),connect:async()=>client },provenance);
        assert.equal((await readonlyStore.getMissionStatus(id))?.missionId,id); await client.query("COMMIT");
      } finally { await client.query("ROLLBACK"); client.release(); }
    });
  }
  if(phase==="limits") {
    await check("malformed latest current evaluation fails without reverting to an older passing evaluation",async()=>{
      for(const bad of [{ status:"passed",options:{ receipts:false } },{ status:"passed",options:{ freshness:false } },
        { status:"failed",options:{ disqualifiers:[] } }] as const) {
        const id=await mission(); await evaluation(id,"passed"); await evaluation(id,bad.status,bad.options);
        await assert.rejects(store.getMissionStatus(id),/inconsistent verification metadata/u);
      }
    });
    await check("restricted, cross-project and missing references deny the whole snapshot",async()=>{
      const otherProject=createStableId("project");
      await pool.query("INSERT INTO acp.projects(project_id,display_name) VALUES($1,'Other synthetic status project')",[otherProject]);
      for(const evd of [await evidence({ sensitivity:"restricted" }),await evidence({ project_id:otherProject }),createStableId("evidence")]) {
        const id=await mission(); await candidate(id,evd);
        await assert.rejects(store.getMissionStatus(id),/invalid or undisclosable references/u);
        const row=(await pool.query(counterpartMissionStatusSql,[id,200,50,65536])).rows[0];
        assert.equal(row.snapshot,null); assert.equal(row.status_error,"invalid_references");
      }
    });
    await check("deployment evidence is subject to the same disclosure boundary as candidate evidence",async()=>{
      const id=await mission(),evd=await evidence({ sensitivity:"restricted" }); await deployment(id,"staging","verified","sha256:test",[evd]);
      await assert.rejects(store.getMissionStatus(id),/invalid or undisclosable references/u);
    });
    await check("malformed latest records fail rather than falling back to older favorable observations",async()=>{
      const id=await mission(),evd=await evidence(); await candidate(id,evd); await candidate(id,evd,{ candidateId:createStableId("event") });
      await assert.rejects(store.getMissionStatus(id),/Invalid candidate identifier/u);
      const second=await mission(); await tracker(second); await tracker(second,"");
      await assert.rejects(store.getMissionStatus(second),/non-empty string/u);
    });
    await check("node and environment overflow return bounded errors instead of partial state",async()=>{
      const id=await mission();
      await pool.query(`INSERT INTO acp.mission_nodes SELECT (jsonb_populate_record(NULL::acp.mission_nodes,to_jsonb(n)||jsonb_build_object(
        'node_id','nod_'||gen_random_uuid()::text,'mission_id',$1::text,'state','pending','started_at',NULL,'completed_at',NULL,
        'dependencies','[]'::jsonb,'provenance_id',$2::text,'transition_provenance_id',$2::text))).*
        FROM acp.mission_nodes n CROSS JOIN generate_series(1,201) WHERE node_id=$3`,[id,provenance,legacy("nod")]);
      await assert.rejects(store.getMissionStatus(id),/bounded snapshot/u);
      const environments=await mission(); for(let i=0;i<51;i++) await deployment(environments,`environment-${i}`,"not_deployed");
      await assert.rejects(store.getMissionStatus(environments),/bounded snapshot/u);
    });
    await check("effect and evidence-array overflow is denied before exposing a partial collection",async()=>{
      const id=await mission();
      await pool.query(`INSERT INTO acp.effect_proposals SELECT (jsonb_populate_record(NULL::acp.effect_proposals,to_jsonb(e)||jsonb_build_object(
        'effect_id',fresh.id,'mission_id',$1::text,'idempotency_key',fresh.id,'state','proposed','execution_fencing_token',NULL,
        'execution_precondition_evaluation_id',NULL,'verification_receipt_id',NULL,'provenance_id',$2::text,'transition_provenance_id',$2::text))).*
        FROM acp.effect_proposals e CROSS JOIN (SELECT 'eff_'||gen_random_uuid()::text AS id FROM generate_series(1,201)) fresh WHERE effect_id=$3`,
      [id,provenance,legacy("eff")]);
      await assert.rejects(store.getMissionStatus(id),/bounded snapshot/u);
      const excessive=await mission();
      await deployment(excessive,"staging","verified",null,Array.from({ length:201 },()=>createStableId("evidence")));
      const row=(await pool.query(counterpartMissionStatusSql,[excessive,200,50,65536])).rows[0];
      assert.equal(row.status_error,"too_large"); assert.equal(row.snapshot,null);
    });
    await check("UTF-8 response cap is enforced in SQL before any oversized payload leaves the database",async()=>{
      const id=await mission("ž".repeat(40000)),row=(await pool.query(counterpartMissionStatusSql,[id,200,50,65536])).rows[0];
      assert.equal(row.status_error,"too_large"); assert.equal(row.snapshot,null);
      await assert.rejects(store.getMissionStatus(id),/bounded snapshot/u);
    });
  }
  if(phase==="snapshot") {
    await check("a commit while the real status SELECT waits cannot mix mission and lifecycle revisions",async()=>{
      const id=await mission(),evd=await evidence(); await candidate(id,evd); await tracker(id);
      const producer=await pool.connect(),lockKey=`acp:status-snapshot-test:${id}`;
      let pending:Promise<CounterpartMissionStatus|undefined>|undefined;
      const gatedPool:ConnectionPool={ connect:async()=>{ throw new Error("status must not open a write transaction"); },
        async query<R extends QueryResultRow>(text:string,values?:unknown[]):Promise<QueryResult<R>> {
          assert.equal(text,counterpartMissionStatusSql);
          // Test-only barrier after statement snapshot creation. The production
          // statement has neither this lock nor any other mutation.
          const gated=text.replace(/^WITH/u,"WITH status_test_gate AS MATERIALIZED (SELECT pg_advisory_xact_lock(hashtextextended($5,0))),")
            .replace("FROM mission m CROSS JOIN checks\n","FROM mission m CROSS JOIN checks CROSS JOIN status_test_gate\n");
          assert.notEqual(gated,text); return pool.query<R>(gated,[...(values??[]),lockKey]);
        } };
      try {
        await producer.query("BEGIN"); const pid=(await producer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
        await producer.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[lockKey]);
        await producer.query("UPDATE acp.missions SET state='verifying',transition_provenance_id=$2 WHERE mission_id=$1",[id,provenance]);
        const newCandidate=createStableId("event"),newTracker=createStableId("event");
        await producer.query(`INSERT INTO acp.candidate_records SELECT (jsonb_populate_record(NULL::acp.candidate_records,to_jsonb(c)||jsonb_build_object(
          'record_id',$2::text,'state','abandoned','observed_at',statement_timestamp()))).* FROM acp.candidate_records c WHERE mission_id=$1`,[id,newCandidate]);
        await producer.query(`INSERT INTO acp.tracker_records SELECT (jsonb_populate_record(NULL::acp.tracker_records,to_jsonb(t)||jsonb_build_object(
          'record_id',$2::text,'native_state','Released','semantic_category','released','source_version','version:2','observed_at',statement_timestamp()))).*
          FROM acp.tracker_records t WHERE mission_id=$1`,[id,newTracker]);
        pending=new PostgresCounterpartMissionStore(gatedPool,provenance).getMissionStatus(id); void pending.catch(()=>{});
        let blocked=false;
        for(let attempt=0;attempt<100;attempt++) {
          blocked=(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE NOT granted AND $1=ANY(pg_blocking_pids(pid))) AS blocked",[pid])).rows[0].blocked as boolean;
          if(blocked) break; await new Promise((done)=>setTimeout(done,10));
        }
        assert.equal(blocked,true,"actual SELECT must wait while producer is uncommitted");
        await producer.query("COMMIT"); const beforeCommit=await pending; assert.ok(beforeCommit);
        assert.equal(beforeCommit.state,"executing"); assert.equal(beforeCommit.lifecycle.candidate?.state,"merged");
        assert.equal(beforeCommit.lifecycle.tracker?.sourceVersion,"version:1");
        const afterCommit=await store.getMissionStatus(id); assert.ok(afterCommit); assert.equal(afterCommit.state,"verifying");
        assert.equal(afterCommit.lifecycle.candidate?.observation?.recordId,newCandidate); assert.equal(afterCommit.lifecycle.candidate?.state,"abandoned");
        assert.equal(afterCommit.lifecycle.tracker?.observation?.recordId,newTracker); assert.equal(afterCommit.lifecycle.tracker?.sourceVersion,"version:2");
      } finally { await producer.query("ROLLBACK"); producer.release(); if(pending) await pending.catch(()=>{}); }
    });
    await check("status remains readable after runtime closure and workflow-binding retirement without worker admission",async()=>{
      const f=await launchRecoveryFixture(pool,"host:read-only-status-retired","0015"),assigned=await f.assignment();
      await f.dispatches.closeRuntime(f.runtime.hostIdentifier,f.runtime.sessionId);
      await pool.query("UPDATE acp.project_workflow_bindings SET retired_at=statement_timestamp() WHERE binding_id=$1",[f.binding]);
      const before=await counts(),retiredStore=new PostgresCounterpartMissionStore(pool,f.template),s=await retiredStore.getMissionStatus(assigned.a.missionId);
      assert.ok(s); assert.equal(s.missionId,assigned.a.missionId); assert.equal(s.nodes[0]?.state,"running");
      assert.equal((await pool.query("SELECT 1 FROM acp.worker_runs WHERE run_id=$1",[assigned.a.runId])).rowCount,0);
      assert.deepEqual(await counts(),before);
    });
  }
  assert.ok(checks>0); process.stdout.write(`Counterpart status integration: ${checks} ${phase} checks passed.\n`);
} finally { await pool.end(); }
