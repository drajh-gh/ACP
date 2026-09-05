import { fileURLToPath } from "node:url";
import { createStableId } from "@acp/domain";
import { WindowsWorkerLauncher } from "../../src/windows-worker-launcher.ts";
const launcher = new WindowsWorkerLauncher({
  runnerPath: fileURLToPath(new URL("./nonreading-owned-runner.ts", import.meta.url)),
  onSpawn: (identity) => process.send?.(identity),
});
const worker = await launcher.launch({ workerProcessId: createStableId("workerProcess"),
  deadlineAt: new Date(Date.now() + 12000).toISOString(), workspace: process.cwd(),
  maximumOutputBytes: 4096, signal: new AbortController().signal });
worker.release("x".repeat(250000));
process.send?.({ ready: true });
await worker.closed;
