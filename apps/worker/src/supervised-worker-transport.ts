import { createStableId, type WorkerResult } from "@acp/domain";
import { parseWindowsLaunchFence, parseWorkerLaunchIntent, type PostgresWorkerRuntimeStore,
  type PostgresWorkerLaunchStore, type WindowsLaunchFenceDescriptor } from "@acp/storage";
import { isDeepStrictEqual } from "node:util";
import { WorkerTerminationUnconfirmedError, type WorkerTransport, type WorkerTransportRequest } from "./worker-manager.ts";
import type { OwnedWorker, OwnedWorkerExit, WorkerLauncher } from "./windows-worker-launcher.ts";

export interface SupervisedWorkerTransportOptions {
  readonly launcher: WorkerLauncher;
  readonly processes: Pick<PostgresWorkerRuntimeStore, "recordWorkerProcessFromRun" | "loadWorkerProcess" | "heartbeatWorkerProcess" | "finishWorkerProcess">;
  /** Also configure server-side statement/lock timeouts on the supplied pool. */
  readonly journalOperationTimeoutMs?: number;
  readonly launchFence?: WindowsLaunchFenceDescriptor;
  readonly launches?: Pick<PostgresWorkerLaunchStore, "finishOwnedLaunch">;
}

/** One journaled native root per admitted run; the child never receives a DB client. */
export class SupervisedWorkerTransport implements WorkerTransport {
  private readonly options: SupervisedWorkerTransportOptions;
  readonly launchFence?: WindowsLaunchFenceDescriptor;
  constructor(options: SupervisedWorkerTransportOptions) {
    const timeout = options.journalOperationTimeoutMs ?? 5000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000) throw new Error("invalid journal operation timeout");
    if ((options.launchFence === undefined) !== (options.launches === undefined)) throw new Error("launch fence and receipt store must be configured together");
    if (options.launchFence !== undefined) {
      const fence = parseWindowsLaunchFence(options.launchFence);
      this.launchFence = Object.freeze({ ...fence, scope: Object.freeze(fence.scope) });
    }
    this.options = { ...options };
  }

  async run(request: WorkerTransportRequest): Promise<WorkerResult> {
    let intent;
    try {
      intent = request.execution.launchIntent === undefined ? undefined : parseWorkerLaunchIntent(request.execution.launchIntent);
      if (!isDeepStrictEqual(intent?.fence, this.launchFence)) throw new Error("launch intent does not match trusted transport configuration");
    } catch { throw new WorkerTerminationUnconfirmedError(); }
    const workerProcessId = intent?.workerProcessId ?? createStableId("workerProcess");
    let owned: OwnedWorker | undefined;
    let journaled = false;
    let registrationAttempted = false;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let heartbeat: Promise<void> | undefined;
    let heartbeatFailed = false;
    let exit: OwnedWorkerExit | undefined;
    try {
      owned = await this.options.launcher.launch({ workerProcessId, deadlineAt: request.execution.timeoutAt,
        ...(intent === undefined ? {} : { launchFence: intent.fence }),
        workspace: request.isolation.workspace, maximumOutputBytes: request.packet.limits.maximumOutputBytes,
        signal: request.signal });
      const identity = owned;
      registrationAttempted = true;
      const record = await this.bounded(this.options.processes.recordWorkerProcessFromRun({ workerProcessId, runId: request.runId,
        processId: identity.processId, processStartToken: identity.processStartToken, startedAt: identity.startedAt,
        purpose: "ACP isolated Codex SDK runner", provenanceId: request.execution.provenanceId,
        transitionProvenanceId: request.execution.transitionProvenanceId,
        supervision: { kind: "windows_job", treeIdentifier: `Local\\ACP.Worker.${workerProcessId}`, scope: identity.scope } }));
      journaled = true;
      if (record.state !== "running" || record.hostIdentifier !== request.execution.hostIdentifier
          || record.deadlineAt !== request.execution.timeoutAt || record.runId !== request.runId
          || record.workerProcessId !== workerProcessId || record.processId !== identity.processId
          || record.processStartToken !== identity.processStartToken
          || record.supervision?.treeIdentifier !== `Local\\ACP.Worker.${workerProcessId}`) {
        throw new Error("process journal does not match admitted execution");
      }
      if (request.signal.aborted) throw new Error("worker was cancelled before release");
      const renew = () => {
        if (heartbeat || exit) return;
        heartbeat = this.bounded(this.options.processes.heartbeatWorkerProcess(workerProcessId, identity.processId, identity.processStartToken))
          .then(() => {})
          .catch(async () => { heartbeatFailed = true; await identity.terminate(); })
          .finally(() => { heartbeat = undefined; });
        void heartbeat.catch(() => {});
      };
      heartbeatTimer = setInterval(renew, 1_000); heartbeatTimer.unref();
      const { signal: _signal, ...input } = request;
      const { launchIntent: _launchIntent, ...execution } = input.execution;
      identity.release(JSON.stringify({ ...input, execution }));
      exit = await identity.closed;
      if (exit.failed || exit.terminated || exit.exitCode !== 0 || heartbeatFailed) throw new Error("supervised worker ended without a valid result");
      return JSON.parse(exit.output) as WorkerResult; // WorkerManager validates and binds it.
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (owned) {
        try {
          exit ??= await owned.terminate();
          await heartbeat;
          // A committed INSERT can lose its acknowledgement. Never retry a
          // launch: recover only this exact journal identity after tree stop.
          if (!journaled && registrationAttempted) {
            const record = await this.bounded(this.options.processes.loadWorkerProcess(workerProcessId));
            if (record) {
              if (record.runId !== request.runId || record.processId !== owned.processId
                  || record.processStartToken !== owned.processStartToken
                  || record.supervision?.treeIdentifier !== `Local\\ACP.Worker.${workerProcessId}`) {
                throw new Error("ambiguous process journal identity");
              }
              journaled = true;
            }
          }
          if (intent !== undefined && (!journaled || exit.launchSealed !== true)) throw new WorkerTerminationUnconfirmedError();
          const completion = { workerProcessId,
            processId: owned.processId, processStartToken: owned.processStartToken,
            state: exit.terminated || exit.failed ? "terminated" as const : "exited" as const, exitCode: exit.exitCode,
            terminationReason: exit.terminated || exit.failed ? "Owned worker tree was terminated." : "Owned worker tree exited and was drained.",
            transitionProvenanceId: request.execution.transitionProvenanceId };
          if (journaled) {
            if (intent !== undefined) await this.bounded(this.options.launches!.finishOwnedLaunch({ ...completion, runId: request.runId, launchSealed: true }));
            else await this.bounded(this.options.processes.finishWorkerProcess(completion));
          }
        } catch { throw new WorkerTerminationUnconfirmedError(); }
      } else if (intent !== undefined) throw new WorkerTerminationUnconfirmedError();
      // A pending renewal may reject during cleanup, after output was parsed.
      // Confirmed cleanup permits a failure result, never the pending success.
      if (heartbeatFailed) throw new Error("supervised worker heartbeat failed during cleanup");
    }
  }

  private async bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("process journal operation timed out")), this.options.journalOperationTimeoutMs ?? 5000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
