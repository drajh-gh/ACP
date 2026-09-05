import { parseContextPacket } from "@acp/domain";
import { CodexSdkWorkerTransport } from "./codex-sdk-transport.ts";
import type { WorkerTransportRequest } from "./worker-manager.ts";

// Trusted entry point only. Input is private IPC from the supervisor, not argv
// or a project file. There is no database connection or effect credential here.
async function main(): Promise<void> {
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk as Uint8Array); total += bytes.length;
    if (total > 524_288) throw new Error("worker IPC input exceeds limit");
    chunks.push(bytes);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Omit<WorkerTransportRequest, "signal">;
  const packet = parseContextPacket(input.packet);
  const controller = new AbortController();
  const remaining = Date.parse(input.execution.timeoutAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > packet.limits.wallTimeMs) throw new Error("worker deadline invalid");
  const deadline = setTimeout(() => controller.abort(new Error("persisted worker deadline elapsed")), remaining);
  try {
    const output = await new CodexSdkWorkerTransport().run({ ...input, packet, signal: controller.signal });
    const json = JSON.stringify(output);
    if (Buffer.byteLength(json) > packet.limits.maximumOutputBytes) throw new Error("worker output exceeds limit");
    process.stdout.write(json);
  } finally { clearTimeout(deadline); }
}
main().catch(() => { process.exitCode = 1; }); // Never print private input/errors.
