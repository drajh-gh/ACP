import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { PostgresWorkerRecoveryStore } from "../../src/worker-recovery-store.ts";
import { launchRecoveryFixture } from "./launch-recovery-fixture.ts";
import { WindowsWorkerLauncher, type OwnedWorker, type WorkerLaunchRequest } from "../../../../apps/worker/src/windows-worker-launcher.ts";
import { describeWindowsLaunchFence } from "../../../../apps/worker/src/windows-launch-fence.ts";
import { SupervisedWorkerTransport } from "../../../../apps/worker/src/supervised-worker-transport.ts";
import { WorkerManager, type WorkerTransportRequest } from "../../../../apps/worker/src/worker-manager.ts";
import { WorkerLaunchRecoveryRuntime, WindowsWorkerLaunchInspector } from "../../../../apps/worker/src/worker-launch-recovery.ts";
import { WorkerRecoveryRuntime } from "../../../../apps/worker/src/worker-recovery.ts";
import { HostDispatchRuntime } from "../../../../apps/worker/src/host-dispatch.ts";

if (process.platform !== "win32") throw new Error("native launch gate requires Windows");
const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("owned database port required");
const pool = new Pool({ connectionString: `postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test`, max: 4,
  statement_timeout: 5000, lock_timeout: 3000, connectionTimeoutMillis: 3000 });
