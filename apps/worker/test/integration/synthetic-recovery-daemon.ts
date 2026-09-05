// Sacrificial owner: parent persists this exact identity before releasing it.
import { fileURLToPath } from "node:url";
import { parseStableId } from "@acp/domain";
import { WindowsWorkerLauncher } from "../../src/windows-worker-launcher.ts";
const workerProcessId = parseStableId(process.argv[2], "workerProcess");
const deadlineAt = process.argv[3]!;
const launcher = new WindowsWorkerLauncher({ runnerPath: fileURLToPath(new URL("./nonreading-owned-runner.ts", import.meta.url)),
  onSpawn: (identity) => process.send?.({ type: "spawn", ...identity }) });
const worker = await launcher.launch({ workerProcessId, deadlineAt, workspace: process.cwd(), maximumOutputBytes: 4096,
  signal: new AbortController().signal });
process.send?.({ type: "ready", processId: worker.processId, processStartToken: worker.processStartToken,
  startedAt: worker.startedAt, scope: worker.scope });
process.once("message", (message) => { if (message === "go") { worker.release("x".repeat(250000)); process.send?.({ type: "released" }); } });
await worker.closed;
