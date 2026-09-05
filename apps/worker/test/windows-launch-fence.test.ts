import assert from "node:assert/strict";
import { it } from "node:test";
import { createStableId } from "@acp/domain";
import { describeWindowsLaunchFence, parseWindowsLaunchFence, sealWindowsWorkerLaunch } from "../src/windows-launch-fence.ts";

const descriptor = { directory: "C:\\ACP\\seals ž 🚀", directoryIdentity: "win32-dir:12345678:0123456789abcdef",
  scope: { machineFingerprint: "a".repeat(64), bootedAt: "2026-09-01T00:00:00.000Z", sessionId: 1 } };
it("launch fence descriptors pin the directory file identity and exact OS namespace", () => {
  assert.deepEqual(parseWindowsLaunchFence(descriptor), descriptor);
  for (const value of [undefined, null, [], {}, { ...descriptor, extra: true }, { ...descriptor, directoryIdentity: "same-path" },
    { ...descriptor, scope: { ...descriptor.scope, bootedAt: "invalid" } }]) assert.throws(() => parseWindowsLaunchFence(value));
});
it("launch fence descriptors reject relative, network, drive-root and control-character locations", () => {
  for (const directory of ["seals", "\\seals", "C:seals", "C:\\", "C:\\ACP\\..\\", "\\\\server\\seals", "C:\\ACP\\\u0000seals"])
    assert.throws(() => parseWindowsLaunchFence({ ...descriptor, directory }));
});
it("cancelled seal requests never spawn helpers and relative description requests are rejected", async () => {
  const controller = new AbortController(); controller.abort(); let spawned = false;
  assert.deepEqual(await sealWindowsWorkerLaunch(descriptor, createStableId("workerProcess"), controller.signal,
    { onSpawn: () => { spawned = true; } }), { state: "unconfirmed" });
  assert.equal(spawned, false);
  await assert.rejects(describeWindowsLaunchFence("relative", controller.signal), /absolute/);
});
