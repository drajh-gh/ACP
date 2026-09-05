import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import { parseStableId, type StableId } from "@acp/domain";
import { parseWindowsLaunchFence, type WindowsLaunchFenceDescriptor } from "@acp/storage";
import { minimalCodexEnvironment } from "./codex-sdk-transport.ts";
export { parseWindowsLaunchFence, type WindowsLaunchFenceDescriptor } from "@acp/storage";
export type WindowsLaunchObservation = { readonly state: "unconfirmed" } | {
  readonly state: "lost" | "terminated";
  readonly sealed: true;
  readonly reason: string;
  readonly exitCode?: number;
  readonly root?: { readonly processId: number; readonly processStartToken: string; readonly startedAt: string };
};
export interface WindowsLaunchFenceOptions {
  readonly onSpawn?: (pid: number, purpose: string) => void;
}

/** Read-only identity of an existing trusted, non-synced, non-model-writable directory. */
export async function describeWindowsLaunchFence(directory: string, signal: AbortSignal,
  options: WindowsLaunchFenceOptions = {}): Promise<WindowsLaunchFenceDescriptor> {
  if (!isAbsolute(directory)) throw new Error("absolute launch fence directory required");
  const result = await helper({ operation: "describe", directory: resolve(directory) }, signal, options);
  return parseWindowsLaunchFence(result);
}

/** Sealing is irreversible and precedes observation; unknown stop evidence remains pending. */
export async function sealWindowsWorkerLaunch(fence: WindowsLaunchFenceDescriptor, workerProcessId: StableId<"workerProcess">,
  signal: AbortSignal, options: WindowsLaunchFenceOptions = {}): Promise<WindowsLaunchObservation> {
  const descriptor = parseWindowsLaunchFence(fence); parseStableId(workerProcessId, "workerProcess");
  const value = await helper({ operation: "seal", fence: descriptor, workerProcessId,
    deadlineAt: new Date(Date.now() + 11000).toISOString() }, signal, options);
  if (typeof value !== "object" || value === null) return { state: "unconfirmed" };
  const result = value as Record<string, unknown>;
  if (result.sealed !== true) return { state: "unconfirmed" };
  const lostReasons = ["sealed_launch_job_absent", "sealed_launch_job_empty", "owned_job_and_original_root_absent", "owned_job_empty"];
  if (!(result.state === "lost" && result.exitCode === null && lostReasons.includes(result.reason as string))
      && !(result.state === "terminated" && result.reason === "exact_owned_tree_terminated" && Number.isSafeInteger(result.exitCode))) {
    return { state: "unconfirmed" };
  }
  let root: { processId: number; processStartToken: string; startedAt: string } | undefined;
  if (result.root !== null) {
    const input = result.root as Record<string, unknown> | undefined;
    if (!input || !Number.isSafeInteger(input.processId) || (input.processId as number) < 1
        || typeof input.processStartToken !== "string" || !/^win32-filetime:[0-9]{16,20}$/u.test(input.processStartToken)
        || typeof input.startedAt !== "string" || !Number.isFinite(Date.parse(input.startedAt))) return { state: "unconfirmed" };
    root = { processId: input.processId as number, processStartToken: input.processStartToken, startedAt: input.startedAt };
  }
  if ((result.state === "terminated" || !(result.reason as string).startsWith("sealed_launch_")) && root === undefined) return { state: "unconfirmed" };
  return { state: result.state as "lost" | "terminated", sealed: true, reason: result.reason as string,
    ...(root === undefined ? {} : { root }), ...(result.state === "terminated" ? { exitCode: result.exitCode as number } : {}) };
}

async function helper(input: object, signal: AbortSignal, options: WindowsLaunchFenceOptions): Promise<unknown> {
  if (process.platform !== "win32" || signal.aborted) return { state: "unconfirmed" };
  const frame = JSON.stringify(input);
  if (Buffer.byteLength(frame) > 8192) throw new Error("launch fence request too large");
  const child = spawn("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File",
    fileURLToPath(new URL("../native/windows-worker-fence.ps1", import.meta.url))],
  { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: minimalCodexEnvironment() });
  if (child.pid) try { options.onSpawn?.(child.pid, "ACP native launch-fence helper"); } catch {}
  return new Promise((resolveResult) => {
    const output: Buffer[] = []; let bytes = 0, invalid = false;
    const stop = () => { invalid = true; child.kill(); };
    const timer = setTimeout(stop, 12000);
    signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop();
    child.stdin.on("error", stop); child.on("error", () => { invalid = true; });
    child.stdout.on("data", (data: Buffer) => { bytes += data.length; if (bytes > 8192) stop(); else output.push(data); });
    child.stderr.on("data", (data: Buffer) => { bytes += data.length; if (bytes > 8192) stop(); });
    child.on("close", (code) => {
      clearTimeout(timer); signal.removeEventListener("abort", stop);
      if (!invalid && code === 0) try { resolveResult(JSON.parse(Buffer.concat(output).toString("utf8"))); return; } catch {}
      resolveResult({ state: "unconfirmed" });
    });
    child.stdin.end(frame + "\n");
  });
}
