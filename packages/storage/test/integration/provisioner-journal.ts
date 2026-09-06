import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool,type QueryResult,type QueryResultRow } from "pg";
import { createStableId } from "@acp/domain";
import { PostgresRepositoryBindingStore,PostgresWorktreeReservationStore,PostgresWorktreeProvisionerStore,PostgresProvisionerJournalStore,
  parseProvisionerNativeRoot,type ProvisionerProcessRecordInput,type ProvisionerStopRecordInput } from "../../src/index.ts";
import { launchRecoveryFixture } from "./launch-recovery-fixture.ts";

const port=Number(process.argv[2]),phase=process.argv[3];
if(!Number.isInteger(port) || port<1024 || port>65535 || !["core","races","expiry","upgrade"].includes(phase??"")) throw new Error("owned port and exact journal phase required");
const pool=new Pool({ connectionString:`postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test`,max:4,connectionTimeoutMillis:3000,statement_timeout:5000,lock_timeout:2000 });
let checks=0,identities=0;
const identity=()=>`win32-dir:12345678:${(++identities).toString(16).padStart(16,"0")}`;
async function check(name:string,action:()=>Promise<void>) { await action(); checks++; process.stdout.write(`PASS provisioner journal: ${name}\n`); }
try {
  const f=await launchRecoveryFixture(pool,"host:provisioner-journal",phase==="upgrade" ? "0018" : "0019");
  const registry=new PostgresRepositoryBindingStore(pool,f.runtime),holds=new PostgresWorktreeReservationStore(pool,f.runtime),plans=new PostgresWorktreeProvisionerStore(pool,f.runtime),journal=new PostgresProvisionerJournalStore(pool,f.runtime);
  async function target(deadlineMs=15000) {
    const reservationId=createStableId("worktreeReservation"),workspacePath=`C:\\ACP-journal-tests\\planned\\${reservationId}`;
    const a=await f.assignment(undefined,workspacePath,true),repoId=createStableId("repositoryBinding");
    await registry.recordRepository({ repositoryBindingId:repoId,repositoryId:createStableId("repository"),projectId:a.packet.projectId,machineFingerprint:"b".repeat(64),
      checkout:{ path:`C:\\ACP-journal-tests\\repos\\${repoId}`,identity:identity() },commonGitDirectory:{ path:`C:\\ACP-journal-tests\\repos\\${repoId}\\.git`,identity:identity() },
      observedAt:new Date().toISOString(),provenanceId:a.a.packetProvenanceId });
    const hold=await holds.reserve({ reservationId,repositoryBindingId:repoId,missionId:a.a.missionId,nodeId:a.a.nodeId,graphRevision:"launch-recovery-check",workspacePath,
      branchRef:"refs/heads/Journal/ExactCase",provenanceId:a.a.packetProvenanceId });
    const times=(await pool.query("SELECT to_jsonb(clock_timestamp()) AS at,to_jsonb(least(clock_timestamp()+$1*interval '1 millisecond',expires_at-interval '10 milliseconds')) AS deadline FROM acp.worktree_reservations WHERE reservation_id=$2",[deadlineMs,reservationId])).rows[0];
    const plan=await plans.plan({ attemptId:createStableId("worktreeProvisionerAttempt"),reservationId,reservationRevision:hold.revision,baseRevision:"a".repeat(40),
      reportedParent:{ path:"C:\\ACP-journal-tests\\planned",identity:identity(),observedAt:times.at as string },
      fencePlan:{ namespace:"acp-worktree-provisioner-v1",directory:"C:\\ACP-journal-fences" },deadlineAt:times.deadline as string });
    // Independent epoch arithmetic supplies the seventh tick; no new validation helper constructs its own oracle.
    const native=(await pool.query(`WITH t AS MATERIALIZED(SELECT clock_timestamp() AS at)
      SELECT to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'7Z' AS started,
        'win32-filetime:'||((extract(epoch FROM at)*10000000+116444736000000000+7)::numeric(30,0))::text AS token FROM t`)).rows[0];
    const input:ProvisionerProcessRecordInput={ attemptId:plan.attemptId,fence:{ ...plan.fencePlan,directoryIdentity:identity(),scope:{ machineFingerprint:"b".repeat(64),bootedAt:"2026-09-01T00:00:00.000Z",sessionId:1 } },
      root:{ processId:930000+identities,processStartToken:native.token as string,startedAt:native.started as string } };
    const stop:ProvisionerStopRecordInput={ attemptId:input.attemptId,fence:input.fence,observation:{ state:"terminated",sealed:true,reason:"exact_owned_tree_terminated",exitCode:0,root:input.root } };
    return { a,hold,plan,input,stop };
  }
  async function unchanged(x:Awaited<ReturnType<typeof target>>) {
    assert.deepEqual(await holds.load(x.hold.reservationId),x.hold);
    assert.equal((await pool.query("SELECT 1 FROM acp.filesystem_exclusion_keys WHERE reservation_id=$1",[x.hold.reservationId])).rowCount,4);
    assert.equal((await pool.query("SELECT 1 FROM acp.worker_runs WHERE mission_id=$1",[x.plan.missionId])).rowCount,0);
    assert.equal((await pool.query("SELECT 1 FROM acp.worker_processes WHERE run_id IN(SELECT run_id FROM acp.worker_runs WHERE mission_id=$1)",[x.plan.missionId])).rowCount,0);
  }
  async function events(attemptId:string) {
    return (await pool.query("SELECT event_type FROM acp.mission_events WHERE idempotency_key=$1 AND event_type IN('filesystem.provisioner-process-recorded','filesystem.provisioner-stopped') ORDER BY occurred_at",[attemptId])).rows.map((r)=>r.event_type);
  }
  async function migration(direction:"up"|"down") {
    const client=await pool.connect();
    try { await client.query("BEGIN"); await client.query(await readFile(new URL(`../../migrations/0019_provisioner_process_journal${direction==="down" ? ".down" : ""}.sql`,import.meta.url),"utf8")); await client.query("COMMIT"); }
    finally { await client.query("ROLLBACK"); client.release(); }
  }
  function intercepted(before:(client:QueryExecutorLike,sql:string,values?:unknown[])=>Promise<void>,after?:(client:QueryExecutorLike,sql:string)=>Promise<void>,evidence?:{ pids:number[];ended:Promise<void>[];discards:(boolean|Error|undefined)[] }) {
    return new PostgresProvisionerJournalStore({ options:pool.options,async connect() {
      const client=await pool.connect();
      if(evidence) { evidence.pids.push(Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid)); evidence.ended.push(new Promise<void>((resolve)=>client.once("end",()=>resolve()))); }
      return { on:client.on.bind(client),off:client.off.bind(client),release:(discard?:boolean|Error)=>{ evidence?.discards.push(discard); client.release(discard); },
        async query<R extends QueryResultRow>(sql:string,values?:unknown[]):Promise<QueryResult<R>> { await before(client,sql,values); const result=await client.query<R>(sql,values); await after?.(client,sql); return result; } };
    } } as unknown as Pool,f.runtime);
  }
  type QueryExecutorLike={ query:Pool["query"] };
  async function direct(kind:"processes"|"stops",x:Awaited<ReturnType<typeof target>>,overrides:Record<string,unknown>={},client:QueryExecutorLike=pool) {
    const i=x.input,a=f.runtime;
    const row={ attempt_id:i.attemptId,fence_namespace:i.fence.namespace,fence_directory:i.fence.directory,directory_identity:i.fence.directoryIdentity,
      supervision_scope:i.fence.scope,host_identifier:a.hostIdentifier,owner_session_id:a.sessionId,application_version:a.applicationVersion,
      root_process_id:i.root.processId,root_process_start_token:i.root.processStartToken,root_started_at:i.root.startedAt,
      ...(kind==="stops" ? { launch_sealed:true,process_state:"terminated",reason:"exact_owned_tree_terminated",exit_code:0 } : {}),...overrides };
    return client.query(`INSERT INTO acp.worktree_provisioner_${kind} SELECT (jsonb_populate_record(NULL::acp.worktree_provisioner_${kind},$1::jsonb)).*`,[JSON.stringify(row)]);
  }
  async function waitPast(at:string) {
    const ms=(await pool.query("SELECT greatest(0,extract(epoch FROM($1::timestamptz-clock_timestamp()))*1000)::float8 AS ms",[at])).rows[0].ms as number;
    await new Promise((done)=>setTimeout(done,Math.ceil(ms)+30));
  }
  async function waitBlocked(pid:number) {
    for(let i=0;i<100;i++) { if((await pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE NOT granted AND $1=ANY(pg_blocking_pids(pid))) AS blocked",[pid])).rows[0].blocked) return; await new Promise((done)=>setTimeout(done,10)); }
    throw new Error("journal did not wait for exact incumbent transaction");
  }
  if(phase==="core") {
    await check("native identity stays exact while temporal bounds compare the shared database microsecond",async()=>{
      const boundary="2026-09-06T01:00:00.123456Z";
      for(const digit of ["0","7","9"]) {
        const row=(await pool.query(`SELECT acp.provisioner_root_within_recording_window($1,$2,$2) AS valid,
          acp.provisioner_utc7_filetime($1)::text AS ticks,
          div(acp.provisioner_utc7_filetime($1),10)::text AS integer_quotient,
          (extract(epoch FROM $2::timestamptz)*1000000+11644473600000000)::text AS boundary`,[`2026-09-06T01:00:00.123456${digit}Z`,boundary])).rows[0];
        assert.equal(row.valid,true,JSON.stringify(row));
      }
      for(const started of ["2026-09-06T01:00:00.1234559Z","2026-09-06T01:00:00.1234570Z"]) assert.equal((await pool.query("SELECT acp.provisioner_root_within_recording_window($1,$2,$2) AS valid",[started,boundary])).rows[0].valid,false);
    });
    await check("native UTC7 validation agrees with independent known FILETIME values and rejects rounding",async()=>{
      const root={ processId:1,processStartToken:"win32-filetime:134331300001234567",startedAt:"2026-09-06T01:00:00.1234567Z" };
      assert.deepEqual(parseProvisionerNativeRoot(root),root);
      assert.equal((await pool.query("SELECT acp.provisioner_native_root_valid($1,$2,$3) AS valid",[1,root.processStartToken,root.startedAt])).rows[0].valid,true);
      for(const started of ["2026-09-06T01:00:00.1234568Z","2026-09-06T01:00:00.123456Z","2026-02-30T00:00:00.0000000Z","2026-09-06T01:00:00.1234567+00:00"]) {
        assert.equal((await pool.query("SELECT acp.provisioner_native_root_valid($1,$2,$3) AS valid",[1,root.processStartToken,started])).rows[0].valid,false);
      }
      assert.equal((await pool.query("SELECT acp.provisioner_utc7_filetime('1601-01-01T00:00:00.0000000Z')::text AS ticks")).rows[0].ticks,"0");
      assert.equal((await pool.query("SELECT acp.provisioner_utc7_filetime('9999-12-31T23:59:59.9999999Z')::text AS ticks")).rows[0].ticks,"2650467743999999999");
    });
    await check("one exact process journal derives plan authority and retains native ticks without worker admission",async()=>{
      const x=await target(); assert.deepEqual(await journal.load(x.plan.attemptId),{ attemptId:x.plan.attemptId,state:"unrecorded" });
      const [left,right]=await Promise.all([journal.recordProcess(x.input),journal.recordProcess(x.input)]); assert.deepEqual(left,right);
      assert.deepEqual(left.root,x.input.root); assert.equal(left.root.startedAt.at(-2),"7"); assert.equal(left.provenanceId,x.plan.provenanceId);
      assert.equal(left.treeIdentifier,`Local\\ACP.Provisioner.${x.plan.attemptId}`); assert.equal(left.ownerSessionId,x.plan.ownerSessionId);
      assert.deepEqual(await journal.load(x.plan.attemptId),{ attemptId:x.plan.attemptId,state:"process_recorded",process:left });
      assert.deepEqual(await events(x.plan.attemptId),["filesystem.provisioner-process-recorded"]); await unchanged(x);
      for(const change of [{ processId:x.input.root.processId+1 },{ startedAt:x.input.root.startedAt.replace(/7Z$/u,"8Z") }]) await assert.rejects(journal.recordProcess({ ...x.input,root:{ ...x.input.root,...change } }));
      await assert.rejects(new PostgresProvisionerJournalStore(pool,{ ...f.runtime,sessionId:createStableId("workerHostSession") }).recordProcess(x.input),/original actor/u);
      assert.equal(await new PostgresProvisionerJournalStore(pool,{ ...f.runtime,hostIdentifier:"host:foreign" }).load(x.plan.attemptId),undefined);
    });
    await check("matching sealed stop records one terminal claim without releasing or renewing the hold",async()=>{
      const x=await target(),process=await journal.recordProcess(x.input),stop=await journal.recordStop(x.stop);
      assert.deepEqual(await journal.recordStop(x.stop),stop); assert.deepEqual(await journal.recordProcess(x.input),process);
      assert.deepEqual(await journal.load(x.plan.attemptId),{ attemptId:x.plan.attemptId,state:"stop_recorded",process,stop });
      assert.deepEqual(await events(x.plan.attemptId),["filesystem.provisioner-process-recorded","filesystem.provisioner-stopped"]); await unchanged(x);
      await assert.rejects(journal.recordStop({ ...x.stop,observation:{ ...x.stop.observation,exitCode:1 } } as ProvisionerStopRecordInput),/different sealed/u);
    });
    await check("all five native stop forms survive a missing journal and permanently deny a later process",async()=>{
      for(const reason of ["sealed_launch_job_absent","sealed_launch_job_empty","owned_job_and_original_root_absent","owned_job_empty","exact_owned_tree_terminated"] as const) {
        const x=await target(),observation=reason==="exact_owned_tree_terminated" ? x.stop.observation
          : reason.startsWith("sealed_launch_") ? { state:"lost",sealed:true,reason } : { state:"lost",sealed:true,reason,root:x.input.root };
        const input={ ...x.stop,observation } as ProvisionerStopRecordInput,stopped=await journal.recordStop(input);
        assert.deepEqual(stopped.observation,observation); assert.deepEqual(await journal.recordStop(input),stopped);
        await assert.rejects(journal.recordProcess(x.input),/permanently denies/u);
        assert.deepEqual(await events(x.plan.attemptId),["filesystem.provisioner-stopped"]); await unchanged(x);
      }
    });
    await check("a process-backed stop rejects missing, substituted or cross-fence native evidence",async()=>{
      const x=await target(); await journal.recordProcess(x.input);
      for(const candidate of [{ ...x.stop,observation:{ state:"lost",sealed:true,reason:"sealed_launch_job_empty" } },
        { ...x.stop,fence:{ ...x.stop.fence,directoryIdentity:identity() } },
        { ...x.stop,observation:{ state:"terminated",sealed:true,reason:"exact_owned_tree_terminated",exitCode:0,root:{ ...x.input.root,processId:x.input.root.processId+1 } } }]) {
        await assert.rejects(journal.recordStop(candidate as ProvisionerStopRecordInput),/exact recorded native/u);
      }
      assert.equal((await journal.load(x.plan.attemptId))?.state,"process_recorded"); assert.equal((await events(x.plan.attemptId)).length,1);
    });
    await check("lost actual process and stop COMMIT acknowledgements reject without automatic replay",async()=>{
      const x=await target(),evidence:{ pids:number[];ended:Promise<void>[];discards:(boolean|Error|undefined)[] }={ pids:[],ended:[],discards:[] };
      const lost=intercepted(async()=>{},async(_client,sql)=>{ if(sql==="COMMIT") throw new Error("injected lost actual journal COMMIT"); },evidence);
      await assert.rejects(lost.recordProcess(x.input),/lost actual journal/u); const process=await journal.recordProcess(x.input);
      await assert.rejects(lost.recordStop(x.stop),/lost actual journal/u); const stop=await journal.recordStop(x.stop);
      assert.deepEqual(await journal.load(x.plan.attemptId),{ attemptId:x.plan.attemptId,state:"stop_recorded",process,stop });
      assert.deepEqual(await events(x.plan.attemptId),["filesystem.provisioner-process-recorded","filesystem.provisioner-stopped"]);
      await Promise.all(evidence.ended); assert.deepEqual(evidence.discards,[true,true]); assert.equal(new Set(evidence.pids).size,2);
      assert.equal((await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=ANY($1::int[])",[evidence.pids])).rowCount,0); await unchanged(x);
    });
    await check("journal rows reject mutation and populated downgrade without losing audit history",async()=>{
      const x=await target(); await journal.recordProcess(x.input); await journal.recordStop(x.stop); const before=await journal.load(x.plan.attemptId);
      for(const table of ["worktree_provisioner_processes","worktree_provisioner_stops"]) {
        for(const sql of [`UPDATE acp.${table} SET root_process_id=1 WHERE attempt_id=$1`,`DELETE FROM acp.${table} WHERE attempt_id=$1`]) await assert.rejects(pool.query(sql,[x.plan.attemptId]),/append-only/u);
        // Under0021 the deferred admission pair rejects a plain process
        // TRUNCATE before statement triggers; CASCADE must remain immutable too.
        await assert.rejects(pool.query(`TRUNCATE acp.${table}`),/append-only|foreign key constraint/u);
        await assert.rejects(pool.query(`TRUNCATE acp.${table} CASCADE`),/append-only/u);
      }
      await assert.rejects(migration("down"),/cannot downgrade retained/u); assert.deepEqual(await journal.load(x.plan.attemptId),before);
    });
    await check("direct SQL independently derives metadata and denies malformed identity and stop combinations",async()=>{
      const x=await target();
      for(const override of [{ root_process_start_token:x.input.root.processStartToken.replace(/7$/u,"8") },{ root_started_at:"2026-02-30T00:00:00.0000000Z" },
        { fence_namespace:"acp-worker" },{ fence_directory:"C:\\Different-fence" },{ supervision_scope:{ ...x.input.fence.scope,machineFingerprint:"a".repeat(64) } },
        { supervision_scope:{ ...x.input.fence.scope,bootedAt:"2026-09-01T00:00:00.0000000Z" } },{ supervision_scope:{ ...x.input.fence.scope,extra:1 } },
        { owner_session_id:createStableId("workerHostSession") }]) await assert.rejects(direct("processes",x,override));
      await direct("processes",x,{ tree_identifier:"forged tree",provenance_id:createStableId("provenance"),recorded_at:"2000-01-01" });
      const record=(await journal.load(x.plan.attemptId))!.process!;
      assert.equal(record.provenanceId,x.plan.provenanceId); assert.equal(record.treeIdentifier,`Local\\ACP.Provisioner.${x.plan.attemptId}`);
      assert.ok(Date.parse(record.recordedAt)>=Date.parse(x.plan.createdAt));
      for(const override of [{ launch_sealed:false },{ process_state:"success" },{ process_state:"lost" },{ exit_code:null },
        { process_state:"lost",reason:"sealed_launch_job_empty",exit_code:null },{ root_started_at:null },{ reason:"owner_tree_closed_and_launch_sealed" }]) await assert.rejects(direct("stops",x,override));
      await direct("stops",x); assert.equal((await journal.load(x.plan.attemptId))?.state,"stop_recorded"); await unchanged(x);
    });
    await check("killed process and stop sessions issue no post-loss statement and retain their exact prior state",async()=>{
      for(const stopping of [false,true]) {
        const x=await target(); if(stopping) await journal.recordProcess(x.input); const before=await journal.load(x.plan.attemptId),audit=await events(x.plan.attemptId);
        const queries:string[]=[],discards:(boolean|Error|undefined)[]=[]; let pid=0,ended:Promise<void>|undefined;
        const killed=new PostgresProvisionerJournalStore({ options:pool.options,async connect() {
          const client=await pool.connect(); pid=Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
          const failed=new Promise<void>((resolve)=>client.once("error",()=>resolve())); ended=new Promise<void>((resolve)=>client.once("end",()=>resolve()));
          return { on:client.on.bind(client),off:client.off.bind(client),release:(discard?:boolean|Error)=>{ discards.push(discard); client.release(discard); },
            async query<R extends QueryResultRow>(sql:string,values?:unknown[]):Promise<QueryResult<R>> {
              queries.push(sql); const result=await client.query<R>(sql,values);
              if(sql.includes("lock_provisioner_journal")) { assert.equal((await pool.query("SELECT pg_terminate_backend($1) AS stopped",[pid])).rows[0].stopped,true); await failed; }
              return result;
            } };
        } } as unknown as Pool,f.runtime);
        await assert.rejects(stopping ? killed.recordStop(x.stop) : killed.recordProcess(x.input),/terminating connection|connection terminated/iu); await ended;
        assert.deepEqual(discards,[true]); assert.equal(queries.length,2); assert.match(queries[1]!,/lock_provisioner_journal/u);
        assert.equal((await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1",[pid])).rowCount,0);
        await pool.query("SELECT acp.lock_provisioner_journal($1)",[x.plan.attemptId]);
        assert.deepEqual(await journal.load(x.plan.attemptId),before); assert.deepEqual(await events(x.plan.attemptId),audit); await unchanged(x);
        await (stopping ? journal.recordStop(x.stop) : journal.recordProcess(x.input));
      }
    });
    await check("uncertain real BEGIN and failed rollback preserve original failure and release actual journal locks",async()=>{
      const x=await target(),failure=new Error("injected journal BEGIN acknowledgement loss"),evidence:{ pids:number[];ended:Promise<void>[];discards:(boolean|Error|undefined)[] }={ pids:[],ended:[],discards:[] };
      const uncertain=intercepted(async(_client,sql)=>{ if(sql==="ROLLBACK") throw new Error("unavailable rollback"); },async(client,sql)=>{
        if(sql==="BEGIN") { await client.query("SELECT acp.lock_provisioner_journal($1)",[x.plan.attemptId]); throw failure; }
      },evidence);
      await assert.rejects(uncertain.recordProcess(x.input),(error)=>error===failure); await Promise.all(evidence.ended); assert.deepEqual(evidence.discards,[true]);
      assert.equal((await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=ANY($1::int[])",[evidence.pids])).rowCount,0);
      await pool.query("SELECT acp.lock_provisioner_journal($1)",[x.plan.attemptId]);
      assert.deepEqual(await journal.load(x.plan.attemptId),{ attemptId:x.plan.attemptId,state:"unrecorded" }); assert.deepEqual(await events(x.plan.attemptId),[]); await unchanged(x);
      await journal.recordProcess(x.input);
    });
  }
  if(phase==="races") {
    for(const stopping of [false,true]) await check(`${stopping ? "stop" : "process"} journal holds workflow binding authority until commit`,async()=>{
      const x=await target(),client=await pool.connect(),retirement=await pool.connect(); let pending:Promise<unknown>|undefined;
      try {
        await client.query("BEGIN"); await retirement.query("BEGIN"); const pid=Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        await direct(stopping ? "stops" : "processes",x,{},client);
        pending=retirement.query("UPDATE acp.project_workflow_bindings SET retired_at=clock_timestamp() WHERE binding_id=$1",[f.runtime.bindings[0]!.workflowBindingId]);
        await waitBlocked(pid); await client.query("COMMIT"); await pending;
      } finally { await client.query("ROLLBACK"); client.release(); if(pending) await pending; await retirement.query("ROLLBACK"); retirement.release(); }
      assert.equal((await journal.load(x.plan.attemptId))?.state,stopping ? "stop_recorded" : "process_recorded"); await unchanged(x);
    });
    for(const stopFirst of [false,true]) await check(`${stopFirst ? "stop" : "process"}-first transactions serialize before the opposing journal mutation`,async()=>{
      const x=await target(),client=await pool.connect(); let pending:Promise<unknown>|undefined;
      try {
        await client.query("BEGIN"); const pid=Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        await direct(stopFirst ? "stops" : "processes",x,{},client);
        pending=stopFirst ? assert.rejects(journal.recordProcess(x.input),/permanently denies/u) : journal.recordStop(x.stop);
        await waitBlocked(pid); await client.query("COMMIT"); await pending;
      } finally { await client.query("ROLLBACK"); client.release(); if(pending) await pending; }
      const result=await journal.load(x.plan.attemptId); assert.equal(result?.state,"stop_recorded"); assert.equal(Boolean(result?.process),!stopFirst);
      assert.deepEqual(await events(x.plan.attemptId),stopFirst ? ["filesystem.provisioner-stopped"] : ["filesystem.provisioner-process-recorded","filesystem.provisioner-stopped"]); await unchanged(x);
    });
    await check("process admission waits for an actual hold revision change then fails closed",async()=>{
      const x=await target(),client=await pool.connect(); let pending:Promise<unknown>|undefined;
      try {
        await client.query("BEGIN"); const pid=Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        await client.query("UPDATE acp.worktree_reservations SET heartbeat_at=clock_timestamp() WHERE reservation_id=$1",[x.hold.reservationId]);
        pending=assert.rejects(journal.recordProcess(x.input),/current original runtime.*plan authority/u);
        await waitBlocked(pid); await client.query("COMMIT"); await pending;
      } finally { await client.query("ROLLBACK"); client.release(); if(pending) await pending; }
      assert.equal((await holds.load(x.hold.reservationId))?.revision,2); assert.deepEqual(await events(x.plan.attemptId),[]);
      assert.equal((await journal.load(x.plan.attemptId))?.state,"unrecorded");
      await journal.recordStop(x.stop); // Cleanup does not require the captured hold to remain live.
    });
    await check("workflow binding retirement first denies both new process and owner cleanup claims",async()=>{
      const x=await target(),y=await target(); await journal.recordProcess(y.input);
      const before=await journal.load(y.plan.attemptId),client=await pool.connect(); let pending:Promise<unknown>|undefined;
      try {
        await client.query("BEGIN"); const pid=Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        await client.query("UPDATE acp.project_workflow_bindings SET retired_at=clock_timestamp() WHERE binding_id=$1",[f.runtime.bindings[0]!.workflowBindingId]);
        pending=Promise.all([assert.rejects(journal.recordProcess(x.input),/current original runtime/u),assert.rejects(journal.recordStop(y.stop),/current original runtime/u)]);
        void pending.catch(()=>{}); await waitBlocked(pid); await client.query("COMMIT"); await pending;
      } finally { await client.query("ROLLBACK"); client.release(); if(pending) await pending; }
      assert.equal((await journal.load(x.plan.attemptId))?.state,"unrecorded"); assert.deepEqual(await journal.load(y.plan.attemptId),before);
      assert.deepEqual(await events(x.plan.attemptId),[]); assert.deepEqual(await events(y.plan.attemptId),["filesystem.provisioner-process-recorded"]);
    });
  }
  if(phase==="expiry") {
    await check("expired plan denies new process but current owner may retain native cleanup and replay history",async()=>{
      const x=await target(800),record=await journal.recordProcess(x.input); await waitPast(x.plan.deadlineAt);
      assert.deepEqual(await journal.recordProcess(x.input),record); const stop=await journal.recordStop(x.stop); assert.deepEqual(await journal.recordStop(x.stop),stop); await unchanged(x);
      const y=await target(400); await waitPast(y.plan.deadlineAt); await assert.rejects(journal.recordProcess(y.input),/current original runtime.*plan authority/u);
      await journal.recordStop(y.stop); assert.equal((await journal.load(y.plan.attemptId))?.state,"stop_recorded"); await unchanged(y);
    });
    await check("process expiry at deferred COMMIT rolls back the native claim and event",async()=>{
      const x=await target(800),late=intercepted(async(_client,sql)=>{ if(sql==="COMMIT") await waitPast(x.plan.deadlineAt); });
      await assert.rejects(late.recordProcess(x.input),/authority ended before commit/u);
      assert.equal((await journal.load(x.plan.attemptId))?.state,"unrecorded"); assert.deepEqual(await events(x.plan.attemptId),[]); await unchanged(x);
    });
    await check("hold revision drift at deferred COMMIT denies a process claim without preserving the drift",async()=>{
      const x=await target(),changed=intercepted(async(client,sql)=>{ if(sql==="COMMIT") await client.query("UPDATE acp.worktree_reservations SET heartbeat_at=clock_timestamp() WHERE reservation_id=$1",[x.hold.reservationId]); });
      await assert.rejects(changed.recordProcess(x.input),/authority ended before commit/u); assert.deepEqual(await events(x.plan.attemptId),[]); await unchanged(x);
    });
    for(const stopping of [false,true]) await check(`${stopping ? "stop" : "process"} claim rejects current runtime closure at deferred COMMIT`,async()=>{
      const x=await target(); if(stopping) await journal.recordProcess(x.input); const before=await journal.load(x.plan.attemptId),audit=await events(x.plan.attemptId);
      const closed=intercepted(async(client,sql)=>{ if(sql==="COMMIT") await client.query("UPDATE acp.worker_host_sessions SET state='closed' WHERE host_identifier=$1",[f.runtime.hostIdentifier]); });
      await assert.rejects(stopping ? closed.recordStop(x.stop) : closed.recordProcess(x.input),/authority ended before commit/u);
      assert.deepEqual(await journal.load(x.plan.attemptId),before); assert.deepEqual(await events(x.plan.attemptId),audit); await unchanged(x);
    });
    await check("retired owner cannot create cleanup history but exact retained replay stays historical",async()=>{
      const x=await target(),y=await target(); const record=await journal.recordStop(x.stop);
      await f.dispatches.closeRuntime(f.runtime.hostIdentifier,f.runtime.sessionId);
      assert.deepEqual(await journal.recordStop(x.stop),record);
      await assert.rejects(journal.recordStop(y.stop),/current original runtime/u);
      await assert.rejects(journal.recordProcess(y.input),/current original runtime/u);
      assert.deepEqual(await events(y.plan.attemptId),[]);
    });
  }
  if(phase==="upgrade") {
    await check("populated pre-journal plans survive empty-journal downgrade and re-upgrade with exclusions intact",async()=>{
      const x=await target(),before=await plans.load(x.plan.attemptId);
      assert.equal((await pool.query("SELECT to_regclass('acp.worktree_provisioner_processes') AS name")).rows[0].name,null);
      await migration("up"); assert.deepEqual(await plans.load(x.plan.attemptId),before); await unchanged(x);
      assert.equal((await journal.load(x.plan.attemptId))?.state,"unrecorded"); await migration("down");
      assert.equal((await pool.query("SELECT to_regclass('acp.worktree_provisioner_processes') AS name")).rows[0].name,null);
      assert.deepEqual(await plans.load(x.plan.attemptId),before); await unchanged(x); await migration("up");
    });
    await check("downgrade waits for the exact concurrent writer and refuses its committed history",async()=>{
      const x=await target(),client=await pool.connect(); let pending:Promise<unknown>|undefined;
      try {
        await client.query("BEGIN"); const pid=Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        await direct("processes",x,{},client); await direct("stops",x,{},client);
        pending=assert.rejects(migration("down"),/cannot downgrade retained/u); void pending.catch(()=>{});
        await waitBlocked(pid); await client.query("COMMIT"); await pending;
      } finally { await client.query("ROLLBACK"); client.release(); if(pending) await pending; }
      const retained=await journal.load(x.plan.attemptId); assert.equal(retained?.state,"stop_recorded"); assert.ok(retained?.process);
      await assert.rejects(migration("down"),/cannot downgrade retained/u); assert.deepEqual(await journal.load(x.plan.attemptId),retained);
      assert.deepEqual(await events(x.plan.attemptId),["filesystem.provisioner-process-recorded","filesystem.provisioner-stopped"]); await unchanged(x);
    });
  }
  if(checks===0) throw new Error("journal phase has no completed checks");
  process.stdout.write(`Provisioner journal integration ${phase}: ${checks} checks passed.\n`);
} finally { await pool.end(); }
