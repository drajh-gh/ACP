import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { it } from "node:test";
import type { Pool, QueryResult, QueryResultRow } from "pg";
import { createStableId } from "@acp/domain";
import { PostgresFilesystemWriterStore } from "../src/filesystem-writer-store.ts";

type Operation = "new reserve" | "historical reserve" | "heartbeat" | "new release" | "historical release";
class WriterSession extends EventEmitter {
  readonly options = { connectionTimeoutMillis: 3000, statement_timeout: 5000, lock_timeout: 2000 };
  readonly runtime = { hostIdentifier: "host:writer-session", sessionId: createStableId("workerHostSession"), applicationVersion: "unit-v1", bindings: [] };
  readonly input = { leaseId: createStableId("lease"), runId: createStableId("run"), workerProcessId: createStableId("workerProcess"),
    worktreeBindingId: createStableId("worktreeBinding"), provenanceId: createStableId("provenance") };
  readonly queries: string[] = [];
  readonly releases: (Error | boolean | undefined)[] = [];
  readonly failure = new Error("original writer session failure");
  readonly rollbackFailure = new Error("rollback must not mask original failure");
  connections = 0; listenerAtRelease = 0; receipts = 0; provenances = 0;
  failAt?: "BEGIN" | "lock" | "COMMIT";
  emitAt?: "BEGIN" | "lock" | "COMMIT";
  rollbackFails = false;
  row: QueryResultRow | undefined;
  private before: QueryResultRow | undefined;
  private beforeReceipts = 0;
  private beforeProvenances = 0;
  private transaction = false;
  readonly operation: Operation;
  constructor(operation: Operation) {
    super(); this.operation = operation;
    if (operation !== "new reserve") this.row = this.record();
    if (operation === "historical release") this.markReleased();
  }
  private record(): QueryResultRow {
    const i = this.input, at = new Date("2026-09-06T10:00:00.000Z");
    return { lease_id: i.leaseId, run_id: i.runId, worker_process_id: i.workerProcessId, worktree_binding_id: i.worktreeBindingId,
      provenance_id: i.provenanceId, repository_binding_id: createStableId("repositoryBinding"), host_identifier: this.runtime.hostIdentifier,
      owner_session_id: this.runtime.sessionId, application_version: this.runtime.applicationVersion, workspace_key: "workspace:unit",
      physical_workspace_key: "physical:workspace", physical_repository_key: "physical:repository", branch_key: "branch:Exact/Case",
      acquired_at: at, heartbeat_at: at, expires_at: new Date(at.getTime() + 20000), revision: 1, released_at: null, state: "active" };
  }
  private markReleased() {
    assert.ok(this.row); this.row = { ...this.row, revision: Number(this.row.revision) + 1, state: "released", released_at: new Date("2026-09-06T10:00:01.000Z") };
    this.receipts++; this.provenances++;
  }
  private rollback() { this.row = this.before; this.receipts = this.beforeReceipts; this.provenances = this.beforeProvenances; this.transaction = false; }
  async connect() { this.connections++; return this; }
  release(discard?: Error | boolean) {
    this.listenerAtRelease = this.listenerCount("error"); this.releases.push(discard);
    if (discard && this.transaction) this.rollback();
    if (this.listenerAtRelease) this.emit("error", new Error("physical close notification"));
  }
  async query<R extends QueryResultRow>(sql: string): Promise<QueryResult<R>> {
    this.queries.push(sql); let phase: string = sql; let rows: QueryResultRow[] = [];
    if (sql === "BEGIN") { this.before = this.row && { ...this.row }; this.beforeReceipts = this.receipts; this.beforeProvenances = this.provenances; this.transaction = true; }
    else if (sql === "COMMIT") this.transaction = false;
    else if (sql === "ROLLBACK") { if (this.rollbackFails) throw this.rollbackFailure; if (this.transaction) this.rollback(); }
    else if (sql.includes("lock_filesystem_writer")) phase = "lock";
    else if (sql.startsWith("SELECT * FROM acp.filesystem_writer_lease_status")) rows = this.row ? [{ ...this.row }] : [];
    else if (sql.startsWith("SELECT 1 FROM acp.filesystem_writer_leases")) rows = this.row ? [{}] : [];
    else if (sql.startsWith("SELECT 1 FROM acp.filesystem_writer_releases")) rows = this.receipts ? [{}] : [];
    else if (sql.startsWith("SELECT acp.make_filesystem_writer_release_provenance")) rows = [{ id: createStableId("provenance") }];
    else if (sql.startsWith("INSERT INTO acp.filesystem_writer_releases")) this.markReleased();
    else if (sql.startsWith("INSERT INTO acp.filesystem_writer_leases")) this.row = this.record();
    else if (sql.startsWith("UPDATE acp.filesystem_writer_leases")) {
      assert.ok(this.row); this.row = { ...this.row, revision: Number(this.row.revision) + 1 };
      rows = [{ lease_id: this.input.leaseId }];
    } else throw new Error(`Unexpected writer query: ${sql}`);
    if (phase === this.emitAt) this.emit("error", this.failure);
    if (phase === this.failAt) throw this.failure;
    return { rows: rows as R[], rowCount: rows.length, command: sql, fields: [], oid: 0 };
  }
  invoke() {
    const store = new PostgresFilesystemWriterStore(this as unknown as Pool, this.runtime);
    return this.operation === "heartbeat" ? store.heartbeat(this.input.leaseId)
      : this.operation.endsWith("release") ? store.release(this.input.leaseId) : store.reserve(this.input);
  }
}
function discarded(session: WriterSession) {
  assert.deepEqual(session.releases, [true]); assert.equal(session.connections, 1);
  assert.equal(session.listenerAtRelease, 1); assert.equal(session.listenerCount("error"), 0);
}
function retained(session: WriterSession, committed: boolean) {
  const op = session.operation, released = op === "historical release" || (committed && op === "new release");
  assert.equal(session.row?.revision, op === "new reserve" && !committed ? undefined : released || (committed && op === "heartbeat") ? 2 : 1);
  assert.equal(session.receipts, released ? 1 : 0); assert.equal(session.provenances, released ? 1 : 0);
}
for (const operation of ["new reserve", "historical reserve", "heartbeat", "new release", "historical release"] as const) {
  it(`writer ${operation} discards its successful session without replay or duplicate history`, async () => {
    const session = new WriterSession(operation), result = await session.invoke();
    assert.equal(result.leaseId, session.input.leaseId); assert.equal(result.branchKey, "branch:Exact/Case");
    assert.equal(session.queries.filter((sql) => sql === "BEGIN").length, 1);
    assert.equal(session.queries.filter((sql) => sql === "COMMIT").length, 1);
    assert.equal(session.queries.filter((sql) => sql.startsWith("INSERT")).length, operation.startsWith("new") ? 1 : 0);
    assert.equal(session.queries.filter((sql) => sql.startsWith("UPDATE")).length, operation === "heartbeat" ? 1 : 0);
    assert.equal(session.queries.filter((sql) => sql.startsWith("SELECT acp.make_")).length, operation === "new release" ? 1 : 0);
    retained(session, true); discarded(session);
  });
  for (const phase of ["BEGIN", "lock", "COMMIT"] as const) {
    it(`writer ${operation} preserves uncertain ${phase} despite failed rollback without automatic replay`, async () => {
      const session = new WriterSession(operation); session.failAt = phase; session.rollbackFails = true;
      await assert.rejects(session.invoke(), (error) => error === session.failure);
      assert.equal(session.queries.at(-1), "ROLLBACK"); discarded(session); retained(session, phase === "COMMIT");
      assert.equal(session.queries.filter((sql) => sql === "BEGIN").length, 1);
    });
    it(`writer ${operation} fences queries after a physical error during ${phase}`, async () => {
      const session = new WriterSession(operation); session.emitAt = phase;
      await assert.rejects(session.invoke(), (error) => error === session.failure);
      assert.ok(!session.queries.includes("ROLLBACK"));
      assert.ok(phase === "lock" ? session.queries.at(-1)?.includes("lock_filesystem_writer") : session.queries.at(-1) === phase);
      discarded(session); retained(session, phase === "COMMIT");
    });
  }
}
