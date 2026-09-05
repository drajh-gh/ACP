import { isDeepStrictEqual } from "node:util";
import { parseStableId, type StableId } from "@acp/domain";
import { parseRepositoryBinding, parseWorktreeBinding, type FilesystemWriterLease,
  type PostgresFilesystemWriterStore, type PostgresRepositoryBindingStore } from "@acp/storage";
import { observeWindowsWorktree, parseWindowsFilesystemObservation, validateWindowsRepositoryObserverOptions,
  type WindowsRepositoryObserverOptions } from "./windows-repository-observer.ts";

type WriterStore = Pick<PostgresFilesystemWriterStore,"authority" | "load" | "heartbeat">;
type BindingStore = Pick<PostgresRepositoryBindingStore,"authority" | "loadWorktree" | "loadRepository">;
export interface LeasedWorktreeObserverOptions extends WindowsRepositoryObserverOptions {
  /** Trusted read-only dependency; must abort and settle after its owned helpers exit. */
  readonly observeWorktree?: typeof observeWindowsWorktree;
  /** Monotonic elapsed time only. Database and host wall clocks need not agree. */
  readonly monotonicNow?: () => number;
}
/** Historical preflight evidence, NOT a live handle, launch permission or writer fence. */
export type LeasedWorktreeObservation = { readonly state: "unconfirmed" } | {
  readonly state: "observed";
  readonly leaseId: StableId<"lease">;
  readonly runId: StableId<"run">;
  readonly workerProcessId: StableId<"workerProcess">;
  readonly worktreeBindingId: StableId<"worktreeBinding">;
  readonly repositoryBindingId: StableId<"repositoryBinding">;
  readonly leaseRevision: number;
  readonly observedAt: string;
  readonly branchRef: string;
  readonly headRevision: string;
};

/** One-shot native preflight. Never acquires/releases a lease, launches a writer, or executes Git mutations. */
export class WindowsLeasedWorktreeObserver {
  private readonly writers: WriterStore;
  private readonly bindings: BindingStore;
  private readonly options: LeasedWorktreeObserverOptions;
  constructor(writers: WriterStore, bindings: BindingStore, options: LeasedWorktreeObserverOptions) {
    validateWindowsRepositoryObserverOptions(options);
    if (!isDeepStrictEqual(writers.authority,bindings.authority)) throw new TypeError("leased observation stores require the same exact host runtime");
    this.writers = writers; this.bindings = bindings; this.options = options;
  }
  async observe(leaseId: StableId<"lease">, signal: AbortSignal): Promise<LeasedWorktreeObservation> {
    parseStableId(leaseId,"lease");
    const unconfirmed = { state: "unconfirmed" } as const;
    if (signal.aborted) return unconfirmed;
    const controller = new AbortController(), now = this.options.monotonicNow ?? (() => performance.now());
    const abort = () => controller.abort();
    signal.addEventListener("abort",abort,{ once:true });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let deadline = Infinity;
    const valid = () => !controller.signal.aborted && now() < deadline;
    try {
      if (signal.aborted) return unconfirmed;
      const lease = await this.writers.load(leaseId);
      if (!lease || lease.leaseId !== leaseId || !this.owned(lease) || !valid()) return unconfirmed;
      const retained = await this.bindings.loadWorktree(lease.worktreeBindingId);
      if (!retained || retained.retired || !valid()) return unconfirmed;
      const worktree = parseWorktreeBinding(retained.binding);
      if (worktree.worktreeBindingId !== lease.worktreeBindingId || worktree.repositoryBindingId !== lease.repositoryBindingId) return unconfirmed;
      const parent = await this.bindings.loadRepository(worktree.repositoryBindingId);
      if (!parent || parent.retired || !valid()) return unconfirmed;
      const repository = parseRepositoryBinding(parent.binding);
      if (repository.repositoryBindingId !== lease.repositoryBindingId) return unconfirmed;

      // A historical active snapshot is insufficient. Bracket the native read
      // with acknowledged, exact-owner renewals. No overlapping renewals exist.
      const began = now();
      const before = await this.writers.heartbeat(leaseId);
      const received = now();
      if (!valid() || !this.renewed(lease,before)) return unconfirmed;
      const duration = Date.parse(before.expiresAt)-Date.parse(before.heartbeatAt);
      const elapsed = received-began;
      if (!Number.isFinite(duration) || duration <= 0 || duration > 20000 || !Number.isFinite(elapsed) || elapsed < 0) return unconfirmed;
      const remaining = duration-elapsed-250;
      if (remaining <= 0) return unconfirmed;
      deadline = received+remaining;
      watchdog = setTimeout(abort,remaining);
      if (!valid()) return unconfirmed;
      const observe = this.options.observeWorktree ?? observeWindowsWorktree;
      // Always await native close, including after abort; never abandon owned helpers.
      const observation = parseWindowsFilesystemObservation(await observe(repository,worktree.workspace.path,controller.signal,this.options));
      if (!valid() || observation.state !== "confirmed" || observation.kind !== "worktree"
        || observation.machineFingerprint !== repository.machineFingerprint
        || !isDeepStrictEqual(observation.workspace,worktree.workspace)
        || !isDeepStrictEqual(observation.gitDirectory,worktree.gitDirectory)
        || observation.branchRef !== worktree.branchRef || observation.headRevision !== worktree.headRevision) return unconfirmed;

      // The original watchdog remains armed through COMMIT acknowledgement.
      // A late successful heartbeat may extend DB history but cannot revive this call.
      const finalBegan = now();
      const after = await this.writers.heartbeat(leaseId);
      if (!valid() || !this.renewed(before,after)) return unconfirmed;
      const finalRemaining = Date.parse(after.expiresAt)-Date.parse(after.heartbeatAt);
      const finalElapsed = now()-finalBegan;
      if (!Number.isFinite(finalRemaining) || finalRemaining > 20000 || !Number.isFinite(finalElapsed) || finalElapsed < 0
        || finalRemaining-finalElapsed-250 <= 0) return unconfirmed;
      return { state:"observed",leaseId,runId:lease.runId,workerProcessId:lease.workerProcessId,
        worktreeBindingId:worktree.worktreeBindingId,repositoryBindingId:repository.repositoryBindingId,
        leaseRevision:after.revision,observedAt:observation.observedAt,branchRef:observation.branchRef,headRevision:observation.headRevision };
    } catch {
      return unconfirmed;
    } finally {
      controller.abort();
      if (watchdog !== undefined) clearTimeout(watchdog);
      signal.removeEventListener("abort",abort);
    }
  }
  private owned(lease: FilesystemWriterLease): boolean {
    const a = this.writers.authority;
    return lease.state === "active" && lease.releasedAt === null && lease.hostIdentifier === a.hostIdentifier
      && lease.ownerSessionId === a.sessionId && lease.applicationVersion === a.applicationVersion;
  }
  private renewed(previous: FilesystemWriterLease, current: FilesystemWriterLease): boolean {
    const immutable = (value: FilesystemWriterLease) => {
      const { heartbeatAt:_heartbeat,expiresAt:_expiry,revision:_revision,...identity } = value;
      return identity;
    };
    return this.owned(current) && Number.isSafeInteger(current.revision) && current.revision>previous.revision
      && isDeepStrictEqual(immutable(previous),immutable(current));
  }
}
