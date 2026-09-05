import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseStableId, type StableId } from "@acp/domain";
import { minimalCodexEnvironment } from "./codex-sdk-transport.ts";
import { WorkerTerminationUnconfirmedError } from "./worker-manager.ts";
import type { WindowsSupervisionScope } from "@acp/storage";
import type { WindowsLaunchFenceDescriptor } from "./windows-launch-fence.ts";

export interface OwnedWorkerExit {
  /** Present only after an intent-mode bridge durably sealed its exact root. */
  readonly launchSealed?: true;
  readonly treeEmpty: true;
  readonly exitCode: number;
  readonly terminated: boolean;
  readonly failed: boolean;
  readonly output: string;
}
export interface OwnedWorker {
  readonly scope: WindowsSupervisionScope;
  readonly processId: number;
  readonly processStartToken: string;
  readonly startedAt: string;
  readonly closed: Promise<OwnedWorkerExit>;
  release(input: string): void;
  terminate(): Promise<OwnedWorkerExit>;
}
export interface WorkerLaunchRequest {
  readonly workerProcessId: StableId<"workerProcess">;
  readonly deadlineAt: string;
  readonly workspace: string;
  readonly maximumOutputBytes: number;
  readonly signal: AbortSignal;
  /** Must first be bound to a durable launch intent; legacy callers omit it. */
  readonly launchFence?: WindowsLaunchFenceDescriptor;
}
export interface WorkerLauncher { launch(request: WorkerLaunchRequest): Promise<OwnedWorker>; }
export interface WindowsWorkerLauncherOptions {
  /** Trusted configuration, never a model-selected command or packet field. */
  readonly runnerPath?: string;
  readonly powershellExecutable?: string;
  readonly onSpawn?: (process: { readonly processId: number; readonly purpose: string }) => void;
}

/** Windows 10+ / PowerShell 7; no unowned create→attach window or PID-only kill. */
export class WindowsWorkerLauncher implements WorkerLauncher {
  private readonly options: WindowsWorkerLauncherOptions;
  constructor(options: WindowsWorkerLauncherOptions = {}) { this.options = options; }

