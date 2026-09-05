import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { createStableId } from "@acp/domain";
import { PostgresFilesystemWriterStore, PostgresRepositoryBindingStore, PostgresWorktreeReservationStore, PostgresRuntimeStore,
  type RepositoryBindingInput, type WorktreeBindingInput } from "../../src/index.ts";
import { launchRecoveryFixture } from "./launch-recovery-fixture.ts";

const port=Number(process.argv[2]),phase=process.argv[3];
if(!Number.isInteger(port) || port<1024 || port>65535) throw new Error("owned database port required");
if(!["core","races","expiry","upgrade"].includes(phase??"")) throw new Error("exact pre-run phase required");
const pool=new Pool({ connectionString:`postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test`,max:4,
  connectionTimeoutMillis:3000,statement_timeout:5000,lock_timeout:3000 });
let checks=0,directories=0;
const identity=() => `win32-dir:12345678:${(++directories).toString(16).padStart(16,"0")}`;
async function check(name:string,action:()=>Promise<void>) { await action(); checks++; process.stdout.write(`PASS pre-run targets: ${name}\n`); }
try {
  const f=await launchRecoveryFixture(pool,"host:pre-run-target-check","0015");
  const holds=new PostgresWorktreeReservationStore(pool,f.runtime),registry=new PostgresRepositoryBindingStore(pool,f.runtime),writers=new PostgresFilesystemWriterStore(pool,f.runtime);
  async function provenance() {
    const id=createStableId("provenance");
    await pool.query(`INSERT INTO acp.runtime_provenance SELECT (jsonb_populate_record(NULL::acp.runtime_provenance,to_jsonb(p)
      ||jsonb_build_object('provenance_id',$1::text,'recorded_at',clock_timestamp()))).* FROM acp.runtime_provenance p WHERE provenance_id=$2`,[id,f.template]);
    return id;
  }
  async function target(options:{ repo?:RepositoryBindingInput;repositoryId?:RepositoryBindingInput["repositoryId"];branch?:string;workspacePath?:string;assignmentTtlMs?:number }={}) {
    const reservationId=createStableId("worktreeReservation"),workspacePath=options.workspacePath??`C:\\ACP-target-tests\\planned\\${reservationId}`;
    const a=await f.assignment(undefined,workspacePath,true,60000,options.assignmentTtlMs),id=createStableId("repositoryBinding");
    const repo:RepositoryBindingInput=options.repo??{ repositoryBindingId:id,repositoryId:options.repositoryId??createStableId("repository"),projectId:a.packet.projectId,
      machineFingerprint:"b".repeat(64),checkout:{ path:`C:\\ACP-target-tests\\repos\\${id}`,identity:identity() },
      commonGitDirectory:{ path:`C:\\ACP-target-tests\\repos\\${id}\\.git`,identity:identity() },observedAt:new Date().toISOString(),provenanceId:await provenance() };
    if(!options.repo) await registry.recordRepository(repo);
    return { a,repo,input:{ reservationId,repositoryBindingId:repo.repositoryBindingId,missionId:a.a.missionId,nodeId:a.a.nodeId,
      graphRevision:"launch-recovery-check",workspacePath,branchRef:options.branch??"refs/heads/Feature/TargetCase",provenanceId:await provenance() } };
  }
  async function writer(repo:RepositoryBindingInput) {
    const id=createStableId("worktreeBinding"),workspace={ path:`C:\\ACP-target-tests\\writers\\${id}`,identity:identity() };
    const s=await f.sample(false,undefined,workspace.path,true);
    const tree:WorktreeBindingInput={ worktreeBindingId:id,repositoryBindingId:repo.repositoryBindingId,missionId:s.a.missionId,workspace,
      gitDirectory:{ path:`${repo.commonGitDirectory.path}\\worktrees\\${id}`,identity:identity() },branchRef:"refs/heads/OtherWriterCase",
      headRevision:"a".repeat(40),observedAt:new Date().toISOString(),provenanceId:await provenance() };
    await registry.recordWorktree(tree);
    return { s,tree,input:{ leaseId:createStableId("lease"),runId:s.start.runId,workerProcessId:s.registration.workerProcessId,
      worktreeBindingId:id,provenanceId:s.a.packetProvenanceId } };
  }
  function intercepted(mode:"lost_commit"|"close_before_commit"|"expire_before_commit",reservationId?:string) {
    return new PostgresWorktreeReservationStore({ options:pool.options,async connect() {
      const client=await pool.connect();
      return { release:()=>client.release(),async query<R extends QueryResultRow>(text:string,values?:unknown[]):Promise<QueryResult<R>> {
        if(text==="COMMIT" && mode==="close_before_commit") await client.query("UPDATE acp.worker_host_sessions SET state='closed' WHERE host_identifier=$1",[f.runtime.hostIdentifier]);
        if(text==="COMMIT" && mode==="expire_before_commit") {
          const row=(await client.query("SELECT expires_at FROM acp.worktree_reservations WHERE reservation_id=$1",[reservationId])).rows[0];
          assert.ok(row); await new Promise((done)=>setTimeout(done,Math.max(1,(row.expires_at as Date).getTime()-Date.now()+30)));
        }
        const result=await client.query<R>(text,values);
        if(text==="COMMIT" && mode==="lost_commit") throw new Error("synthetic lost commit acknowledgement");
        return result;
      } };
    } } as unknown as Pool,f.runtime);
  }
  async function migration(direction:"up"|"down") {
    const sql=await readFile(new URL(`../../migrations/0015_worktree_target_holds${direction==="down" ? ".down" : ""}.sql`,import.meta.url),"utf8");
    const client=await pool.connect();
    try { await client.query("BEGIN"); await client.query(sql); await client.query("COMMIT"); }
    finally { await client.query("ROLLBACK"); client.release(); }
  }
  async function projection(reservationId:string) {
    return (await pool.query("SELECT key FROM acp.filesystem_exclusion_keys WHERE reservation_id=$1 ORDER BY key",[reservationId])).rows;
  }
  if(phase==="core") {
  await check("exact concurrent replay derives target keys without worker runs, launch intents or native workspace identity",async () => {
    const x=await target(),[left,right]=await Promise.all([holds.reserve(x.input),holds.reserve(x.input)]);
    assert.deepEqual(left,right); assert.equal(left.state,"held"); assert.equal(left.revision,1);
    assert.equal(left.dispatchRunId,x.a.a.runId); assert.equal(left.dispatchGeneration,x.a.a.generation);
    assert.equal(left.workspaceKey,`repo:${x.repo.repositoryId}:worktree:${x.a.a.missionId}`);
    assert.equal(left.branchKey,`branch:${x.repo.repositoryId}:${createHash("sha256").update(x.input.branchRef).digest("hex")}`);
    assert.equal(left.physicalRepositoryKey,`host:${f.runtime.hostIdentifier}:machine:${x.repo.machineFingerprint}:git:${x.repo.commonGitDirectory.identity}`);
    assert.equal(Date.parse(left.expiresAt)-Date.parse(left.heartbeatAt),20000);
    assert.equal((await pool.query("SELECT 1 FROM acp.filesystem_exclusion_keys WHERE reservation_id=$1",[left.reservationId])).rowCount,4);
    for(const table of ["worker_runs","worker_launch_intents"]) {
      const predicate=table==="worker_runs" ? "mission_id=$1" : "run_id IN (SELECT run_id FROM acp.worker_runs WHERE mission_id=$1)";
      assert.equal((await pool.query(`SELECT 1 FROM acp.${table} WHERE ${predicate}`,[x.a.a.missionId])).rowCount,0);
    }
    const next=await holds.heartbeat(left.reservationId); assert.equal(next.revision,2); assert.equal(next.acquiredAt,left.acquiredAt);
    assert.deepEqual(await holds.reserve(x.input),next); assert.deepEqual(await holds.load(left.reservationId),next);
    assert.equal((await pool.query("SELECT 1 FROM acp.mission_events WHERE mission_id=$1 AND event_type LIKE 'filesystem.target-%'",[x.a.a.missionId])).rowCount,2);
  });
  await check("the selected runtime cannot substitute another prospective workspace for its exact delivery grant",async () => {
    const x=await target();
    await assert.rejects(holds.reserve({ ...x.input,workspacePath:x.input.workspacePath+"-ungranted" }),/exact unstarted delivery/u);
    assert.equal(await holds.load(x.input.reservationId),undefined);
    assert.equal((await holds.reserve(x.input)).state,"held");
  });
  await check("pre-run holds and admitted writers exclude each other in both insertion orders",async () => {
    const x=await target(),old=await writer(x.repo); await writers.reserve(old.input);
    await assert.rejects(holds.reserve(x.input),/duplicate key/u); assert.equal(await holds.load(x.input.reservationId),undefined);
    const y=await target(); await holds.reserve(y.input); const newer=await writer(y.repo);
    await assert.rejects(writers.reserve(newer.input),/duplicate key/u); assert.equal(await writers.load(newer.input.leaseId),undefined);
  });
  await check("common metadata serializes different branches while exact branch case remains distinct across physical clones",async () => {
    const x=await target(); await holds.reserve(x.input);
    const same=await target({ repo:x.repo,branch:x.input.branchRef.toLowerCase() }); await assert.rejects(holds.reserve(same.input),/duplicate key/u);
    const clone=await target({ repositoryId:x.repo.repositoryId }); await assert.rejects(holds.reserve(clone.input),/duplicate key/u);
    const caseClone=await target({ repositoryId:x.repo.repositoryId,branch:x.input.branchRef.toLowerCase() });
    assert.equal((await holds.reserve(caseClone.input)).state,"held");
  });
  await check("changed replay identity and foreign owner cannot renew or rebind history",async () => {
    const x=await target(),held=await holds.reserve(x.input);
    for(const change of [{ branchRef:"refs/heads/changed" },{ graphRevision:"other-graph" },{ workspacePath:"C:\\ACP-target-tests\\other" },
      { nodeId:createStableId("node") },{ missionId:createStableId("mission") },{ repositoryBindingId:createStableId("repositoryBinding") },{ provenanceId:await provenance() }]) {
      await assert.rejects(holds.reserve({ ...x.input,...change }),/aliases different/u);
    }
    const foreign=new PostgresWorktreeReservationStore(pool,{ ...f.runtime,sessionId:createStableId("workerHostSession") });
    await assert.rejects(foreign.reserve(x.input),/aliases different/u); await assert.rejects(foreign.heartbeat(x.input.reservationId),/exact original owner/u);
    assert.equal(await new PostgresWorktreeReservationStore(pool,{ ...f.runtime,hostIdentifier:"host:other-targets" }).load(x.input.reservationId),undefined);
    assert.deepEqual(await holds.load(x.input.reservationId),held);
  });
  await check("prospective paths reject retained directories and subsequent bindings in both directions",async () => {
    const x=await target();
    for(const workspacePath of [x.repo.checkout.path,x.repo.checkout.path+"\\nested",x.repo.commonGitDirectory.path,"C:\\ACP-target-tests\\repos"]) {
      const attempt=await target({ repo:x.repo,workspacePath });
      await assert.rejects(holds.reserve(attempt.input),/overlaps/u);
    }
    await holds.reserve(x.input);
    const y=await target();
    for(const workspacePath of [x.input.workspacePath.toLowerCase(),x.input.workspacePath+"\\nested","C:\\ACP-target-tests\\planned"]) {
      const attempt=await target({ repo:y.repo,workspacePath });
      await assert.rejects(holds.reserve(attempt.input),/overlaps/u);
    }
    const id=createStableId("repositoryBinding"),binding={ ...y.repo,repositoryBindingId:id,repositoryId:createStableId("repository"),
      checkout:{ path:x.input.workspacePath+"\\checkout",identity:identity() },commonGitDirectory:{ path:x.input.workspacePath+"\\checkout\\.git",identity:identity() },provenanceId:await provenance() };
    await assert.rejects(registry.recordRepository(binding),/overlaps reserved prospective/u);
    assert.equal(await registry.loadRepository(id),undefined);
  });
  await check("a valid different host cannot hold a node assigned to the selected original host",async () => {
    const x=await target(),otherTemplate=createStableId("provenance"),hostIdentifier="host:other-pre-run-target-check";
    await f.clone("runtime_provenance","provenance_id",f.template,{ provenance_id:otherTemplate,host_identifier:hostIdentifier });
    const runtime={ ...f.runtime,hostIdentifier,sessionId:createStableId("workerHostSession"),
      bindings:[{ workflowBindingId:f.binding,templateProvenanceId:otherTemplate }] };
    await f.dispatches.registerRuntime(runtime,{ ...f.host,hostIdentifier,provenanceId:otherTemplate,transitionProvenanceId:otherTemplate });
    const otherProvenance=createStableId("provenance");
    await f.clone("runtime_provenance","provenance_id",otherTemplate,{ provenance_id:otherProvenance,recorded_at:new Date().toISOString() });
    const otherRegistry=new PostgresRepositoryBindingStore(pool,runtime),otherHolds=new PostgresWorktreeReservationStore(pool,runtime);
    const repo={ ...x.repo,repositoryBindingId:createStableId("repositoryBinding"),observedAt:new Date().toISOString(),provenanceId:otherProvenance };
    await otherRegistry.recordRepository(repo);
    const valid=await pool.query("SELECT acp.filesystem_observation_actor_valid($1,$2,$3,$4,$5) AS valid",
      [x.repo.projectId,hostIdentifier,runtime.sessionId,runtime.applicationVersion,otherProvenance]);
    assert.equal(valid.rows[0].valid,true,"negative must use an otherwise valid live same-project actor");
    await assert.rejects(otherHolds.reserve({ ...x.input,repositoryBindingId:repo.repositoryBindingId,provenanceId:otherProvenance }),/exact unstarted delivery/u);
    assert.equal(await otherHolds.load(x.input.reservationId),undefined);
    assert.equal((await holds.reserve(x.input)).state,"held");
  });
  await check("history and shared-key projection cannot be independently changed or removed",async () => {
    const x=await target(); await holds.reserve(x.input);
    await assert.rejects(pool.query("UPDATE acp.worktree_reservations SET branch_ref='refs/heads/forged' WHERE reservation_id=$1",[x.input.reservationId]),/immutable/u);
    await assert.rejects(pool.query("DELETE FROM acp.worktree_reservations WHERE reservation_id=$1",[x.input.reservationId]),/append-only/u);
    await assert.rejects(pool.query("TRUNCATE acp.worktree_reservations CASCADE"),/append-only/u);
    await assert.rejects(pool.query("DELETE FROM acp.filesystem_exclusion_keys WHERE reservation_id=$1",[x.input.reservationId]),/already released writer/u);
    await assert.rejects(pool.query("UPDATE acp.filesystem_exclusion_keys SET key='forged' WHERE reservation_id=$1",[x.input.reservationId]),/immutable/u);
    await assert.rejects(pool.query("INSERT INTO acp.filesystem_exclusion_keys(key,reservation_id) VALUES('forged',$1)",[x.input.reservationId]),/exact retained reservation key/u);
    await assert.rejects(pool.query("TRUNCATE acp.filesystem_exclusion_keys"),/append-only/u);
    assert.equal((await pool.query("SELECT 1 FROM acp.filesystem_exclusion_keys WHERE reservation_id=$1",[x.input.reservationId])).rowCount,4);
  });
  await check("direct SQL cannot select a different dispatch generation or inject exclusion keys and timestamps",async () => {
    const x=await target(),i=x.input;
    await pool.query(`INSERT INTO acp.worktree_reservations(reservation_id,repository_binding_id,mission_id,node_id,graph_revision,
      workspace_path,branch_ref,host_identifier,owner_session_id,application_version,provenance_id,dispatch_run_id,dispatch_generation,
      workspace_key,physical_repository_key,branch_key,path_key,acquired_at,heartbeat_at,expires_at,revision)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,999,'forged','forged','forged','forged','2000-01-01','2000-01-01','2099-01-01',999)`,
    [i.reservationId,i.repositoryBindingId,i.missionId,i.nodeId,i.graphRevision,i.workspacePath,i.branchRef,
      f.runtime.hostIdentifier,f.runtime.sessionId,f.runtime.applicationVersion,i.provenanceId,createStableId("run")]);
    const held=await holds.load(i.reservationId); assert.ok(held);
    assert.equal(held.dispatchRunId,x.a.a.runId); assert.equal(held.dispatchGeneration,x.a.a.generation); assert.equal(held.revision,1);
    assert.equal(Date.parse(held.expiresAt)-Date.parse(held.heartbeatAt),20000);
    assert.ok((await projection(i.reservationId)).every((row)=>row.key!=="forged"));
    await assert.rejects(pool.query("UPDATE acp.worktree_reservations SET dispatch_generation=999 WHERE reservation_id=$1",[i.reservationId]),/immutable/u);
  });
  }
  if(phase==="races") {
    await check("competing target owners and existing writer acquisition each have one atomic winner",async () => {
      const x=await target(),y=await target({ repo:x.repo,branch:"refs/heads/another" });
      const outcomes=await Promise.allSettled([holds.reserve(x.input),holds.reserve(y.input)]);
      assert.equal(outcomes.filter((r)=>r.status==="fulfilled").length,1);
      assert.equal(outcomes.filter((r)=>r.status==="rejected" && /duplicate key/u.test(String(r.reason))).length,1);
      assert.equal((await projection(x.input.reservationId)).length+(await projection(y.input.reservationId)).length,4);
      const z=await target(),w=await writer(z.repo);
      const mixed=await Promise.allSettled([holds.reserve(z.input),writers.reserve(w.input)]);
      assert.equal(mixed.filter((r)=>r.status==="fulfilled").length,1);
      assert.equal(mixed.filter((r)=>r.status==="rejected" && /duplicate key/u.test(String(r.reason))).length,1);
    });
    await check("prospective paths and directory registration cannot both win their concurrent overlap",async () => {
      const x=await target(),id=createStableId("repositoryBinding");
      const repo={ ...x.repo,repositoryBindingId:id,repositoryId:createStableId("repository"),
        checkout:{ path:x.input.workspacePath+"\\repo",identity:identity() },commonGitDirectory:{ path:x.input.workspacePath+"\\repo\\.git",identity:identity() },provenanceId:await provenance() };
      const outcomes=await Promise.allSettled([holds.reserve(x.input),registry.recordRepository(repo)]);
      assert.equal(outcomes.filter((r)=>r.status==="fulfilled").length,1);
      assert.equal(outcomes.filter((r)=>r.status==="rejected" && /overlap/u.test(String(r.reason))).length,1);
      assert.notEqual(Boolean(await holds.load(x.input.reservationId)),Boolean(await registry.loadRepository(id)));
    });
    await check("reserve and heartbeat wait for exact repository retirement then deny without partial writes",async () => {
      for(const renewing of [false,true]) {
        const x=await target(); if(renewing) await holds.reserve(x.input);
        const client=await pool.connect(); let pending:Promise<unknown>|undefined;
        try {
          const actor=await provenance(); await client.query("BEGIN");
          const pid=(await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
          await client.query(`INSERT INTO acp.repository_binding_retirements(repository_binding_id,host_identifier,owner_session_id,application_version,provenance_id,reason)
            VALUES($1,$2,$3,$4,$5,'Concurrent target retirement.')`,[x.repo.repositoryBindingId,f.runtime.hostIdentifier,f.runtime.sessionId,f.runtime.applicationVersion,actor]);
          pending=assert.rejects(renewing ? holds.heartbeat(x.input.reservationId) : holds.reserve(x.input),/exact unstarted delivery/u);
          let blocked=false;
          for(let attempt=0;attempt<100;attempt++) {
            blocked=(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE NOT granted AND $1=ANY(pg_blocking_pids(pid))) AS blocked",[pid])).rows[0].blocked as boolean;
            if(blocked) break; await new Promise((done)=>setTimeout(done,10));
          }
          assert.equal(blocked,true,"target operation must wait for exact retirement lock");
          await client.query("COMMIT"); await pending;
          assert.equal((await holds.load(x.input.reservationId))?.revision,renewing ? 1 : undefined);
          assert.equal((await projection(x.input.reservationId)).length,renewing ? 4 : 0);
        } finally { await client.query("ROLLBACK"); client.release(); if(pending) await pending; }
      }
    });
    await check("lost actual commit acknowledgement replays history without duplicating acquisition or renewal",async () => {
      const x=await target(),lost=intercepted("lost_commit");
      await assert.rejects(lost.reserve(x.input),/lost commit acknowledgement/u);
      const first=await holds.load(x.input.reservationId); assert.ok(first); assert.equal(first.revision,1);
      assert.deepEqual(await holds.reserve(x.input),first);
      await assert.rejects(lost.heartbeat(x.input.reservationId),/lost commit acknowledgement/u);
      const second=await holds.load(x.input.reservationId); assert.ok(second); assert.equal(second.revision,2);
      assert.deepEqual(await holds.reserve(x.input),second);
      assert.equal((await pool.query("SELECT 1 FROM acp.mission_events WHERE mission_id=$1 AND event_type LIKE 'filesystem.target-%'",[x.input.missionId])).rowCount,2);
    });
    await check("deferred authority loss rolls back reserve and renewal including keys and events",async () => {
      const x=await target(),denied=intercepted("close_before_commit");
      await assert.rejects(denied.reserve(x.input),/authority ended before commit/u);
      assert.equal(await holds.load(x.input.reservationId),undefined); assert.equal((await projection(x.input.reservationId)).length,0);
      const first=await holds.reserve(x.input);
      await assert.rejects(denied.heartbeat(x.input.reservationId),/authority ended before commit/u);
      assert.deepEqual(await holds.load(x.input.reservationId),first);
      assert.equal((await pool.query("SELECT 1 FROM acp.mission_events WHERE mission_id=$1 AND event_type LIKE 'filesystem.target-%'",[x.input.missionId])).rowCount,1);
    });
    await check("actual worker admission makes a held pre-run target recovering without releasing its keys",async () => {
      const x=await target(),held=await holds.reserve(x.input),keys=await projection(held.reservationId);
      await f.workers.startRun(x.a.start);
      assert.equal((await holds.load(held.reservationId))?.state,"recovering");
      await assert.rejects(holds.heartbeat(held.reservationId),/exact unstarted delivery/u);
      assert.deepEqual(await projection(held.reservationId),keys);
      const y=await target({ repo:x.repo }); await assert.rejects(holds.reserve(y.input),/duplicate key/u);
      const z=await target(); await f.workers.startRun(z.a.start);
      await assert.rejects(holds.reserve(z.input),/exact unstarted delivery/u);
    });
    await check("racing actual worker admission cannot leave a renewable pre-run hold",async () => {
      const x=await target();
      const [reserved,started]=await Promise.allSettled([holds.reserve(x.input),f.workers.startRun(x.a.start)]);
      assert.equal(started.status,"fulfilled");
      if(reserved.status==="fulfilled") {
        assert.equal((await holds.load(x.input.reservationId))?.state,"recovering");
        await assert.rejects(holds.heartbeat(x.input.reservationId),/exact unstarted delivery/u);
        assert.equal((await projection(x.input.reservationId)).length,4);
      } else {
        assert.match(String(reserved.reason),/exact unstarted delivery/u);
        assert.equal(await holds.load(x.input.reservationId),undefined); assert.equal((await projection(x.input.reservationId)).length,0);
      }
    });
    await check("a concurrently cancelled dispatch fences reserve and heartbeat behind its exact row lock",async () => {
      for(const renewing of [false,true]) {
        const x=await target(); if(renewing) await holds.reserve(x.input);
        const client=await pool.connect(); let pending:Promise<unknown>|undefined;
        try {
          await client.query("BEGIN"); const pid=(await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
          await client.query("UPDATE acp.worker_dispatches SET state='cancelled',reason='Synthetic concurrent dispatch cancellation.' WHERE run_id=$1",[x.a.a.runId]);
          pending=assert.rejects(renewing ? holds.heartbeat(x.input.reservationId) : holds.reserve(x.input),/exact unstarted delivery/u);
          let blocked=false;
          for(let attempt=0;attempt<100;attempt++) {
            blocked=(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE NOT granted AND $1=ANY(pg_blocking_pids(pid))) AS blocked",[pid])).rows[0].blocked as boolean;
            if(blocked) break; await new Promise((done)=>setTimeout(done,10));
          }
          assert.equal(blocked,true,"target must wait for exact dispatch authority lock");
          await client.query("COMMIT"); await pending;
          assert.equal((await holds.load(x.input.reservationId))?.revision,renewing ? 1 : undefined);
          assert.equal((await projection(x.input.reservationId)).length,renewing ? 4 : 0);
        } finally { await client.query("ROLLBACK"); client.release(); if(pending) await pending; }
      }
    });
    await check("durable cancellation ends renewal but preserves target quarantine",async () => {
      const x=await target(),held=await holds.reserve(x.input),execution=createStableId("workflowExecution"),dbosWorkflowId=`target-cancel:${x.input.missionId}`;
      const run=(await pool.query(`INSERT INTO acp.mission_workflow_runs(workflow_execution_id,mission_id,dbos_workflow_id,
        workflow_id,workflow_version,workflow_binding_id,dbos_application_version,graph_revision,state,provenance_id,transition_provenance_id)
        SELECT $1,mission_id,$2,workflow_id,workflow_version,workflow_binding_id,$3,'launch-recovery-check','running',$4,$4
        FROM acp.missions WHERE mission_id=$5 RETURNING workflow_version`,
      [execution,dbosWorkflowId,f.runtime.applicationVersion,f.template,x.input.missionId])).rows[0];
      assert.equal(await new PostgresRuntimeStore(pool).recordWorkflowCancellationIntent({ target:{ workflowExecutionId:execution,dbosWorkflowId,
        missionId:x.input.missionId,workflowVersion:run.workflow_version as string,graphRevision:x.input.graphRevision,provenanceId:f.template },
        eventId:createStableId("event"),idempotencyKey:`target-cancel:${execution}`,reason:"Synthetic target cancellation.",requestedBy:"test:operator",occurredAt:new Date().toISOString() }),true);
      assert.equal((await holds.load(held.reservationId))?.state,"recovering");
      await assert.rejects(holds.heartbeat(held.reservationId),/exact unstarted delivery/u);
      assert.equal((await projection(held.reservationId)).length,4);
      const y=await target({ repo:x.repo }); await assert.rejects(holds.reserve(y.input),/duplicate key/u);
    });
    await check("replacement runtime cannot inherit an old hold or free its target",async () => {
      const x=await target(),held=await holds.reserve(x.input); await f.replaceOwner();
      const replacement=new PostgresWorktreeReservationStore(pool,f.runtime);
      assert.equal((await replacement.load(held.reservationId))?.state,"recovering");
      await assert.rejects(replacement.heartbeat(held.reservationId),/exact original owner/u);
      await assert.rejects(replacement.reserve(x.input),/aliases different/u);
      await assert.rejects(holds.heartbeat(held.reservationId),/exact unstarted delivery/u);
      assert.equal((await projection(held.reservationId)).length,4);
    });
  }
  if(phase==="expiry") {
    const long=await target(),longHold=await holds.reserve(long.input);
    await check("assignment expiry before actual commit rolls back a newly held target and its keys",async () => {
      const x=await target({ assignmentTtlMs:1000 });
      await assert.rejects(intercepted("expire_before_commit",x.input.reservationId).reserve(x.input),/authority ended before commit/u);
      assert.equal(await holds.load(x.input.reservationId),undefined); assert.equal((await projection(x.input.reservationId)).length,0);
      assert.equal((await pool.query("SELECT 1 FROM acp.mission_events WHERE mission_id=$1 AND event_type LIKE 'filesystem.target-%'",[x.input.missionId])).rowCount,0);
    });
    await check("assignment expiry caps the hold and a later generation cannot revive original ownership",async () => {
      const x=await target({ assignmentTtlMs:1000 }),held=await holds.reserve(x.input);
      const assignment=(await pool.query("SELECT expires_at FROM acp.worker_dispatch_assignments WHERE run_id=$1 AND generation=$2",[held.dispatchRunId,held.dispatchGeneration])).rows[0];
      assert.equal(held.expiresAt,(assignment.expires_at as Date).toISOString());
      await new Promise((done)=>setTimeout(done,Math.max(1,Date.parse(held.expiresAt)-Date.now()+30)));
      assert.equal((await holds.load(held.reservationId))?.state,"recovering");
      const next=await f.dispatches.assign(x.a.a.runId,async()=>{}); assert.ok(next); assert.equal(next.generation,held.dispatchGeneration+1);
      assert.equal((await holds.reserve(x.input)).dispatchGeneration,held.dispatchGeneration);
      await assert.rejects(holds.heartbeat(held.reservationId),/expired pre-run/u);
      const y=await target({ repo:x.repo }); await assert.rejects(holds.reserve(y.input),/duplicate key/u);
      assert.equal((await projection(held.reservationId)).length,4);
    });
    await check("natural twenty-second expiry retains every key and historical replay does not renew",async () => {
      assert.equal(Date.parse(longHold.expiresAt)-Date.parse(longHold.heartbeatAt),20000);
      await new Promise((done)=>setTimeout(done,Math.max(1,Date.parse(longHold.expiresAt)-Date.now()+30)));
      const expired=await holds.load(longHold.reservationId); assert.deepEqual(expired,{ ...longHold,state:"recovering" });
      assert.deepEqual(await holds.reserve(long.input),expired);
      await assert.rejects(holds.heartbeat(longHold.reservationId),/expired pre-run/u);
      const y=await target({ repo:long.repo }); await assert.rejects(holds.reserve(y.input),/duplicate key/u);
      assert.equal((await projection(longHold.reservationId)).length,4);
    });
    await check("recovery inventory is bounded, host-scoped, keyset-paged and non-mutating",async () => {
      for(const limit of [0,101,1.5]) await assert.rejects(holds.listRecovery({ limit }),/limit/u);
      await assert.rejects(holds.listRecovery({ afterReservationId:createStableId("lease") as never }),/Invalid worktreeReservation identifier/u);
      const first=await holds.listRecovery({ limit:1 }); assert.equal(first.items.length,1); assert.ok(first.nextCursor);
      const second=await holds.listRecovery({ limit:1,afterReservationId:first.nextCursor }); assert.equal(second.items.length,1); assert.equal(second.nextCursor,undefined);
      assert.notEqual(first.items[0]?.reservationId,second.items[0]?.reservationId);
      assert.ok(first.items.concat(second.items).every((x)=>x.state==="recovering" && x.revision===1));
      assert.deepEqual(await new PostgresWorktreeReservationStore(pool,{ ...f.runtime,hostIdentifier:"host:no-targets" }).listRecovery(),{ items:[] });
      assert.equal((await projection(longHold.reservationId)).length,4);
    });
  }
  if(phase==="upgrade") {
    const x=await target(); let original:Awaited<ReturnType<typeof writer>>;
    await check("empty-hold downgrade preserves existing writer history and upgrade backfills active keys",async () => {
      await migration("down"); original=await writer(x.repo); await writers.reserve(original.input);
      const conflicting=await writer(x.repo);
      await assert.rejects(writers.reserve(conflicting.input),/duplicate key/u);
      assert.equal(await writers.load(conflicting.input.leaseId),undefined);
      const y=await target(),released=await writer(y.repo); await writers.reserve(released.input);
      await f.workers.recordWorkerProcessFromRun(released.s.registration); await released.s.finishOwner(); await released.s.finishRun(); await writers.release(released.input.leaseId);
      await migration("up");
      assert.equal((await pool.query("SELECT 1 FROM acp.filesystem_exclusion_keys WHERE writer_lease_id=$1",[original.input.leaseId])).rowCount,5);
      assert.equal((await pool.query("SELECT 1 FROM acp.filesystem_exclusion_keys WHERE writer_lease_id=$1",[released.input.leaseId])).rowCount,0);
      assert.equal((await writers.load(released.input.leaseId))?.state,"released");
      await assert.rejects(holds.reserve(x.input),/duplicate key/u);
    });
    await check("only durable writer release removes its backfilled keys and leaves original history intact",async () => {
      const before=await writers.heartbeat(original!.input.leaseId); assert.equal(before.revision,2);
      await assert.rejects(writers.release(original!.input.leaseId),/stopped terminal run/u);
      await f.workers.recordWorkerProcessFromRun(original!.s.registration); await original!.s.finishOwner(); await original!.s.finishRun();
      await writers.release(original!.input.leaseId);
      assert.equal((await pool.query("SELECT 1 FROM acp.filesystem_exclusion_keys WHERE writer_lease_id=$1",[original!.input.leaseId])).rowCount,0);
      await migration("down"); assert.equal((await writers.load(original!.input.leaseId))?.state,"released"); await migration("up");
      assert.equal((await holds.reserve(x.input)).state,"held");
    });
    await check("populated target downgrade refuses and rolls back without losing retained keys",async () => {
      const before=await holds.load(x.input.reservationId),keys=await projection(x.input.reservationId);
      await assert.rejects(migration("down"),/retained pre-run target history/u);
      assert.deepEqual(await holds.load(x.input.reservationId),before); assert.deepEqual(await projection(x.input.reservationId),keys);
    });
  }
  assert.ok(checks>0); process.stdout.write(`Pre-run target hold integration: ${checks} ${phase} checks passed.\n`);
} finally { await pool.end(); }
