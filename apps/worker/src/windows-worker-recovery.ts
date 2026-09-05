import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseStableId } from "@acp/domain";
import type { WorkerProcessRecord } from "@acp/storage";
import { minimalCodexEnvironment } from "./codex-sdk-transport.ts";
import { parseWindowsSupervisionScope } from "./windows-worker-launcher.ts";

export type WorkerTreeObservation =
  | { readonly state: "unconfirmed" }
  | { readonly state: "lost"; readonly reason: string }
  | { readonly state: "terminated"; readonly reason: string; readonly exitCode: number };
export interface WorkerTreeInspector {
  stop(process: WorkerProcessRecord, signal: AbortSignal): Promise<WorkerTreeObservation>;
}

/** Same-installation, boot-aware, session-aware inspector; never kills by PID. */
export class WindowsWorkerTreeInspector implements WorkerTreeInspector {
  constructor(privateOptions: { readonly onSpawn?: (pid: number, purpose: string) => void } = {}) { this.options = privateOptions; }
  private readonly options: { readonly onSpawn?: (pid: number, purpose: string) => void };
  async stop(record: WorkerProcessRecord, signal: AbortSignal): Promise<WorkerTreeObservation> {
    if (process.platform !== "win32" || record.supervision?.kind !== "windows_job" || record.supervision.scope === undefined) return { state: "unconfirmed" };
    parseStableId(record.workerProcessId, "workerProcess");
    const scope = parseWindowsSupervisionScope(record.supervision.scope);
    if (record.supervision.treeIdentifier !== `Local\\ACP.Worker.${record.workerProcessId}`
        || !Number.isSafeInteger(record.processId) || record.processId < 1 || record.processId > 2147483647
        || !/^win32-filetime:[0-9]{16,20}$/u.test(record.processStartToken)) throw new Error("invalid process recovery identity");
    if (signal.aborted) return { state: "unconfirmed" };
    const child = spawn("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File",
      fileURLToPath(new URL("../native/windows-worker-recover.ps1", import.meta.url))],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: minimalCodexEnvironment() });
    if (child.pid) { try { this.options.onSpawn?.(child.pid, "ACP exact-tree recovery inspector"); } catch {} }
    return await new Promise<WorkerTreeObservation>((resolve) => {
      let output = "", bytes = 0, invalid = false;
      const stop = () => { invalid = true; child.kill(); };
      const timer = setTimeout(stop, 12000);
      signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop();
      child.stdin.on("error", stop);
      child.on("error", () => { invalid = true; });
      child.stdout.on("data", (data: Buffer) => { bytes += data.length; if (bytes > 4096) stop(); else output += data.toString("utf8"); });
      child.stderr.on("data", (data: Buffer) => { bytes += data.length; if (bytes > 4096) stop(); });
      child.on("close", (code) => {
        clearTimeout(timer); signal.removeEventListener("abort", stop);
        if (!invalid && code === 0) try {
          const value = JSON.parse(output) as Record<string, unknown>;
          if (value.state === "lost" && ["owned_job_and_original_root_absent", "owned_job_empty"].includes(value.reason as string)
              && value.exitCode === null) { resolve({ state: "lost", reason: value.reason as string }); return; }
          if (value.state === "terminated" && value.reason === "exact_owned_tree_terminated" && Number.isSafeInteger(value.exitCode)) {
            resolve({ state: "terminated", reason: value.reason, exitCode: value.exitCode as number }); return;
          }
        } catch {}
        resolve({ state: "unconfirmed" });
      });
      child.stdin.end(JSON.stringify({ workerProcessId: record.workerProcessId, treeIdentifier: record.supervision!.treeIdentifier,
        processId: record.processId, processStartToken: record.processStartToken, scope,
        deadlineAt: new Date(Date.now() + 11000).toISOString() }) + "\n");
    });
  }
}
