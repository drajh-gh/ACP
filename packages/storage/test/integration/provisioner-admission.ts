import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool,type PoolClient,type QueryResult,type QueryResultRow } from "pg";
import { createStableId } from "@acp/domain";
import { PostgresRepositoryBindingStore,PostgresWorktreeReservationStore,PostgresWorktreeProvisionerStore,PostgresProvisionerJournalStore,
  PostgresProvisionerAdmissionStore,type ProvisionerAdmissionRequest,type ProvisionerStopRecordInput } from "../../src/index.ts";
import { launchRecoveryFixture } from "./launch-recovery-fixture.ts";

const port=Number(process.argv[2]),phase=process.argv[3];
if(!Number.isInteger(port) || port<1024 || port>65535 || !["core","races","expiry","sessions","upgrade"].includes(phase??"")) throw new Error("owned port and exact admission phase required");
const pool=new Pool({ connectionString:`postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test`,max:4,connectionTimeoutMillis:3000,statement_timeout:5000,lock_timeout:2000 });
let checks=0,identities=0;
const identity=()=>`win32-dir:87654321:${(++identities).toString(16).padStart(16,"0")}`;
async function check(name:string,action:()=>Promise<void>) { await action(); checks++; process.stdout.write(`PASS provisioner admission: ${name}\n`); }
try {
  const f=await launchRecoveryFixture(pool,"host:provisioner-admission",phase==="upgrade" ? "0020" : "0021");
  const registry=new PostgresRepositoryBindingStore(pool,f.runtime),holds=new PostgresWorktreeReservationStore(pool,f.runtime),plans=new PostgresWorktreeProvisionerStore(pool,f.runtime),journal=new PostgresProvisionerJournalStore(pool,f.runtime),admissions=new PostgresProvisionerAdmissionStore(pool,f.runtime);
  async function target(deadlineMs=15000) {
    const reservationId=createStableId("worktreeReservation"),workspacePath=`C:\\ACP-admission-tests\\planned\\${reservationId}`;
    const a=await f.assignment(undefined,workspacePath,true),repoId=createStableId("repositoryBinding");
    await registry.recordRepository({ repositoryBindingId:repoId,repositoryId:createStableId("repository"),projectId:a.packet.projectId,machineFingerprint:"b".repeat(64),
      checkout:{ path:`C:\\ACP-admission-tests\\repos\\${repoId}`,identity:identity() },commonGitDirectory:{ path:`C:\\ACP-admission-tests\\repos\\${repoId}\\.git`,identity:identity() },
      observedAt:new Date().toISOString(),provenanceId:a.a.packetProvenanceId });
    const hold=await holds.reserve({ reservationId,repositoryBindingId:repoId,missionId:a.a.missionId,nodeId:a.a.nodeId,graphRevision:"launch-recovery-check",workspacePath,
      branchRef:"refs/heads/Admission/ExactCase",provenanceId:a.a.packetProvenanceId });
    const rawHold=(await pool.query("SELECT to_jsonb(r) AS row FROM acp.worktree_reservations r WHERE reservation_id=$1",[hold.reservationId])).rows[0].row;
    const times=(await pool.query("SELECT to_jsonb(clock_timestamp()) AS at,to_jsonb(least(clock_timestamp()+$1*interval '1 millisecond',expires_at-interval '10 milliseconds')) AS deadline FROM acp.worktree_reservations WHERE reservation_id=$2",[deadlineMs,reservationId])).rows[0];
    const plan=await plans.plan({ attemptId:createStableId("worktreeProvisionerAttempt"),reservationId,reservationRevision:hold.revision,baseRevision:"a".repeat(40),
      reportedParent:{ path:"C:\\ACP-admission-tests\\planned",identity:identity(),observedAt:times.at as string },
      fencePlan:{ namespace:"acp-worktree-provisioner-v1",directory:"C:\\ACP-admission-fences" },deadlineAt:times.deadline as string });
    const native=(await pool.query(`WITH t AS MATERIALIZED(SELECT clock_timestamp() AS at)
      SELECT to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'7Z' AS started,
        'win32-filetime:'||((extract(epoch FROM at)*10000000+116444736000000000+7)::numeric(30,0))::text AS token FROM t`)).rows[0];
    const input:ProvisionerAdmissionRequest={ attemptId:plan.attemptId,fence:{ ...plan.fencePlan,directoryIdentity:identity(),scope:{ machineFingerprint:"b".repeat(64),bootedAt:"2026-09-01T00:00:00.000Z",sessionId:1 } },
      root:{ processId:960000+identities,processStartToken:native.token as string,startedAt:native.started as string },challenge:{ nonce:"c".repeat(32),epoch:1 } };
    const process={ attemptId:input.attemptId,fence:input.fence,root:input.root };
    const stop:ProvisionerStopRecordInput={ attemptId:input.attemptId,fence:input.fence,observation:{ state:"terminated",sealed:true,reason:"exact_owned_tree_terminated",exitCode:0,root:input.root } };
    return { a,hold,rawHold,plan,input,process,stop };
  }
  async function unchanged(x:Awaited<ReturnType<typeof target>>,state=x.hold.state) {
    assert.deepEqual((await pool.query("SELECT to_jsonb(r) AS row FROM acp.worktree_reservations r WHERE reservation_id=$1",[x.hold.reservationId])).rows[0].row,x.rawHold);
    assert.deepEqual(await holds.load(x.hold.reservationId),{ ...x.hold,state });
    assert.equal((await pool.query("SELECT 1 FROM acp.filesystem_exclusion_keys WHERE reservation_id=$1",[x.hold.reservationId])).rowCount,4);
    assert.equal((await pool.query("SELECT 1 FROM acp.worker_runs WHERE mission_id=$1",[x.plan.missionId])).rowCount,0);
  }
  async function history(attemptId:string) {
    return (await pool.query(`SELECT
      (SELECT count(*)::int FROM acp.worktree_provisioner_processes WHERE attempt_id=$1) AS processes,
      (SELECT count(*)::int FROM acp.worktree_provisioner_admissions WHERE attempt_id=$1) AS admissions,
      (SELECT count(*)::int FROM acp.windows_native_root_claims WHERE owner_id=$1) AS claims,
      (SELECT array_agg(event_type ORDER BY occurred_at) FROM acp.mission_events WHERE idempotency_key=$1
        AND event_type IN('filesystem.provisioner-process-recorded','filesystem.provisioner-admitted','filesystem.provisioner-stopped')) AS events`,[attemptId])).rows[0];
  }
  const empty={ processes:0,admissions:0,claims:0,events:null };
  const admitted={ processes:1,admissions:1,claims:1,events:["filesystem.provisioner-process-recorded","filesystem.provisioner-admitted"] };
  type Client={ query:Pool["query"] };
  function intercepted(before:(client:Client,sql:string)=>Promise<void>,after?:(client:Client,sql:string)=>Promise<void>) {
    const evidence:{ pids:number[];ended:Promise<void>[];discards:(boolean|Error|undefined)[];queries:string[] }={ pids:[],ended:[],discards:[],queries:[] };
    const store=new PostgresProvisionerAdmissionStore({ options:pool.options,async connect() {
      const client=await pool.connect(); evidence.pids.push(Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid)); evidence.ended.push(new Promise<void>((resolve)=>client.once("end",()=>resolve())));
      return { on:client.on.bind(client),off:client.off.bind(client),release:(discard?:boolean|Error)=>{ evidence.discards.push(discard); client.release(discard); },
        async query<R extends QueryResultRow>(sql:string,values?:unknown[]):Promise<QueryResult<R>> { evidence.queries.push(sql); await before(client,sql); const result=await client.query<R>(sql,values); await after?.(client,sql); return result; } };
    } } as unknown as Pool,f.runtime);
    return { store,evidence };
  }
  async function closed(e:ReturnType<typeof intercepted>["evidence"]) {
    await Promise.all(e.ended); assert.deepEqual(e.discards,[true]); assert.equal((await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=ANY($1::int[])",[e.pids])).rowCount,0);
  }
  async function directProcess(x:Awaited<ReturnType<typeof target>>,client:Client=pool,extra:Record<string,unknown>={}) {
    const i=x.input,a=f.runtime;
    return client.query(`INSERT INTO acp.worktree_provisioner_processes SELECT (jsonb_populate_record(NULL::acp.worktree_provisioner_processes,$1::jsonb)).*`,[JSON.stringify({
      attempt_id:i.attemptId,admission_attempt_id:i.attemptId,fence_namespace:i.fence.namespace,fence_directory:i.fence.directory,directory_identity:i.fence.directoryIdentity,supervision_scope:i.fence.scope,
      host_identifier:a.hostIdentifier,owner_session_id:a.sessionId,application_version:a.applicationVersion,root_process_id:i.root.processId,root_process_start_token:i.root.processStartToken,root_started_at:i.root.startedAt,...extra })]);
  }
  async function directAdmission(x:Awaited<ReturnType<typeof target>>,client:Client=pool,extra:Record<string,unknown>={}) {
    return client.query(`INSERT INTO acp.worktree_provisioner_admissions SELECT (jsonb_populate_record(NULL::acp.worktree_provisioner_admissions,$1::jsonb)).*`,[JSON.stringify({ attempt_id:x.input.attemptId,challenge_nonce:x.input.challenge.nonce,challenge_epoch:1,...extra })]);
  }
  async function migration(direction:"up"|"down") {
    const client=await pool.connect();
    try { await client.query("BEGIN"); await client.query(await readFile(new URL(`../../migrations/0021_provisioner_admissions${direction==="down" ? ".down" : ""}.sql`,import.meta.url),"utf8")); await client.query("COMMIT"); }
    finally { await client.query("ROLLBACK"); client.release(); }
  }
  async function waitPast(at:string) {
    const ms=(await pool.query("SELECT greatest(0,extract(epoch FROM($1::timestamptz-clock_timestamp()))*1000)::float8 AS ms",[at])).rows[0].ms as number;
    await new Promise((done)=>setTimeout(done,Math.ceil(ms)+30));
  }
  async function waitBlocked(pid:number) {
    for(let i=0;i<100;i++) { if((await pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE NOT granted AND $1=ANY(pg_blocking_pids(pid))) AS blocked",[pid])).rows[0].blocked) return; await new Promise((done)=>setTimeout(done,10)); }
    throw new Error("admission did not wait for exact incumbent transaction");
  }
  if(phase==="core") {
    await check("fresh atomic acknowledgement binds exact challenge, original hold and root claim without a worker or renewal",async()=>{
      const x=await target(),ack=await admissions.admit(x.input);
      assert.equal(ack.fresh,true); assert.deepEqual(ack.root,x.input.root); assert.deepEqual(ack.fence,x.input.fence); assert.deepEqual(ack.challenge,x.input.challenge);
      assert.equal(ack.reservationId,x.hold.reservationId); assert.equal(ack.reservationRevision,x.hold.revision); assert.equal(ack.deadlineAt,x.plan.deadlineAt);
      assert.equal(ack.rootClaimOwnerId,x.plan.attemptId); assert.equal(ack.provenanceId,x.plan.provenanceId); assert.equal(ack.ownerSessionId,f.runtime.sessionId);
      assert.ok(ack.durationMilliseconds>250 && ack.durationMilliseconds<=15000);
      assert.equal((await pool.query("SELECT duration_milliseconds=floor(extract(epoch FROM(deadline_at-admitted_at))*1000)::integer AS exact FROM acp.worktree_provisioner_admissions WHERE attempt_id=$1",[x.plan.attemptId])).rows[0].exact,true);
      assert.deepEqual(await history(x.plan.attemptId),admitted); await unchanged(x);
      assert.equal((await pool.query("SELECT payload=(SELECT to_jsonb(p)-'admission_attempt_id' FROM acp.worktree_provisioner_processes p WHERE p.attempt_id=$1) AND event_version='1.0.0' AS compatible FROM acp.mission_events WHERE idempotency_key=$1 AND event_type='filesystem.provisioner-process-recorded'",[x.plan.attemptId])).rows[0].compatible,true);
      for(const input of [x.input,{ ...x.input,challenge:{ nonce:"d".repeat(32),epoch:1 as const } }]) await assert.rejects(admissions.admit(input),/fresh unrecorded/u);
      assert.deepEqual(await history(x.plan.attemptId),admitted); await unchanged(x);
    });
    await check("standalone process and sealed stop history cannot become fresh admission, including direct SQL",async()=>{
      for(const stopped of [false,true]) {
        const x=await target(); if(stopped) await journal.recordStop(x.stop); else await journal.recordProcess(x.process);
        const before=await history(x.plan.attemptId); await assert.rejects(admissions.admit(x.input),/fresh unrecorded/u); await assert.rejects(directAdmission(x),/fresh same-transaction process/u);
        assert.deepEqual(await history(x.plan.attemptId),before); await unchanged(x);
      }
    });
    await check("a marked process cannot commit alone and a committed standalone marker cannot be upgraded",async()=>{
      const x=await target(),client=await pool.connect();
      try { await client.query("BEGIN"); await directProcess(x,client); await assert.rejects(client.query("COMMIT"),(error:unknown)=>(error as { code?:string }).code==="23503"); }
      finally { await client.query("ROLLBACK"); client.release(); }
      assert.deepEqual(await history(x.plan.attemptId),empty); await unchanged(x);
      await journal.recordProcess(x.process); await assert.rejects(pool.query("UPDATE acp.worktree_provisioner_processes SET admission_attempt_id=attempt_id WHERE attempt_id=$1",[x.plan.attemptId]),/append-only/u);
      await assert.rejects(directAdmission(x),/fresh same-transaction process/u); assert.equal((await history(x.plan.attemptId)).admissions,0);
    });
    await check("lost actual COMMIT response persists history but never returns or replays a fresh acknowledgement",async()=>{
      const x=await target(),lost=intercepted(async()=>{},async(_client,sql)=>{ if(sql==="COMMIT") throw new Error("lost actual admission COMMIT"); });
      await assert.rejects(lost.store.admit(x.input),/lost actual admission COMMIT/u); await closed(lost.evidence);
      assert.deepEqual(await history(x.plan.attemptId),admitted); await assert.rejects(admissions.admit(x.input),/fresh unrecorded/u); await unchanged(x);
    });
    await check("failure before COMMIT discards the entire process, root claim, admission and audit transaction",async()=>{
      const x=await target(),lost=intercepted(async(_client,sql)=>{ if(sql==="COMMIT") throw new Error("before admission COMMIT"); });
      await assert.rejects(lost.store.admit(x.input),/before admission COMMIT/u); await closed(lost.evidence);
      assert.deepEqual(await history(x.plan.attemptId),empty); await unchanged(x); await admissions.admit(x.input);
    });
    await check("direct SQL derives immutable admission metadata and requires its deferred process pair",async()=>{
      const x=await target(),client=await pool.connect();
      try {
        await client.query("BEGIN"); await directProcess(x,client);
        await directAdmission(x,client,{ reservation_revision:999,deadline_at:"2099-01-01",admitted_at:"2000-01-01",duration_milliseconds:20000,
          root_claim_owner_id:createStableId("worktreeProvisionerAttempt"),provenance_id:createStableId("provenance"),host_identifier:"forged",owner_session_id:createStableId("workerHostSession"),application_version:"forged" });
        assert.equal((await client.query("SELECT admission_attempt_id=attempt_id AS exact FROM acp.worktree_provisioner_processes WHERE attempt_id=$1",[x.plan.attemptId])).rows[0].exact,true);
        await client.query("COMMIT");
      } finally { await client.query("ROLLBACK"); client.release(); }
      const row=(await pool.query("SELECT to_jsonb(a) AS row FROM acp.worktree_provisioner_admissions a WHERE attempt_id=$1",[x.plan.attemptId])).rows[0].row;
      assert.equal(row.reservation_revision,x.hold.revision); assert.equal(row.deadline_at,x.plan.deadlineAt); assert.equal(row.provenance_id,x.plan.provenanceId); assert.equal(row.host_identifier,f.runtime.hostIdentifier);
      assert.deepEqual(await history(x.plan.attemptId),admitted); await unchanged(x);
      for(const sql of ["UPDATE acp.worktree_provisioner_admissions SET challenge_epoch=1","DELETE FROM acp.worktree_provisioner_admissions","TRUNCATE acp.worktree_provisioner_admissions CASCADE"]) await assert.rejects(pool.query(sql),/append-only/u);
      await assert.rejects(pool.query("TRUNCATE acp.worktree_provisioner_admissions"),/foreign key constraint/u);
      await assert.rejects(migration("down"),/cannot downgrade retained provisioner admission/u); assert.deepEqual(await history(x.plan.attemptId),admitted);
    });
    await check("malformed native challenges rejected by SQL roll back their newly inserted process and claim",async()=>{
      for(const extra of [{ challenge_nonce:"c".repeat(31) },{ challenge_nonce:"c".repeat(32)+"\n" },{ challenge_epoch:2 }]) {
        const x=await target(),client=await pool.connect();
        try { await client.query("BEGIN"); await directProcess(x,client); await assert.rejects(directAdmission(x,client,extra)); }
        finally { await client.query("ROLLBACK"); client.release(); }
        assert.deepEqual(await history(x.plan.attemptId),empty); await unchanged(x);
      }
    });
    await check("two simultaneous exact requests have exactly one fresh winner",async()=>{
      const x=await target(),results=await Promise.allSettled([admissions.admit(x.input),admissions.admit(x.input)]);
      assert.equal(results.filter((r)=>r.status==="fulfilled").length,1); assert.equal(results.filter((r)=>r.status==="rejected").length,1);
      assert.deepEqual(await history(x.plan.attemptId),admitted); await unchanged(x);
    });
    await check("a globally occupied native root rolls back the new admission without replacing its incumbent",async()=>{
      const x=await target(),y=await target(); // Both plans predate the chosen native root.
      await admissions.admit(y.input); const before=await history(y.plan.attemptId);
      await assert.rejects(admissions.admit({ ...x.input,root:y.input.root }),/duplicate key/u);
      assert.deepEqual(await history(x.plan.attemptId),empty); assert.deepEqual(await history(y.plan.attemptId),before); await unchanged(x);
    });
  }
  if(phase==="races") {
    for(const stopFirst of [false,true]) await check(`${stopFirst ? "stop" : "admission"}-first transactions serialize and preserve exact terminal history`,async()=>{
      const x=await target(),client=await pool.connect(); let pending:Promise<unknown>|undefined;
      try {
        await client.query("BEGIN"); const pid=Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        if(stopFirst) {
          await client.query("SELECT acp.lock_provisioner_journal($1)",[x.plan.attemptId]);
          const i=x.input; await client.query(`INSERT INTO acp.worktree_provisioner_stops(attempt_id,fence_namespace,fence_directory,directory_identity,supervision_scope,host_identifier,owner_session_id,application_version,launch_sealed,process_state,reason)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,true,'lost','sealed_launch_job_empty')`,[i.attemptId,i.fence.namespace,i.fence.directory,i.fence.directoryIdentity,i.fence.scope,f.runtime.hostIdentifier,f.runtime.sessionId,f.runtime.applicationVersion]);
          pending=assert.rejects(admissions.admit(x.input),/fresh unrecorded/u);
        } else {
          await directProcess(x,client); await directAdmission(x,client); pending=journal.recordStop(x.stop);
        }
        void pending.catch(()=>{}); await waitBlocked(pid); await client.query("COMMIT"); await pending;
      } finally { await client.query("ROLLBACK"); client.release(); if(pending) await pending; }
      const result=await history(x.plan.attemptId); assert.equal(result.admissions,stopFirst ? 0 : 1); assert.equal(result.processes,stopFirst ? 0 : 1);
      assert.equal((await journal.load(x.plan.attemptId))?.state,"stop_recorded"); await unchanged(x);
    });
    await check("hold renewal first invalidates captured revision instead of extending provisioner authority",async()=>{
      const x=await target(),client=await pool.connect(); let pending:Promise<unknown>|undefined;
      try {
        await client.query("BEGIN"); const pid=Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        await client.query("UPDATE acp.worktree_reservations SET heartbeat_at=clock_timestamp() WHERE reservation_id=$1",[x.hold.reservationId]);
        pending=assert.rejects(admissions.admit(x.input),/current original runtime.*plan authority/u); void pending.catch(()=>{}); await waitBlocked(pid); await client.query("COMMIT"); await pending;
      } finally { await client.query("ROLLBACK"); client.release(); if(pending) await pending; }
      assert.deepEqual(await history(x.plan.attemptId),empty); assert.equal((await holds.load(x.hold.reservationId))?.revision,2); assert.equal((await plans.load(x.plan.attemptId))?.deadlineAt,x.plan.deadlineAt);
    });
    for(const change of ["cancel","retire"] as const) await check(`${change}-first authority invalidation denies a waiting admission and retains its hold`,async()=>{
      const x=await target(),client=await pool.connect(); let pending:Promise<unknown>|undefined;
      try {
        await client.query("BEGIN"); const pid=Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        if(change==="cancel") await client.query("UPDATE acp.worker_dispatches SET state='cancelled',reason='Synthetic admission cancellation.' WHERE run_id=$1",[x.plan.dispatchRunId]);
        else await client.query(`INSERT INTO acp.repository_binding_retirements(repository_binding_id,host_identifier,owner_session_id,application_version,provenance_id,reason)
          VALUES($1,$2,$3,$4,$5,'Synthetic admission retirement.')`,[x.plan.repositoryBindingId,f.runtime.hostIdentifier,f.runtime.sessionId,f.runtime.applicationVersion,x.hold.provenanceId]);
        pending=assert.rejects(admissions.admit(x.input),/current original runtime.*plan authority/u); void pending.catch(()=>{}); await waitBlocked(pid); await client.query("COMMIT"); await pending;
      } finally { await client.query("ROLLBACK"); client.release(); if(pending) await pending; }
      assert.deepEqual(await history(x.plan.attemptId),empty); await unchanged(x,"recovering");
    });
    await check("an already-admitted worker cannot also receive fresh provisioner permission",async()=>{
      const x=await target(); await f.workers.startRun(x.a.start);
      await assert.rejects(admissions.admit(x.input),/current original runtime.*plan authority/u); assert.deepEqual(await history(x.plan.attemptId),empty);
      assert.deepEqual(await holds.load(x.hold.reservationId),{ ...x.hold,state:"recovering" }); assert.equal((await pool.query("SELECT 1 FROM acp.filesystem_exclusion_keys WHERE reservation_id=$1",[x.hold.reservationId])).rowCount,4);
    });
  }
  if(phase==="expiry") {
    await check("the admission safety margin denies an otherwise-live process during the last250ms",async()=>{
      const x=await target(1500),client=await pool.connect();
      try {
        await client.query("BEGIN"); await directProcess(x,client); await directAdmission(x,client);
        // Server-side ordering removes a host scheduling gap between the live
        // process guard and the stricter admission guard under the same clock.
        await client.query(`DO $$ DECLARE original_deadline timestamptz; BEGIN
          SELECT deadline_at INTO STRICT original_deadline FROM acp.worktree_provisioner_admissions WHERE attempt_id='${x.plan.attemptId}';
          PERFORM pg_sleep(greatest(0,extract(epoch FROM(original_deadline-clock_timestamp()))-0.2));
          SET CONSTRAINTS acp.worktree_provisioner_processes_commit_authority IMMEDIATE;
          BEGIN
            SET CONSTRAINTS acp.worktree_provisioner_admissions_commit_authority IMMEDIATE;
            RAISE EXCEPTION 'missing admission safety margin';
          EXCEPTION WHEN raise_exception THEN
            IF SQLERRM<>'provisioner admission authority ended before commit' THEN RAISE; END IF;
            IF clock_timestamp()>=original_deadline THEN RAISE EXCEPTION 'margin evidence arrived after ordinary expiry'; END IF;
          END;
        END $$`);
      } finally { await client.query("ROLLBACK"); client.release(); }
      assert.deepEqual(await history(x.plan.attemptId),empty); await unchanged(x);
    });
    await check("original deadline expiry before admission or deferred COMMIT never returns fresh authority",async()=>{
      const x=await target(500); await waitPast(x.plan.deadlineAt); await assert.rejects(admissions.admit(x.input),/plan authority/u); assert.deepEqual(await history(x.plan.attemptId),empty);
      const y=await target(700),late=intercepted(async(_client,sql)=>{ if(sql==="COMMIT") await waitPast(y.plan.deadlineAt); });
      await assert.rejects(late.store.admit(y.input),/authority ended before commit/u); await closed(late.evidence); assert.deepEqual(await history(y.plan.attemptId),empty); await unchanged(y);
    });
    for(const change of ["hold","runtime","cancel","retire","stop"] as const) await check(`${change} drift in the same transaction is rechecked at deferred COMMIT`,async()=>{
      const x=await target(),changed=intercepted(async(client,sql)=>{
        if(sql!=="COMMIT") return;
        if(change==="hold") await client.query("UPDATE acp.worktree_reservations SET heartbeat_at=clock_timestamp() WHERE reservation_id=$1",[x.hold.reservationId]);
        else if(change==="runtime") await client.query("UPDATE acp.worker_host_sessions SET state='closed' WHERE host_identifier=$1",[f.runtime.hostIdentifier]);
        else if(change==="cancel") await client.query("UPDATE acp.worker_dispatches SET state='cancelled',reason='Synthetic deferred admission cancellation.' WHERE run_id=$1",[x.plan.dispatchRunId]);
        else if(change==="retire") await client.query(`INSERT INTO acp.repository_binding_retirements(repository_binding_id,host_identifier,owner_session_id,application_version,provenance_id,reason)
          VALUES($1,$2,$3,$4,$5,'Synthetic deferred admission retirement.')`,[x.plan.repositoryBindingId,f.runtime.hostIdentifier,f.runtime.sessionId,f.runtime.applicationVersion,x.hold.provenanceId]);
        else { const i=x.input; await client.query(`INSERT INTO acp.worktree_provisioner_stops(attempt_id,fence_namespace,fence_directory,directory_identity,supervision_scope,host_identifier,owner_session_id,application_version,launch_sealed,process_state,reason,root_process_id,root_process_start_token,root_started_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,true,'lost','owned_job_empty',$9,$10,$11)`,[i.attemptId,i.fence.namespace,i.fence.directory,i.fence.directoryIdentity,i.fence.scope,f.runtime.hostIdentifier,f.runtime.sessionId,f.runtime.applicationVersion,i.root.processId,i.root.processStartToken,i.root.startedAt]); }
      });
      await assert.rejects(changed.store.admit(x.input),/authority ended before commit/u); await closed(changed.evidence); assert.deepEqual(await history(x.plan.attemptId),empty); await unchanged(x);
    });
  }
  if(phase==="sessions") {
    await check("a killed actual backend issues no post-loss SQL and releases all admission locks",async()=>{
      const x=await target(),killed=intercepted(async()=>{},async(client,sql)=>{
        if(!sql.includes("lock_provisioner_journal")) return;
        const failed=new Promise<void>((resolve)=>(client as PoolClient).once("error",()=>resolve()));
        assert.equal((await pool.query("SELECT pg_terminate_backend($1) AS stopped",[killed.evidence.pids[0]])).rows[0].stopped,true); await failed;
      });
      await assert.rejects(killed.store.admit(x.input),/terminating connection|connection terminated/iu); await closed(killed.evidence);
      assert.deepEqual(killed.evidence.queries,["BEGIN","SELECT acp.lock_provisioner_journal($1)"]); assert.deepEqual(await history(x.plan.attemptId),empty); await unchanged(x);
      await pool.query("SELECT acp.lock_provisioner_journal($1)",[x.plan.attemptId]); await admissions.admit(x.input);
    });
    await check("uncertain actual BEGIN and unavailable rollback preserve the original failure and physically release locks",async()=>{
      const x=await target(),failure=new Error("lost admission BEGIN response"),uncertain=intercepted(async(_client,sql)=>{ if(sql==="ROLLBACK") throw new Error("unavailable rollback"); },async(client,sql)=>{
        if(sql==="BEGIN") { await client.query("SELECT acp.lock_provisioner_journal($1)",[x.plan.attemptId]); throw failure; }
      });
      await assert.rejects(uncertain.store.admit(x.input),(error)=>error===failure); await closed(uncertain.evidence);
      assert.deepEqual(uncertain.evidence.queries,["BEGIN","ROLLBACK"]); assert.deepEqual(await history(x.plan.attemptId),empty); await unchanged(x);
      await pool.query("SELECT acp.lock_provisioner_journal($1)",[x.plan.attemptId]); await admissions.admit(x.input);
    });
    await check("connection loss after both INSERTs cannot commit any fresh-admission state",async()=>{
      const x=await target(),killed=intercepted(async()=>{},async(client,sql)=>{
        if(!sql.includes("RETURNING to_jsonb(worktree_provisioner_admissions)")) return;
        const failed=new Promise<void>((resolve)=>(client as PoolClient).once("error",()=>resolve()));
        assert.equal((await pool.query("SELECT pg_terminate_backend($1) AS stopped",[killed.evidence.pids[0]])).rows[0].stopped,true); await failed;
      });
      await assert.rejects(killed.store.admit(x.input),/terminating connection|connection terminated/iu); await closed(killed.evidence);
      assert.ok(!killed.evidence.queries.includes("COMMIT")); assert.ok(!killed.evidence.queries.includes("ROLLBACK"));
      assert.deepEqual(await history(x.plan.attemptId),empty); await unchanged(x);
    });
  }
  if(phase==="upgrade") {
    await check("upgrade preserves prior journal history but cannot grandfather it into fresh admission",async()=>{
      const x=await target(); await journal.recordProcess(x.process); const before=await journal.load(x.plan.attemptId);
      await migration("up"); assert.deepEqual(await journal.load(x.plan.attemptId),before); await assert.rejects(directAdmission(x),/fresh same-transaction process/u);
      await migration("down"); assert.deepEqual(await journal.load(x.plan.attemptId),before); await migration("up");
      await assert.rejects(admissions.admit(x.input),/fresh unrecorded/u); await unchanged(x);
    });
    await check("an empty admission downgrade fails fast against its exact in-flight writer then preserves the committed record",async()=>{
      const x=await target(),client=await pool.connect();
      try { await client.query("BEGIN"); await directProcess(x,client); await directAdmission(x,client); await assert.rejects(migration("down"),/could not obtain lock/u); await client.query("COMMIT"); }
      finally { await client.query("ROLLBACK"); client.release(); }
      await assert.rejects(migration("down"),/cannot downgrade retained provisioner admission/u); assert.deepEqual(await history(x.plan.attemptId),admitted); await unchanged(x);
    });
  }
  if(!checks) throw new Error("admission phase has no completed checks");
  process.stdout.write(`Provisioner admission integration ${phase}: ${checks} checks passed.\n`);
} finally { await pool.end(); }
