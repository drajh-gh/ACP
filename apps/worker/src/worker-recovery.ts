import type { StableId } from "@acp/domain";
import type { DispatchMessage, PostgresWorkerRecoveryStore, PostgresWorkerRuntimeStore } from "@acp/storage";
import type { WorkerTreeInspector } from "./windows-worker-recovery.ts";

export interface WorkerRecoverySweep {
  readonly recovered: number;
  readonly unconfirmed: number;
  readonly errors: readonly Error[];
}

/** Sequential bounded batches with a keyset cursor, including poisoned items. */
export class WorkerRecoveryRuntime {
  private cursor: StableId<"workerProcess"> | undefined;
  private inFlight: Promise<WorkerRecoverySweep> | undefined;
  private readonly store: Pick<PostgresWorkerRecoveryStore, "authority" | "listCandidates" | "prepare" | "handoff">;
  private readonly workers: Pick<PostgresWorkerRuntimeStore, "reconcileClaimedWorkerProcess" | "recoverStoppedRun">;
  private readonly inspector: WorkerTreeInspector;
  constructor(options: { readonly store: WorkerRecoveryRuntime["store"]; readonly workers: WorkerRecoveryRuntime["workers"];
    readonly inspector: WorkerTreeInspector }) {
    this.store = options.store; this.workers = options.workers; this.inspector = options.inspector;
  }
  get authority() { return this.store.authority; }
  handoff(message: DispatchMessage) {
    return this.store.handoff(message);
  }
  maintain(signal: AbortSignal): Promise<WorkerRecoverySweep> {
    this.inFlight ??= this.sweep(signal).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
  private async sweep(signal: AbortSignal): Promise<WorkerRecoverySweep> {
    let recovered = 0, unconfirmed = 0;
    const errors: Error[] = [];
    if (signal.aborted) return { recovered, unconfirmed, errors };
    // At most two observations per pass (~28 seconds); heartbeat runs independently.
    let candidates = await this.store.listCandidates(this.cursor, 2);
    if (!candidates.length && this.cursor !== undefined) {
      this.cursor = undefined;
      if (!signal.aborted) candidates = await this.store.listCandidates(undefined, 2);
    }
    for (const candidate of candidates) {
      if (signal.aborted) break;
      try {
        const prepared = await this.store.prepare(candidate);
        if (!prepared || signal.aborted) continue;
        if (prepared.claim) {
          const reconciliation = await this.workers.reconcileClaimedWorkerProcess(candidate.workerProcessId,
            prepared.claim.reconciliationId, async (claim, leaseSignal) => {
              const observed = await this.inspector.stop(claim, AbortSignal.any([signal, leaseSignal]));
              if (observed.state === "unconfirmed") throw new Error("exact worker tree stop remains unconfirmed");
              return { state: observed.state, terminationReason: observed.reason,
                ...(observed.state === "terminated" ? { exitCode: observed.exitCode } : {}),
                transitionProvenanceId: prepared.provenanceId };
            }, this.store.authority);
          if (reconciliation.state !== "terminalized") { unconfirmed++; continue; }
        }
        if (signal.aborted) continue; // A later sweep can close the durable projection gap.
        const outcome = await this.workers.recoverStoppedRun({ runId: candidate.runId,
          hostIdentifier: this.store.authority.hostIdentifier, authority: this.store.authority,
          transitionProvenanceId: prepared.provenanceId });
        if (outcome === "recovered") recovered++;
        if (outcome === "pending") unconfirmed++;
      } catch {
        // Do not put raw database/OS output or sensitive context in daemon logs.
        errors.push(new Error(`worker recovery remains pending for ${candidate.workerProcessId}`));
        unconfirmed++;
      } finally { this.cursor = candidate.workerProcessId; }
    }
    return { recovered, unconfirmed, errors };
  }
}
