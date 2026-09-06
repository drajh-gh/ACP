import assert from "node:assert/strict";
import { Pool,type QueryResult,type QueryResultRow } from "pg";
import { createStableId } from "@acp/domain";
import { PostgresRepositoryBindingStore,PostgresWorktreeReservationStore,PostgresWorktreeProvisionerStore,PostgresProvisionerAdmissionStore,PostgresProvisionerJournalStore,
  type ProvisionerAdmissionRequest,type ProvisionerStopRecordInput } from "@acp/storage";
import { launchRecoveryFixture } from "../../../../packages/storage/test/integration/launch-recovery-fixture.ts";
import { NativeProvisionerAdmissionController,type NativeProvisionerSession } from "../../src/native-provisioner-controller.ts";

const port=Number(process.argv[2]); if(!Number.isInteger(port) || port<1024 || port>65535) throw new Error("owned PostgreSQL port required");
const pool=new Pool({ connectionString:`postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test`,max:4,connectionTimeoutMillis:3000,statement_timeout:5000,lock_timeout:2000 });
let checks=0,identities=0;
const identity=()=>`win32-dir:abcdef12:${(++identities).toString(16).padStart(16,"0")}`;
async function check(name:string,action:()=>Promise<void>) { await action(); checks++; process.stdout.write(`PASS database provisioner controller: ${name}\n`); }
async function checkedAndDrained<T>(observe:()=>Promise<void>,drain:()=>Promise<T>):Promise<T> {
  let failed=false,primary:unknown;
  try { await observe(); } catch(error) { failed=true; primary=error; }
  let result:T;
  try { result=await drain(); } catch(cleanup) { if(failed) throw new AggregateError([primary,cleanup],"fixture assertion and cleanup failed",{ cause:primary }); throw cleanup; }
  if(failed) throw primary; return result;
}
try {
  const f=await launchRecoveryFixture(pool,"host:provisioner-controller-pg","0021");
  const registry=new PostgresRepositoryBindingStore(pool,f.runtime),holds=new PostgresWorktreeReservationStore(pool,f.runtime),plans=new PostgresWorktreeProvisionerStore(pool,f.runtime),
    admissions=new PostgresProvisionerAdmissionStore(pool,f.runtime),journal=new PostgresProvisionerJournalStore(pool,f.runtime);
  async function target() {
    const reservationId=createStableId("worktreeReservation"),workspacePath=`C:\\ACP-controller-pg\\planned\\${reservationId}`,a=await f.assignment(undefined,workspacePath,true),repoId=createStableId("repositoryBinding");
    await registry.recordRepository({ repositoryBindingId:repoId,repositoryId:createStableId("repository"),projectId:a.packet.projectId,machineFingerprint:"b".repeat(64),
      checkout:{ path:`C:\\ACP-controller-pg\\repos\\${repoId}`,identity:identity() },commonGitDirectory:{ path:`C:\\ACP-controller-pg\\repos\\${repoId}\\.git`,identity:identity() },
      observedAt:new Date().toISOString(),provenanceId:a.a.packetProvenanceId });
    const hold=await holds.reserve({ reservationId,repositoryBindingId:repoId,missionId:a.a.missionId,nodeId:a.a.nodeId,graphRevision:"launch-recovery-check",workspacePath,
      branchRef:"refs/heads/Controller/ExactCase",provenanceId:a.a.packetProvenanceId });
    const times=(await pool.query("SELECT to_jsonb(clock_timestamp()) AS at,to_jsonb(least(clock_timestamp()+interval '15 seconds',expires_at-interval '10 milliseconds')) AS deadline,to_jsonb(r) AS original_hold FROM acp.worktree_reservations r WHERE reservation_id=$1",[reservationId])).rows[0];
    const plan=await plans.plan({ attemptId:createStableId("worktreeProvisionerAttempt"),reservationId,reservationRevision:hold.revision,baseRevision:"a".repeat(40),
      reportedParent:{ path:"C:\\ACP-controller-pg\\planned",identity:identity(),observedAt:times.at as string },
      fencePlan:{ namespace:"acp-worktree-provisioner-v1",directory:"C:\\ACP-controller-pg-fences" },deadlineAt:times.deadline as string });
    const native=(await pool.query(`WITH t AS MATERIALIZED(SELECT clock_timestamp() AS at)
      SELECT to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'7Z' AS started,
        'win32-filetime:'||((extract(epoch FROM at)*10000000+116444736000000000+7)::numeric(30,0))::text AS token FROM t`)).rows[0];
    const request:ProvisionerAdmissionRequest={ attemptId:plan.attemptId,fence:{ ...plan.fencePlan,directoryIdentity:identity(),scope:{ machineFingerprint:"b".repeat(64),bootedAt:"2026-09-01T00:00:00.000Z",sessionId:1 } },
      root:{ processId:970000+identities,processStartToken:native.token as string,startedAt:native.started as string },challenge:{ nonce:"c".repeat(32),epoch:1 } };
    const stop:ProvisionerStopRecordInput={ attemptId:request.attemptId,fence:request.fence,observation:{ state:"terminated",sealed:true,reason:"exact_owned_tree_terminated",exitCode:0,root:request.root } };
    const closed=Promise.withResolvers<ProvisionerStopRecordInput>(),abort=new AbortController(),trace:string[]=[]; let go=0,terminated=0,accepted=0;
    // Synthetic already-owned port only: no OS launch, termination or Git work.
    const session:NativeProvisionerSession={ request,expectedPlan:{ reservationId,reservationRevision:hold.revision,deadlineAt:plan.deadlineAt,provenanceId:plan.provenanceId },closed:closed.promise,
      async acceptAdmission(ack){ accepted++; trace.push("native:accept"); return { attemptId:ack.attemptId,root:ack.root,fence:ack.fence,challenge:ack.challenge,reservationRevision:ack.reservationRevision }; },
      go(){ go++; trace.push("native:go"); closed.resolve(stop); },async terminate(){ terminated++; trace.push("native:terminate"); closed.resolve(stop); } };
    return { hold,plan,request,stop,closed,abort,session,trace,originalHold:times.original_hold,get counts(){ return { go,terminated,accepted }; } };
  }
  async function unchanged(x:Awaited<ReturnType<typeof target>>) {
    assert.deepEqual((await pool.query("SELECT to_jsonb(r) AS row FROM acp.worktree_reservations r WHERE reservation_id=$1",[x.hold.reservationId])).rows[0].row,x.originalHold);
    assert.equal((await pool.query("SELECT 1 FROM acp.filesystem_exclusion_keys WHERE reservation_id=$1",[x.hold.reservationId])).rowCount,4);
    assert.equal((await pool.query("SELECT 1 FROM acp.worker_runs WHERE mission_id=$1",[x.plan.missionId])).rowCount,0);
  }
  async function events(x:Awaited<ReturnType<typeof target>>) {
    return (await pool.query("SELECT event_type FROM acp.mission_events WHERE idempotency_key=$1 AND event_type IN('filesystem.provisioner-process-recorded','filesystem.provisioner-admitted','filesystem.provisioner-stopped') ORDER BY occurred_at",[x.plan.attemptId])).rows.map((r)=>r.event_type);
  }
  const fullHistory=["filesystem.provisioner-process-recorded","filesystem.provisioner-admitted","filesystem.provisioner-stopped"];
  function intercepted(before:(client:{ query:Pool["query"] },sql:string)=>Promise<void>,after?:(sql:string)=>Promise<void>) {
    const evidence:{ ended:Promise<void>[];pids:number[];discards:(boolean|Error|undefined)[] }={ ended:[],pids:[],discards:[] };
    const wrapper={ options:pool.options,async connect(){
      const client=await pool.connect(); evidence.pids.push(Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid)); evidence.ended.push(new Promise<void>((resolve)=>client.once("end",()=>resolve())));
      return { on:client.on.bind(client),off:client.off.bind(client),release(discard?:boolean|Error){ evidence.discards.push(discard); client.release(discard); },
        async query<R extends QueryResultRow>(sql:string,values?:unknown[]):Promise<QueryResult<R>>{ await before(client,sql); const result=await client.query<R>(sql,values); await after?.(sql); return result; } };
    } } as unknown as Pool;
    return { pool:wrapper,evidence };
  }
  async function discarded(e:ReturnType<typeof intercepted>["evidence"]) {
    await Promise.all(e.ended); assert.deepEqual(e.discards,[true]); assert.equal((await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=ANY($1::int[])",[e.pids])).rowCount,0);
  }
  await check("actual fresh admission reaches one synthetic GO then retains exact sealed stop without releasing the hold",async()=>{
    const x=await target(),accept=x.session.acceptAdmission;
    x.session.acceptAdmission=async(ack)=>{
      const committed=(await pool.query(`SELECT p.root_process_id=$2 AND p.root_process_start_token=$3 AND p.root_started_at=$4
        AND p.admission_attempt_id=p.attempt_id AND a.challenge_nonce=$5 AND a.challenge_epoch=1
        AND c.owner_kind='provisioner' AND c.process_id=p.root_process_id AND c.process_start_token=p.root_process_start_token
        AND c.supervision_scope=p.supervision_scope AS exact
        FROM acp.worktree_provisioner_processes p JOIN acp.worktree_provisioner_admissions a USING(attempt_id)
        JOIN acp.windows_native_root_claims c ON c.owner_id=p.attempt_id WHERE p.attempt_id=$1`,
      [x.plan.attemptId,x.request.root.processId,x.request.root.processStartToken,x.request.root.startedAt,x.request.challenge.nonce])).rows[0];
      assert.equal(committed?.exact,true,"another connection must observe the committed pair and exact root before native acceptance");
      assert.equal(x.counts.go,0); x.trace.push("db:committed-before-go"); return accept(ack);
    };
    const result=await new NativeProvisionerAdmissionController(admissions,journal).run(x.session,x.abort.signal);
    assert.equal(result.state,"stop_recorded"); assert.equal(result.authorityLost,false); assert.equal(result.goAttempted,true);
    assert.deepEqual(x.counts,{ go:1,terminated:0,accepted:1 }); assert.deepEqual(await events(x),fullHistory);
    assert.deepEqual(x.trace,["db:committed-before-go","native:accept","native:go"]);
    assert.equal((await journal.load(x.plan.attemptId))?.state,"stop_recorded"); await unchanged(x);
    await assert.rejects(admissions.admit(x.request),/fresh unrecorded/u);
  });
  await check("lost actual admission COMMIT yields zero GO while the exact physical stop can still be journaled",async()=>{
    const x=await target(),lost=intercepted(async()=>{},async(sql)=>{ if(sql==="COMMIT") throw new Error("lost actual admission COMMIT"); });
    const result=await new NativeProvisionerAdmissionController(new PostgresProvisionerAdmissionStore(lost.pool,f.runtime),journal).run(x.session,x.abort.signal);
    await discarded(lost.evidence); assert.equal(result.state,"stop_recorded"); assert.equal(result.authorityLost,true); assert.equal(result.goAttempted,false);
    assert.deepEqual(x.counts,{ go:0,terminated:1,accepted:0 }); assert.deepEqual(await events(x),fullHistory); await unchanged(x);
    await assert.rejects(admissions.admit(x.request),/fresh unrecorded/u);
  });
  await check("abort during actual uncommitted admission stops immediately then drains COMMIT before persisting the stop",async()=>{
    const x=await target(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),held=intercepted(async(_client,sql)=>{ if(sql==="COMMIT"){ entered.resolve(); await release.promise; } });
    let settled=false;
    const running=new NativeProvisionerAdmissionController(new PostgresProvisionerAdmissionStore(held.pool,f.runtime),journal).run(x.session,x.abort.signal).then((value)=>{ settled=true; return value; });
    const result=await checkedAndDrained(async()=>{
      await entered.promise; x.abort.abort(); assert.equal(x.counts.terminated,1); assert.equal(settled,false);
      assert.equal((await pool.query("SELECT 1 FROM acp.worktree_provisioner_stops WHERE attempt_id=$1",[x.plan.attemptId])).rowCount,0);
    },async()=>{
      release.resolve(); const results=await Promise.allSettled([running,discarded(held.evidence)]);
      if(results[0].status==="rejected") throw results[0].reason; if(results[1].status==="rejected") throw results[1].reason; return results[0].value;
    });
    assert.equal(result.state,"stop_recorded"); assert.equal(result.authorityLost,true);
    assert.deepEqual(x.counts,{ go:0,terminated:1,accepted:0 }); assert.deepEqual(await events(x),fullHistory); await unchanged(x);
  });
  await check("lost actual stop COMMIT preserves native closure but leaves the controller's durable receipt unconfirmed",async()=>{
    const x=await target(),lost=intercepted(async()=>{},async(sql)=>{ if(sql==="COMMIT") throw new Error("lost actual stop COMMIT"); });
    const result=await new NativeProvisionerAdmissionController(admissions,new PostgresProvisionerJournalStore(lost.pool,f.runtime)).run(x.session,x.abort.signal);
    await discarded(lost.evidence); assert.equal(result.state,"closed_stop_unconfirmed"); assert.equal(result.goAttempted,true);
    if(result.state==="closed_stop_unconfirmed") assert.deepEqual(result.observation,x.stop);
    assert.deepEqual(await events(x),fullHistory); assert.equal((await journal.load(x.plan.attemptId))?.state,"stop_recorded"); await unchanged(x);
  });
  await check("fresh database admission cannot outlive cancellation during a pending synthetic native acceptance",async()=>{
    const x=await target(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),accept=x.session.acceptAdmission;
    x.session.acceptAdmission=async(ack)=>{ const result=await accept(ack); entered.resolve(); await release.promise; return result; };
    const running=new NativeProvisionerAdmissionController(admissions,journal).run(x.session,x.abort.signal);
    const result=await checkedAndDrained(async()=>{
      await entered.promise; x.abort.abort(); assert.equal(x.counts.terminated,1); assert.equal(x.counts.go,0);
      assert.equal((await pool.query("SELECT 1 FROM acp.worktree_provisioner_stops WHERE attempt_id=$1",[x.plan.attemptId])).rowCount,0);
    },async()=>{ release.resolve(); return running; });
    assert.equal(result.state,"stop_recorded"); assert.equal(result.authorityLost,true); assert.equal(x.counts.go,0);
    assert.deepEqual(await events(x),fullHistory); await unchanged(x);
  });
  await check("retired original owner keeps physical closure but cannot manufacture recovery or a sealed database receipt",async()=>{
    const x=await target(),accept=x.session.acceptAdmission;
    x.session.acceptAdmission=async(ack)=>{ const result=await accept(ack); await f.dispatches.closeRuntime(f.runtime.hostIdentifier,f.runtime.sessionId); x.abort.abort(); return result; };
    const result=await new NativeProvisionerAdmissionController(admissions,journal).run(x.session,x.abort.signal);
    assert.equal(result.state,"closed_stop_unconfirmed"); assert.equal(result.goAttempted,false); assert.equal(x.counts.go,0);
    if(result.state==="closed_stop_unconfirmed") assert.deepEqual(result.observation,x.stop);
    assert.deepEqual(await events(x),fullHistory.slice(0,2)); assert.equal((await journal.load(x.plan.attemptId))?.state,"process_recorded"); await unchanged(x);
  });
  process.stdout.write(`Database provisioner controller integration: ${checks} checks passed. Synthetic native port only.\n`);
} finally { await pool.end(); }
