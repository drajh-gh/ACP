import { isDeepStrictEqual } from "node:util";
import { parseStableId, type StableId } from "@acp/domain";
import type { FilesystemWriterLease, PostgresFilesystemWriterStore } from "@acp/storage";

type WriterStore = Pick<PostgresFilesystemWriterStore,"authority" | "load" | "heartbeat">;
export interface FilesystemWriterGuardOptions {
  /** Trusted supervisor tuning, never model/dispatch input. */
  readonly renewalIntervalMs?: number;
  readonly monotonicNow?: () => number;
}
export interface FilesystemWriterScope {
  readonly signal: AbortSignal;
  /** Frozen initial ACK snapshot, not a live deadline or launch permission. */
  readonly lease: FilesystemWriterLease;
}
export type FilesystemWriterGuardResult<T> = { readonly state:"unconfirmed" }
  | { readonly state:"completed"; readonly value:T };

/** Cooperative renewal for trusted, pre-stop-receipt work, NOT native write isolation.
 * The callback must settle only after all its owned helpers have stopped. It must
 * not persist a launch stop/terminal run or release the lease inside this scope.
 * A native independent renewable watchdog is still required before writer wiring.
 */
export class FilesystemWriterGuard {
  private readonly writers: WriterStore;
  private readonly interval: number;
  private readonly now: () => number;
  constructor(writers: WriterStore, options: FilesystemWriterGuardOptions = {}) {
    const interval = options.renewalIntervalMs ?? 1000;
    if (!Number.isSafeInteger(interval) || interval < 1 || interval > 5000) throw new TypeError("writer renewal interval must be 1 to 5000 ms");
    this.writers = writers; this.interval = interval;
    this.now = options.monotonicNow ?? (() => performance.now());
  }
  async run<T>(leaseId: StableId<"lease">, signal: AbortSignal,
    operation: (scope: FilesystemWriterScope) => Promise<T>): Promise<FilesystemWriterGuardResult<T>> {
    parseStableId(leaseId,"lease");
    const unconfirmed = { state:"unconfirmed" } as const;
    if (signal.aborted) return unconfirmed;
    const controller = new AbortController();
    let watchdog: ReturnType<typeof setTimeout> | undefined, scheduled: ReturnType<typeof setTimeout> | undefined;
    let pending: Promise<boolean> | undefined, current: FilesystemWriterLease;
    let finishing = false, lost = false, deadline = Infinity, lastTime = -Infinity;
    let result: FilesystemWriterGuardResult<T> = unconfirmed;
    const stopScheduling = () => { finishing=true; if (scheduled !== undefined) clearTimeout(scheduled); };
    const abort = () => { lost=true; stopScheduling(); controller.abort(); };
    signal.addEventListener("abort",abort,{ once:true });
    const sample = () => {
      const at=this.now();
      if (!Number.isFinite(at) || at < lastTime) throw new Error("writer guard requires finite monotonic time");
      lastTime=at; return at;
    };
    const valid = () => {
      if (controller.signal.aborted) return false;
      if (sample() >= deadline) { abort(); return false; }
      return true;
    };
    const renew = async (): Promise<boolean> => {
      try {
        if (!valid()) return false;
        const began=sample(), next=await this.writers.heartbeat(leaseId), received=sample();
        // Check the OLD budget before accepting another epoch. A blocked event
        // loop, cancelled call or late COMMIT ACK can never revive lost authority.
        if (!valid() || !this.renewed(current,next)) { abort(); return false; }
        const duration=Date.parse(next.expiresAt)-Date.parse(next.heartbeatAt);
        const nextDeadline=began+duration-250;
        if (!Number.isFinite(duration) || duration <= 0 || duration > 20000 || nextDeadline <= received) {
          abort(); return false;
        }
        current={ ...next }; deadline=nextDeadline;
        if (watchdog !== undefined) clearTimeout(watchdog);
        watchdog=setTimeout(abort,deadline-received);
        return valid();
      } catch { abort(); return false; }
    };
    const schedule = () => {
      if (finishing || !valid()) return;
      scheduled=setTimeout(() => {
        if (finishing) return;
        // One chain owns every renewal, including the final acknowledgement.
        pending=renew().then((ok) => {
          if (ok && !finishing) schedule();
          return ok;
        }).catch(() => { abort(); return false; });
      },Math.min(this.interval,Math.max(1,(deadline-sample())/2)));
    };
    try {
      if (signal.aborted) return unconfirmed;
      const loaded=await this.writers.load(leaseId);
      if (!loaded || loaded.leaseId !== leaseId || !this.owned(loaded) || !valid()) return unconfirmed;
      current={ ...loaded };
      if (!(await renew())) return unconfirmed;
      schedule();
      // No promise race: abort is cooperative and owned-helper cleanup is awaited.
      const value=await operation({ signal:controller.signal,lease:Object.freeze({ ...current }) });
      stopScheduling();
      if (pending !== undefined && !(await pending)) return unconfirmed;
      if (!valid() || !(await renew())) return unconfirmed;
      result={ state:"completed",value };
    } catch {
      return unconfirmed;
    } finally {
      stopScheduling(); controller.abort();
      if (watchdog !== undefined) clearTimeout(watchdog);
      // Store calls are bounded by their configured database connection/query
      // limits, not falsely cancellable. Never detach an uncertain transaction.
      await pending;
      signal.removeEventListener("abort",abort);
    }
    return lost || signal.aborted ? unconfirmed : result;
  }
  private owned(lease: FilesystemWriterLease): boolean {
    const a=this.writers.authority;
    return lease.state === "active" && lease.releasedAt === null && Number.isSafeInteger(lease.revision) && lease.revision > 0
      && lease.hostIdentifier === a.hostIdentifier && lease.ownerSessionId === a.sessionId && lease.applicationVersion === a.applicationVersion;
  }
  private renewed(previous: FilesystemWriterLease, current: FilesystemWriterLease): boolean {
    const immutable = (value: FilesystemWriterLease) => {
      const { heartbeatAt:_heartbeat,expiresAt:_expiry,revision:_revision,...identity }=value;
      return identity;
    };
    return this.owned(current) && current.revision > previous.revision && isDeepStrictEqual(immutable(previous),immutable(current));
  }
}
