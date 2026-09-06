import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, readdir, readFile, writeFile, appendFile, mkdir, rename, link, symlink, open, stat } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createStableId } from "@acp/domain";
import { WindowsWorkerLauncher, type OwnedWorker } from "../../src/windows-worker-launcher.ts";
import { describeWindowsLaunchFence, sealWindowsWorkerLaunch, type WindowsLaunchFenceDescriptor } from "../../src/windows-launch-fence.ts";
import { minimalCodexEnvironment } from "../../src/codex-sdk-transport.ts";
import { WorkerTerminationUnconfirmedError } from "../../src/worker-manager.ts";

const native = process.platform === "win32";
const runnerPath = fileURLToPath(new URL("./synthetic-owned-runner.ts", import.meta.url));
const pids=new Set<number>();
const report = (pid: number, purpose: string) => { pids.add(pid); process.stdout.write(`Owned PID ${pid}: ${purpose}\n`); };
const options = { onSpawn: report };
const launcher = new WindowsWorkerLauncher({ runnerPath, onSpawn: ({ processId, purpose }) => report(processId, purpose) });
const signal = () => new AbortController().signal;
const request = (fence: WindowsLaunchFenceDescriptor) => ({ workerProcessId: createStableId("workerProcess"),
  deadlineAt: new Date(Date.now() + 30000).toISOString(), workspace: process.cwd(), maximumOutputBytes: 4096, signal: signal(), launchFence: fence });

async function fixture() {
  const owner=process.env.ACP_TEST_NATIVE_CHANNEL_ROOT;
  assert.ok(owner && isAbsolute(owner),"native gate must own the fixture root");
  const root = await mkdtemp(join(owner, "case-"));
  const directory = join(root, "seals ž 🚀"); await mkdir(directory);
  const dispose = async () => {
    const until=Date.now()+8000;
    while(pids.size && Date.now()<until) {
      for(const pid of pids) {
        try { process.kill(pid,0); }
        catch(error) { if((error as NodeJS.ErrnoException).code==="ESRCH") pids.delete(pid); else throw error; }
      }
      if(pids.size) await new Promise((done)=>setTimeout(done,20));
    }
    assert.equal(pids.size,0,"every reported launch/helper process must exit before case completion");
    // Outer gate confirms its whole job empty before exact UUID-root removal,
    // including hard test timeouts. Cases never select recursive cleanup paths.
  };
  try { return { root, directory, fence: await describeWindowsLaunchFence(directory, signal(), options), dispose }; }
  catch (error) { await dispose(); throw error; }
}
async function cleanup(worker: OwnedWorker | undefined) { await worker?.terminate().catch(() => {}); }
async function gone(pid: number) {
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((done) => setTimeout(done, 25));
  }
  assert.fail(`Owned PID ${pid} did not exit`);
}
async function probe(operation: string, launch: ReturnType<typeof request>) {
  const child = spawn("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File",
    fileURLToPath(new URL("./synthetic-launch-fence-holder.ps1", import.meta.url))],
  { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: minimalCodexEnvironment() });
  assert.ok(child.pid); report(child.pid, `synthetic launch fence ${operation}`);
  const closed = once(child, "close"); child.stdin.on("error", () => {});
  let output = ""; child.stderr.resume();
  const ready = new Promise<{ ready: true; processId?: number }>((done, reject) => {
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString("utf8");
      if (output.includes("\n")) try { done(JSON.parse(output.trim())); } catch { reject(new Error("invalid probe frame")); }
    });
    child.on("error", reject);
    child.on("close", () => { if (!output.includes("\n")) reject(new Error("probe exited before ready")); });
  });
  child.stdin.write(JSON.stringify({ operation, fence: launch.launchFence, workerProcessId: launch.workerProcessId,
    deadlineAt: launch.deadlineAt, executable: process.execPath, arguments: ["--experimental-strip-types", runnerPath],
    workspace: launch.workspace, environment: Object.entries(minimalCodexEnvironment()).map(([key, value]) => `${key}=${value}`) }) + "\n");
  const timer = setTimeout(() => child.kill(), 15000);
  const dispose = async () => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; };
  try { return { child, closed, ready: await ready, dispose }; }
  catch (error) { await dispose(); throw error; }
}

