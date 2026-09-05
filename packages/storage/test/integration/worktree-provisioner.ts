import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool,type QueryResult,type QueryResultRow } from "pg";
import { createStableId } from "@acp/domain";
import { PostgresRepositoryBindingStore,PostgresWorktreeReservationStore,PostgresWorktreeProvisionerStore,PostgresRuntimeStore,
  type WorktreeProvisionerAttemptInput } from "../../src/index.ts";
import { launchRecoveryFixture } from "./launch-recovery-fixture.ts";

const port=Number(process.argv[2]),phase=process.argv[3];
if(!Number.isInteger(port) || port<1024 || port>65535 || !["core","races","expiry","upgrade"].includes(phase??"")) throw new Error("owned database port and exact provisioner phase required");
const pool=new Pool({ connectionString:`postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test`,max:4,
  connectionTimeoutMillis:3000,statement_timeout:5000,lock_timeout:3000 });
let checks=0,identities=0;
const identity=()=>`win32-dir:12345678:${(++identities).toString(16).padStart(16,"0")}`;
async function check(name:string,action:()=>Promise<void>) { await action(); checks++; process.stdout.write(`PASS provisioner plans: ${name}\n`); }
try {
  const f=await launchRecoveryFixture(pool,"host:provisioner-plan-check","0016");
  const registry=new PostgresRepositoryBindingStore(pool,f.runtime),holds=new PostgresWorktreeReservationStore(pool,f.runtime),plans=new PostgresWorktreeProvisionerStore(pool,f.runtime);
  async function target(deadlineMs=15000,assignmentTtlMs=60000,directRoot=false) {
    const reservationId=createStableId("worktreeReservation"),workspacePath=directRoot ? `C:\\${reservationId}` : `C:\\ACP-provisioner-tests\\planned\\${reservationId}`;
    const assigned=await f.assignment(undefined,workspacePath,true,60000,assignmentTtlMs),repoId=createStableId("repositoryBinding");
    const repo={ repositoryBindingId:repoId,repositoryId:createStableId("repository"),projectId:assigned.packet.projectId,machineFingerprint:"b".repeat(64),
      checkout:{ path:`C:\\ACP-provisioner-tests\\repos\\${repoId}`,identity:identity() },
      commonGitDirectory:{ path:`C:\\ACP-provisioner-tests\\repos\\${repoId}\\.git`,identity:identity() },
      observedAt:((await pool.query("SELECT clock_timestamp() AS now")).rows[0].now as Date).toISOString(),provenanceId:assigned.a.packetProvenanceId };
    await registry.recordRepository(repo);
    const hold=await holds.reserve({ reservationId,repositoryBindingId:repoId,missionId:assigned.a.missionId,nodeId:assigned.a.nodeId,
      graphRevision:"launch-recovery-check",workspacePath,branchRef:"refs/heads/Feature/PlanCase",provenanceId:assigned.a.packetProvenanceId });
    const times=(await pool.query("SELECT to_jsonb(clock_timestamp()) AS observed,to_jsonb(least(clock_timestamp()+$1*interval '1 millisecond',expires_at-interval '10 milliseconds')) AS deadline FROM acp.worktree_reservations WHERE reservation_id=$2",[deadlineMs,reservationId])).rows[0];
    const input:WorktreeProvisionerAttemptInput={ attemptId:createStableId("worktreeProvisionerAttempt"),reservationId,reservationRevision:hold.revision,
      baseRevision:"a".repeat(40),reportedParent:{ path:"C:\\ACP-provisioner-tests\\planned",identity:identity(),observedAt:times.observed as string },
      fencePlan:{ namespace:"acp-worktree-provisioner-v1",directory:"C:\\ACP-planned-provisioner-fences" },deadlineAt:times.deadline as string };
    return { assigned,repo,hold,input };
  }
  async function exactTime(at:string,shiftMicros=0) {
    return (await pool.query("SELECT to_jsonb($1::timestamptz+$2*interval '1 microsecond') AS at",[at,shiftMicros])).rows[0].at as string;
  }
  async function absent(input:WorktreeProvisionerAttemptInput) {
    assert.equal(await plans.load(input.attemptId),undefined);
    assert.equal((await pool.query("SELECT 1 FROM acp.mission_events WHERE event_type='filesystem.provisioner-planned' AND idempotency_key=$1",[input.attemptId])).rowCount,0);
    assert.equal((await pool.query("SELECT 1 FROM acp.filesystem_exclusion_keys WHERE reservation_id=$1",[input.reservationId])).rowCount,4);
  }
  async function direct(client:{ query:Pool["query"] },input:WorktreeProvisionerAttemptInput,extraSql="",extraValues:unknown[]=[]) {
    return client.query(`INSERT INTO acp.worktree_provisioner_attempts(attempt_id,reservation_id,reservation_revision,base_revision,
      parent_path,parent_identity,parent_observed_at,fence_namespace,fence_directory,deadline_at,host_identifier,owner_session_id,application_version${extraSql})
      VALUES($1,$2,$3,$4,$5,$6,$7::timestamptz,$8,$9,$10::timestamptz,$11,$12,$13${extraValues.map((_,i)=>`,$${i+14}`).join("")})`,
    [input.attemptId,input.reservationId,input.reservationRevision,input.baseRevision,input.reportedParent.path,input.reportedParent.identity,
      input.reportedParent.observedAt,input.fencePlan.namespace,input.fencePlan.directory,input.deadlineAt,
      f.runtime.hostIdentifier,f.runtime.sessionId,f.runtime.applicationVersion,...extraValues]);
  }
  function intercepted(beforeCommit:(client:{ query:Pool["query"] })=>Promise<void>,lost=false) {
    return new PostgresWorktreeProvisionerStore({ options:pool.options,async connect() {
      const client=await pool.connect();
      return { release:()=>client.release(),async query<R extends QueryResultRow>(text:string,values?:unknown[]):Promise<QueryResult<R>> {
        if(text==="COMMIT") await beforeCommit(client);
        const result=await client.query<R>(text,values);
        if(text==="COMMIT" && lost) throw new Error("synthetic lost actual plan COMMIT acknowledgement");
        return result;
      } };
    } } as unknown as Pool,f.runtime);
  }
  async function migration(direction:"up"|"down") {
    const client=await pool.connect();
    try { await client.query("BEGIN"); await client.query(await readFile(new URL(`../../migrations/0016_worktree_provisioner_attempts${direction==="down" ? ".down" : ""}.sql`,import.meta.url),"utf8")); await client.query("COMMIT"); }
    finally { await client.query("ROLLBACK"); client.release(); }
  }
  async function waitPast(at:string) {
    const ms=(await pool.query("SELECT greatest(0,extract(epoch FROM ($1::timestamptz-clock_timestamp()))*1000)::float8 AS ms",[at])).rows[0].ms as number;
    await new Promise((done)=>setTimeout(done,Math.ceil(ms)+30));
  }
  async function waitBlocked(pid:number) {
    for(let attempt=0;attempt<100;attempt++) {
      if((await pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE NOT granted AND $1=ANY(pg_blocking_pids(pid))) AS blocked",[pid])).rows[0].blocked) return;
      await new Promise((done)=>setTimeout(done,10));
    }
    throw new Error("actual provisioner statement did not block on the exact incumbent");
  }
  if(phase==="core") {
    await check("direct-root prospective targets are explicitly unsupported without widening native parent-path handling",async()=>{
      const x=await target(15000,60000,true);
      await assert.rejects(direct(pool,{ ...x.input,reportedParent:{ ...x.input.reportedParent,path:"C:\\" } }),/direct-root/u);
      await absent(x.input);
    });
    await check("a later hold revision makes the immutable earlier plan recovery history without renewing it",async()=>{
      const x=await target(),p=await plans.plan(x.input); await holds.heartbeat(x.hold.reservationId);
      assert.deepEqual(await plans.load(p.attemptId),{ ...p,state:"recovering" });
      assert.deepEqual(await plans.plan(x.input),{ ...p,state:"recovering" });
      assert.ok((await plans.listRecovery()).items.some((i)=>i.attemptId===p.attemptId));
      assert.equal((await holds.load(x.hold.reservationId))?.revision,x.hold.revision+1);
    });
    await check("one exact concurrent plan derives original target and authority without native or worker records",async()=>{
      const x=await target(),[left,right]=await Promise.all([plans.plan(x.input),plans.plan(x.input)]);
      assert.deepEqual(left,right); assert.equal(left.state,"planned"); assert.equal(left.missionId,x.hold.missionId);
      assert.equal(left.dispatchRunId,x.hold.dispatchRunId); assert.equal(left.dispatchGeneration,x.hold.dispatchGeneration);
      assert.equal(left.workspacePath,x.hold.workspacePath); assert.equal(left.branchRef,"refs/heads/Feature/PlanCase");
      assert.deepEqual(left.commonGitDirectory,x.repo.commonGitDirectory); assert.equal(left.ownerSessionId,f.runtime.sessionId);
      assert.equal(left.provenanceId,x.hold.provenanceId); assert.equal(left.fenceKey,`${x.input.attemptId}.provision`);
      assert.equal(left.reportedParent.observedAt,await exactTime(x.input.reportedParent.observedAt));
      assert.equal(left.deadlineAt,await exactTime(x.input.deadlineAt)); assert.deepEqual(await holds.load(x.hold.reservationId),x.hold);
      for(const [table,predicate,id] of [["worker_runs","run_id",left.dispatchRunId],["worker_launch_intents","run_id",left.dispatchRunId],
        ["worker_processes","run_id",left.dispatchRunId],["worktree_bindings","mission_id",left.missionId]] as const) {
        assert.equal((await pool.query(`SELECT 1 FROM acp.${table} WHERE ${predicate}=$1`,[id])).rowCount,0);
      }
      assert.equal((await pool.query("SELECT 1 FROM acp.mission_events WHERE event_type='filesystem.provisioner-planned' AND idempotency_key=$1",[left.attemptId])).rowCount,1);
      assert.equal((await pool.query("SELECT 1 FROM acp.filesystem_exclusion_keys WHERE reservation_id=$1",[left.reservationId])).rowCount,4);
    });
    await check("direct SQL cannot substitute derived identity, timestamps or planned fence key",async()=>{
      const x=await target();
      await direct(pool,x.input,",mission_id,node_id,graph_revision,provenance_id,dispatch_run_id,dispatch_generation,fence_key,created_at,workspace_path,branch_ref",
        [createStableId("mission"),createStableId("node"),"forged",createStableId("provenance"),createStableId("run"),999,"worker-fence","2000-01-01","C:\\WrongTarget","refs/heads/Wrong"]);
      const p=await plans.load(x.input.attemptId); assert.ok(p); assert.equal(p.missionId,x.hold.missionId); assert.equal(p.nodeId,x.hold.nodeId);
      assert.equal(p.graphRevision,x.hold.graphRevision); assert.equal(p.provenanceId,x.hold.provenanceId); assert.equal(p.dispatchGeneration,x.hold.dispatchGeneration);
      assert.equal(p.workspacePath,x.hold.workspacePath); assert.equal(p.branchRef,x.hold.branchRef); assert.ok(Date.parse(p.createdAt)>Date.parse("2026-01-01"));
      assert.equal(p.fenceKey,`${p.attemptId}.provision`);
    });
    await check("changed replay terms and a second attempt on the same hold are permanently denied",async()=>{
      const x=await target(),p=await plans.plan(x.input);
      for(const changed of [{ baseRevision:"b".repeat(40) },{ reservationRevision:x.input.reservationRevision+1 },
        { reportedParent:{ ...x.input.reportedParent,identity:identity() } },{ reportedParent:{ ...x.input.reportedParent,path:"C:\\OtherParent" } },
        { reportedParent:{ ...x.input.reportedParent,observedAt:await exactTime(x.input.reportedParent.observedAt,1) } },
        { deadlineAt:await exactTime(x.input.deadlineAt,1) },{ fencePlan:{ ...x.input.fencePlan,directory:"C:\\OtherPlanFence" } }]) {
        await assert.rejects(plans.plan({ ...x.input,...changed }),/aliases different/u);
      }
      await assert.rejects(plans.plan({ ...x.input,attemptId:createStableId("worktreeProvisionerAttempt") }),/duplicate key/u);
      assert.deepEqual(await plans.load(p.attemptId),p);
      const shifted={ ...x.input,deadlineAt:x.input.deadlineAt.replace("+00:00","Z"),
        reportedParent:{ ...x.input.reportedParent,observedAt:x.input.reportedParent.observedAt.replace("+00:00","Z") } };
      assert.deepEqual(await plans.plan(shifted),p);
      const offsets=(await pool.query(`SELECT to_char(($1::timestamptz AT TIME ZONE 'UTC')+interval '2 hours','YYYY-MM-DD"T"HH24:MI:SS.US')||'+02:00' AS observed,
        to_char(($2::timestamptz AT TIME ZONE 'UTC')+interval '2 hours','YYYY-MM-DD"T"HH24:MI:SS.US')||'+02:00' AS deadline`,
        [x.input.reportedParent.observedAt,x.input.deadlineAt])).rows[0];
      assert.deepEqual(await plans.plan({ ...x.input,reportedParent:{ ...x.input.reportedParent,observedAt:offsets.observed as string },deadlineAt:offsets.deadline as string }),p);
    });
    await check("wrong original actor or stale revision cannot plan or alias history",async()=>{
      const x=await target();
      for(const actor of [{ ...f.runtime,sessionId:createStableId("workerHostSession") },{ ...f.runtime,hostIdentifier:"host:foreign-provisioner" },
        { ...f.runtime,applicationVersion:"foreign-app" }]) {
        await assert.rejects(new PostgresWorktreeProvisionerStore(pool,actor).plan(x.input),/exact live original/u);
      }
      await holds.heartbeat(x.hold.reservationId); await assert.rejects(plans.plan(x.input),/exact live original/u); await absent(x.input);
    });
    await check("wrong parent, stale/future observation, oversized deadline and target-overlapping fence fail before recording",async()=>{
      const x=await target();
      for(const input of [{ ...x.input,reportedParent:{ ...x.input.reportedParent,path:"C:\\WrongParent" } },
        { ...x.input,reportedParent:{ ...x.input.reportedParent,observedAt:await exactTime(x.input.reportedParent.observedAt,-6000000) } },
        { ...x.input,reportedParent:{ ...x.input.reportedParent,observedAt:await exactTime(x.input.reportedParent.observedAt,1000000) } },
        { ...x.input,deadlineAt:await exactTime(x.hold.expiresAt,1000000) },
        ...[x.hold.workspacePath,x.hold.workspacePath+"\\fence",x.repo.checkout.path].map((directory)=>({ ...x.input,fencePlan:{ ...x.input.fencePlan,directory } }))]) {
        await assert.rejects(plans.plan(input),/reported parent|fence directory/u); await absent(x.input);
      }
    });
    await check("lost actual COMMIT acknowledgement is recovered by immutable exact replay",async()=>{
      const x=await target(),lost=intercepted(async()=>{},true);
      await assert.rejects(lost.plan(x.input),/lost actual/u); const p=await plans.load(x.input.attemptId); assert.ok(p);
      assert.deepEqual(await plans.plan(x.input),p); assert.deepEqual(await holds.load(x.hold.reservationId),x.hold);
    });
    await check("direct mutation and populated downgrade cannot discard attempt history",async()=>{
      const x=await target(),p=await plans.plan(x.input);
      for(const sql of ["UPDATE acp.worktree_provisioner_attempts SET base_revision=base_revision WHERE attempt_id=$1",
        "DELETE FROM acp.worktree_provisioner_attempts WHERE attempt_id=$1"]) await assert.rejects(pool.query(sql,[p.attemptId]),/immutable|append.only/u);
      await assert.rejects(pool.query("TRUNCATE acp.worktree_provisioner_attempts"),/immutable|append.only/u);
      await assert.rejects(migration("down"),/retained provisioner plan history/u); assert.deepEqual(await plans.load(p.attemptId),p);
    });
  }
  if(phase==="expiry") {
    await check("deadline expiry preserves immutable replay and keys and does not authorize a second attempt",async()=>{
      const x=await target(250),p=await plans.plan(x.input); await waitPast(p.deadlineAt);
      const expired={ ...p,state:"recovering" }; assert.deepEqual(await plans.load(p.attemptId),expired); assert.deepEqual(await plans.plan(x.input),expired);
      const fresh=(await pool.query("SELECT to_jsonb(clock_timestamp()) AS observed,to_jsonb(clock_timestamp()+interval '1 second') AS deadline")).rows[0];
      await assert.rejects(plans.plan({ ...x.input,attemptId:createStableId("worktreeProvisionerAttempt"),
        reportedParent:{ ...x.input.reportedParent,observedAt:fresh.observed as string },deadlineAt:fresh.deadline as string }),/duplicate key/u);
      assert.deepEqual(await holds.load(x.hold.reservationId),x.hold);
      assert.equal((await pool.query("SELECT 1 FROM acp.filesystem_exclusion_keys WHERE reservation_id=$1",[x.hold.reservationId])).rowCount,4);
    });
    await check("a plan crossing its exact immutable deadline at COMMIT rolls back attempt and audit",async()=>{
      const x=await target(250),delayed=intercepted(async()=>{ await waitPast(x.input.deadlineAt); });
      await assert.rejects(delayed.plan(x.input),/ended before commit/u); await absent(x.input);
    });
    await check("parent observation freshness is rechecked after INSERT immediately before COMMIT",async()=>{
      const x=await target(),delayed=intercepted(async()=>{ await waitPast(await exactTime(x.input.reportedParent.observedAt,5100000)); });
      await assert.rejects(delayed.plan(x.input),/reported observation ended before commit/u); await absent(x.input);
    });
    await check("same-transaction heartbeat cannot move the accepted hold revision before COMMIT",async()=>{
      const x=await target(),changed=intercepted(async(client)=>{
        await client.query("UPDATE acp.worktree_reservations SET heartbeat_at=clock_timestamp() WHERE reservation_id=$1",[x.hold.reservationId]);
      });
      await assert.rejects(changed.plan(x.input),/ended before commit/u); await absent(x.input);
      assert.deepEqual(await holds.load(x.hold.reservationId),x.hold);
    });
    await check("same-transaction runtime closure cannot leave a planned attempt or creation event",async()=>{
      const x=await target(),changed=intercepted(async(client)=>{
        await client.query("UPDATE acp.worker_host_sessions SET state='closed' WHERE host_identifier=$1",[f.runtime.hostIdentifier]);
      });
      await assert.rejects(changed.plan(x.input),/ended before commit/u); await absent(x.input);
      assert.equal((await holds.load(x.hold.reservationId))?.state,"held");
    });
    await check("assignment expiry and a later generation cannot revive an unplanned original hold",async()=>{
      const x=await target(300,1000); await waitPast(x.hold.expiresAt);
      const next=await f.dispatches.assign(x.assigned.a.runId,async()=>{}); assert.ok(next); assert.equal(next.generation,x.hold.dispatchGeneration+1);
      await assert.rejects(plans.plan(x.input),/exact live original/u); await absent(x.input);
      assert.equal((await holds.load(x.hold.reservationId))?.state,"recovering");
    });
    await check("host-scoped recovery pages are bounded, keyset-ordered and grant no reclaim operation",async()=>{
      const inputs=[];
      for(let i=0;i<3;i++) { const x=await target(250); inputs.push(x.input); await plans.plan(x.input); }
      await waitPast(inputs[2]!.deadlineAt);
      const first=await plans.listRecovery({ limit:1 }); assert.equal(first.items.length,1); assert.ok(first.nextCursor);
      const second=await plans.listRecovery({ limit:1,afterAttemptId:first.nextCursor }); assert.equal(second.items.length,1);
      assert.ok(second.items[0]!.attemptId>first.items[0]!.attemptId);
      assert.deepEqual(await new PostgresWorktreeProvisionerStore(pool,{ ...f.runtime,hostIdentifier:"host:other-provisioner" }).listRecovery(),{ items:[] });
      for(const input of inputs) { const p=await plans.plan(input); assert.equal(p.state,"recovering"); }
      await assert.rejects(plans.listRecovery({ limit:101 }),/limit/u);
    });
    await check("old owner may replay after runtime replacement but the replacement cannot alias or inherit the plan",async()=>{
      const x=await target(),p=await plans.plan(x.input); await f.replaceOwner();
      assert.deepEqual(await plans.plan(x.input),{ ...p,state:"recovering" });
      const replacement=new PostgresWorktreeProvisionerStore(pool,f.runtime);
      assert.equal((await replacement.load(p.attemptId))?.state,"recovering");
      await assert.rejects(replacement.plan(x.input),/aliases different/u);
    });
  }
  if(phase==="races") {
    await check("a concurrent heartbeat wins its row lock and the old revision is denied after it commits",async()=>{
      const x=await target(),client=await pool.connect(); let pending:Promise<unknown>|undefined;
      try {
        await client.query("BEGIN"); const pid=(await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
        await client.query("SELECT acp.lock_worktree_provisioner_plan($1)",[x.hold.reservationId]);
        await client.query("UPDATE acp.worktree_reservations SET heartbeat_at=clock_timestamp() WHERE reservation_id=$1",[x.hold.reservationId]);
        pending=assert.rejects(plans.plan(x.input),/exact live original/u); await waitBlocked(pid);
        await client.query("COMMIT"); await pending; await absent(x.input);
        assert.equal((await holds.load(x.hold.reservationId))?.revision,x.hold.revision+1);
      } finally { await client.query("ROLLBACK"); client.release(); if(pending) await pending; }
    });
    await check("concurrent repository retirement denies a waiting plan while retaining the hold keys",async()=>{
      const x=await target(),client=await pool.connect(); let pending:Promise<unknown>|undefined;
      try {
        await client.query("BEGIN"); const pid=(await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
        await client.query(`INSERT INTO acp.repository_binding_retirements(repository_binding_id,host_identifier,owner_session_id,application_version,provenance_id,reason)
          VALUES($1,$2,$3,$4,$5,'Synthetic concurrent provisioner retirement.')`,[x.repo.repositoryBindingId,f.runtime.hostIdentifier,f.runtime.sessionId,f.runtime.applicationVersion,x.hold.provenanceId]);
        pending=assert.rejects(plans.plan(x.input),/exact live original/u); await waitBlocked(pid);
        await client.query("COMMIT"); await pending; await absent(x.input);
      } finally { await client.query("ROLLBACK"); client.release(); if(pending) await pending; }
    });
    await check("concurrent dispatch cancellation denies a waiting plan without creating partial history",async()=>{
      const x=await target(),client=await pool.connect(); let pending:Promise<unknown>|undefined;
      try {
        await client.query("BEGIN"); const pid=(await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
        await client.query("UPDATE acp.worker_dispatches SET state='cancelled',reason='Synthetic concurrent provisioner cancellation.' WHERE run_id=$1",[x.assigned.a.runId]);
        pending=assert.rejects(plans.plan(x.input),/exact live original/u); await waitBlocked(pid);
        await client.query("COMMIT"); await pending; await absent(x.input);
      } finally { await client.query("ROLLBACK"); client.release(); if(pending) await pending; }
    });
    await check("actual worker admission denies fresh plans and turns an earlier plan into retained recovery history",async()=>{
      for(const existing of [false,true]) {
        const x=await target(); if(existing) await plans.plan(x.input);
        await f.workers.startRun(x.assigned.start);
        if(existing) assert.equal((await plans.load(x.input.attemptId))?.state,"recovering");
        else { await assert.rejects(plans.plan(x.input),/exact live original/u); await absent(x.input); }
      }
    });
    await check("racing actual worker admission cannot leave a planned projection",async()=>{
      const x=await target(),[planned,started]=await Promise.allSettled([plans.plan(x.input),f.workers.startRun(x.assigned.start)]);
      assert.equal(started.status,"fulfilled");
      if(planned.status==="fulfilled") assert.equal((await plans.load(x.input.attemptId))?.state,"recovering");
      else { assert.match(String(planned.reason),/exact live original/u); await absent(x.input); }
    });
    await check("durable workflow cancellation retains earlier plans and denies new planning",async()=>{
      for(const existing of [false,true]) {
        const x=await target(); if(existing) await plans.plan(x.input);
        const execution=createStableId("workflowExecution"),dbosWorkflowId=`plan-cancel:${x.hold.missionId}`;
        const run=(await pool.query(`INSERT INTO acp.mission_workflow_runs(workflow_execution_id,mission_id,dbos_workflow_id,
          workflow_id,workflow_version,workflow_binding_id,dbos_application_version,graph_revision,state,provenance_id,transition_provenance_id)
          SELECT $1,mission_id,$2,workflow_id,workflow_version,workflow_binding_id,$3,'launch-recovery-check','running',$4,$4
          FROM acp.missions WHERE mission_id=$5 RETURNING workflow_version`,[execution,dbosWorkflowId,f.runtime.applicationVersion,f.template,x.hold.missionId])).rows[0];
        assert.equal(await new PostgresRuntimeStore(pool).recordWorkflowCancellationIntent({ target:{ workflowExecutionId:execution,dbosWorkflowId,
          missionId:x.hold.missionId,workflowVersion:run.workflow_version as string,graphRevision:x.hold.graphRevision,provenanceId:f.template },
          eventId:createStableId("event"),idempotencyKey:`plan-cancel:${execution}`,reason:"Synthetic provisioner cancellation.",requestedBy:"test:operator",occurredAt:new Date().toISOString() }),true);
        if(existing) assert.equal((await plans.load(x.input.attemptId))?.state,"recovering");
        else { await assert.rejects(plans.plan(x.input),/exact live original/u); await absent(x.input); }
      }
    });
  }
  if(phase==="upgrade") {
    await check("empty-attempt downgrade preserves existing hold, exclusion and audit history",async()=>{
      const x=await target(),keys=(await pool.query("SELECT * FROM acp.filesystem_exclusion_keys WHERE reservation_id=$1 ORDER BY key",[x.hold.reservationId])).rows;
      await migration("down"); assert.equal((await pool.query("SELECT to_regclass('acp.worktree_provisioner_attempts') IS NULL AS absent")).rows[0].absent,true);
      assert.deepEqual(await holds.load(x.hold.reservationId),x.hold);
      assert.deepEqual((await pool.query("SELECT * FROM acp.filesystem_exclusion_keys WHERE reservation_id=$1 ORDER BY key",[x.hold.reservationId])).rows,keys);
      await migration("up"); assert.equal((await plans.plan(x.input)).reservationId,x.hold.reservationId);
    });
    await check("populated downgrade fails atomically with authoritative attempt and creation receipt intact",async()=>{
      const x=await target(),p=await plans.plan(x.input);
      await assert.rejects(migration("down"),/retained provisioner plan history/u); assert.deepEqual(await plans.load(p.attemptId),p);
      assert.equal((await pool.query("SELECT 1 FROM acp.mission_events WHERE event_type='filesystem.provisioner-planned' AND idempotency_key=$1",[p.attemptId])).rowCount,1);
    });
  }
  assert.ok(checks>0); process.stdout.write(`Provisioner plan integration: ${checks} ${phase} checks passed.\n`);
} finally { await pool.end(); }
