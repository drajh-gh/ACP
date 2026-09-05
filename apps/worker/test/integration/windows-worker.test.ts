import assert from "node:assert/strict";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createStableId } from "@acp/domain";
import type { WorkerProcessRecord } from "@acp/storage";
import { WindowsWorkerLauncher, type OwnedWorker } from "../../src/windows-worker-launcher.ts";
import { WindowsWorkerTreeInspector } from "../../src/windows-worker-recovery.ts";
import { minimalCodexEnvironment } from "../../src/codex-sdk-transport.ts";

const native = process.platform === "win32";
const runnerPath = fileURLToPath(new URL("./synthetic-owned-runner.ts", import.meta.url));
const launcher = new WindowsWorkerLauncher({ runnerPath,
  onSpawn: ({ processId, purpose }) => process.stdout.write(`Owned PID ${processId}: ${purpose}\n`) });
function request(signal = new AbortController().signal, maximumOutputBytes = 4096) {
  return { workerProcessId: createStableId("workerProcess"), deadlineAt: new Date(Date.now() + 12_000).toISOString(),
    workspace: process.cwd(), maximumOutputBytes, signal };
}
async function cleanup(worker: OwnedWorker | undefined) { await worker?.terminate().catch(() => {}); }
async function gone(pid: number, milliseconds = 8000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Owned PID ${pid} remained after bounded cleanup`);
}

const inspector = new WindowsWorkerTreeInspector({
  onSpawn: (pid, purpose) => process.stdout.write(`Owned PID ${pid}: ${purpose}\n`),
});
function recoveryRequest() {
  // Leave room for the separate bounded inspector to compile and observe the
  // worker, without the launcher's deadline accidentally proving the test.
  return { ...request(), deadlineAt: new Date(Date.now() + 30_000).toISOString() };
}
function recordedWorker(launch: ReturnType<typeof request>, worker: OwnedWorker): WorkerProcessRecord {
  const provenanceId = createStableId("provenance");
  return {
    workerProcessId: launch.workerProcessId, runId: createStableId("run"),
    missionId: createStableId("mission"), nodeId: createStableId("node"),
    processId: worker.processId, processStartToken: worker.processStartToken,
    purpose: "Native recovery test fixture", hostIdentifier: "windows-native-test",
    resourceClass: "lightweight_read", state: "running", startedAt: worker.startedAt,
    recordedAt: worker.startedAt, heartbeatAt: worker.startedAt, deadlineAt: launch.deadlineAt,
    provenanceId, transitionProvenanceId: provenanceId,
    supervision: { kind: "windows_job", treeIdentifier: `Local\\ACP.Worker.${launch.workerProcessId}`, scope: worker.scope },
  };
}

async function stillReleasable(worker: OwnedWorker, text: string) {
  assert.doesNotThrow(() => process.kill(worker.processId, 0)); // Liveness probe only, never a PID kill.
  worker.release(JSON.stringify({ text }));
  const outcome = await worker.closed;
  assert.equal(outcome.treeEmpty, true); assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.failed, false); assert.equal(outcome.terminated, false);
  assert.deepEqual(JSON.parse(outcome.output), { processId: worker.processId, text, leaked: false });
}

async function cleanupRecovery(worker: OwnedWorker) {
  assert.equal((await worker.terminate()).treeEmpty, true);
  await gone(worker.processId);
}

it("native suspended identity precedes release; private IPC preserves text and strips secrets", { skip: !native, timeout: 20000 }, async () => {
  const previous = process.env.ACP_TEST_SECRET; process.env.ACP_TEST_SECRET = "synthetic-do-not-inherit";
  let worker: OwnedWorker | undefined;
  try {
    worker = await launcher.launch(request());
    assert.match(worker.processStartToken, /^win32-filetime:/);
    let closed = false; void worker.closed.then(() => { closed = true; }, () => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 100)); assert.equal(closed, false);
    worker.release(JSON.stringify({ text: 'Quote " and slash \\ and Unicode ž 🚀' }));
    const outcome = await worker.closed;
    assert.equal(outcome.treeEmpty, true); assert.equal(outcome.exitCode, 0); assert.equal(outcome.failed, false);
    assert.equal(outcome.terminated, false);
    assert.deepEqual(JSON.parse(outcome.output), { processId: worker.processId,
      text: 'Quote " and slash \\ and Unicode ž 🚀', leaked: false });
    assert.throws(() => worker!.release("{}"));
  } finally {
    if (previous === undefined) delete process.env.ACP_TEST_SECRET; else process.env.ACP_TEST_SECRET = previous;
    await cleanup(worker);
  }
});

it("root exit drains a detached descendant before acknowledging tree closure", { skip: !native, timeout: 20000 }, async () => {
  const worker = await launcher.launch(request());
  try {
    worker.release(JSON.stringify({ mode: "descendant" }));
    const outcome = await worker.closed;
    assert.equal(outcome.treeEmpty, true); assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.terminated, false);
    const { childId } = JSON.parse(outcome.output) as { childId: number };
    assert.ok(childId > 0);
    process.stdout.write(`Owned PID ${childId}: detached synthetic descendant (confirmed stopped)\n`);
    assert.throws(() => process.kill(childId, 0), /ESRCH/);
  } finally { await cleanup(worker); }
});

it("abort kills a running owned tree and confirms closure", { skip: !native, timeout: 20000 }, async () => {
  const controller = new AbortController();
  const worker = await launcher.launch(request(controller.signal));
  try {
    worker.release(JSON.stringify({ mode: "hold" })); controller.abort();
    const outcome = await worker.closed;
    assert.equal(outcome.treeEmpty, true); assert.equal(outcome.terminated, true);
    assert.throws(() => process.kill(worker.processId, 0), /ESRCH/);
  } finally { await cleanup(worker); }
});

it("output overflow fails closed only after owned-tree termination", { skip: !native, timeout: 20000 }, async () => {
  const worker = await launcher.launch(request(undefined, 1024));
  try {
    worker.release(JSON.stringify({ mode: "overflow" }));
    const outcome = await worker.closed;
    assert.equal(outcome.treeEmpty, true); assert.equal(outcome.failed, true);
    assert.equal(outcome.terminated, true);
  } finally { await cleanup(worker); }
});

it("legal large output is not rejected at an aggregate IPC chunk boundary", { skip: !native, timeout: 20000 }, async () => {
  const worker = await launcher.launch(request(undefined, 524288));
  try {
    const text = "ž".repeat(120000);
    worker.release(JSON.stringify({ text }));
    const outcome = await worker.closed;
    assert.equal(outcome.failed, false); assert.equal(outcome.terminated, false);
    assert.equal(JSON.parse(outcome.output).text, text);
  } finally { await cleanup(worker); }
});

it("non-reading runner cannot block cancellation during input delivery", { skip: !native, timeout: 20000 }, async () => {
  const controller = new AbortController();
  const blocked = new WindowsWorkerLauncher({ runnerPath: fileURLToPath(new URL("./nonreading-owned-runner.ts", import.meta.url)),
    onSpawn: ({ processId, purpose }) => process.stdout.write(`Owned PID ${processId}: ${purpose}\n`) });
  const worker = await blocked.launch(request(controller.signal));
  try {
    worker.release("x".repeat(250000));
    await new Promise((resolve) => setTimeout(resolve, 100)); controller.abort();
    assert.equal((await worker.closed).terminated, true);
    await gone(worker.processId);
  } finally { await cleanup(worker); }
});

it("daemon death closes control input and reaps a blocked-input worker", { skip: !native, timeout: 20000 }, async () => {
  const parent = spawn(process.execPath, ["--experimental-strip-types",
    fileURLToPath(new URL("./synthetic-worker-parent.ts", import.meta.url))],
  { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
  assert.ok(parent.pid); process.stdout.write(`Owned PID ${parent.pid}: sacrificial worker daemon\n`);
  const pids: number[] = [];
  const closed = once(parent, "exit");
  const ready = new Promise<void>((resolve, reject) => {
    parent.on("message", (value: { ready?: boolean; processId?: number; purpose?: string }) => {
      if (value.processId) { pids.push(value.processId); process.stdout.write(`Owned PID ${value.processId}: ${value.purpose}\n`); }
      if (value.ready) resolve();
    });
    parent.on("error", reject);
    parent.on("exit", () => reject(new Error("synthetic daemon exited before ready")));
  });
  try {
    await ready; assert.equal(pids.length, 2);
    parent.kill(); await closed;
    for (const pid of pids) await gone(pid);
  } finally { if (parent.exitCode === null && parent.signalCode === null) parent.kill(); await closed; }
});

it("persisted deadline terminates an unreleased suspended root", { skip: !native, timeout: 20000 }, async () => {
  const worker = await launcher.launch({ ...request(), deadlineAt: new Date(Date.now() + 6000).toISOString() });
  try {
    const outcome = await worker.closed;
    assert.equal(outcome.terminated, true); assert.equal(outcome.treeEmpty, true);
    assert.equal(outcome.output, ""); await gone(worker.processId);
  } finally { await cleanup(worker); }
});

it("native watchdog kills the tree and bridge even when the daemon stops draining control output", { skip: !native, timeout: 20000 }, async () => {
  const environment = minimalCodexEnvironment();
  const bridge = spawn("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File",
    fileURLToPath(new URL("../../native/windows-worker-host.ps1", import.meta.url))],
  { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: environment });
  assert.ok(bridge.pid); process.stdout.write(`Owned PID ${bridge.pid}: blocked-output bridge probe\n`);
  const exited = once(bridge, "exit");
  bridge.stderr.resume(); bridge.stdin.on("error", () => {});
  let buffered = "";
  const ready = new Promise<number>((resolve, reject) => {
    bridge.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const frame = JSON.parse(buffered.slice(0, newline)) as { type: string; processId: number };
      if (frame.type !== "ready") { reject(new Error("probe did not create owned root")); return; }
      bridge.stdout.pause(); bridge.stdout.removeAllListeners("data");
      process.stdout.write(`Owned PID ${frame.processId}: flood-output runner\n`);
      resolve(frame.processId);
    });
    bridge.on("error", reject); bridge.on("exit", () => reject(new Error("probe exited before ready")));
  });
  const deadline = Date.now() + 6000;
  bridge.stdin.write(JSON.stringify({ workerProcessId: createStableId("workerProcess"),
    deadlineAt: new Date(deadline).toISOString(), executable: process.execPath,
    arguments: ["--experimental-strip-types", fileURLToPath(new URL("./flood-owned-runner.ts", import.meta.url))],
    workspace: process.cwd(), maximumOutputBytes: 1048576,
    environment: Object.entries(environment).map(([key, value]) => `${key}=${value}`) }) + "\n");
  try {
    const pid = await ready;
    bridge.stdin.write(JSON.stringify({ type: "go", input: "{}" }) + "\n");
    await gone(pid, 9000);
    assert.ok(Date.now() >= deadline - 100, "only the native watchdog should stop this blocked probe");
    const [code] = await exited; assert.equal(code, 137);
  } finally {
    if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill();
    bridge.stdout.resume(); bridge.stdin.end(); await exited;
  }
});

for (const released of [false, true]) {
  it(`recovery terminates the exact ${released ? "running" : "suspended"} owned root`, { skip: !native, timeout: 40000 }, async () => {
    const launch = recoveryRequest();
    const worker = await launcher.launch(launch);
    try {
      const record = recordedWorker(launch, worker);
      if (released) {
        worker.release(JSON.stringify({ mode: "hold" }));
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.doesNotThrow(() => process.kill(worker.processId, 0));
      const observation = await inspector.stop(record, new AbortController().signal);
      assert.deepEqual(observation, { state: "terminated", reason: "exact_owned_tree_terminated", exitCode: 137 });
      const outcome = await worker.closed;
      assert.equal(outcome.treeEmpty, true); assert.equal(outcome.exitCode, 137);
      await gone(worker.processId);
    } finally { await cleanupRecovery(worker); }
  });
}

it("recovery observes absence after normal owner cleanup without inferring success", { skip: !native, timeout: 40000 }, async () => {
  const launch = recoveryRequest();
  const worker = await launcher.launch(launch);
  try {
    const record = recordedWorker(launch, worker);
    await stillReleasable(worker, "normal cleanup before recovery");
    assert.deepEqual(await inspector.stop(record, new AbortController().signal), {
      state: "lost", reason: "owned_job_and_original_root_absent",
    });
  } finally { await cleanupRecovery(worker); }
});

const wrongScopes: readonly { readonly name: string; readonly change: (scope: OwnedWorker["scope"]) => OwnedWorker["scope"] }[] = [
  { name: "machine", change: (scope) => ({ ...scope,
    machineFingerprint: (scope.machineFingerprint.startsWith("0") ? "1" : "0") + scope.machineFingerprint.slice(1) }) },
  { name: "session", change: (scope) => ({ ...scope, sessionId: (scope.sessionId + 1) % 2147483648 }) },
  { name: "earlier boot timestamp", change: (scope) => ({ ...scope,
    bootedAt: new Date(Date.parse(scope.bootedAt) - 1000).toISOString() }) },
  { name: "later boot timestamp", change: (scope) => ({ ...scope,
    bootedAt: new Date(Date.parse(scope.bootedAt) + 1000).toISOString() }) },
];
for (const mismatch of wrongScopes) {
  it(`recovery with the wrong ${mismatch.name} leaves the owned worker usable`, { skip: !native, timeout: 40000 }, async () => {
    const launch = recoveryRequest();
    const worker = await launcher.launch(launch);
    try {
      const record = recordedWorker(launch, worker);
      assert.ok(record.supervision);
      const wrong: WorkerProcessRecord = { ...record,
        supervision: { ...record.supervision, scope: mismatch.change(worker.scope) } };
      assert.deepEqual(await inspector.stop(wrong, new AbortController().signal), { state: "unconfirmed" });
      await stillReleasable(worker, `preserved after wrong ${mismatch.name}`);
    } finally { await cleanupRecovery(worker); }
  });
}

it("recovery with a mismatched creation token does not terminate the live worker", { skip: !native, timeout: 40000 }, async () => {
  const launch = recoveryRequest();
  const worker = await launcher.launch(launch);
  try {
    const record = recordedWorker(launch, worker);
    const creation = BigInt(worker.processStartToken.slice("win32-filetime:".length));
    worker.release(JSON.stringify({ mode: "hold" }));
    let closed = false; void worker.closed.then(() => { closed = true; }, () => { closed = true; });
    assert.deepEqual(await inspector.stop({ ...record, processStartToken: `win32-filetime:${creation + 1n}` },
      new AbortController().signal), { state: "unconfirmed" });
    assert.equal(closed, false);
    assert.doesNotThrow(() => process.kill(worker.processId, 0));
  } finally { await cleanupRecovery(worker); }
});

it("historical journals without OS scope fail closed without spawning an inspector", { skip: !native, timeout: 40000 }, async () => {
  const launch = recoveryRequest();
  const worker = await launcher.launch(launch);
  let spawned = false;
  const historicalInspector = new WindowsWorkerTreeInspector({ onSpawn: (pid, purpose) => {
    spawned = true; process.stdout.write(`Owned PID ${pid}: ${purpose}\n`);
  } });
  try {
    const record = recordedWorker(launch, worker);
    assert.ok(record.supervision);
    const historical: WorkerProcessRecord = { ...record,
      supervision: { kind: "windows_job", treeIdentifier: record.supervision.treeIdentifier } };
    assert.deepEqual(await historicalInspector.stop(historical, new AbortController().signal), { state: "unconfirmed" });
    assert.equal(spawned, false);
    await stillReleasable(worker, "historical scope is not invented");
  } finally { await cleanupRecovery(worker); }
});

it("aborting a spawned inspector confirms helper exit and leaves the worker usable", { skip: !native, timeout: 40000 }, async () => {
  const launch = recoveryRequest();
  const worker = await launcher.launch(launch);
  const controller = new AbortController();
  let inspectorPid: number | undefined;
  const abortingInspector = new WindowsWorkerTreeInspector({ onSpawn: (pid, purpose) => {
    inspectorPid = pid; process.stdout.write(`Owned PID ${pid}: ${purpose}\n`);
    // Deterministically abort after the helper exists but before its native
    // inspection starts. Cleanup must await this owned helper's close event.
    controller.abort();
  } });
  try {
    assert.deepEqual(await abortingInspector.stop(recordedWorker(launch, worker), controller.signal), { state: "unconfirmed" });
    assert.ok(inspectorPid !== undefined);
    await gone(inspectorPid);
    await stillReleasable(worker, "inspection cancellation preserves the target");
  } finally { await cleanupRecovery(worker); }
});
