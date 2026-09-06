import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { it } from "node:test";
import type { Pool, QueryResult, QueryResultRow } from "pg";
import { createStableId } from "@acp/domain";
import { PostgresRepositoryBindingStore } from "../src/repository-binding-store.ts";

type Operation = "recordRepository" | "recordWorktree" | "retireRepository" | "retireWorktree";
class RegistrySession extends EventEmitter {
  readonly options = { connectionTimeoutMillis: 3000, statement_timeout: 5000, lock_timeout: 2000 };
  readonly runtime = { hostIdentifier: "host:registry-session", sessionId: createStableId("workerHostSession"), applicationVersion: "unit-v1", bindings: [] };
  readonly repository = { repositoryBindingId: createStableId("repositoryBinding"), repositoryId: createStableId("repository"), projectId: createStableId("project"),
    machineFingerprint: "a".repeat(64), checkout: { path: "C:\\ACP registry Ž\\Repo", identity: "win32-dir:12345678:0000000000000001" },
    commonGitDirectory: { path: "C:\\ACP registry Ž\\Repo\\.git", identity: "win32-dir:12345678:0000000000000002" },
    observedAt: "2026-09-06T12:00:00.000Z", provenanceId: createStableId("provenance") };
  readonly worktree = { worktreeBindingId: createStableId("worktreeBinding"), repositoryBindingId: this.repository.repositoryBindingId,
    missionId: createStableId("mission"), workspace: { path: "C:\\ACP registry Ž\\Task", identity: "win32-dir:12345678:0000000000000003" },
    gitDirectory: { path: this.repository.commonGitDirectory.path + "\\worktrees\\task", identity: "win32-dir:12345678:0000000000000004" },
    branchRef: "refs/heads/Feature/ExactCase", headRevision: "b".repeat(40), observedAt: this.repository.observedAt, provenanceId: createStableId("provenance") };
  readonly actor = createStableId("provenance");
  readonly reason = "Exact retained retirement.";
  readonly queries: string[] = [];
  readonly releases: (Error | boolean | undefined)[] = [];
  readonly failure = new Error("original registry transaction failure");
  readonly cleanupFailure = new Error("rollback must not mask registry failure");
  readonly operation: Operation;
  row: QueryResultRow | undefined;
  private before: QueryResultRow | undefined;
  private transaction = false;
  connections = 0; listenerAtRelease = 0;
  failAt?: "BEGIN" | "lock" | "COMMIT";
  emitAt?: "BEGIN" | "lock" | "COMMIT";
  rollbackFails = false;
  constructor(operation: Operation, historical = false) { super(); this.operation = operation; if (historical) this.row = this.record(); }
  private record(): QueryResultRow {
    const r = this.repository, w = this.worktree;
    if (this.operation === "recordRepository") return { repository_binding_id: r.repositoryBindingId, repository_id: r.repositoryId, project_id: r.projectId,
      host_identifier: this.runtime.hostIdentifier, machine_fingerprint: r.machineFingerprint, checkout_path: r.checkout.path, checkout_identity: r.checkout.identity,
      common_git_directory_path: r.commonGitDirectory.path, common_git_directory_identity: r.commonGitDirectory.identity,
      observed_at: new Date(r.observedAt), provenance_id: r.provenanceId };
    if (this.operation === "recordWorktree") return { worktree_binding_id: w.worktreeBindingId, repository_binding_id: w.repositoryBindingId, mission_id: w.missionId,
      host_identifier: this.runtime.hostIdentifier, workspace_path: w.workspace.path, workspace_identity: w.workspace.identity,
      git_directory_path: w.gitDirectory.path, git_directory_identity: w.gitDirectory.identity, branch_ref: w.branchRef, head_revision: w.headRevision,
      observed_at: new Date(w.observedAt), provenance_id: w.provenanceId };
    return { host_identifier: this.runtime.hostIdentifier, provenance_id: this.actor, reason: this.reason };
  }
  async connect() { this.connections++; return this; }
  release(discard?: Error | boolean) {
    this.listenerAtRelease = this.listenerCount("error"); this.releases.push(discard);
    if (discard && this.transaction) { this.row = this.before; this.transaction = false; }
    if (this.listenerAtRelease) this.emit("error", new Error("physical close notification"));
  }
  async query<R extends QueryResultRow>(sql: string): Promise<QueryResult<R>> {
    this.queries.push(sql); let phase: string = sql; let rows: QueryResultRow[] = [];
    if (sql === "BEGIN") { this.before = this.row && { ...this.row }; this.transaction = true; }
    else if (sql === "COMMIT") this.transaction = false;
    else if (sql === "ROLLBACK") {
      if (this.rollbackFails) throw this.cleanupFailure;
      if (this.transaction) this.row = this.before;
      this.transaction = false;
    } else if (sql.includes("pg_advisory_xact_lock")) phase = "lock";
    else if (sql.startsWith("SELECT * FROM acp.")) rows = this.row ? [{ ...this.row }] : [];
    else if (sql.startsWith("INSERT INTO acp.repositories(")) { /* Its encompassing transaction owns the logical parent too. */ }
    else if (sql.startsWith("INSERT INTO acp.")) { this.row = this.record(); rows = [{ ...this.row }]; }
    else throw new Error(`Unexpected registry query: ${sql}`);
    if (phase === this.emitAt) this.emit("error", this.failure);
    if (phase === this.failAt) throw this.failure;
    return { rows: rows as R[], rowCount: rows.length, command: sql, fields: [], oid: 0 };
  }
  invoke() {
    const store = new PostgresRepositoryBindingStore(this as unknown as Pool, this.runtime);
    switch (this.operation) {
      case "recordRepository": return store.recordRepository(this.repository);
      case "recordWorktree": return store.recordWorktree(this.worktree);
      case "retireRepository": return store.retireRepository(this.repository.repositoryBindingId, this.actor, this.reason);
      case "retireWorktree": return store.retireWorktree(this.worktree.worktreeBindingId, this.actor, this.reason);
    }
  }
}
function discarded(session: RegistrySession) {
  assert.deepEqual(session.releases, [true]); assert.equal(session.connections, 1);
  assert.equal(session.listenerAtRelease, 1); assert.equal(session.listenerCount("error"), 0);
}
for (const operation of ["recordRepository", "recordWorktree", "retireRepository", "retireWorktree"] as const) {
  for (const historical of [false, true]) {
    it(`registry ${operation} ${historical ? "replays history" : "records once"} on a discarded physical session`, async () => {
      const session = new RegistrySession(operation, historical), result = await session.invoke();
      assert.deepEqual(result, operation === "recordRepository" ? session.repository : operation === "recordWorktree" ? session.worktree : undefined);
      assert.equal(session.queries.filter((sql) => sql === "COMMIT").length, 1);
      assert.equal(session.queries.filter((sql) => sql.startsWith("INSERT")).length, historical ? 0 : operation === "recordRepository" ? 2 : 1);
      discarded(session);
    });
  }
  for (const phase of ["BEGIN", "lock", "COMMIT"] as const) {
    it(`registry ${operation} preserves uncertain ${phase} despite failed rollback without automatic replay`, async () => {
      const session = new RegistrySession(operation); session.failAt = phase; session.rollbackFails = true;
      await assert.rejects(session.invoke(), (error) => error === session.failure);
      assert.equal(session.queries.at(-1), "ROLLBACK"); assert.equal(Boolean(session.row), phase === "COMMIT"); discarded(session);
    });
    it(`registry ${operation} rejects a query response after a physical error during ${phase}`, async () => {
      const session = new RegistrySession(operation); session.emitAt = phase;
      await assert.rejects(session.invoke(), (error) => error === session.failure);
      assert.ok(!session.queries.includes("ROLLBACK"));
      assert.ok(phase === "lock" ? session.queries.at(-1)?.includes("pg_advisory_xact_lock") : session.queries.at(-1) === phase);
      discarded(session);
    });
  }
}
