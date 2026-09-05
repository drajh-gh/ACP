import { createHash } from "node:crypto";
import { DBOS, type DBOSClient } from "@dbos-inc/dbos-sdk";
import { expectOnlyKeys, expectRecord, parseStableId, workerResourceClasses,
  type StableId, type WorkerResourceClass, type WorkerResult } from "@acp/domain";
import { PostgresContextStore, PostgresDispatchStore, PostgresWorkerRuntimeStore,
  type DispatchMessage, type EnqueueWorkerAssignment, type HostRuntimeRegistration,
  type WorkerHostRegistration } from "@acp/storage";
import type { WorkerManager } from "./worker-manager.ts";
import type { WorkerRecoveryRuntime } from "./worker-recovery.ts";

export const workerDispatchWorkflowName = "acp.execute_worker_dispatch.v1";
export type WorkerDispatchOutcome =
  | { readonly state: "obsolete" | "reconciliation_required" }
  | { readonly state: "terminal"; readonly result: WorkerResult };

export function hostWorkerQueueName(host: string, resourceClass: WorkerResourceClass, session: StableId<"workerHostSession">): string {
  return `acp-worker-v1:${createHash("sha256").update(host).digest("hex")}:${session}:${resourceClass}`;
}

export function postgresWorkerEnqueuer(dbos: DBOSClient): EnqueueWorkerAssignment {
  return async (client, assignment) => {
    await dbos.enqueueInTransaction(client, {
      workflowName: workerDispatchWorkflowName,
      queueName: assignment.queueName,
      workflowID: assignment.workflowId,
      deduplicationID: `${assignment.runId}:${assignment.generation}`,
      appVersion: assignment.applicationVersion,
      applicationName: "acp-worker",
      attributes: { runId: assignment.runId, missionId: assignment.missionId,
        hostIdentifier: assignment.hostIdentifier, hostSessionId: assignment.hostSessionId },
    }, { runId: assignment.runId, generation: assignment.generation, hostSessionId: assignment.hostSessionId });
  };
}

export interface HostDispatchOptions {
  readonly host: WorkerHostRegistration;
  readonly runtime: HostRuntimeRegistration;
  readonly dispatches: Pick<PostgresDispatchStore, "registerRuntime" | "heartbeatRuntime" | "closeRuntime" |
    "cancellationRequests" | "listPending" | "assign" | "prepare" | "blockUnstarted">;
  readonly contexts: Pick<PostgresContextStore, "buildAndRecordContextPacket">;
  readonly workers: Pick<PostgresWorkerRuntimeStore, "registerHost" | "heartbeatHost">;
  readonly manager: Pick<WorkerManager, "dispatch">;
  readonly enqueue: EnqueueWorkerAssignment;
  readonly recovery?: Pick<WorkerRecoveryRuntime, "authority" | "maintain"> & Partial<Pick<WorkerRecoveryRuntime, "handoff">>;
}

/** One daemon session. A run may execute only after a NEW durable startRun insert. */
export class HostDispatchRuntime {
  private readonly options: HostDispatchOptions;
  private readonly active = new Map<string, { runId: StableId<"run">; controller: AbortController; promise: Promise<WorkerDispatchOutcome> }>();
  private stopping = false;
  private leaseWatchdog: NodeJS.Timeout | undefined;
  private readonly lifetime = new AbortController();
  private recoveryInFlight: Promise<unknown> | undefined;
  private readonly pendingHandoffs = new Map<string, DispatchMessage>();
  constructor(options: HostDispatchOptions) {
    if (options.host.hostIdentifier !== options.runtime.hostIdentifier) throw new Error("host/runtime identity mismatch");
    if (options.recovery && (options.recovery.authority.hostIdentifier !== options.runtime.hostIdentifier
      || options.recovery.authority.sessionId !== options.runtime.sessionId
      || options.recovery.authority.applicationVersion !== options.runtime.applicationVersion)) throw new Error("recovery runtime identity mismatch");
    if (!Number.isInteger(options.host.heartbeatTtlSeconds) || options.host.heartbeatTtlSeconds < 5
        || options.host.heartbeatTtlSeconds > 300) throw new Error("host heartbeat TTL must be 5 to 300 seconds");
    this.options = options;
  }
  get applicationVersion(): string { return this.options.runtime.applicationVersion; }
  get heartbeatIntervalMilliseconds(): number {
    return Math.min(5_000, Math.floor(this.options.host.heartbeatTtlSeconds * 1000 / 3));
  }
  get queueNames(): readonly string[] {
    return workerResourceClasses.map((resourceClass) => hostWorkerQueueName(this.options.host.hostIdentifier,
      resourceClass, this.options.runtime.sessionId));
  }

