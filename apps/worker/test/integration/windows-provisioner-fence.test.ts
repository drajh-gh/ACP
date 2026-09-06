import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, link, mkdir, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { createStableId } from "@acp/domain";
import { describeWindowsProvisionerFence, sealWindowsProvisionerAttempt, sealWindowsWorkerLaunch, type WindowsProvisionerFenceDescriptor } from "../../src/windows-launch-fence.ts";
import { minimalCodexEnvironment } from "../../src/codex-sdk-transport.ts";

const pids = new Set<number>(), native = process.platform === "win32";
const signal = () => new AbortController().signal;
const report = (pid: number, purpose: string) => { pids.add(pid); process.stdout.write(`Owned PID ${pid}: ${purpose}\n`); };
const options = { onSpawn: report };
async function gone(pid: number) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { pids.delete(pid); return; } throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Owned PID ${pid} did not exit`);
}
async function fixture() {
  const owner = process.env.ACP_TEST_NATIVE_CHANNEL_ROOT; assert.ok(owner && isAbsolute(owner), "owned fixture root required");
  const root = await mkdtemp(join(owner, "case-")), directory = join(root, "provision ž 🚀"); await mkdir(directory);
  const fence = await describeWindowsProvisionerFence(directory, signal(), options), attemptId = createStableId("worktreeProvisionerAttempt");
  return { root, directory, fence, attemptId, file: join(directory, attemptId + ".provision"),
    async dispose() { for (const pid of [...pids]) await gone(pid); assert.equal(pids.size, 0); } };
}
async function probe(operation: string, f: { fence: WindowsProvisionerFenceDescriptor; attemptId: string }) {
  const child = spawn("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", fileURLToPath(new URL("./synthetic-provisioner-fence-holder.ps1", import.meta.url))],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: minimalCodexEnvironment() });
  assert.ok(child.pid); report(child.pid, `synthetic provisioner ${operation}`);
  const closed = once(child, "close"); child.stdin.on("error", () => {}); child.stderr.resume();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const timer = setTimeout(() => child.kill(), 20000);
  const dispose = async () => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; await gone(child.pid!); };
  child.stdin.write(JSON.stringify({ operation, fence: f.fence, attemptId: f.attemptId,
    executable: process.execPath, arguments: ["--experimental-strip-types", fileURLToPath(new URL("./synthetic-provisioner-fence-runner.ts", import.meta.url))],
    workspace: process.cwd(), deadlineAt: new Date(Date.now() + 15000).toISOString(),
    environment: Object.entries(minimalCodexEnvironment()).map(([key, value]) => `${key}=${value}`) }) + "\n");
  try {
    const line = await lines.next(); assert.equal(line.done, false); assert.ok(line.value.length <= 1024);
    const ready = JSON.parse(line.value) as { ready: boolean; processId?: number; childId?: number };
    if (ready.processId) report(ready.processId, "synthetic provisioner root"); if (ready.childId) report(ready.childId, "synthetic provisioner descendant");
    return { ready, closed, dispose, async resume() { child.stdin.write("resume\n"); const line = await lines.next(); assert.equal(line.done, false); return JSON.parse(line.value) as { resumeDenied: boolean; rootWasLive: boolean; deadlineExpired: boolean }; } };
  } catch (error) { await dispose(); throw error; }
}

it("provisioner core: unused seals are permanent, idempotent and separate from worker identities", { skip: !native, timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const result = await sealWindowsProvisionerAttempt(f.fence, f.attemptId, signal(), options);
    assert.deepEqual(result, { state: "lost", sealed: true, reason: "sealed_launch_job_absent" });
    const before = await readFile(f.file, "utf8"); assert.match(before, /^ACP-PROVISIONER-FENCE-1\nwpa_/u); assert.match(before, /\nsealed\n$/u);
    assert.deepEqual(await sealWindowsProvisionerAttempt(f.fence, f.attemptId, signal(), options), result);
    const late = await probe("claim-only", f); try { assert.equal(late.ready.ready, false); } finally { await late.dispose(); }
    await assert.rejects(sealWindowsWorkerLaunch(f.fence as never, f.attemptId as never, signal(), options));
    assert.deepEqual(await readdir(f.directory), [f.attemptId + ".provision"]); assert.equal(await readFile(f.file, "utf8"), before);
  } finally { await f.dispose(); }
});
it("provisioner core: consumed attempts cannot create another root and worker IDs cannot enter the native namespace", { skip: !native, timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const first = await probe("claim-only", f); try { assert.equal(first.ready.ready, true); await first.closed; } finally { await first.dispose(); }
    const duplicate = await probe("hold-root", f); try { assert.equal(duplicate.ready.ready, false); } finally { await duplicate.dispose(); }
    const wrong = await probe("claim-only", { ...f, attemptId: createStableId("workerProcess") }); try { assert.equal(wrong.ready.ready, false); } finally { await wrong.dispose(); }
    assert.deepEqual(await readdir(f.directory), [f.attemptId + ".provision"]);
    assert.equal((await sealWindowsProvisionerAttempt(f.fence, f.attemptId, signal(), options)).state, "lost");
  } finally { await f.dispose(); }
});
it("provisioner core: a seal alone denies delayed resume while the exact suspended root remains alive", { skip: !native, timeout: 20000 }, async () => {
  const f = await fixture(); let held: Awaited<ReturnType<typeof probe>> | undefined;
  try {
    held = await probe("hold-root", f); assert.equal(held.ready.ready, true); assert.ok(held.ready.processId);
    const sealer = await probe("seal-only", f); try { assert.equal(sealer.ready.ready, true); await sealer.closed; } finally { await sealer.dispose(); }
    assert.doesNotThrow(() => process.kill(held!.ready.processId!, 0));
    assert.deepEqual(await held.resume(), { resumeDenied: true, rootWasLive: true, deadlineExpired: false }); await held.closed;
    await gone(held.ready.processId);
    assert.match(await readFile(f.file, "utf8"), /\nsealed\n$/u);
  } finally { await held?.dispose(); await f.dispose(); }
});
it("provisioner core: confirmed sealed closure includes the running root and actual descendant", { skip: !native, timeout: 20000 }, async () => {
  const f = await fixture(); let held: Awaited<ReturnType<typeof probe>> | undefined;
  try {
    held = await probe("hold-tree", f); assert.equal(held.ready.ready, true); assert.ok(held.ready.processId); assert.ok(held.ready.childId);
    const stopped = await sealWindowsProvisionerAttempt(f.fence, f.attemptId, signal(), options);
    assert.equal(stopped.state, "terminated"); assert.equal(stopped.exitCode, 137);
    await gone(held.ready.processId); await gone(held.ready.childId);
    assert.match(await readFile(f.file, "utf8"), /\nsealed\n$/u);
  } finally { await held?.dispose(); await f.dispose(); }
});
it("provisioner safety: helper death before root recording leaves no process and cannot revive a consumed attempt", { skip: !native, timeout: 25000 }, async () => {
  const f = await fixture(); let held: Awaited<ReturnType<typeof probe>> | undefined;
  try {
    held = await probe("hold-before-record", f); assert.equal(held.ready.ready, true); assert.ok(held.ready.processId);
    assert.deepEqual(await sealWindowsProvisionerAttempt(f.fence, f.attemptId, signal(), options), { state: "unconfirmed" });
    await held.dispose(); await gone(held.ready.processId);
    assert.deepEqual(await sealWindowsProvisionerAttempt(f.fence, f.attemptId, signal(), options), { state: "lost", sealed: true, reason: "sealed_launch_job_absent" });
    const late = await probe("hold-root", f); try { assert.equal(late.ready.ready, false); } finally { await late.dispose(); }
  } finally { await held?.dispose(); await f.dispose(); }
});
it("provisioner safety: a live named job with no recorded root remains unconfirmed after sealing", { skip: !native, timeout: 20000 }, async () => {
  const f = await fixture(); let held: Awaited<ReturnType<typeof probe>> | undefined;
  try {
    held = await probe("hold-unrecorded", f); assert.equal(held.ready.ready, true); assert.ok(held.ready.processId);
    assert.deepEqual(await sealWindowsProvisionerAttempt(f.fence, f.attemptId, signal(), options), { state: "unconfirmed" });
    assert.doesNotThrow(() => process.kill(held!.ready.processId!, 0)); assert.match(await readFile(f.file, "utf8"), /\nsealed\n$/u);
    await held.dispose(); await gone(held.ready.processId);
    assert.equal((await sealWindowsProvisionerAttempt(f.fence, f.attemptId, signal(), options)).state, "lost");
  } finally { await held?.dispose(); await f.dispose(); }
});
it("provisioner safety: wrong observed scope or replaced directory cannot seal a healthy exact owner", { skip: !native, timeout: 25000 }, async () => {
  const f = await fixture(); let held: Awaited<ReturnType<typeof probe>> | undefined;
  try {
    held = await probe("hold-root", f); assert.equal(held.ready.ready, true); assert.ok(held.ready.processId);
    for (const fence of [{ ...f.fence, directoryIdentity: "win32-dir:00000000:0000000000000000" },
      { ...f.fence, scope: { ...f.fence.scope, sessionId: f.fence.scope.sessionId + 1 } }]) {
      assert.deepEqual(await sealWindowsProvisionerAttempt(fence, f.attemptId, signal(), options), { state: "unconfirmed" });
    }
    await rename(f.directory, join(f.root, "old")); await mkdir(f.directory);
    assert.deepEqual(await sealWindowsProvisionerAttempt(f.fence, f.attemptId, signal(), options), { state: "unconfirmed" });
    assert.doesNotThrow(() => process.kill(held!.ready.processId!, 0));
  } finally { await held?.dispose(); await f.dispose(); }
});
it("provisioner safety: malformed, cross-format and hardlinked files never become absence or reuse evidence", { skip: !native, timeout: 25000 }, async () => {
  const f = await fixture();
  try {
    const held = await probe("claim-only", f); try { assert.equal(held.ready.ready, true); await held.closed; } finally { await held.dispose(); }
    await appendFile(f.file, "root\t123");
    assert.deepEqual(await sealWindowsProvisionerAttempt(f.fence, f.attemptId, signal(), options), { state: "unconfirmed" });
    const crossId = createStableId("worktreeProvisionerAttempt"), crossFile = join(f.directory, crossId + ".provision");
    await writeFile(crossFile, "ACP-LAUNCH-FENCE-1\n" + crossId + "\n");
    assert.deepEqual(await sealWindowsProvisionerAttempt(f.fence, crossId, signal(), options), { state: "unconfirmed" });
    const linkedId = createStableId("worktreeProvisionerAttempt"), linkedFile = join(f.directory, linkedId + ".provision");
    await writeFile(linkedFile, ""); await link(linkedFile, join(f.root, "hardlinked"));
    assert.deepEqual(await sealWindowsProvisionerAttempt(f.fence, linkedId, signal(), options), { state: "unconfirmed" });
  } finally { await f.dispose(); }
});
