import { isDeepStrictEqual } from "node:util";
import { expectBoolean, expectOnlyKeys, expectRecord, parseCanonicalTimestamp, parseStableId, snapshotJsonData, type StableId } from "@acp/domain";
import { parseProvisionerProcessRecord, parseProvisionerStopRecord, parseRepositoryBinding,
  type PostgresWorktreeProvisionerStore, type PostgresProvisionerJournalStore, type PostgresRepositoryBindingStore,
  type ProvisionerJournalReceipt, type ProvisionerStopRecord, type RepositoryBindingInput, type WindowsDirectoryBinding,
  type WorktreeProvisionerAttempt, type WorkerRecoveryAuthority } from "@acp/storage";
import { parseNativeProvisionerOwner, snapshotNativeProvisionerPlan } from "./native-provisioner-plan.ts";
import { observeWindowsStoppedProvisionerWorktree, parseWindowsStoppedProvisionerWorktreeObservation, validateWindowsRepositoryObserverOptions,
  type WindowsRepositoryObserverOptions, type WindowsStoppedProvisionerWorktreeObservation } from "./windows-repository-observer.ts";

type PlanPort = Pick<PostgresWorktreeProvisionerStore, "authority" | "load">;
type JournalPort = Pick<PostgresProvisionerJournalStore, "authority" | "load">;
type RepositoryPort = Pick<PostgresRepositoryBindingStore, "authority" | "loadRepository">;
export interface ProvisionerWorktreeObserverPort {
  /** Bounded read-only operation that drains its owned helper before settling. */
  observe(repository: RepositoryBindingInput, workspace: string, parent: WindowsDirectoryBinding, signal: AbortSignal): Promise<unknown>;
}
export type StoppedProvisionerWorktreeObservation = { readonly state: "unconfirmed" } | {
  readonly state: "observed"; readonly kind: "stopped_provisioner_worktree"; readonly scope: "observation_only";
  readonly attempt: WorktreeProvisionerAttempt; readonly stop: ProvisionerStopRecord;
  readonly repository: { readonly binding: RepositoryBindingInput; readonly retired: boolean };
  readonly worktree: Extract<WindowsStoppedProvisionerWorktreeObservation, { readonly state: "observed" }>;
};

export function windowsStoppedProvisionerWorktreeObserver(options: WindowsRepositoryObserverOptions): ProvisionerWorktreeObserverPort {
  validateWindowsRepositoryObserverOptions(options);
  const trusted = Object.freeze({ gitExecutable: options.gitExecutable, ...(options.onSpawn ? { onSpawn: options.onSpawn } : {}) });
  return Object.freeze({ observe: (repository: RepositoryBindingInput, workspace: string, parent: WindowsDirectoryBinding, signal: AbortSignal) =>
    observeWindowsStoppedProvisionerWorktree(repository, workspace, parent, signal, trusted) });
}

/** Private read-only historical composition. No admission, success, registration,
 * retry, conversion, release, active-runtime or unexpired-plan requirement. */