  async start(): Promise<void> {
    // Configure queues before advertising a live consumer to the scheduler.
    for (const resourceClass of workerResourceClasses) {
      const concurrency = this.capacity(resourceClass);
      await DBOS.registerQueue(hostWorkerQueueName(this.options.host.hostIdentifier,
        resourceClass, this.options.runtime.sessionId), { globalConcurrency: concurrency, workerConcurrency: concurrency });
    }
    await this.options.dispatches.registerRuntime(this.options.runtime, this.options.host);
    this.armLeaseWatchdog(this.options.host.heartbeatTtlSeconds * 1000);
  }

  /** Renew independently of queue sweeps; loss of authority cancels local work. */
  async heartbeat(): Promise<void> {
    if (this.stopping) return;
    const renewalStarted = performance.now();
    try {
      if (!(await this.options.dispatches.heartbeatRuntime(this.options.host.hostIdentifier, this.options.runtime.sessionId))) {
        throw new Error("host dispatch session was fenced by a replacement");
      }
      await this.options.workers.heartbeatHost(this.options.host.hostIdentifier, this.options.host.transitionProvenanceId);
      if (this.stopping) return; // A stalled renewal cannot resurrect a fenced daemon.
      this.armLeaseWatchdog(this.options.host.heartbeatTtlSeconds * 1000 - (performance.now() - renewalStarted));
      const pending = [...this.active.values()];
      for (let offset = 0; offset < pending.length; offset += 100) {
        const batch = pending.slice(offset, offset + 100);
        const cancelled = new Set(await this.options.dispatches.cancellationRequests(batch.map((item) => item.runId),
          this.options.host.hostIdentifier, this.options.runtime.sessionId));
        for (const item of batch) if (cancelled.has(item.runId)) item.controller.abort(new Error("durable worker authority was cancelled"));
      }
    } catch (error) {
      // Fail closed even when the database cannot confirm local authority.
      this.stopping = true;
      this.clearLeaseWatchdog();
      this.abortActive(error);
      throw error;
    }
  }

  async maintain(): Promise<void> {
    if (this.stopping) return;
    // Only failed local invocations enter this queue. Initial DBOS replay must
    // not manufacture a handoff for a healthy owner whose result is in flight.
    for (const message of [...this.pendingHandoffs.values()].slice(0, 2)) {
      if (this.stopping) return;
      await this.tryHandoff(message);
    }
    if (this.options.recovery) {
      this.recoveryInFlight ??= this.options.recovery.maintain(this.lifetime.signal)
        .then((result) => { for (const error of result.errors) DBOS.logger.error(error); })
        .finally(() => { this.recoveryInFlight = undefined; });
      await this.recoveryInFlight;
    }
    if (this.stopping) return;
    for (const runId of await this.options.dispatches.listPending(25)) {
      if (this.stopping) break;
      try { await this.options.dispatches.assign(runId, this.options.enqueue); }
      catch (error) { DBOS.logger.error(error); }
    }
  }

  execute(value: unknown): Promise<WorkerDispatchOutcome> {
    const message = parseDispatchMessage(value);
    if (this.stopping || message.hostSessionId !== this.options.runtime.sessionId) return Promise.resolve({ state: "obsolete" });
    const key = `${message.runId}:${message.generation}`;
    const existing = this.active.get(key);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const promise = this.executeOnce(message, controller.signal).finally(() => { this.active.delete(key); });
    this.active.set(key, { runId: message.runId, controller, promise });
    return promise;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearLeaseWatchdog();
    const pending = [...this.active.values()];
    this.abortActive(new Error("host worker is stopping"));
    try {
      await this.options.dispatches.closeRuntime(this.options.host.hostIdentifier, this.options.runtime.sessionId);
    } finally {
      await Promise.allSettled([...pending.map((item) => item.promise), this.recoveryInFlight]);
    }
  }

  private abortActive(reason: unknown): void {
    this.lifetime.abort(reason);
    for (const item of this.active.values()) item.controller.abort(reason);
  }

  private clearLeaseWatchdog(): void {
    if (this.leaseWatchdog !== undefined) clearTimeout(this.leaseWatchdog);
    this.leaseWatchdog = undefined;
  }

  private armLeaseWatchdog(remainingMilliseconds: number): void {
    this.clearLeaseWatchdog();
    const fence = () => {
      this.stopping = true;
      this.abortActive(new Error("host session renewal exceeded its local lease deadline"));
    };
    if (remainingMilliseconds <= 0) { fence(); throw new Error("host session renewal exceeded its lease deadline"); }
    this.leaseWatchdog = setTimeout(fence, remainingMilliseconds);
    this.leaseWatchdog.unref();
  }