it("sealing a never-launched intent prevents every later creation and is idempotent", { skip: !native, timeout: 25000 }, async () => {
  const f = await fixture(), launch = request(f.fence);
  try {
    const sealed = await sealWindowsWorkerLaunch(f.fence, launch.workerProcessId, signal(), options);
    assert.deepEqual(sealed, { state: "lost", sealed: true, reason: "sealed_launch_job_absent" });
    const before = await readFile(join(f.directory, launch.workerProcessId + ".launch"));
    assert.deepEqual(await sealWindowsWorkerLaunch(f.fence, launch.workerProcessId, signal(), options), sealed);
    assert.deepEqual(await readFile(join(f.directory, launch.workerProcessId + ".launch")), before);
    await assert.rejects(launcher.launch(launch));
    assert.deepEqual(await readFile(join(f.directory, launch.workerProcessId + ".launch")), before);
  } finally { await f.dispose(); }
});

it("a consumed identity cannot create a second root after normal exit", { skip: !native, timeout: 25000 }, async () => {
  const f = await fixture(), launch = request(f.fence); let worker: OwnedWorker | undefined;
  try {
    worker = await launcher.launch(launch); worker.release(JSON.stringify({ text: "fenced output" }));
    const result = await worker.closed; assert.equal(result.failed, false); assert.equal(JSON.parse(result.output).text, "fenced output");
    assert.equal(result.launchSealed, true);
    assert.match(await readFile(join(f.directory, launch.workerProcessId + ".launch"), "utf8"), /\nsealed\n$/u);
    await assert.rejects(launcher.launch(launch));
    const sealed = await sealWindowsWorkerLaunch(f.fence, launch.workerProcessId, signal(), options);
    assert.equal(sealed.state, "lost");
    assert.equal(sealed.root?.processId, worker.processId);
  } finally { await cleanup(worker); await f.dispose(); }
});

it("a permanent seal fences late GO even before recovery stops the suspended root", { skip: !native, timeout: 25000 }, async () => {
  const f = await fixture(), launch = request(f.fence); let worker: OwnedWorker | undefined;
  try {
    worker = await launcher.launch(launch);
    const holder = await probe("seal-only", launch); await holder.closed; await holder.dispose();
    worker.release(JSON.stringify({ text: "must never execute" }));
    const result = await worker.closed; assert.equal(result.failed, true); assert.equal(result.output, "");
    assert.equal(result.launchSealed, true);
    await gone(worker.processId);
    assert.equal((await sealWindowsWorkerLaunch(f.fence, launch.workerProcessId, signal(), options)).state, "lost");
  } finally { await cleanup(worker); await f.dispose(); }
});

it("explicit termination durably seals the exact unreleased root before reporting closure", { skip: !native, timeout: 25000 }, async () => {
  const f = await fixture(), launch = request(f.fence); let worker: OwnedWorker | undefined;
  try {
    worker = await launcher.launch(launch);
    const result = await worker.terminate();
    assert.equal(result.launchSealed, true); assert.equal(result.terminated, true); assert.equal(result.output, "");
    await gone(worker.processId);
    assert.match(await readFile(join(f.directory, launch.workerProcessId + ".launch"), "utf8"), /\nsealed\n$/u);
    await assert.rejects(launcher.launch(launch));
  } finally { await cleanup(worker); await f.dispose(); }
});

it("tree closure without a writable durable seal remains unconfirmed until independent recovery", { skip: !native, timeout: 25000 }, async () => {
  const f = await fixture(), launch = request(f.fence); let worker: OwnedWorker | undefined, held: Awaited<ReturnType<typeof open>> | undefined;
  try {
    worker = await launcher.launch(launch);
    held = await open(join(f.directory, launch.workerProcessId + ".launch"), "r");
    // Native Open requests no sharing. Keep the existing seal file occupied
    // through confirmed tree stop, without changing its bytes or identity.
    await assert.rejects(worker.terminate(), WorkerTerminationUnconfirmedError);
    await gone(worker.processId);
    await held.close(); held = undefined;
    const recovered = await sealWindowsWorkerLaunch(f.fence, launch.workerProcessId, signal(), options);
    assert.equal(recovered.state, "lost"); assert.equal(recovered.sealed, true);
    assert.equal(recovered.root?.processId, worker.processId);
    await assert.rejects(launcher.launch(launch));
  } finally { await held?.close(); await cleanup(worker); await f.dispose(); }
});

