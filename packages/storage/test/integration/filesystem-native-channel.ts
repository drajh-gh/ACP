import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { createStableId, createWorkerFailureResult, parseWorkerResult } from "@acp/domain";
import { PostgresFilesystemWriterStore, PostgresRepositoryBindingStore, type RepositoryBindingInput, type WorktreeBindingInput } from "../../src/index.ts";
import { launchRecoveryFixture } from "./launch-recovery-fixture.ts";
import { describeWindowsLaunchFence } from "../../../../apps/worker/src/windows-launch-fence.ts";
import { observeWindowsRepository, observeWindowsWorktree } from "../../../../apps/worker/src/windows-repository-observer.ts";
import { NativeFilesystemWriterController } from "../../../../apps/worker/src/native-filesystem-writer-controller.ts";
import { WindowsWorkerLauncher, type OwnedWorker } from "../../../../apps/worker/src/windows-worker-launcher.ts";

// One scenario per separately bounded child: never spend a lease on fixture setup.
if (process.platform!=="win32") throw new Error("native writer channel gate requires Windows");
const port=Number(process.argv[2]),phase=process.argv[3];
if (!Number.isInteger(port) || port<1024 || port>65535) throw new Error("owned database port required");
if (phase!=="initial" && phase!=="lost-ack") throw new Error("exact native writer channel phase required");
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
  const responseLoss=new PostgresFilesystemWriterStore({ options:pool.options,query:pool.query.bind(pool),async connect() {
    const client=await pool.connect();
    return { release:() => client.release(),async query<R extends QueryResultRow>(text:string,values?:unknown[]):Promise<QueryResult<R>> {
      const result=await client.query<R>(text,values);
      if (text==="COMMIT") { commits++; if(phase==="lost-ack") { dropped++; throw new Error("injected loss of actual COMMIT response"); } }
      return result;
    } };
  } } as unknown as Pool,f.runtime);
  const native=new WindowsWorkerLauncher({ runnerPath:fileURLToPath(new URL("../../../../apps/worker/test/integration/synthetic-owned-result-runner.ts",import.meta.url)),
    filesystemWriterController:new NativeFilesystemWriterController(responseLoss,{ renewalIntervalMs:5000 }),
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
  worker.release(JSON.stringify({ runId:a.start.runId,packet:a.packet,attemptNumber:1 }));
  const exit=await worker.closed;
  assert.equal(exit.treeEmpty,true); assert.equal(exit.launchSealed,true);
  assert.equal(exit.failed,phase==="lost-ack"); assert.equal(exit.terminated,phase==="lost-ack");
  assert.equal(commits,1); assert.equal(dropped,phase==="lost-ack" ? 1 : 0);
  const renewed=await writers.load(leaseId); assert.ok(renewed); assert.equal(renewed.revision,2); assert.equal(renewed.releasedAt,null);
  assert.equal((await pool.query("SELECT 1 FROM acp.mission_events WHERE mission_id=$1 AND event_type='filesystem.writer-renewed'",[a.a.missionId])).rowCount,1);
  assert.equal((await f.workers.loadWorkerProcess(workerProcessId))?.state,"running");
  for (const table of ["worker_launch_stops","filesystem_writer_releases"]) assert.equal((await pool.query(`SELECT 1 FROM acp.${table} WHERE run_id=$1`,[a.start.runId])).rowCount,0);
  assert.deepEqual((await pool.query("SELECT state,result FROM acp.worker_runs WHERE run_id=$1",[a.start.runId])).rows[0],{ state:"started",result:null });
  await assert.rejects(writers.release(leaseId),/stopped terminal run/u);
  assert.match(await readFile(join(directory,workerProcessId+".launch"),"utf8"),/\nsealed\n$/u);
  const result=phase==="initial" ? parseWorkerResult(JSON.parse(exit.output)) : createWorkerFailureResult({ runId:a.start.runId,packet:a.packet,
    attemptNumber:1,status:"failed",code:"terminated",conclusion:"Supervisor rejected execution after injected database COMMIT response loss.",wallMilliseconds:1 });
  if (phase==="lost-ack") assert.equal(exit.output,""); else { assert.equal(exit.exitCode,0); assert.equal(result.runId,a.start.runId); }
  assert.equal(result.status,"failed"); // Model-free structured failure, not a successful delivery candidate.
  await f.launches.finishOwnedLaunch({ ...registration,state:exit.terminated || exit.failed ? "terminated" : "exited",exitCode:exit.exitCode,
    terminationReason:"Actual native owned-tree closure in disposable lease-channel fixture.",launchSealed:true });
  const stop=(await pool.query("SELECT * FROM acp.worker_launch_stops WHERE run_id=$1",[a.start.runId])).rows[0];
  assert.equal(stop.root_process_id,worker.processId); assert.equal(stop.root_process_start_token,worker.processStartToken);
  assert.equal(stop.actor_kind,"owner"); assert.equal(stop.exit_code,exit.exitCode);
  assert.equal(await writers.loadLaunchBinding(leaseId),undefined);
  await assert.rejects(writers.release(leaseId),/stopped terminal run/u);
  await f.workers.completeRun({ result,completedAt:new Date().toISOString(),transitionProvenanceId:a.a.packetProvenanceId });
  assert.deepEqual((await pool.query("SELECT state,result FROM acp.worker_runs WHERE run_id=$1",[a.start.runId])).rows[0],{ state:"failed",result });
  const released=await writers.release(leaseId);
  assert.equal(released.state,"released"); assert.equal(released.revision,renewed.revision+1);
  assert.equal((await pool.query("SELECT 1 FROM acp.filesystem_writer_releases WHERE lease_id=$1",[leaseId])).rowCount,1);
  await new Promise((done) => setTimeout(done,100));
  assert.deepEqual(await writers.load(leaseId),released); assert.equal(commits,1);
  assert.equal((await pool.query("SELECT 1 FROM acp.mission_events WHERE mission_id=$1 AND event_type='filesystem.writer-renewed'",[a.a.missionId])).rowCount,1);
  assert.deepEqual(await registry.loadWorktree(tree.worktreeBindingId),{ binding:tree,retired:false });
  await registry.retireWorktree(tree.worktreeBindingId,await provenance(),"Disposable native channel scenario ended.");
  await registry.retireRepository(repository.repositoryBindingId,await provenance(),"Disposable native channel scenario ended.");
  await f.dispatches.closeRuntime(f.runtime.hostIdentifier,f.runtime.sessionId);
  process.stdout.write(`PASS native writer channel ${phase}: actual journal before GO, quiescent sealed stop before result/release; ${commits} real heartbeat COMMIT, ${dropped} injected response loss\nNative writer channel integration: 1 scenario passed.\n`);
} finally {
  try { await worker?.terminate().catch(() => {}); } finally {
  try { await pool.end(); } finally {
  const until=Date.now()+5000;
  while(pids.size && Date.now()<until) {
    for(const pid of pids) { try { process.kill(pid,0); } catch(error) { if((error as NodeJS.ErrnoException).code==="ESRCH") pids.delete(pid); else throw error; } }
    if(pids.size) await new Promise((done) => setTimeout(done,20));
  }
  assert.equal(pids.size,0,"all owned native/Git processes must exit before fixture removal");
  // The outer gate removes this exact registered directory only after the whole
  // kernel job is empty, even when timeout bypasses this child's finally block.
  } }
}
