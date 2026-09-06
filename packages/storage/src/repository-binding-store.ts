import { isDeepStrictEqual } from "node:util";
import { parseStableId, type StableId } from "@acp/domain";
import type { Pool, QueryResultRow } from "pg";
import { PostgresDispatchStore, type HostRuntimeRegistration } from "./dispatch-store.ts";
import { withIsolatedTransaction } from "./isolated-transaction.ts";
import { parseRepositoryBinding, parseWorktreeBinding, type RepositoryBindingInput, type WorktreeBindingInput } from "./repository-binding.ts";
import type { WorkerRecoveryAuthority } from "./worker-recovery-store.ts";

/** Observation registry only. This store never executes Git or grants a writer lease. */
export class PostgresRepositoryBindingStore {
  private readonly pool: Pool;
  readonly authority: WorkerRecoveryAuthority;
  constructor(pool: Pool, runtime: HostRuntimeRegistration) {
    new PostgresDispatchStore(pool);
    parseStableId(runtime.sessionId, "workerHostSession");
    if (!runtime.hostIdentifier.trim() || !runtime.applicationVersion.trim()) throw new TypeError("filesystem observer runtime identity required");
    this.pool = pool; this.authority = { hostIdentifier: runtime.hostIdentifier, sessionId: runtime.sessionId, applicationVersion: runtime.applicationVersion };
  }
  async recordRepository(value: RepositoryBindingInput): Promise<RepositoryBindingInput> {
    const input = parseRepositoryBinding(value), a = this.authority;
    return withIsolatedTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('acp:filesystem-binding-record:'||$1,0))", [input.repositoryBindingId]);
      const existing = (await client.query("SELECT * FROM acp.repository_bindings WHERE repository_binding_id=$1", [input.repositoryBindingId])).rows[0];
      if (existing) {
        if (existing.host_identifier !== a.hostIdentifier || !isDeepStrictEqual(repositoryFromRow(existing), input)) throw new Error("repository binding identifier aliases different observation");
        return repositoryFromRow(existing);
      }
      await client.query(`INSERT INTO acp.repositories(repository_id,project_id,provenance_id) VALUES($1,$2,$3)
        ON CONFLICT(repository_id) DO NOTHING`, [input.repositoryId, input.projectId, input.provenanceId]);
      const row = (await client.query(`INSERT INTO acp.repository_bindings(repository_binding_id,repository_id,project_id,host_identifier,
        owner_session_id,application_version,machine_fingerprint,checkout_path,checkout_identity,common_git_directory_path,
        common_git_directory_identity,observed_at,provenance_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13) RETURNING *`,
      [input.repositoryBindingId,input.repositoryId,input.projectId,a.hostIdentifier,a.sessionId,a.applicationVersion,input.machineFingerprint,
        input.checkout.path,input.checkout.identity,input.commonGitDirectory.path,input.commonGitDirectory.identity,input.observedAt,input.provenanceId])).rows[0];
      if (!row || !isDeepStrictEqual(repositoryFromRow(row), input)) throw new Error("repository observation readback mismatch");
      return repositoryFromRow(row);
    });
  }
  async recordWorktree(value: WorktreeBindingInput): Promise<WorktreeBindingInput> {
    const input = parseWorktreeBinding(value), a = this.authority;
    return withIsolatedTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('acp:filesystem-binding-record:'||$1,0))", [input.worktreeBindingId]);
      const existing = (await client.query("SELECT * FROM acp.worktree_bindings WHERE worktree_binding_id=$1", [input.worktreeBindingId])).rows[0];
      if (existing) {
        if (existing.host_identifier !== a.hostIdentifier || !isDeepStrictEqual(worktreeFromRow(existing), input)) throw new Error("worktree binding identifier aliases different observation");
        return worktreeFromRow(existing);
      }
      const row = (await client.query(`INSERT INTO acp.worktree_bindings(worktree_binding_id,repository_binding_id,mission_id,host_identifier,
        owner_session_id,application_version,workspace_path,workspace_identity,git_directory_path,git_directory_identity,branch_ref,
        head_revision,observed_at,provenance_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::timestamptz,$14) RETURNING *`,
      [input.worktreeBindingId,input.repositoryBindingId,input.missionId,a.hostIdentifier,a.sessionId,a.applicationVersion,input.workspace.path,
        input.workspace.identity,input.gitDirectory.path,input.gitDirectory.identity,input.branchRef,input.headRevision,input.observedAt,input.provenanceId])).rows[0];
      if (!row || !isDeepStrictEqual(worktreeFromRow(row), input)) throw new Error("worktree observation readback mismatch");
      return worktreeFromRow(row);
    });
  }
  async loadRepository(id: StableId<"repositoryBinding">): Promise<{ readonly binding: RepositoryBindingInput; readonly retired: boolean } | undefined> {
    parseStableId(id, "repositoryBinding");
    const row = (await this.pool.query(`SELECT b.*, EXISTS(SELECT 1 FROM acp.repository_binding_retirements WHERE repository_binding_id=b.repository_binding_id) AS retired
      FROM acp.repository_bindings b WHERE b.repository_binding_id=$1 AND b.host_identifier=$2`, [id,this.authority.hostIdentifier])).rows[0];
    return row ? { binding: repositoryFromRow(row), retired: row.retired === true } : undefined;
  }
  async loadWorktree(id: StableId<"worktreeBinding">): Promise<{ readonly binding: WorktreeBindingInput; readonly retired: boolean } | undefined> {
    parseStableId(id, "worktreeBinding");
    const row = (await this.pool.query(`SELECT b.*, (EXISTS(SELECT 1 FROM acp.worktree_binding_retirements WHERE worktree_binding_id=b.worktree_binding_id)
      OR EXISTS(SELECT 1 FROM acp.repository_binding_retirements WHERE repository_binding_id=b.repository_binding_id)) AS retired
      FROM acp.worktree_bindings b WHERE b.worktree_binding_id=$1 AND b.host_identifier=$2`, [id,this.authority.hostIdentifier])).rows[0];
    return row ? { binding: worktreeFromRow(row), retired: row.retired === true } : undefined;
  }
  retireRepository(id: StableId<"repositoryBinding">, provenanceId: StableId<"provenance">, reason: string): Promise<void> {
    parseStableId(id, "repositoryBinding"); return this.retire("repository_binding_retirements", "repository_binding_id", id, provenanceId, reason);
  }
  retireWorktree(id: StableId<"worktreeBinding">, provenanceId: StableId<"provenance">, reason: string): Promise<void> {
    parseStableId(id, "worktreeBinding"); return this.retire("worktree_binding_retirements", "worktree_binding_id", id, provenanceId, reason);
  }
  private async retire(table: "repository_binding_retirements" | "worktree_binding_retirements", key: "repository_binding_id" | "worktree_binding_id",
    id: string, provenanceId: StableId<"provenance">, reason: string): Promise<void> {
    parseStableId(provenanceId, "provenance");
    if (!reason.trim() || reason.length > 2000) throw new TypeError("bounded filesystem retirement reason required");
    const a = this.authority;
    await withIsolatedTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('acp:filesystem-binding-record:'||$1,0))", [id]);
      const existing = (await client.query(`SELECT * FROM acp.${table} WHERE ${key}=$1`, [id])).rows[0];
      if (existing) {
        if (existing.host_identifier !== a.hostIdentifier || existing.provenance_id !== provenanceId || existing.reason !== reason) throw new Error("filesystem retirement aliases different evidence");
        return;
      }
      await client.query(`INSERT INTO acp.${table}(${key},host_identifier,owner_session_id,application_version,provenance_id,reason)
        VALUES($1,$2,$3,$4,$5,$6)`, [id,a.hostIdentifier,a.sessionId,a.applicationVersion,provenanceId,reason]);
    });
  }
}
function repositoryFromRow(row: QueryResultRow): RepositoryBindingInput {
  return parseRepositoryBinding({ repositoryBindingId: row.repository_binding_id, repositoryId: row.repository_id, projectId: row.project_id,
    machineFingerprint: row.machine_fingerprint, checkout: { path: row.checkout_path, identity: row.checkout_identity },
    commonGitDirectory: { path: row.common_git_directory_path, identity: row.common_git_directory_identity },
    observedAt: (row.observed_at as Date).toISOString(), provenanceId: row.provenance_id });
}
function worktreeFromRow(row: QueryResultRow): WorktreeBindingInput {
  return parseWorktreeBinding({ worktreeBindingId: row.worktree_binding_id, repositoryBindingId: row.repository_binding_id, missionId: row.mission_id,
    workspace: { path: row.workspace_path, identity: row.workspace_identity }, gitDirectory: { path: row.git_directory_path, identity: row.git_directory_identity },
    branchRef: row.branch_ref, headRevision: row.head_revision, observedAt: (row.observed_at as Date).toISOString(), provenanceId: row.provenance_id });
}
