import assert from "node:assert/strict";
import { mkdir,mkdtemp,readFile,stat } from "node:fs/promises";
import { isAbsolute,join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool,type QueryResult,type QueryResultRow } from "pg";
import { createStableId } from "@acp/domain";
import { PostgresRepositoryBindingStore,PostgresWorktreeReservationStore,PostgresWorktreeProvisionerStore,PostgresProvisionerAdmissionStore,PostgresProvisionerJournalStore,
  type ProvisionerAdmissionRequest,type WorktreeProvisionerAttempt } from "@acp/storage";
import { launchRecoveryFixture } from "../../../../packages/storage/test/integration/launch-recovery-fixture.ts";
import { NativeProvisionerExecutor } from "../../src/native-provisioner-executor.ts";
import { snapshotNativeProvisionerPlan } from "../../src/native-provisioner-plan.ts";
import { WindowsProvisionerProcessRunner } from "../../src/windows-provisioner-runner.ts";
import type { OwnedProvisionerHandle } from "../../src/windows-provisioner-process.ts";
import { describeWindowsProvisionerFence } from "../../src/windows-launch-fence.ts";
import { gone } from "./native-lease-probe.ts";

const port=Number(process.argv[2]),phase=process.argv[3],base=process.env.ACP_TEST_NATIVE_CHANNEL_ROOT,powershell=process.env.ACP_TEST_PWSH;
if(!Number.isInteger(port) || port<1024 || port>65535 || !["native-happy","native-lost-ack","native-hold-invalidated"].includes(phase??""))throw new Error("exact owned database/native phase required");
assert.ok(base && isAbsolute(base) && powershell && isAbsolute(powershell),"exact outer-owned fixture and PowerShell required");
const pool=new Pool({connectionString:`postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test`,max:4,connectionTimeoutMillis:3000,statement_timeout:5000,lock_timeout:2000});
const abort=new AbortController(),pids=new Set<number>(),handles:OwnedProvisionerHandle[]=[],ended:Promise<void>[]=[],backends:number[]=[],discards:(boolean|Error|undefined)[]=[];
const report=(pid:number,purpose:string)=>{pids.add(pid);process.stdout.write(`Owned PID ${pid}: ${purpose}\n`);};
try {
  const directory=await mkdtemp(join(base,"executor ž 🚀-")),fenceDirectory=join(directory,"fence"),parentDirectory=join(directory,"targets");
  await mkdir(fenceDirectory);await mkdir(parentDirectory);
  const parent=await describeWindowsProvisionerFence(parentDirectory,abort.signal,{onSpawn:report});
  const f=await launchRecoveryFixture(pool,"host:provisioner-executor-pg","0021"),runtime=f.runtime;
  const registry=new PostgresRepositoryBindingStore(pool,runtime),holds=new PostgresWorktreeReservationStore(pool,runtime),plans=new PostgresWorktreeProvisionerStore(pool,runtime),
    admissions=new PostgresProvisionerAdmissionStore(pool,runtime),journal=new PostgresProvisionerJournalStore(pool,runtime);
  const native=new WindowsProvisionerProcessRunner(plans.authority,{runnerPath:fileURLToPath(new URL("./synthetic-provisioner-plan-runner.ts",import.meta.url)),powershellExecutable:powershell,onSpawn:report});
  const reservationId=createStableId("worktreeReservation"),workspacePath=join(parentDirectory,"FutureCase"),assignment=await f.assignment(undefined,workspacePath,true),repositoryBindingId=createStableId("repositoryBinding");
  // Actual empty directory identities, not a Git repository/content assertion.
  // This fixed capsule neither creates nor mutates a prospective target.
  const checkoutPath=join(directory,"synthetic-repository"),commonPath=join(checkoutPath,".git");await mkdir(commonPath,{recursive:true});
  const checkout=await describeWindowsProvisionerFence(checkoutPath,abort.signal,{onSpawn:report}),common=await describeWindowsProvisionerFence(commonPath,abort.signal,{onSpawn:report});
  const commonGitDirectory={path:commonPath,identity:common.directoryIdentity};
  await registry.recordRepository({repositoryBindingId,repositoryId:createStableId("repository"),projectId:assignment.packet.projectId,machineFingerprint:parent.scope.machineFingerprint,
    checkout:{path:checkoutPath,identity:checkout.directoryIdentity},commonGitDirectory,observedAt:new Date().toISOString(),provenanceId:assignment.a.packetProvenanceId});
  await holds.reserve({reservationId,repositoryBindingId,missionId:assignment.a.missionId,nodeId:assignment.a.nodeId,graphRevision:"launch-recovery-check",workspacePath,
    branchRef:"refs/heads/Executor/ExactCase",provenanceId:assignment.a.packetProvenanceId});
  let plan:WorktreeProvisionerAttempt,loads=0,starts=0,accepts=0,goes=0,writes=0,physicallyClosed=false,commitVisible=false,stopAfterClose=false;
  let request:ProvisionerAdmissionRequest|undefined,invalidatedHold:Record<string,unknown>|undefined,rootClaimsBeforeStop:number|undefined;
  const trace:string[]=[],fixtureErrors:unknown[]=[];
  async function observed<T>(action:()=>Promise<T>):Promise<T>{try{return await action();}catch(error){fixtureErrors.push(error);throw error;}}
  const lostPool={options:pool.options,async connect(){
    const client=await pool.connect();backends.push(Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid));
    ended.push(new Promise<void>(resolve=>client.once("end",()=>resolve())));
    return {on:client.on.bind(client),off:client.off.bind(client),release(discard?:boolean|Error){discards.push(discard);client.release(discard);},
      async query<R extends QueryResultRow>(sql:string,values?:unknown[]):Promise<QueryResult<R>>{
        const result=await client.query<R>(sql,values);if(sql==="COMMIT")throw new Error("synthetic lost actual admission COMMIT reply");return result;
      }};
  }} as unknown as Pool;
  const selectedAdmissions=phase==="native-lost-ack"?new PostgresProvisionerAdmissionStore(lostPool,runtime):admissions;
  const executor=new NativeProvisionerExecutor({authority:plans.authority,async load(id){loads++;trace.push("load");return plans.load(id);}},
    {authority:admissions.authority,async admit(value){
      request=value;trace.push("admit");assert.doesNotThrow(()=>process.kill(value.root.processId,0));
      if(phase==="native-hold-invalidated"){
        await holds.heartbeat(reservationId);invalidatedHold=(await pool.query("SELECT to_jsonb(r) AS row FROM acp.worktree_reservations r WHERE reservation_id=$1",[reservationId])).rows[0].row;
        trace.push("hold-invalidated");
      }
      return selectedAdmissions.admit(value);
    }},{authority:journal.authority,async recordStop(value){return observed(async()=>{
      writes++;stopAfterClose=physicallyClosed;assert.equal(stopAfterClose,true,"physical child close precedes durable stop attempt");
      rootClaimsBeforeStop=(await pool.query("SELECT 1 FROM acp.windows_native_root_claims WHERE owner_id=$1",[plan.attemptId])).rowCount??undefined;
      for(const pid of pids)await gone(pid,5000);
      assert.match(await readFile(join(fenceDirectory,plan.attemptId+".provision"),"utf8"),/\nsealed\n$/u);trace.push("stop");return journal.recordStop(value);
    });}},{authority:native.authority,async start(value,signal){return observed(async()=>{
      starts++;trace.push("start");assert.ok(Object.isFrozen(value));assert.deepEqual(value,plan);
      const owned=await native.start(value,signal);handles.push(owned);
      void owned.closed.then(()=>{physicallyClosed=true;trace.push("close");},()=>{});
      const ready=owned.ready.then(session=>({...session,async acceptAdmission(ack){return observed(async()=>{
        accepts++;
        const row=(await pool.query(`SELECT p.root_process_id=$2 AND p.root_process_start_token=$3 AND p.root_started_at=$4
          AND p.admission_attempt_id=p.attempt_id AND a.challenge_nonce=$5 AND a.challenge_epoch=1
          AND c.owner_kind='provisioner' AND c.process_id=p.root_process_id AND c.process_start_token=p.root_process_start_token
          AND c.supervision_scope=p.supervision_scope AS exact
          FROM acp.worktree_provisioner_processes p JOIN acp.worktree_provisioner_admissions a USING(attempt_id)
          JOIN acp.windows_native_root_claims c ON c.owner_id=p.attempt_id WHERE p.attempt_id=$1`,
        [plan.attemptId,session.request.root.processId,session.request.root.processStartToken,session.request.root.startedAt,session.request.challenge.nonce])).rows[0];
        commitVisible=row?.exact===true;assert.equal(commitVisible,true);trace.push("committed-before-accept");return session.acceptAdmission(ack);
      });},go(){goes++;trace.push("go");session.go();}}));
      void ready.catch(()=>{});return {...owned,ready};
    });}});
  // Plan last: native observation and setup cannot spend its fixed native budget.
  const currentParent=await describeWindowsProvisionerFence(parentDirectory,abort.signal,{onSpawn:report});assert.equal(currentParent.directoryIdentity,parent.directoryIdentity);
  const hold=await holds.heartbeat(reservationId);
  const times=(await pool.query("SELECT to_jsonb(clock_timestamp()) AS at,to_jsonb(least(clock_timestamp()+interval '18 seconds',expires_at-interval '500 milliseconds')) AS deadline,to_jsonb(r) AS original_hold FROM acp.worktree_reservations r WHERE reservation_id=$1",[reservationId])).rows[0];
  plan=snapshotNativeProvisionerPlan(await plans.plan({attemptId:createStableId("worktreeProvisionerAttempt"),reservationId,reservationRevision:hold.revision,baseRevision:"a".repeat(40),
    reportedParent:{path:parentDirectory,identity:currentParent.directoryIdentity,observedAt:times.at as string},fencePlan:{namespace:"acp-worktree-provisioner-v1",directory:fenceDirectory},deadlineAt:times.deadline as string}));
  assert.ok(Date.parse(plan.deadlineAt)-Date.now()>5000);
  const result=await executor.run({attemptId:plan.attemptId,signal:abort.signal});
  await Promise.all(ended);for(const pid of pids)await gone(pid,5000);
  assert.deepEqual(fixtureErrors,[],"private callback assertions must remain visible after controller error handling");
  assert.equal(result.state,"stop_recorded");assert.equal(result.authorityLost,phase!=="native-happy");assert.equal(result.goAttempted,phase==="native-happy");
  assert.equal(loads,1);assert.equal(starts,1);assert.equal(accepts,phase==="native-happy"?1:0);assert.equal(goes,phase==="native-happy"?1:0);
  assert.equal(writes,1);assert.equal(stopAfterClose,true);assert.equal(physicallyClosed,true);assert.ok(request);
  const nativeStop=await handles[0]!.closed;assert.deepEqual(result.state==="stop_recorded" && result.stop.observation,nativeStop.observation);
  assert.equal("exitCode" in nativeStop.observation && nativeStop.observation.exitCode,phase==="native-happy"?0:137);
  const output=handles[0]!.outputBytes();
  if(phase==="native-happy"){
    assert.equal(commitVisible,true);assert.deepEqual(trace,["load","start","admit","committed-before-accept","go","close","stop"]);
    assert.deepEqual(JSON.parse(output.toString("utf8")),{processId:request.root.processId,workspace:parentDirectory,plan:{attemptId:plan.attemptId,workspacePath:plan.workspacePath,
      branchRef:plan.branchRef,baseRevision:plan.baseRevision,reportedParent:plan.reportedParent,commonGitDirectory:plan.commonGitDirectory},leaked:false});
  } else {assert.equal(output.length,0);assert.equal(commitVisible,false);}
  if(phase==="native-lost-ack"){
    assert.deepEqual(discards,[true]);assert.equal(backends.length,1);assert.equal((await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=ANY($1::int[])",[backends])).rowCount,0);
  }
  const events=(await pool.query("SELECT event_type FROM acp.mission_events WHERE idempotency_key=$1 AND event_type IN('filesystem.provisioner-process-recorded','filesystem.provisioner-admitted','filesystem.provisioner-stopped') ORDER BY occurred_at",[plan.attemptId])).rows.map(row=>row.event_type);
  assert.deepEqual(events,phase==="native-hold-invalidated"?["filesystem.provisioner-stopped"]:["filesystem.provisioner-process-recorded","filesystem.provisioner-admitted","filesystem.provisioner-stopped"]);
  const recorded=phase==="native-hold-invalidated"?0:1;
  for(const table of ["worktree_provisioner_processes","worktree_provisioner_admissions"])
    assert.equal((await pool.query(`SELECT 1 FROM acp.${table} WHERE attempt_id=$1`,[plan.attemptId])).rowCount,recorded);
  assert.equal(rootClaimsBeforeStop,recorded);
  // A rooted stop-first record itself projects a permanent exclusion claim;
  // admission rollback must be empty before that separate stop transaction.
  assert.equal((await pool.query("SELECT 1 FROM acp.windows_native_root_claims WHERE owner_id=$1",[plan.attemptId])).rowCount,1);
  assert.equal((await pool.query("SELECT source_relation FROM acp.windows_native_root_source('provisioner',$1)",[plan.attemptId])).rows[0]?.source_relation,
    phase==="native-hold-invalidated"?"worktree_provisioner_stops":"worktree_provisioner_processes");
  if(phase==="native-hold-invalidated"){
    assert.equal(invalidatedHold?.revision,plan.reservationRevision+1);
    assert.equal((await plans.load(plan.attemptId))?.state,"recovering","post-run historical projection, never executor readback repair");
  }
  assert.equal((await journal.load(plan.attemptId))?.state,"stop_recorded");
  assert.deepEqual((await pool.query("SELECT to_jsonb(r) AS row FROM acp.worktree_reservations r WHERE reservation_id=$1",[reservationId])).rows[0].row,
    phase==="native-hold-invalidated"?invalidatedHold:times.original_hold);
  assert.equal((await pool.query("SELECT 1 FROM acp.filesystem_exclusion_keys WHERE reservation_id=$1",[reservationId])).rowCount,4);
  assert.equal((await pool.query("SELECT 1 FROM acp.worker_runs WHERE mission_id=$1",[plan.missionId])).rowCount,0);
  await assert.rejects(stat(workspacePath),{code:"ENOENT"});await assert.rejects(admissions.admit(request));
  process.stdout.write(`PASS database/native provisioner executor: ${phase}; exact physical closure and retained hold, no Git mutation or release.\n`);
} finally {
  abort.abort();await Promise.allSettled(handles.map(handle=>handle.terminate()));
  try{await Promise.all(ended);for(const pid of pids)await gone(pid,5000);}finally{await pool.end();}
}
