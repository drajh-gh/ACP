import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool,type PoolClient } from "pg";
import { createStableId } from "@acp/domain";
import { PostgresRepositoryBindingStore,PostgresWorktreeReservationStore,PostgresWorktreeProvisionerStore,PostgresProvisionerJournalStore,type WorkerProcessRegistration } from "../../src/index.ts";
import { launchRecoveryFixture } from "./launch-recovery-fixture.ts";

const port=Number(process.argv[2]),phase=process.argv[3];
if(!Number.isInteger(port) || port<1024 || port>65535 || !["core","races","upgrade","conflict"].includes(phase??"")) throw new Error("owned port and exact root-claim phase required");
const pool=new Pool({ connectionString:`postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test`,max:6,connectionTimeoutMillis:3000,statement_timeout:5000,lock_timeout:2000 });
let checks=0,identities=0;
const identity=()=>`win32-dir:12345678:${(++identities).toString(16).padStart(16,"0")}`;
async function check(name:string,action:()=>Promise<void>) { await action(); checks++; process.stdout.write(`PASS native root claims: ${name}\n`); }
try {
  const f=await launchRecoveryFixture(pool,"host:native-root-claims",["upgrade","conflict"].includes(phase!) ? "0019" : "0020");
  const registry=new PostgresRepositoryBindingStore(pool,f.runtime),holds=new PostgresWorktreeReservationStore(pool,f.runtime),plans=new PostgresWorktreeProvisionerStore(pool,f.runtime),journal=new PostgresProvisionerJournalStore(pool,f.runtime);
  async function target() {
    const reservationId=createStableId("worktreeReservation"),workspacePath=`C:\\ACP-root-claim-tests\\planned\\${reservationId}`;
    const a=await f.assignment(undefined,workspacePath,true),repoId=createStableId("repositoryBinding");
    await registry.recordRepository({ repositoryBindingId:repoId,repositoryId:createStableId("repository"),projectId:a.packet.projectId,machineFingerprint:"b".repeat(64),
      checkout:{ path:`C:\\ACP-root-claim-tests\\repos\\${repoId}`,identity:identity() },commonGitDirectory:{ path:`C:\\ACP-root-claim-tests\\repos\\${repoId}\\.git`,identity:identity() },
      observedAt:new Date().toISOString(),provenanceId:a.a.packetProvenanceId });
    const hold=await holds.reserve({ reservationId,repositoryBindingId:repoId,missionId:a.a.missionId,nodeId:a.a.nodeId,graphRevision:"launch-recovery-check",workspacePath,
      branchRef:"refs/heads/RootClaim/ExactCase",provenanceId:a.a.packetProvenanceId });
    const times=(await pool.query("SELECT to_jsonb(clock_timestamp()) AS at,to_jsonb(least(clock_timestamp()+interval '15 seconds',expires_at-interval '10 milliseconds')) AS deadline FROM acp.worktree_reservations WHERE reservation_id=$1",[reservationId])).rows[0];
    const plan=await plans.plan({ attemptId:createStableId("worktreeProvisionerAttempt"),reservationId,reservationRevision:hold.revision,baseRevision:"a".repeat(40),
      reportedParent:{ path:"C:\\ACP-root-claim-tests\\planned",identity:identity(),observedAt:times.at as string },
      fencePlan:{ namespace:"acp-worktree-provisioner-v1",directory:"C:\\ACP-root-claim-fences" },deadlineAt:times.deadline as string });
    const native=(await pool.query(`WITH t AS MATERIALIZED(SELECT clock_timestamp() AS at)
      SELECT to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'7Z' AS started,
        'win32-filetime:'||((extract(epoch FROM at)*10000000+116444736000000000+7)::numeric(30,0))::text AS token FROM t`)).rows[0];
    const input={ attemptId:plan.attemptId,fence:{ ...plan.fencePlan,directoryIdentity:identity(),scope:{ machineFingerprint:"b".repeat(64),bootedAt:"2026-09-01T00:00:00.000Z",sessionId:1 } },
      root:{ processId:940000+identities,processStartToken:native.token as string,startedAt:native.started as string } };
    return { hold,plan,input,stop:{ attemptId:input.attemptId,fence:input.fence,observation:{ state:"terminated" as const,sealed:true as const,reason:"exact_owned_tree_terminated" as const,exitCode:0,root:input.root } } };
  }
  const collision=/native_root_claims|native root.*claimed/u;
  const claim=async(ownerId:string)=>(await pool.query("SELECT to_jsonb(c)||jsonb_build_object('process_start_filetime',process_start_filetime::text,'process_id',process_id::text) AS value FROM acp.windows_native_root_claims c WHERE owner_id=$1",[ownerId])).rows[0]?.value;
  async function migration(direction:"up"|"down") {
    const client=await pool.connect();
    try { await client.query("BEGIN"); await client.query(await readFile(new URL(`../../migrations/0020_windows_native_root_claims${direction==="down" ? ".down" : ""}.sql`,import.meta.url),"utf8")); await client.query("COMMIT"); }
    finally { await client.query("ROLLBACK"); client.release(); }
  }
  async function stoppedWorker(root?:Awaited<ReturnType<typeof target>>["input"]["root"],existing?:Awaited<ReturnType<typeof f.sample>>) {
    const w=existing??await f.sample(); await w.handoff(); const prepared=await f.launches.prepare(w.candidate); assert.ok(prepared?.claim);
    const observation=root ? { state:"terminated" as const,sealed:true as const,reason:"exact_owned_tree_terminated",exitCode:0,root }
      : { state:"lost" as const,sealed:true as const,reason:"sealed_launch_job_absent" };
    await f.launches.observe(prepared.claim,async()=>observation,new AbortController().signal);
    assert.equal((await pool.query("SELECT 1 FROM acp.worker_processes WHERE worker_process_id=$1",[w.registration.workerProcessId])).rowCount,0);
    assert.equal((await pool.query("SELECT 1 FROM acp.worker_launch_stops WHERE run_id=$1",[w.registration.runId])).rowCount,1);
    return w;
  }
  async function directProcess(client:PoolClient,x:Awaited<ReturnType<typeof target>>) {
    const i=x.input,a=f.runtime;
    await client.query(`INSERT INTO acp.worktree_provisioner_processes(attempt_id,fence_namespace,fence_directory,directory_identity,supervision_scope,
      host_identifier,owner_session_id,application_version,root_process_id,root_process_start_token,root_started_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[i.attemptId,i.fence.namespace,i.fence.directory,i.fence.directoryIdentity,i.fence.scope,
      a.hostIdentifier,a.sessionId,a.applicationVersion,i.root.processId,i.root.processStartToken,i.root.startedAt]);
  }
  async function directWorker(client:PoolClient,r:WorkerProcessRegistration) {
    await client.query(`INSERT INTO acp.worker_processes(worker_process_id,run_id,mission_id,node_id,process_id,process_start_token,purpose,
      host_identifier,resource_class,state,started_at,deadline_at,heartbeat_at,provenance_id,transition_provenance_id,supervision_kind,tree_identifier,supervision_scope)
      SELECT $1,run_id,mission_id,node_id,$3,$4,$5,host_identifier,resource_class,'running',$6,timeout_at,clock_timestamp(),$7,$7,'windows_job',$8,$9
      FROM acp.worker_runs WHERE run_id=$2`,[r.workerProcessId,r.runId,r.processId,r.processStartToken,r.purpose,r.startedAt,r.provenanceId,r.supervision!.treeIdentifier,r.supervision!.scope]);
  }
  async function waitBlocked(pid:number,signal?:AbortSignal) {
    for(let i=0;i<100;i++) { if(signal?.aborted) return; if((await pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE NOT granted AND $1=ANY(pg_blocking_pids(pid))) AS blocked",[pid])).rows[0].blocked) return; await new Promise((done)=>setTimeout(done,10)); }
    throw new Error("root claim did not wait for exact incumbent transaction");
  }
  if(phase==="core") {
  await check("worker-first exact native identity denies a provisioner claim without partial journal or event",async()=>{
    const w=await f.sample(),x=await target(),registration={ ...w.registration,...x.input.root };
    await f.workers.recordWorkerProcessFromRun(registration);
    await assert.rejects(journal.recordProcess(x.input),collision);
    assert.equal((await journal.load(x.plan.attemptId))?.state,"unrecorded");
    assert.equal((await pool.query("SELECT 1 FROM acp.mission_events WHERE idempotency_key=$1 AND event_type='filesystem.provisioner-process-recorded'",[x.plan.attemptId])).rowCount,0);
    assert.deepEqual(await holds.load(x.hold.reservationId),x.hold);
  });
  await check("provisioner-first identity denies worker admission without a source row or extra event",async()=>{
    const w=await f.sample(),x=await target(); await journal.recordProcess(x.input);
    const before=(await pool.query("SELECT count(*)::int AS count FROM acp.mission_events WHERE mission_id=$1",[w.packet.missionId])).rows[0].count;
    await assert.rejects(f.workers.recordWorkerProcessFromRun({ ...w.registration,...x.input.root }),collision);
    assert.equal(await f.workers.loadWorkerProcess(w.registration.workerProcessId),undefined);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM acp.mission_events WHERE mission_id=$1",[w.packet.missionId])).rows[0].count,before);
    assert.equal((await claim(x.input.attemptId)).owner_kind,"provisioner");
  });
  await check("one owner retains one immutable claim through matching process and sealed stop history",async()=>{
    const w=await f.sample(),x=await target(),registration={ ...w.registration,...x.input.root };
    await f.workers.recordWorkerProcessFromRun(registration); const workerBefore=await claim(registration.workerProcessId);
    await w.finishOwner(registration); assert.deepEqual(await claim(registration.workerProcessId),workerBefore);
    const y=await target(); await journal.recordProcess(y.input); const before=await claim(y.input.attemptId);
    await journal.recordStop(y.stop); assert.deepEqual(await claim(y.input.attemptId),before);
    await journal.recordProcess(y.input); await journal.recordStop(y.stop); assert.deepEqual(await claim(y.input.attemptId),before);
    for(const sql of ["UPDATE acp.windows_native_root_claims SET process_id=process_id","DELETE FROM acp.windows_native_root_claims","TRUNCATE acp.windows_native_root_claims CASCADE"]) await assert.rejects(pool.query(sql),/append-only/u);
    await assert.rejects(pool.query("TRUNCATE acp.windows_native_root_claims"),/append-only|foreign key constraint/u);
  });
  await check("rooted stop-only history claims identity while rootless absence fabricates nothing",async()=>{
    const x=await target(); await journal.recordStop(x.stop); assert.equal((await claim(x.input.attemptId)).owner_kind,"provisioner");
    await assert.rejects(journal.recordProcess(x.input),/permanently denies/u);
    const y=await target(); await journal.recordStop({ attemptId:y.input.attemptId,fence:y.input.fence,observation:{ state:"lost",sealed:true,reason:"sealed_launch_job_empty" } });
    assert.equal(await claim(y.input.attemptId),undefined);
    const stopOwner=await f.sample(),z=await target(),w=await stoppedWorker(z.input.root,stopOwner); assert.equal((await claim(w.registration.workerProcessId)).owner_kind,"worker");
    await assert.rejects(journal.recordStop(z.stop),collision);
    assert.equal(await claim((await stoppedWorker()).registration.workerProcessId),undefined);
  });
  await check("leading-zero worker tokens retain spelling but cannot alias numeric FILETIME ownership",async()=>{
    const w=await f.sample(),x=await target(),token=x.input.root.processStartToken.replace(":",":0");
    await f.workers.recordWorkerProcessFromRun({ ...w.registration,...x.input.root,processStartToken:token });
    const c=await claim(w.registration.workerProcessId); assert.equal(c.process_start_token,token);
    assert.equal(BigInt(c.process_start_filetime),BigInt(x.input.root.processStartToken.slice(15)));
    await assert.rejects(journal.recordProcess(x.input),collision);
  });
  await check("PID reuse with another creation token remains distinct after the first owner stops",async()=>{
    const w=await f.sample(),later=await f.sample(),x=await target(),registration={ ...w.registration,...x.input.root };
    await f.workers.recordWorkerProcessFromRun(registration); await w.finishOwner(registration);
    await f.workers.recordWorkerProcessFromRun({ ...later.registration,...x.input.root,processStartToken:`win32-filetime:${BigInt(x.input.root.processStartToken.slice(15))+1n}` });
    assert.notEqual((await claim(w.registration.workerProcessId)).process_start_filetime,(await claim(later.registration.workerProcessId)).process_start_filetime);
  });
  await check("host labels, boot timestamps and Windows sessions cannot split a machine-level root",async()=>{
    const other=await launchRecoveryFixture(pool,"host:native-root-alias","0020");
    for(const change of [{},{ bootedAt:"2026-08-31T00:00:00.000Z" },{ sessionId:2 }]) {
      const w=await f.sample(),fence=w.start.launchIntent.fence;
      const alias=await other.sample(false,{ ...fence,scope:{ ...fence.scope,...change } }),x=await target();
      await f.workers.recordWorkerProcessFromRun({ ...w.registration,...x.input.root });
      await assert.rejects(other.workers.recordWorkerProcessFromRun({ ...alias.registration,...x.input.root }),collision);
      assert.equal(await claim(alias.registration.workerProcessId),undefined);
    }
    const w=await f.sample(),fence=w.start.launchIntent.fence;
    const distinct=await other.sample(false,{ ...fence,scope:{ ...fence.scope,machineFingerprint:"a".repeat(64) } }),x=await target();
    await f.workers.recordWorkerProcessFromRun({ ...w.registration,...x.input.root });
    await other.workers.recordWorkerProcessFromRun({ ...distinct.registration,...x.input.root });
    assert.notEqual((await claim(w.registration.workerProcessId)).machine_fingerprint,(await claim(distinct.registration.workerProcessId)).machine_fingerprint);
  });
  await check("direct projection insertion cannot invent a source or substitute its root metadata",async()=>{
    const x=await target(); await journal.recordProcess(x.input);
    const columns="owner_id,owner_kind,host_identifier,tree_identifier,process_id,process_start_token,supervision_scope";
    await assert.rejects(pool.query(`INSERT INTO acp.windows_native_root_claims(${columns}) SELECT $1,owner_kind,host_identifier,tree_identifier,process_id,process_start_token,supervision_scope FROM acp.windows_native_root_claims WHERE owner_id=$2`,[createStableId("worktreeProvisionerAttempt"),x.input.attemptId]),/one exact scoped retained source/u);
    await assert.rejects(pool.query(`INSERT INTO acp.windows_native_root_claims(${columns}) SELECT owner_id,owner_kind,host_identifier,tree_identifier,process_id+1,process_start_token,supervision_scope FROM acp.windows_native_root_claims WHERE owner_id=$1`,[x.input.attemptId]),/match its exact retained source/u);
  });
  await check("worker source TRUNCATE cannot orphan retained native ownership",async()=>{
    const before=(await pool.query("SELECT count(*)::int AS count FROM acp.worker_processes")).rows[0].count; assert.ok(before>0);
    await assert.rejects(pool.query("TRUNCATE acp.worker_processes"),/foreign key/u);
    await assert.rejects(pool.query("TRUNCATE acp.worker_processes CASCADE"),/append-only/u);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM acp.worker_processes")).rows[0].count,before);
  });
  }
  if(phase==="races") {
    for(const direction of ["down","up"] as const) await check(`${direction} fails fast on an active source writer instead of joining its lock cycle`,async()=>{
      const client=await pool.connect(),watching=new AbortController(); let pending:Promise<unknown>|undefined,blocked:Promise<void>|undefined,failed=false;
      try {
        await client.query("BEGIN"); const pid=Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        await client.query("LOCK TABLE acp.worker_processes IN ROW EXCLUSIVE MODE");
        pending=assert.rejects(migration(direction),(error:unknown)=>(error as {code?:string}).code==="55P03"); void pending.catch(()=>{});
        blocked=waitBlocked(pid,watching.signal);
        assert.equal(await Promise.race([pending.then(()=>"rejected"),blocked.then(()=>"waited")]),"rejected");
      } catch(error) { failed=true; throw error; }
      finally {
        watching.abort(); const rollback=await Promise.allSettled([client.query("ROLLBACK")]); client.release(true);
        const cleanup=[...rollback,...await Promise.allSettled([blocked,pending])];
        const failure=cleanup.find((result)=>result.status==="rejected"); if(!failed && failure?.status==="rejected") throw failure.reason;
      }
      // The successful retry is explicit and only after the writer is quiescent.
      await migration(direction);
    });
    for(const workerFirst of [true,false]) for(const committed of [true,false]) await check(`${workerFirst ? "worker" : "provisioner"}-first ${committed ? "commit" : "rollback"} serializes cross-class root ownership`,async()=>{
      const w=await f.sample(),x=await target(),registration={ ...w.registration,...x.input.root },client=await pool.connect(); let pending:Promise<unknown>|undefined;
      try {
        await client.query("BEGIN"); const pid=Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        await (workerFirst ? directWorker(client,registration) : directProcess(client,x));
        const contender=workerFirst ? journal.recordProcess(x.input) : f.workers.recordWorkerProcessFromRun(registration);
        pending=committed ? assert.rejects(contender,collision) : contender; void pending.catch(()=>{});
        await waitBlocked(pid); await client.query(committed ? "COMMIT" : "ROLLBACK"); await pending;
      } finally { await client.query("ROLLBACK"); client.release(); if(pending) await pending; }
      const workerWins=committed===workerFirst;
      assert.equal(Boolean(await claim(registration.workerProcessId)),workerWins); assert.equal(Boolean(await claim(x.input.attemptId)),!workerWins);
      assert.equal(Boolean(await f.workers.loadWorkerProcess(registration.workerProcessId)),workerWins);
      assert.equal((await journal.load(x.input.attemptId))?.state,workerWins ? "unrecorded" : "process_recorded");
    });
  }
  if(phase==="upgrade") {
    await check("populated process and stop-only history backfills once and reconstructs exactly after downgrade",async()=>{
      const w=await f.sample(),stopOwner=await f.sample(),x=await target(),y=await target(),z=await target();
      const legacyToken="win32-filetime:0134329999999999999";
      await f.workers.recordWorkerProcessFromRun({ ...w.registration,processId:2147483650,processStartToken:legacyToken });
      await journal.recordProcess(x.input); await journal.recordStop(x.stop); await journal.recordStop(y.stop);
      const stopped=await stoppedWorker(z.input.root,stopOwner),absent=await stoppedWorker();
      const sources=await journal.load(x.input.attemptId); assert.equal((await pool.query("SELECT to_regclass('acp.windows_native_root_claims') AS name")).rows[0].name,null);
      await migration("up"); const before=(await pool.query("SELECT to_jsonb(c) AS value FROM acp.windows_native_root_claims c ORDER BY owner_id")).rows;
      for(const id of [w.registration.workerProcessId,x.input.attemptId,y.input.attemptId,stopped.registration.workerProcessId]) assert.ok(await claim(id));
      assert.equal((await claim(w.registration.workerProcessId)).process_id,"2147483650"); assert.equal((await claim(w.registration.workerProcessId)).process_start_token,legacyToken);
      assert.equal(await claim(absent.registration.workerProcessId),undefined);
      await migration("down"); assert.deepEqual(await journal.load(x.input.attemptId),sources); await migration("up");
      assert.deepEqual((await pool.query("SELECT to_jsonb(c) AS value FROM acp.windows_native_root_claims c ORDER BY owner_id")).rows,before);
    });
    await check("conflicting history admitted while downgraded prevents a destructive or partial re-upgrade",async()=>{
      const w=await f.sample(),x=await target(); await journal.recordProcess(x.input); await migration("down");
      await f.workers.recordWorkerProcessFromRun({ ...w.registration,...x.input.root });
      const before=await journal.load(x.input.attemptId); await assert.rejects(migration("up"),collision);
      assert.equal((await pool.query("SELECT to_regclass('acp.windows_native_root_claims') AS name")).rows[0].name,null);
      assert.deepEqual(await journal.load(x.input.attemptId),before); assert.ok(await f.workers.loadWorkerProcess(w.registration.workerProcessId));
    });
  }
  if(phase==="conflict") {
    await check("pre-upgrade numeric-token aliases across classes reject backfill atomically",async()=>{
      const w=await f.sample(),x=await target(); await journal.recordProcess(x.input);
      await f.workers.recordWorkerProcessFromRun({ ...w.registration,...x.input.root,processStartToken:x.input.root.processStartToken.replace(":",":0") });
      const before=await journal.load(x.input.attemptId); await assert.rejects(migration("up"),collision);
      assert.equal((await pool.query("SELECT to_regclass('acp.windows_native_root_claims') AS name")).rows[0].name,null);
      assert.deepEqual(await journal.load(x.input.attemptId),before); assert.ok(await f.workers.loadWorkerProcess(w.registration.workerProcessId));
    });
  }
  process.stdout.write(`Native root claim integration ${phase}: ${checks} checks passed.\n`);
} finally { await pool.end(); }
