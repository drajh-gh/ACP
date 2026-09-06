import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { createStableId, createWorkerFailureResult, parseWorkerResult } from "@acp/domain";
import { PostgresFilesystemWriterStore, PostgresRepositoryBindingStore, PostgresRuntimeStore, type RepositoryBindingInput, type WorktreeBindingInput } from "../../src/index.ts";
import { launchRecoveryFixture } from "./launch-recovery-fixture.ts";
import { describeWindowsLaunchFence } from "../../../../apps/worker/src/windows-launch-fence.ts";
import { observeWindowsRepository, observeWindowsWorktree } from "../../../../apps/worker/src/windows-repository-observer.ts";
import { NativeFilesystemWriterController } from "../../../../apps/worker/src/native-filesystem-writer-controller.ts";
import { WindowsWorkerLauncher, type OwnedWorker } from "../../../../apps/worker/src/windows-worker-launcher.ts";

// One scenario per separately bounded child: never spend a lease on fixture setup.
if (process.platform!=="win32") throw new Error("native writer channel gate requires Windows");
const port=Number(process.argv[2]),phase=process.argv[3];
if (!Number.isInteger(port) || port<1024 || port>65535) throw new Error("owned database port required");
if (phase!=="initial" && phase!=="lost-ack" && phase!=="periodic-cancel") throw new Error("exact native writer channel phase required");
const periodic=phase==="periodic-cancel";
const gitExecutable=process.env.ACP_TEST_GIT;
assert.ok(gitExecutable && isAbsolute(gitExecutable));
const pool=new Pool({ connectionString:`postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test`,max:4,
  connectionTimeoutMillis:3000,statement_timeout:5000,lock_timeout:3000 });