it("a crash after durable consumption but before CreateProcess remains sealed against replay", { skip: !native, timeout: 25000 }, async () => {
  const f = await fixture(), launch = request(f.fence);
  try {
    const holder = await probe("claim-only", launch); await holder.closed; await holder.dispose();
    await assert.rejects(launcher.launch(launch));
    assert.deepEqual(await sealWindowsWorkerLaunch(f.fence, launch.workerProcessId, signal(), options),
      { state: "lost", sealed: true, reason: "sealed_launch_job_absent" });
  } finally { await f.dispose(); }
});

it("recovery cannot overtake native creation and can reconcile a killed pre-journal owner", { skip: !native, timeout: 30000 }, async () => {
  const f = await fixture(), launch = request(f.fence); let holder: Awaited<ReturnType<typeof probe>> | undefined;
  try {
    holder = await probe("hold-created-root", launch); assert.ok(holder.ready.processId); report(holder.ready.processId, "suspended pre-journal root");
    assert.deepEqual(await sealWindowsWorkerLaunch(f.fence, launch.workerProcessId, signal(), options), { state: "unconfirmed" });
    assert.doesNotThrow(() => process.kill(holder!.ready.processId!, 0));
    await holder.dispose(); await gone(holder.ready.processId);
    assert.deepEqual(await sealWindowsWorkerLaunch(f.fence, launch.workerProcessId, signal(), options),
      { state: "lost", sealed: true, reason: "sealed_launch_job_absent" });
    await assert.rejects(launcher.launch(launch));
  } finally { await holder?.dispose(); await f.dispose(); }
});

it("sealing a running unjournaled root stops its exact owned tree", { skip: !native, timeout: 25000 }, async () => {
  const f = await fixture(), launch = request(f.fence); let worker: OwnedWorker | undefined;
  try {
    worker = await launcher.launch(launch); worker.release(JSON.stringify({ mode: "hold" }));
    const observed = await sealWindowsWorkerLaunch(f.fence, launch.workerProcessId, signal(), options);
    assert.equal(observed.state, "terminated");
    assert.equal(observed.sealed, true); assert.equal(observed.root?.processId, worker.processId); assert.equal(observed.exitCode, 137);
    await worker.closed; await gone(worker.processId);
  } finally { await cleanup(worker); await f.dispose(); }
});

it("wrong scope or directory identity cannot seal a healthy owner", { skip: !native, timeout: 30000 }, async () => {
  const f = await fixture(), launch = request(f.fence); let worker: OwnedWorker | undefined;
  try {
    worker = await launcher.launch(launch);
    const wrong = [ { ...f.fence, directoryIdentity: "win32-dir:00000000:0000000000000000" },
      { ...f.fence, scope: { ...f.fence.scope, sessionId: f.fence.scope.sessionId + 1 } } ];
    for (const identity of wrong) assert.deepEqual(await sealWindowsWorkerLaunch(identity, launch.workerProcessId, signal(), options), { state: "unconfirmed" });
    worker.release(JSON.stringify({ text: "still authorized" }));
    const result = await worker.closed; assert.equal(result.failed, false); assert.equal(JSON.parse(result.output).text, "still authorized");
  } finally { await cleanup(worker); await f.dispose(); }
});

it("malformed and partially appended files never become reusable or absence evidence", { skip: !native, timeout: 30000 }, async () => {
  const f = await fixture(), launch = request(f.fence);
  try {
    const holder = await probe("claim-only", launch); await holder.closed; await holder.dispose();
    await appendFile(join(f.directory, launch.workerProcessId + ".launch"), "root\t123");
    await assert.rejects(launcher.launch(launch));
    assert.deepEqual(await sealWindowsWorkerLaunch(f.fence, launch.workerProcessId, signal(), options), { state: "unconfirmed" });
    const second = request(f.fence);
    await writeFile(join(f.directory, second.workerProcessId + ".launch"), "broken");
    await assert.rejects(launcher.launch(second));
  } finally { await f.dispose(); }
});