  async launch(request: WorkerLaunchRequest): Promise<OwnedWorker> {
    if (process.platform !== "win32") throw new Error("Windows worker launcher is unavailable on this host");
    parseStableId(request.workerProcessId, "workerProcess");
    const remaining = Date.parse(request.deadlineAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 86_400_000) throw new Error("invalid persisted worker deadline");
    if (!Number.isSafeInteger(request.maximumOutputBytes) || request.maximumOutputBytes < 1 || request.maximumOutputBytes > 1_048_576) {
      throw new Error("worker output bound must be 1 to 1048576 bytes");
    }
    if (request.signal.aborted) throw new Error("worker launch already cancelled");
    if (!isAbsolute(request.workspace) || !(await stat(request.workspace)).isDirectory()) throw new Error("worker workspace must be an existing absolute directory");
    if (request.signal.aborted) throw new Error("worker launch already cancelled");
    const environment = minimalCodexEnvironment();
    const reportSpawn = (identity: { processId: number; purpose: string }) => {
      // Observability hooks must not interrupt ownership setup or cleanup.
      try { this.options.onSpawn?.(identity); } catch { /* best-effort telemetry */ }
    };
    const bridge = spawn(this.options.powershellExecutable ?? "pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive",
      "-File", fileURLToPath(new URL("../native/windows-worker-host.ps1", import.meta.url))],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: environment });
    if (bridge.pid !== undefined) reportSpawn({ processId: bridge.pid, purpose: "ACP Windows owned-worker bridge" });
    const ready = Promise.withResolvers<Omit<OwnedWorker, "closed" | "release" | "terminate">>();
    const completion = Promise.withResolvers<OwnedWorkerExit>();
    void ready.promise.catch(() => {}); void completion.promise.catch(() => {});
    const chunks: Buffer[] = [];
    let outputBytes = 0, errorBytes = 0;
    let released = false, stopping = false, receivedReady = false, ended = false;
    let evidence: Omit<OwnedWorkerExit, "output"> | undefined;
    let failureDiagnostic: unknown;
    let protocolFailed = false;
    let forceStop: NodeJS.Timeout | undefined;
    const decoder = new StringDecoder("utf8"); let buffered = "";
    const send = (frame: unknown) => {
      if (!ended && !bridge.stdin.destroyed) bridge.stdin.write(JSON.stringify(frame) + "\n");
    };
    const stop = () => {
      if (stopping || ended) return;
      stopping = true; send({ type: "stop" }); bridge.stdin.end();
      // Last bridge-handle close kills the kernel-owned job. Without an explicit
      // tree-empty frame this remains unconfirmed in the durable journal.
      forceStop = setTimeout(() => { if (!ended) bridge.kill(); }, 6_000);
    };
    const deadline = setTimeout(stop, Math.max(0, Date.parse(request.deadlineAt) - Date.now()));
    request.signal.addEventListener("abort", stop, { once: true });
    if (request.signal.aborted) stop();
    bridge.stdin.on("error", () => { stop(); });
    bridge.stderr.on("data", (data: Buffer) => { errorBytes += data.length; if (errorBytes > 65_536) stop(); });
    bridge.on("error", (error) => { ready.reject(error); completion.reject(error); });
    bridge.stdout.on("data", (data: Buffer) => {
      try {
        buffered += decoder.write(data);
        let newline: number;
        while ((newline = buffered.indexOf("\n")) >= 0) {
          if (newline > 65_536) throw new Error("oversized native control frame");
          const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
          const frame = JSON.parse(line) as Record<string, unknown>;
          if (frame.type === "ready" && !receivedReady && !evidence) {
            if (!Number.isSafeInteger(frame.processId) || (frame.processId as number) < 1
                || typeof frame.processStartToken !== "string" || !/^win32-filetime:[0-9]{16,20}$/u.test(frame.processStartToken)
                || typeof frame.startedAt !== "string" || !Number.isFinite(Date.parse(frame.startedAt))) throw new Error("invalid native identity");
            const scope = parseWindowsSupervisionScope(frame.scope);
            receivedReady = true;
            reportSpawn({ processId: frame.processId as number, purpose: "ACP suspended SDK runner" });
            ready.resolve({ scope, processId: frame.processId as number, processStartToken: frame.processStartToken,
              startedAt: new Date(frame.startedAt).toISOString() });
          } else if (frame.type === "output" && receivedReady && !evidence && typeof frame.data === "string") {
            if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(frame.data)) throw new Error("invalid native output encoding");
            const bytes = Buffer.from(frame.data, "base64"); outputBytes += bytes.length;
            if (outputBytes > request.maximumOutputBytes) throw new Error("oversized worker output");
            chunks.push(bytes);
          } else if (frame.type === "closed" && receivedReady && !evidence && frame.treeEmpty === true
              && (request.launchFence === undefined || frame.launchSealed === true)
              && Number.isSafeInteger(frame.exitCode) && typeof frame.terminated === "boolean") {
            evidence = { treeEmpty: true, exitCode: frame.exitCode as number, terminated: frame.terminated, failed: protocolFailed,
              ...(request.launchFence === undefined ? {} : { launchSealed: true }) };
          } else if (frame.type === "failure" && !evidence) {
            failureDiagnostic = { stage: frame.stage, code: frame.errorCode, line: frame.scriptLine };
            if (frame.treeEmpty === true && (request.launchFence === undefined || frame.launchSealed === true)) {
              evidence = { treeEmpty: true, exitCode: 137, terminated: true, failed: true,
                ...(request.launchFence === undefined ? {} : { launchSealed: true }) };
            }
            if (!receivedReady) {
              const error = evidence ? new Error("native worker launch failed") : new WorkerTerminationUnconfirmedError();
              error.cause = failureDiagnostic;
              ready.reject(error);
            }
          } else throw new Error("invalid native control transition");
        }
        if (buffered.length > 65_536) throw new Error("oversized native control frame");
      } catch { protocolFailed = true; evidence = undefined; stop(); }
    });
    bridge.on("close", () => {
      ended = true; clearTimeout(deadline); if (forceStop) clearTimeout(forceStop);
      request.signal.removeEventListener("abort", stop);
      if (evidence && buffered.trim() === "") completion.resolve({ ...evidence, output: Buffer.concat(chunks).toString("utf8") });
      else {
        const error = new WorkerTerminationUnconfirmedError(); error.cause = failureDiagnostic;
        completion.reject(error);
      }
      if (!receivedReady) ready.reject(new WorkerTerminationUnconfirmedError());
    });
    send({ workerProcessId: request.workerProcessId, deadlineAt: request.deadlineAt,
      executable: process.execPath, arguments: ["--experimental-strip-types",
        this.options.runnerPath ?? fileURLToPath(new URL("./codex-sdk-runner.ts", import.meta.url))],
      workspace: request.workspace, maximumOutputBytes: request.maximumOutputBytes,
      ...(request.launchFence === undefined ? {} : { launchFence: request.launchFence }),
      environment: Object.entries(environment).map(([key, value]) => `${key}=${value}`) });
    try {
      const identity = await ready.promise;
      return { ...identity, closed: completion.promise,
        release(input: string) {
          if (released || stopping || ended) throw new Error("worker cannot be released twice or after termination");
          const frame = { type: "go", input };
          if (Buffer.byteLength(JSON.stringify(frame)) > 524_288) throw new Error("worker input exceeds IPC limit");
          released = true; send(frame);
        },
        async terminate() { stop(); return completion.promise; },
      };
    } catch (error) {
      stop(); await completion.promise.catch(() => {}); throw error;
    }
  }
}

export function parseWindowsSupervisionScope(value: unknown): WindowsSupervisionScope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("missing OS scope");
  const scope = value as Record<string, unknown>;
  if (Object.keys(scope).length !== 3 || typeof scope.machineFingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(scope.machineFingerprint)
      || typeof scope.bootedAt !== "string" || !Number.isFinite(Date.parse(scope.bootedAt))
      || !Number.isInteger(scope.sessionId) || (scope.sessionId as number) < 0 || (scope.sessionId as number) > 2147483647) {
    throw new Error("invalid OS scope");
  }
  return { machineFingerprint: scope.machineFingerprint, bootedAt: new Date(scope.bootedAt).toISOString(), sessionId: scope.sessionId as number };
}