  private async executeOnce(message: DispatchMessage, signal: AbortSignal): Promise<WorkerDispatchOutcome> {
    const preparation = await this.prepare(message);
    if (preparation.state !== "ready") return preparation;
    const a = preparation.assignment;
    let managerEntered = false;
    try {
      await this.options.contexts.buildAndRecordContextPacket({ contextPacketId: a.contextPacketId,
        missionId: a.missionId, nodeId: a.nodeId, capabilityGrantId: a.grantId,
        runtimeTemplateProvenanceId: a.templateProvenanceId, provenanceId: a.packetProvenanceId });
      managerEntered = true;
      const result = await this.options.manager.dispatch({ runId: a.runId, dispatchGeneration: a.generation,
        contextPacketId: a.contextPacketId, attemptNumber: a.attemptNumber, operation: a.operation,
        resource: a.resource, mode: a.mode, workspace: a.workspace, provenanceId: a.packetProvenanceId,
        transitionProvenanceId: a.packetProvenanceId, signal });
      return { state: "terminal", result };
    } catch (error) {
      if (managerEntered && this.options.recovery?.handoff && !this.stopping) {
        if (this.pendingHandoffs.size >= 1000 && !this.pendingHandoffs.has(message.runId)) {
          this.stopping = true;
          this.clearLeaseWatchdog();
          this.abortActive(new Error("bounded recovery handoff backlog exhausted"));
          throw error; // Stop renewing this session; never silently drop ownership uncertainty.
        }
        this.pendingHandoffs.set(message.runId, message);
        await this.tryHandoff(message);
      }
      // DBOS may replay an interrupted step even with retriesAllowed:false.
      // Existing started runs require reconciliation, never a second transport.
      const current = await this.prepare(message);
      if (current.state !== "ready") return current;
      if (await this.options.dispatches.blockUnstarted(message, "Worker admission failed; supervisor reconciliation is required.")) {
        return { state: "reconciliation_required" };
      }
      throw error;
    }
  }

  private async tryHandoff(message: DispatchMessage): Promise<void> {
    try {
      const outcome = await this.options.recovery!.handoff!(message);
      this.pendingHandoffs.delete(message.runId);
      if (outcome === "pending") this.pendingHandoffs.set(message.runId, message);
    } catch {
      // Rotate failed acknowledgements fairly. Retry exact identity; never
      // resume execution or infer process absence from an unavailable journal.
      this.pendingHandoffs.delete(message.runId);
      this.pendingHandoffs.set(message.runId, message);
      DBOS.logger.error(`worker recovery handoff remains pending for ${message.runId}`);
    }
  }

  private prepare(message: DispatchMessage) {
    return this.options.dispatches.prepare(message, this.options.host.hostIdentifier,
      this.options.runtime.applicationVersion, this.options.runtime.sessionId);
  }
  private capacity(resourceClass: WorkerResourceClass): number {
    const h = this.options.host;
    return { cpu_intensive: h.maximumCpuIntensive, moderate_compute: h.maximumModerateCompute,
      lightweight_read: h.maximumLightweightRead, network_bound: h.maximumNetworkBound }[resourceClass];
  }
}

export function registerHostDispatchWorkflow(runtime: Pick<HostDispatchRuntime, "execute">) {
  return DBOS.registerWorkflow(async (message: DispatchMessage): Promise<WorkerDispatchOutcome> => {
    if (DBOS.workflowID !== `worker:${message.runId}:assignment:${message.generation}`) throw new Error("worker dispatch workflow identity mismatch");
    // No DBOS timeout: abandoning this promise is not proof of OS termination.
    // WorkerManager owns the persisted deadline and bounded termination grace.
    return DBOS.runStep(() => runtime.execute(message), { name: "execute-assigned-worker", retriesAllowed: false });
  }, { name: workerDispatchWorkflowName, maxRecoveryAttempts: 3 });
}

export function parseDispatchMessage(value: unknown): DispatchMessage {
  const input = expectRecord(value, "dispatchMessage");
  expectOnlyKeys(input, ["runId", "generation", "hostSessionId"], "dispatchMessage");
  if (!Number.isSafeInteger(input.generation) || (input.generation as number) < 1) throw new TypeError("invalid dispatch generation");
  return { runId: parseStableId(input.runId, "run"), generation: input.generation as number,
    hostSessionId: parseStableId(input.hostSessionId, "workerHostSession") };
}