const suppliedRoot=process.env.ACP_TEST_NATIVE_CHANNEL_ROOT; assert.ok(suppliedRoot);
const root=resolve(suppliedRoot),local=relative(resolve(tmpdir()),root);
assert.match(local,/^acp-native-writer-channel-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
assert.equal(isAbsolute(local),false);
const checkout=join(root,"checkout ž 🚀"),workspace=join(root,"workspace ž 🚀");
const pids=new Set<number>(),report=(pid:number,purpose:string) => { pids.add(pid); process.stdout.write(`Owned PID ${pid}: ${purpose}\n`); };
const signal=() => new AbortController().signal;
let worker: OwnedWorker | undefined;
const heartbeatHeld=Promise.withResolvers<void>(),resumeHeartbeat=Promise.withResolvers<void>();
const writes=() => Promise.all(["root","child"].map((role) => readFile(join(workspace,`acp-native-${role}-writes.log`))));
async function bounded<T>(value:Promise<T>,milliseconds:number,label:string):Promise<T> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try { return await Promise.race([value,new Promise<never>((_,reject) => { timer=setTimeout(() => reject(new Error(label)),milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function readWriterPids(required:boolean):Promise<boolean> {
  const manifest=join(workspace,"acp-native-writer-pids.json");
  try {
    assert.ok((await stat(manifest)).size<=256);
    const ids=JSON.parse(await readFile(manifest,"utf8")) as { root:number;child:number };
    assert.deepEqual(Object.keys(ids).sort(),["child","root"]);
    assert.ok(worker); assert.equal(ids.root,worker.processId);
    assert.ok(Number.isSafeInteger(ids.child) && ids.child>0 && ids.child!==ids.root);
    if(!pids.has(ids.child)) report(ids.child,"actual detached workspace writer (15-second fixture bound)");
    return true;
  } catch(error) {
    if((error as NodeJS.ErrnoException).code!=="ENOENT" || required) throw error;
    return false;
  }
}
async function git(...args:string[]) {
  const env=Object.fromEntries(["SystemRoot","WINDIR","TEMP","TMP"].flatMap((key) => process.env[key] ? [[key,process.env[key]!]] : []));
  Object.assign(env,{ GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"NUL",GIT_CONFIG_SYSTEM:"NUL",GIT_TERMINAL_PROMPT:"0" });
  const child=spawn(gitExecutable!,["-c","core.hooksPath=NUL","-c","commit.gpgsign=false",...args],
    { cwd:root,windowsHide:true,stdio:["ignore","pipe","pipe"],env });
  if (child.pid) report(child.pid,"native writer channel disposable Git setup (8-second bound)");
  await new Promise<void>((done,reject) => {
    let bytes=0,failed=false; const timer=setTimeout(() => { failed=true; child.kill(); },8000);
    const drain=(chunk:Buffer) => { bytes+=chunk.length; if(bytes>16384) { failed=true; child.kill(); } };
    child.stdout.on("data",drain); child.stderr.on("data",drain); child.on("error",() => { failed=true; });
    child.on("close",(code) => { clearTimeout(timer); if(code===0 && !failed) done(); else reject(new Error("owned Git setup failed")); });
  });
}
try {
  await mkdir(checkout); await git("init","--initial-branch=main",checkout);
  await git("-C",checkout,"-c","user.name=ACP synthetic test","-c","user.email=acp@example.invalid","commit","--allow-empty","-m","Native writer channel fixture");
  await git("-C",checkout,"worktree","add","-b","Feature/ChannelCase",workspace);
  const directory=join(root,"launch-seals"); await mkdir(directory);
  const fence=await describeWindowsLaunchFence(directory,signal(),{ onSpawn:report });
  const f=await launchRecoveryFixture(pool,`host:writer-channel-${phase}`,"0014"),a=await f.assignment(fence,workspace,true);
  const registry=new PostgresRepositoryBindingStore(pool,f.runtime),writers=new PostgresFilesystemWriterStore(pool,f.runtime);
  async function provenance() {
    const id=createStableId("provenance");
    await pool.query(`INSERT INTO acp.runtime_provenance SELECT (jsonb_populate_record(NULL::acp.runtime_provenance,to_jsonb(p)
      ||jsonb_build_object('provenance_id',$1::text,'recorded_at',clock_timestamp()))).* FROM acp.runtime_provenance p WHERE provenance_id=$2`,[id,f.template]);
    return id;
  }
  const options={ gitExecutable,onSpawn:report };
  const observedRepo=await observeWindowsRepository(checkout,signal(),options);
  assert.equal(observedRepo.state,"confirmed"); if(observedRepo.state!=="confirmed") throw new Error("repository observation unavailable");
  const { state:_repoState,kind:_repoKind,...repoFields }=observedRepo;
  const repository: RepositoryBindingInput={ ...repoFields,repositoryBindingId:createStableId("repositoryBinding"),repositoryId:createStableId("repository"),
    projectId:a.packet.projectId,provenanceId:await provenance() };
  await registry.recordRepository(repository);
  const observedTree=await observeWindowsWorktree(repository,workspace,signal(),options);
  assert.equal(observedTree.state,"confirmed"); if(observedTree.state!=="confirmed") throw new Error("worktree observation unavailable");
  const { state:_treeState,kind:_treeKind,machineFingerprint:_machine,...treeFields }=observedTree;
  const tree: WorktreeBindingInput={ ...treeFields,worktreeBindingId:createStableId("worktreeBinding"),repositoryBindingId:repository.repositoryBindingId,
    missionId:a.a.missionId,provenanceId:await provenance() };
  await registry.recordWorktree(tree);

  const started=await f.workers.startRun(a.start),leaseId=createStableId("lease"),workerProcessId=a.start.launchIntent.workerProcessId;
  const original=await writers.reserve({ leaseId,runId:a.start.runId,workerProcessId,worktreeBindingId:tree.worktreeBindingId,provenanceId:a.a.packetProvenanceId });
  assert.equal(original.revision,1);
  let dropped=0,commits=0;
  const heartbeatSessions:{ pids:number[];ended:Promise<void>[];discards:(Error|boolean|undefined)[] }={ pids:[],ended:[],discards:[] };
  const responseLoss=new PostgresFilesystemWriterStore({ options:pool.options,query:pool.query.bind(pool),async connect() {
    const client=await pool.connect();
    heartbeatSessions.pids.push(Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid));
    heartbeatSessions.ended.push(new Promise<void>((resolve)=>client.once("end",()=>resolve())));
    return { on:client.on.bind(client),off:client.off.bind(client),release:(discard?:Error|boolean) => {
      assert.equal(discard,true); assert.ok(client.listenerCount("error")>0); heartbeatSessions.discards.push(discard); client.release(discard);
    },async query<R extends QueryResultRow>(text:string,values?:unknown[]):Promise<QueryResult<R>> {
      const result=await client.query<R>(text,values);
      if (text==="COMMIT") { commits++; if(phase==="lost-ack") { dropped++; throw new Error("injected loss of actual COMMIT response"); } }
      return result;
    } };
  } } as unknown as Pool,f.runtime);
  let attempts=0,accepted=0,inFlight=0,maximumInFlight=0;
  const heartbeatErrors:unknown[]=[];
  const controlled={ authority:responseLoss.authority,load:responseLoss.load.bind(responseLoss),loadLaunchBinding:responseLoss.loadLaunchBinding.bind(responseLoss),
    async heartbeat(id:typeof leaseId) {
      attempts++; inFlight++; maximumInFlight=Math.max(maximumInFlight,inFlight);
      try {
        if(periodic && attempts===4) { heartbeatHeld.resolve(); await bounded(resumeHeartbeat.promise,5000,"cancellation barrier timed out"); }
        const result=await responseLoss.heartbeat(id); accepted++; return result;
      } catch(error) { heartbeatErrors.push(error); throw error; }
      finally { inFlight--; }
    } };
  const native=new WindowsWorkerLauncher({ runnerPath:fileURLToPath(new URL(periodic
    ? "../../../../apps/worker/test/integration/synthetic-filesystem-writer.ts"
    : "../../../../apps/worker/test/integration/synthetic-owned-result-runner.ts",import.meta.url)),
    filesystemWriterController:new NativeFilesystemWriterController(controlled,{ renewalIntervalMs:periodic ? 200 : 5000 }),
    onSpawn:({ processId,purpose }) => report(processId,purpose) });
  const request={ workerProcessId,deadlineAt:started.timeoutAt,workspace,maximumOutputBytes:4096,signal:signal(),launchFence:fence,
    filesystemLease:{ leaseId,runId:a.start.runId,workerProcessId } };
  worker=await native.launch(request);
  assert.equal((await writers.load(leaseId))?.revision,1); assert.equal(commits,0);
  const registration={ workerProcessId,runId:a.start.runId,processId:worker.processId,processStartToken:worker.processStartToken,
    startedAt:worker.startedAt,purpose:"Actual model-free native filesystem lease fixture",provenanceId:a.a.packetProvenanceId,
    transitionProvenanceId:a.a.packetProvenanceId,supervision:{ kind:"windows_job" as const,treeIdentifier:`Local\\ACP.Worker.${workerProcessId}`,scope:worker.scope } };
  const journal=await f.workers.recordWorkerProcessFromRun(registration);
  assert.equal(journal.processId,worker.processId); assert.equal(journal.processStartToken,worker.processStartToken);
  assert.equal(journal.startedAt,worker.startedAt); assert.deepEqual(journal.supervision,registration.supervision); assert.equal(journal.state,"running");
  worker.release(JSON.stringify(periodic ? { mode:"start-disposable-writes" } : { runId:a.start.runId,packet:a.packet,attemptNumber:1 }));
  if(periodic) {
    // Reaching the fourth challenge proves the initial plus two periodic native
    // ACKs settled. Hold before real SQL, never manufacture a lease/ACK response.
    await bounded(Promise.race([heartbeatHeld.promise,worker.closed.then((early) => {
      throw new Error(`writer closed before fourth heartbeat: exit ${early.exitCode}, attempts ${attempts}, committed ${commits}`);
    })]),5000,"fourth heartbeat was not reached");
    const readyUntil=Date.now()+3000;
    while(!await readWriterPids(false)) {
      assert.ok(Date.now()<readyUntil,"writer diagnostics missing"); await new Promise((done) => setTimeout(done,20));
    }
    let growing=false;
    while(!growing && Date.now()<readyUntil) {
      try {
        const before=await writes(); await new Promise((done) => setTimeout(done,150)); const after=await writes();
        growing=after.every((value,i) => value.length>before[i]!.length);
      } catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; await new Promise((done) => setTimeout(done,20)); }
    }
    assert.ok(growing,"both actual workspace writers must grow before cancellation");
    assert.equal(commits,3); assert.equal(accepted,3); assert.equal(maximumInFlight,1);
    const execution=createStableId("workflowExecution"),dbosWorkflowId=`native-writer-cancel:${a.a.missionId}`;
    const run=(await pool.query(`INSERT INTO acp.mission_workflow_runs(workflow_execution_id,mission_id,dbos_workflow_id,
      workflow_id,workflow_version,workflow_binding_id,dbos_application_version,graph_revision,state,provenance_id,transition_provenance_id)
      SELECT $1,mission_id,$2,workflow_id,workflow_version,workflow_binding_id,$3,'launch-recovery-check','running',$4,$4
      FROM acp.missions WHERE mission_id=$5 RETURNING workflow_version`,
    [execution,dbosWorkflowId,f.runtime.applicationVersion,f.template,a.a.missionId])).rows[0];
    const eventId=createStableId("event");
    assert.equal(await new PostgresRuntimeStore(pool).recordWorkflowCancellationIntent({
      target:{ workflowExecutionId:execution,dbosWorkflowId,missionId:a.a.missionId,workflowVersion:run.workflow_version as string,
        graphRevision:"launch-recovery-check",provenanceId:f.template },eventId,idempotencyKey:`native-cancel:${execution}`,
      reason:"Stop the disposable native workspace writers.",requestedBy:"test:operator",occurredAt:new Date().toISOString() }),true);
    assert.equal((await pool.query("SELECT acp.worker_cancellation_requested($1,'launch-recovery-check') AS cancelled",[a.a.missionId])).rows[0].cancelled,true);
    assert.equal((await pool.query("SELECT 1 FROM acp.mission_events WHERE event_id=$1 AND event_type='mission.cancellation-requested'",[eventId])).rowCount,1);
    resumeHeartbeat.resolve(); // No caller abort or manual termination causes the tested stop.
  }
  const exit=await worker.closed;
  assert.equal(exit.treeEmpty,true); assert.equal(exit.launchSealed,true);
  assert.equal(exit.failed,phase!=="initial"); assert.equal(exit.terminated,phase!=="initial");
  const expectedCommits=periodic ? 3 : 1;
  assert.equal(commits,expectedCommits); assert.equal(dropped,phase==="lost-ack" ? 1 : 0);
  assert.equal(inFlight,0); assert.equal(maximumInFlight,1);
  await bounded(Promise.all(heartbeatSessions.ended),3000,"heartbeat physical sessions did not close after native quiescence");
  assert.equal(attempts,periodic ? 4 : 1); assert.equal(accepted,phase==="lost-ack" ? 0 : expectedCommits);
  assert.deepEqual(heartbeatSessions.discards,Array(attempts).fill(true)); assert.equal(new Set(heartbeatSessions.pids).size,attempts);
  assert.equal((await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=ANY($1::int[])",[heartbeatSessions.pids])).rowCount,0);
  if(phase==="lost-ack") { assert.equal(heartbeatErrors.length,1); assert.match(String(heartbeatErrors[0]),/actual COMMIT response/u); }
  let stoppedWrites:Buffer[]|undefined;
  if(periodic) {
    assert.equal(request.signal.aborted,false); assert.equal(attempts,4); assert.equal(accepted,3);
    assert.equal(heartbeatErrors.length,1); assert.match(String(heartbeatErrors[0]),/exact live delivery/u);
    await readWriterPids(true);
    stoppedWrites=await writes(); await new Promise((done) => setTimeout(done,350)); assert.deepEqual(await writes(),stoppedWrites);
  }
  const renewed=await writers.load(leaseId); assert.ok(renewed); assert.equal(renewed.revision,expectedCommits+1); assert.equal(renewed.releasedAt,null);
  if(periodic) assert.equal(renewed.state,"recovering");
  assert.equal((await pool.query("SELECT 1 FROM acp.mission_events WHERE mission_id=$1 AND event_type='filesystem.writer-renewed'",[a.a.missionId])).rowCount,expectedCommits);
  assert.equal((await f.workers.loadWorkerProcess(workerProcessId))?.state,"running");
  for (const table of ["worker_launch_stops","filesystem_writer_releases"]) assert.equal((await pool.query(`SELECT 1 FROM acp.${table} WHERE run_id=$1`,[a.start.runId])).rowCount,0);
  assert.deepEqual((await pool.query("SELECT state,result FROM acp.worker_runs WHERE run_id=$1",[a.start.runId])).rows[0],{ state:"started",result:null });
  await assert.rejects(writers.release(leaseId),/stopped terminal run/u);
  assert.match(await readFile(join(directory,workerProcessId+".launch"),"utf8"),/\nsealed\n$/u);
  const result=phase==="initial" ? parseWorkerResult(JSON.parse(exit.output)) : createWorkerFailureResult({ runId:a.start.runId,packet:a.packet,
    attemptNumber:1,status:periodic ? "cancelled" : "failed",code:"terminated",conclusion:periodic
      ? "Supervisor stopped actual workspace writers after durable database cancellation."
      : "Supervisor rejected execution after injected database COMMIT response loss.",wallMilliseconds:1 });
  if (phase!=="initial") assert.equal(exit.output,""); else { assert.equal(exit.exitCode,0); assert.equal(result.runId,a.start.runId); }
  assert.equal(result.status,periodic ? "cancelled" : "failed"); // No successful delivery candidate.
  await assert.rejects(f.workers.completeRun({ result,completedAt:new Date().toISOString(),transitionProvenanceId:a.a.packetProvenanceId }),/durable sealed launch stop/u);
  await f.launches.finishOwnedLaunch({ ...registration,state:exit.terminated || exit.failed ? "terminated" : "exited",exitCode:exit.exitCode,
    terminationReason:"Actual native owned-tree closure in disposable lease-channel fixture.",launchSealed:true });
  const stop=(await pool.query("SELECT * FROM acp.worker_launch_stops WHERE run_id=$1",[a.start.runId])).rows[0];
  assert.equal(stop.root_process_id,worker.processId); assert.equal(stop.root_process_start_token,worker.processStartToken);
  assert.equal(stop.actor_kind,"owner"); assert.equal(stop.exit_code,exit.exitCode);
  assert.equal(await writers.loadLaunchBinding(leaseId),undefined);
  await assert.rejects(writers.release(leaseId),/stopped terminal run/u);
  await f.workers.completeRun({ result,completedAt:new Date().toISOString(),transitionProvenanceId:a.a.packetProvenanceId });
  assert.deepEqual((await pool.query("SELECT state,result FROM acp.worker_runs WHERE run_id=$1",[a.start.runId])).rows[0],{ state:periodic ? "cancelled" : "failed",result });
  const released=await writers.release(leaseId);
  assert.equal(released.state,"released"); assert.equal(released.revision,renewed.revision+1);
  assert.equal((await pool.query("SELECT 1 FROM acp.filesystem_writer_releases WHERE lease_id=$1",[leaseId])).rowCount,1);
  await new Promise((done) => setTimeout(done,100));
  assert.deepEqual(await writers.load(leaseId),released); assert.equal(commits,expectedCommits);
  if(periodic) { assert.deepEqual(await writes(),stoppedWrites); assert.equal(attempts,4); }
  assert.equal((await pool.query("SELECT 1 FROM acp.mission_events WHERE mission_id=$1 AND event_type='filesystem.writer-renewed'",[a.a.missionId])).rowCount,expectedCommits);
  assert.deepEqual(await registry.loadWorktree(tree.worktreeBindingId),{ binding:tree,retired:false });
  await registry.retireWorktree(tree.worktreeBindingId,await provenance(),"Disposable native channel scenario ended.");
  await registry.retireRepository(repository.repositoryBindingId,await provenance(),"Disposable native channel scenario ended.");
  await f.dispatches.closeRuntime(f.runtime.hostIdentifier,f.runtime.sessionId);
  process.stdout.write(`PASS native writer channel ${phase}: actual journal before GO, quiescent sealed stop before result/release; ${commits} real heartbeat COMMIT, ${dropped} injected response loss, ${heartbeatSessions.discards.length} physically closed sessions\nNative writer channel integration: 1 scenario passed.\n`);
} finally {
  resumeHeartbeat.resolve();
  try { await worker?.terminate().catch(() => {}); } finally {
  try { if(periodic && !await readWriterPids(false)) process.stdout.write("Native writer PID manifest unavailable; outer job remains cleanup authority.\n"); } finally {
  try { await pool.end(); } finally {
  const until=Date.now()+5000;
  while(pids.size && Date.now()<until) {
    for(const pid of pids) { try { process.kill(pid,0); } catch(error) { if((error as NodeJS.ErrnoException).code==="ESRCH") pids.delete(pid); else throw error; } }
    if(pids.size) await new Promise((done) => setTimeout(done,20));
  }
  assert.equal(pids.size,0,"all owned native/Git processes must exit before fixture removal");
  // The outer gate removes this exact registered directory only after the whole
  // kernel job is empty, even when timeout bypasses this child's finally block.
  } } }
}