export class StoppedProvisionerWorktreeVerifier {
  readonly authority: WorkerRecoveryAuthority;
  private readonly loadPlan: PlanPort["load"];
  private readonly loadJournal: JournalPort["load"];
  private readonly loadRepository: RepositoryPort["loadRepository"];
  private readonly observe: ProvisionerWorktreeObserverPort["observe"];
  constructor(plans: PlanPort, journal: JournalPort, repositories: RepositoryPort, observer: ProvisionerWorktreeObserverPort) {
    this.authority = parseNativeProvisionerOwner(plans.authority);
    for (const owner of [journal.authority, repositories.authority]) {
      if (!isDeepStrictEqual(this.authority, parseNativeProvisionerOwner(owner))) throw new TypeError("exact read-only verifier port owner required");
    }
    this.loadPlan = plans.load.bind(plans); this.loadJournal = journal.load.bind(journal);
    this.loadRepository = repositories.loadRepository.bind(repositories); this.observe = observer.observe.bind(observer);
  }
  async verify(input: { readonly attemptId: StableId<"worktreeProvisionerAttempt">; readonly signal: AbortSignal }): Promise<StoppedProvisionerWorktreeObservation> {
    const invocation = expectRecord(input, "stopped provisioner invocation"), keys = Reflect.ownKeys(invocation);
    if (keys.length !== 2 || !keys.includes("attemptId") || !keys.includes("signal")) throw new TypeError("exact stopped provisioner invocation required");
    const values = keys.map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(invocation, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("plain invocation fields required");
      return [key, descriptor.value] as const;
    });
    const fields = Object.fromEntries(values), attemptId = parseStableId(fields.attemptId, "worktreeProvisionerAttempt"), signal: unknown = fields.signal;
    if (!(signal instanceof AbortSignal)) throw new TypeError("owned verifier cancellation signal required");
    if (signal.aborted) return unconfirmed;
    try {
      const recorded = await this.loadPlan(attemptId);
      if (signal.aborted || recorded === undefined) return unconfirmed;
      const plan = snapshotNativeProvisionerPlan(detach(recorded));
      if (plan.attemptId !== attemptId || plan.hostIdentifier !== this.authority.hostIdentifier) return unconfirmed;
      const retained = await this.loadJournal(attemptId);
      if (signal.aborted || retained === undefined) return unconfirmed;
      const stop = stoppedEvidence(detach(retained), plan);
      const repositoryRecord = await this.loadRepository(plan.repositoryBindingId);
      if (signal.aborted || repositoryRecord === undefined) return unconfirmed;
      const repositoryInput = exact(detach(repositoryRecord), ["binding", "retired"]);
      const binding = parseRepositoryBinding(repositoryInput.binding), retired = expectBoolean(repositoryInput.retired, "repository.retired");
      if (binding.repositoryBindingId !== plan.repositoryBindingId || binding.repositoryId !== plan.repositoryId || binding.projectId !== plan.projectId
        || binding.machineFingerprint !== plan.machineFingerprint || !same(binding.commonGitDirectory, plan.commonGitDirectory)) return unconfirmed;
      // Load the native metadata only after the exact rooted stop was retained.
      // Cancellation waits for the pending read/helper; no abandoned native job.
      const observed = await this.observe(freeze(binding), plan.workspacePath,
        Object.freeze({ path: plan.reportedParent.path, identity: plan.reportedParent.identity }), signal);
      if (signal.aborted) return unconfirmed;
      const worktree = parseWindowsStoppedProvisionerWorktreeObservation(observed);
      if (worktree.state !== "observed" || worktree.machineFingerprint !== plan.machineFingerprint
        || worktree.workspace.path !== plan.workspacePath || worktree.branchRef !== plan.branchRef || worktree.headRevision !== plan.baseRevision
        || worktree.parent.path !== plan.reportedParent.path || worktree.parent.identity !== plan.reportedParent.identity
        || !same(worktree.checkout, binding.checkout) || !same(worktree.commonGitDirectory, binding.commonGitDirectory)) return unconfirmed;
      const result: StoppedProvisionerWorktreeObservation = { state: "observed", kind: "stopped_provisioner_worktree", scope: "observation_only",
        attempt: plan, stop, repository: { binding, retired }, worktree };
      detach(result); // Bound the composed result too, not only each source.
      return freeze(result);
    } catch { return unconfirmed; }
  }
}
const unconfirmed = Object.freeze({ state: "unconfirmed" as const });
const receiptFields = ["hostIdentifier", "ownerSessionId", "applicationVersion", "provenanceId", "treeIdentifier", "recordedAt"] as const;
function stoppedEvidence(value: unknown, plan: WorktreeProvisionerAttempt): ProvisionerStopRecord {
  const snapshot = exact(value, ["attemptId", "state", "process", "stop"]);
  if (snapshot.attemptId !== plan.attemptId || snapshot.state !== "stop_recorded") throw new TypeError("retained process and stop required");
  const p = exact(snapshot.process, ["attemptId", "fence", "root", ...receiptFields]);
  const s = exact(snapshot.stop, ["attemptId", "fence", "observation", ...receiptFields]);
  const process = parseProvisionerProcessRecord({ attemptId: p.attemptId, fence: p.fence, root: p.root });
  const stop = parseProvisionerStopRecord({ attemptId: s.attemptId, fence: s.fence, observation: s.observation });
  receipt(p, plan); const stopReceipt = receipt(s, plan);
  if (process.attemptId !== plan.attemptId || stop.attemptId !== plan.attemptId || !same(process.fence, stop.fence)
    || !("root" in stop.observation) || !same(process.root, stop.observation.root)
    || process.fence.namespace !== plan.fencePlan.namespace || process.fence.directory !== plan.fencePlan.directory
    || process.fence.scope.machineFingerprint !== plan.machineFingerprint) throw new TypeError("exact original rooted sealed stop required");
  return { ...stop, ...stopReceipt };
}
function receipt(input: Record<string, unknown>, plan: WorktreeProvisionerAttempt): ProvisionerJournalReceipt {
  const owner = parseNativeProvisionerOwner({ hostIdentifier: input.hostIdentifier, sessionId: input.ownerSessionId, applicationVersion: input.applicationVersion });
  if (owner.hostIdentifier !== plan.hostIdentifier || owner.sessionId !== plan.ownerSessionId || owner.applicationVersion !== plan.applicationVersion
    || input.provenanceId !== plan.provenanceId || input.treeIdentifier !== `Local\\ACP.Provisioner.${plan.attemptId}`) throw new TypeError("exact original journal receipt required");
  const recordedAt = parseCanonicalTimestamp(input.recordedAt);
  return { hostIdentifier: owner.hostIdentifier, ownerSessionId: owner.sessionId, applicationVersion: owner.applicationVersion,
    provenanceId: plan.provenanceId, treeIdentifier: input.treeIdentifier as string, recordedAt };
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const input = expectRecord(value, "stopped provisioner evidence"); expectOnlyKeys(input, keys, "stopped provisioner evidence");
  if (keys.some(key => !Object.hasOwn(input, key))) throw new TypeError("complete stopped provisioner evidence required");
  return input;
}
const detach = (value: unknown) => snapshotJsonData(value, { maximumBytes: 65_536 });
const same = (left: unknown, right: unknown) => isDeepStrictEqual(left, right);
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