const root = await mkdtemp(join(tmpdir(), "acp-launch-consumer-test-")), directory = join(root, "seals");
const pids: number[] = [];
const report = (pid: number, purpose: string) => { pids.push(pid); process.stdout.write(`Owned PID ${pid}: ${purpose}\n`); };
const signal = () => new AbortController().signal;
let checks = 0, worker: OwnedWorker | undefined, runtime: HostDispatchRuntime | undefined;
async function check(name: string, action: () => Promise<void>) { await action(); checks++; process.stdout.write(`PASS native launch: ${name}\n`); }
async function gone(pid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`owned PID ${pid} still running`);
}
try {
  await mkdir(directory);
  const fence = await describeWindowsLaunchFence(directory, signal(), { onSpawn: report });
  const f = await launchRecoveryFixture(pool, "host:launch-native-check");
  const native = new WindowsWorkerLauncher({ runnerPath: fileURLToPath(new URL(
    "../../../../apps/worker/test/integration/synthetic-owned-result-runner.ts", import.meta.url)),
    onSpawn: ({ processId, purpose }) => report(processId, purpose) });
  let creations = 0, loseReceiptAck = false;
  const transport = new SupervisedWorkerTransport({ launcher: { async launch(input) { creations++; return native.launch(input); } },
    processes: f.workers, launchFence: fence, launches: { async finishOwnedLaunch(completion) {
      await f.launches.finishOwnedLaunch(completion);
      if (loseReceiptAck) throw new Error("synthetic lost owner receipt acknowledgement");
    } } });
  const launchRecovery = () => new WorkerLaunchRecoveryRuntime({ store: f.launches, inspector: new WindowsWorkerLaunchInspector({ onSpawn: report }) });
  const legacyStore = new PostgresWorkerRecoveryStore(pool, f.runtime);
  const recovery = new WorkerRecoveryRuntime({ store: legacyStore, workers: f.workers,
    inspector: { async stop() { assert.fail("intent run must not enter legacy native recovery"); } }, launches: launchRecovery() });
  runtime = new HostDispatchRuntime({ host: f.host, runtime: f.runtime, dispatches: f.dispatches, contexts: f.contexts,
    workers: f.workers, manager: new WorkerManager(f.workers, transport, { localHostIdentifier: f.host.hostIdentifier }),
    enqueue: async () => {}, recovery });
  await check("host admission, native execution and sealed owner receipt precede terminal projection", async () => {
    const a = await f.assignment(fence, process.cwd());
    assert.equal((await runtime!.execute(a.message)).state, "terminal");
    const row = (await pool.query(`SELECT r.state AS run_state,p.state AS process_state,s.actor_kind,i.worker_process_id
      FROM acp.worker_runs r JOIN acp.worker_launch_intents i USING(run_id) JOIN acp.worker_launch_stops s USING(run_id)
      JOIN acp.worker_processes p USING(run_id) WHERE r.run_id=$1`, [a.a.runId])).rows[0];
    assert.equal(row.run_state, "failed"); assert.equal(row.process_state, "exited"); assert.equal(row.actor_kind, "owner");
    assert.match(await readFile(join(directory, row.worker_process_id + ".launch"), "utf8"), /\nsealed\n$/u);
    assert.equal((await runtime!.execute(a.message)).state, "terminal"); assert.equal(creations, 1);
  });
  await check("lost owner receipt acknowledgement hands off and repairs the gap without another native observation", async () => {
    const a = await f.assignment(fence, process.cwd()); loseReceiptAck = true;
    assert.equal((await runtime!.execute(a.message)).state, "reconciliation_required");
    const receipt = (await pool.query("SELECT * FROM acp.worker_launch_stops WHERE run_id=$1", [a.a.runId])).rows[0]; assert.ok(receipt);
    assert.equal((await pool.query("SELECT 1 FROM acp.worker_launch_revocations WHERE run_id=$1", [a.a.runId])).rowCount, 1);
    assert.equal((await legacyStore.listCandidates()).length, 0);
    const before = pids.length; await runtime!.maintain(); assert.equal(pids.length, before);
    assert.equal((await runtime!.execute(a.message)).state, "terminal"); assert.equal(creations, 2);
    assert.deepEqual((await pool.query("SELECT * FROM acp.worker_launch_stops WHERE run_id=$1", [a.a.runId])).rows[0], receipt);
    loseReceiptAck = false;
  });
  await check("a delayed journal acknowledgement after manager cancellation cannot release the revoked root", async () => {
    const a = await f.assignment(fence, process.cwd()), committed = Promise.withResolvers<void>(), acknowledgement = Promise.withResolvers<void>();
    const cancellation = new AbortController(); let transportWork: Promise<unknown> | undefined;
    const delayed = new SupervisedWorkerTransport({ launcher: native, launchFence: fence, launches: f.launches, processes: {
      recordWorkerProcessFromRun: async (input) => { const row = await f.workers.recordWorkerProcessFromRun(input);
        committed.resolve(); await acknowledgement.promise; return row; },
      loadWorkerProcess: f.workers.loadWorkerProcess.bind(f.workers), heartbeatWorkerProcess: f.workers.heartbeatWorkerProcess.bind(f.workers),
      finishWorkerProcess: f.workers.finishWorkerProcess.bind(f.workers),
    } });
    const manager = new WorkerManager(f.workers, { launchFence: fence, run(request: WorkerTransportRequest) {
      transportWork = delayed.run(request); void transportWork.catch(() => {}); return transportWork;
    } }, { localHostIdentifier: f.host.hostIdentifier, terminationConfirmationMs: 20 });
    const cancelledHost = new HostDispatchRuntime({ host: f.host, runtime: f.runtime, dispatches: f.dispatches,
      contexts: f.contexts, workers: f.workers, enqueue: async () => {}, recovery,
      manager: { dispatch: (input) => manager.dispatch({ ...input, signal: AbortSignal.any([input.signal!, cancellation.signal]) }) } });
    const executing = cancelledHost.execute(a.message);
    try {
      await committed.promise; cancellation.abort();
      assert.equal((await executing).state, "reconciliation_required");
      assert.equal((await pool.query("SELECT 1 FROM acp.worker_launch_revocations WHERE run_id=$1", [a.a.runId])).rowCount, 1);
      acknowledgement.resolve(); await assert.rejects(transportWork!);
      assert.equal((await pool.query("SELECT state FROM acp.worker_processes WHERE run_id=$1", [a.a.runId])).rows[0].state, "running");
      assert.equal((await launchRecovery().maintain(signal())).recovered, 1);
      assert.equal((await cancelledHost.execute(a.message)).state, "terminal");
      assert.equal((await pool.query("SELECT state FROM acp.worker_processes WHERE run_id=$1", [a.a.runId])).rows[0].state, "lost");
    } finally { acknowledgement.resolve(); await Promise.allSettled([executing, transportWork]); }
  });
  await check("lost atomic admission acknowledgement recovers the never-created intent without duplicate execution", async () => {
    const a = await f.assignment(fence, process.cwd()), before = creations;
    const manager = new WorkerManager({ loadContextPacket: f.workers.loadContextPacket.bind(f.workers),
      loadCapabilityGrant: f.workers.loadCapabilityGrant.bind(f.workers), completeRun: f.workers.completeRun.bind(f.workers),
      async startRun(input) { await f.workers.startRun(input); throw new Error("synthetic lost launch admission acknowledgement"); },
    }, transport, { localHostIdentifier: f.host.hostIdentifier });
    const uncertainHost = new HostDispatchRuntime({ host: f.host, runtime: f.runtime, dispatches: f.dispatches,
      contexts: f.contexts, workers: f.workers, enqueue: async () => {}, recovery, manager });
    assert.equal((await uncertainHost.execute(a.message)).state, "reconciliation_required");
    assert.equal(creations, before);
    assert.equal((await launchRecovery().maintain(signal())).recovered, 1);
    const receipt = (await pool.query("SELECT * FROM acp.worker_launch_stops WHERE run_id=$1", [a.a.runId])).rows[0];
    assert.equal(receipt.reason, "sealed_launch_job_absent"); assert.equal(receipt.root_process_id, null);
    assert.equal((await uncertainHost.execute(a.message)).state, "terminal"); assert.equal(creations, before);
    assert.equal((await pool.query("SELECT 1 FROM acp.worker_processes WHERE run_id=$1", [a.a.runId])).rowCount, 0);
  });
  await check("a killed unjournaled native owner recovers from its sealed intent and rejects delayed creation", async () => {
    const a = await f.sample(false, fence, process.cwd());
    const request: WorkerLaunchRequest = { workerProcessId: a.candidate.workerProcessId, launchFence: fence,
      deadlineAt: a.started.timeoutAt, workspace: process.cwd(), maximumOutputBytes: 4096, signal: signal() };
    const before = pids.length; worker = await native.launch(request);
    const bridgePid = pids[before]; assert.ok(bridgePid);
    process.kill(bridgePid); await assert.rejects(worker.closed); await gone(bridgePid); await gone(worker.processId);
    await runtime!.stop(); runtime = undefined; await f.replaceOwner();
    assert.equal((await launchRecovery().maintain(signal())).recovered, 1);
    const row = (await pool.query(`SELECT r.state,s.actor_kind,s.root_process_id FROM acp.worker_runs r
      JOIN acp.worker_launch_stops s USING(run_id) WHERE r.run_id=$1`, [a.a.runId])).rows[0];
    assert.equal(row.state, "failed"); assert.equal(row.actor_kind, "recovery"); assert.equal(row.root_process_id, worker.processId);
    assert.equal((await pool.query("SELECT 1 FROM acp.worker_processes WHERE run_id=$1", [a.a.runId])).rowCount, 0);
    await assert.rejects(native.launch({ ...request, signal: signal() }));
    await assert.rejects(f.workers.recordWorkerProcessFromRun({ ...a.registration, processId: worker.processId,
      processStartToken: worker.processStartToken, startedAt: worker.startedAt }), /was not persisted|revoked/u);
    assert.equal((await pool.query("SELECT 1 FROM acp.worker_processes WHERE run_id=$1", [a.a.runId])).rowCount, 0);
  });
  process.stdout.write(`Worker native launch integration: ${checks} checks passed.\n`);
} finally {
  await worker?.terminate().catch(() => {}); await runtime?.stop(); await pool.end();
  for (const pid of pids) await gone(pid);
  const location = resolve(root), local = relative(resolve(tmpdir()), location);
  assert.ok(local.startsWith("acp-launch-consumer-test-") && !local.includes("..") && !isAbsolute(local));
  // Fixture-only seals are removed after every creator/helper has exited. Never production seals.
  await rm(location, { recursive: true, force: true });
}