it("recreated or redirected seal directories and hard-linked files fail closed", { skip: !native, timeout: 30000 }, async () => {
  const f = await fixture(), launch = request(f.fence);
  try {
    const old = join(f.root, "original"); await rename(f.directory, old); await mkdir(f.directory);
    assert.deepEqual(await sealWindowsWorkerLaunch(f.fence, launch.workerProcessId, signal(), options), { state: "unconfirmed" });
    await assert.rejects(launcher.launch(launch)); assert.deepEqual(await readdir(f.directory), []);
    const redirected = join(f.root, "redirected"); await symlink(old, redirected, "junction");
    await assert.rejects(describeWindowsLaunchFence(redirected, signal(), options));
    const current = await describeWindowsLaunchFence(f.directory, signal(), options), other = request(current);
    const source = join(f.directory, "source"); await writeFile(source, "");
    await link(source, join(f.directory, other.workerProcessId + ".launch"));
    await assert.rejects(launcher.launch(other)); assert.equal((await readFile(source)).length, 0);
  } finally { await f.dispose(); }
});

it("pure launch-directory anchors deny rename before a fence file exists and release without reserving children",{ skip:!native,timeout:25000 },async()=>{
  const f=await fixture(),ancestor=join(f.root,"empty-ancestor"),directory=join(ancestor,"empty-fence");
  let holder:Awaited<ReturnType<typeof probe>>|undefined;
  try {
    await mkdir(directory,{ recursive:true });
    const descriptor=await describeWindowsLaunchFence(directory,signal(),options);
    holder=await probe("hold-directory-only",request(descriptor));
    assert.deepEqual(await readdir(directory),[]);
    for(const source of [directory,ancestor]) {
      await assert.rejects(rename(source,source+"-moved"),/EPERM|EBUSY|EACCES/u);
      assert.equal((await stat(source)).isDirectory(),true); await assert.rejects(stat(source+"-moved"),{ code:"ENOENT" });
    }
    await mkdir(join(directory,"child-creation-is-not-reserved"));
    assert.equal((await stat(join(directory,"child-creation-is-not-reserved"))).isDirectory(),true);
    await holder.dispose(); await gone(holder.child.pid!); holder=undefined;
    await rename(directory,directory+"-released"); await rename(directory+"-released",directory);
    await rename(ancestor,ancestor+"-released"); await rename(ancestor+"-released",ancestor);
  } finally { await holder?.dispose(); await f.dispose(); }
});

it("held permanent launch fences keep their directory and ancestor spelling until closure",{ skip:!native,timeout:25000 },async()=>{
  const f=await fixture(),ancestor=join(f.root,"held-ancestor"),directory=join(ancestor,"held-fence");
  let holder:Awaited<ReturnType<typeof probe>>|undefined;
  try {
    await mkdir(directory,{ recursive:true });
    const descriptor=await describeWindowsLaunchFence(directory,signal(),options),launch=request(descriptor);
    holder=await probe("hold-fence",launch);
    for(const source of [directory,ancestor]) {
      await assert.rejects(rename(source,source+"-moved"),/EPERM|EBUSY|EACCES/u);
      assert.equal((await stat(source)).isDirectory(),true); await assert.rejects(stat(source+"-moved"),{ code:"ENOENT" });
    }
    await holder.dispose(); await gone(holder.child.pid!); holder=undefined;
    assert.match(await readFile(join(directory,launch.workerProcessId+".launch"),"utf8"),/\nclaimed\n$/u);
    assert.deepEqual(await sealWindowsWorkerLaunch(descriptor,launch.workerProcessId,signal(),options),{ state:"lost",sealed:true,reason:"sealed_launch_job_absent" });
    await assert.rejects(launcher.launch(launch));
    await rename(directory,directory+"-released"); await rename(directory+"-released",directory);
  } finally { await holder?.dispose(); await f.dispose(); }
});
