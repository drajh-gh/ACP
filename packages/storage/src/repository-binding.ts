import { win32 } from "node:path";
import { parseStableId, type StableId } from "@acp/domain";

export interface WindowsDirectoryBinding {
  readonly path: string;
  readonly identity: string;
}
export interface RepositoryBindingInput {
  readonly repositoryBindingId: StableId<"repositoryBinding">;
  readonly repositoryId: StableId<"repository">;
  readonly projectId: StableId<"project">;
  readonly machineFingerprint: string;
  readonly checkout: WindowsDirectoryBinding;
  readonly commonGitDirectory: WindowsDirectoryBinding;
  readonly observedAt: string;
  readonly provenanceId: StableId<"provenance">;
}
export interface WorktreeBindingInput {
  readonly worktreeBindingId: StableId<"worktreeBinding">;
  readonly repositoryBindingId: StableId<"repositoryBinding">;
  readonly missionId: StableId<"mission">;
  readonly workspace: WindowsDirectoryBinding;
  readonly gitDirectory: WindowsDirectoryBinding;
  readonly branchRef: string;
  readonly headRevision: string;
  readonly observedAt: string;
  readonly provenanceId: StableId<"provenance">;
}

/** Lexical rejection only. Filesystem identity must be observed by a trusted host. */
export function parseWindowsDirectoryBinding(value: unknown): WindowsDirectoryBinding {
  const input = record(value, ["path", "identity"]);
  if (typeof input.path !== "string" || input.path.length > 4096 || !/^[a-z]:\\/iu.test(input.path)
    || input.path.length <= 3 || win32.normalize(input.path) !== input.path
    || /[:<>"|?*\u0000-\u001f\u007f]/u.test(input.path.slice(3))
    || input.path.slice(3).split("\\").some((part) => !part || /[. ]$/u.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))
    || typeof input.identity !== "string" || !/^win32-dir:[0-9a-f]{8}:[0-9a-f]{16}$/u.test(input.identity)) {
    throw new TypeError("invalid canonical Windows directory binding");
  }
  return { path: input.path, identity: input.identity };
}
export function parseRepositoryBinding(value: unknown): RepositoryBindingInput {
  const input = record(value, ["repositoryBindingId", "repositoryId", "projectId", "machineFingerprint", "checkout", "commonGitDirectory", "observedAt", "provenanceId"]);
  const checkout = parseWindowsDirectoryBinding(input.checkout), commonGitDirectory = parseWindowsDirectoryBinding(input.commonGitDirectory);
  if (typeof input.machineFingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(input.machineFingerprint)
    || checkout.identity === commonGitDirectory.identity || checkout.path.toLowerCase() === commonGitDirectory.path.toLowerCase()) {
    throw new TypeError("repository checkout and Git metadata require distinct observed identities");
  }
  return { repositoryBindingId: parseStableId(input.repositoryBindingId, "repositoryBinding"), repositoryId: parseStableId(input.repositoryId, "repository"),
    projectId: parseStableId(input.projectId, "project"), machineFingerprint: input.machineFingerprint, checkout, commonGitDirectory,
    observedAt: timestamp(input.observedAt), provenanceId: parseStableId(input.provenanceId, "provenance") };
}
export function parseWorktreeBinding(value: unknown): WorktreeBindingInput {
  const input = record(value, ["worktreeBindingId", "repositoryBindingId", "missionId", "workspace", "gitDirectory", "branchRef", "headRevision", "observedAt", "provenanceId"]);
  const workspace = parseWindowsDirectoryBinding(input.workspace), gitDirectory = parseWindowsDirectoryBinding(input.gitDirectory);
  if (workspace.identity === gitDirectory.identity || workspace.path.toLowerCase() === gitDirectory.path.toLowerCase()
    || typeof input.branchRef !== "string" || !input.branchRef.startsWith("refs/heads/") || input.branchRef.length <= 11
    || input.branchRef.length > 1024 || /[\u0000-\u001f\u007f]/u.test(input.branchRef)
    || typeof input.headRevision !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(input.headRevision)) {
    throw new TypeError("invalid observed worktree branch, revision or directory identity");
  }
  return { worktreeBindingId: parseStableId(input.worktreeBindingId, "worktreeBinding"), repositoryBindingId: parseStableId(input.repositoryBindingId, "repositoryBinding"),
    missionId: parseStableId(input.missionId, "mission"), workspace, gitDirectory, branchRef: input.branchRef, headRevision: input.headRevision,
    observedAt: timestamp(input.observedAt), provenanceId: parseStableId(input.provenanceId, "provenance") };
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new TypeError("finite observation timestamp required");
  return new Date(value).toISOString();
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length
    || Object.keys(value).some((key) => !keys.includes(key))) throw new TypeError("exact filesystem binding fields required");
  return value as Record<string, unknown>;
}
