import type { StableId } from "@acp/domain";
import type { PostgresWorkerLaunchStore, WorkerLaunchClaim, WorkerLaunchObservation } from "@acp/storage";
import type { WorkerRecoverySweep } from "./worker-recovery.ts";
import { sealWindowsWorkerLaunch, type WindowsLaunchFenceOptions } from "./windows-launch-fence.ts";

export interface WorkerLaunchInspector {
  seal(claim: WorkerLaunchClaim, signal: AbortSignal): Promise<WorkerLaunchObservation>;
}
export class WindowsWorkerLaunchInspector implements WorkerLaunchInspector {
  private readonly options: WindowsLaunchFenceOptions;
  constructor(options: WindowsLaunchFenceOptions = {}) { this.options = options; }
  seal(claim: WorkerLaunchClaim, signal: AbortSignal) {
    return sealWindowsWorkerLaunch(claim.intent.fence, claim.workerProcessId, signal, this.options);
  }
}

/** Immutable intents, not process-journal presence, identify this recovery lane. */
export class WorkerLaunchRecoveryRuntime {
  private cursor: StableId<"workerProcess"> | undefined;
  private inFlight: Promise<WorkerRecoverySweep> | undefined;
  private readonly store: Pick<PostgresWorkerLaunchStore, "authority" | "listCandidates" | "prepare" | "observe" | "recover">;
  private readonly inspector: WorkerLaunchInspector;
  constructor(options: { readonly store: WorkerLaunchRecoveryRuntime["store"]; readonly inspector: WorkerLaunchInspector }) {
    this.store = options.store; this.inspector = options.inspector;
  }
  get authority() { return this.store.authority; }
  maintain(signal: AbortSignal): Promise<WorkerRecoverySweep> {
    this.inFlight ??= this.sweep(signal).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
  private async sweep(signal: AbortSignal): Promise<WorkerRecoverySweep> {
    let recovered = 0, unconfirmed = 0;
    const errors: Error[] = [];
    if (signal.aborted) return { recovered, unconfirmed, errors };
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
          const state = await this.store.observe(prepared.claim, (persisted, lease) => this.inspector.seal(persisted, lease), signal);
          if (state !== "stopped") { unconfirmed++; continue; }
        }
        if (signal.aborted) continue;
        const state = await this.store.recover(candidate.runId, prepared.provenanceId);
        if (state === "recovered") recovered++;
        if (state === "pending") unconfirmed++;
      } catch {
        errors.push(new Error(`worker launch recovery remains pending for ${candidate.workerProcessId}`)); unconfirmed++;
      } finally { this.cursor = candidate.workerProcessId; }
    }
    return { recovered, unconfirmed, errors };
  }
}
