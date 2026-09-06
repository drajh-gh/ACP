import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { it } from "node:test";
import type { Pool, QueryResult, QueryResultRow } from "pg";
import { createStableId } from "@acp/domain";
import { PostgresWorktreeReservationStore } from "../src/worktree-reservation-store.ts";

type Operation = "new reserve" | "historical reserve" | "heartbeat";
class ReservationSession extends EventEmitter {
  readonly options = { connectionTimeoutMillis: 3000, statement_timeout: 5000, lock_timeout: 2000 };
  readonly runtime = { hostIdentifier: "host:reservation-session", sessionId: createStableId("workerHostSession"), applicationVersion: "unit-v1", bindings: [] };
  readonly input = { reservationId: createStableId("worktreeReservation"), repositoryBindingId: createStableId("repositoryBinding"),
    missionId: createStableId("mission"), nodeId: createStableId("node"), graphRevision: "graph:Exact/1", workspacePath: "C:\\ACP pending Ž\\Target",
    branchRef: "refs/heads/Feature/ExactCase", provenanceId: createStableId("provenance") };
  readonly queries: string[] = [];
  readonly releases: (Error | boolean | undefined)[] = [];
  readonly failure = new Error("original reservation session failure");
  readonly rollbackFailure = new Error("rollback must not mask original failure");
  connections = 0; listenerAtRelease = 0;
  failAt?: "BEGIN" | "lock" | "COMMIT";
  emitAt?: "BEGIN" | "lock" | "COMMIT";
  rollbackFails = false;
  row: QueryResultRow | undefined;
  private before: QueryResultRow | undefined;
  private transaction = false;
  readonly operation: Operation;
  constructor(operation: Operation) { super(); this.operation = operation; if (operation !== "new reserve") this.row = this.record(); }
  private record(): QueryResultRow {
    const i = this.input, at = new Date("2026-09-06T10:00:00.000Z");
    return { reservation_id: i.reservationId, repository_binding_id: i.repositoryBindingId, mission_id: i.missionId, node_id: i.nodeId,
      graph_revision: i.graphRevision, workspace_path: i.workspacePath, branch_ref: i.branchRef, provenance_id: i.provenanceId,
      dispatch_run_id: createStableId("run"), dispatch_generation: 2, repository_id: createStableId("repository"), project_id: createStableId("project"),
      project_profile_id: createStableId("projectProfile"), project_profile_version: "1.0.0", host_identifier: this.runtime.hostIdentifier,
      owner_session_id: this.runtime.sessionId, application_version: this.runtime.applicationVersion, machine_fingerprint: "b".repeat(64),
      workspace_key: "workspace:unit", physical_repository_key: "repository:unit", branch_key: "branch:unit", path_key: "path:unit",
      acquired_at: at, heartbeat_at: at, expires_at: new Date(at.getTime() + 20000), revision: 1, state: "held" };
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
      if (this.rollbackFails) throw this.rollbackFailure;
      if (this.transaction) this.row = this.before;
      this.transaction = false;
    } else if (sql.includes("lock_worktree_reservation")) phase = "lock";
    else if (sql.startsWith("SELECT * FROM acp.worktree_reservation_status")) rows = this.row ? [{ ...this.row }] : [];
    else if (sql.startsWith("INSERT INTO acp.worktree_reservations")) this.row = this.record();
    else if (sql.startsWith("UPDATE acp.worktree_reservations")) {
      assert.ok(this.row); this.row = { ...this.row, revision: Number(this.row.revision) + 1 };
      rows = [{ reservation_id: this.input.reservationId }];
    } else throw new Error(`Unexpected reservation query: ${sql}`);
    if (phase === this.emitAt) this.emit("error", this.failure);
    if (phase === this.failAt) throw this.failure;
    return { rows: rows as R[], rowCount: rows.length, command: sql, fields: [], oid: 0 };
  }
  invoke() {
    const store = new PostgresWorktreeReservationStore(this as unknown as Pool, this.runtime);
    return this.operation === "heartbeat" ? store.heartbeat(this.input.reservationId) : store.reserve(this.input);
  }
}
function discarded(session: ReservationSession) {
  assert.deepEqual(session.releases, [true]); assert.equal(session.connections, 1);
  assert.equal(session.listenerAtRelease, 1); assert.equal(session.listenerCount("error"), 0);
}
for (const operation of ["new reserve", "historical reserve", "heartbeat"] as const) {
  it(`reservation ${operation} discards its successful physical session without another operation`, async () => {
    const session = new ReservationSession(operation), result = await session.invoke();
    assert.equal(result.reservationId, session.input.reservationId);
    assert.equal(result.revision, operation === "heartbeat" ? 2 : 1);
    assert.equal(result.branchRef, session.input.branchRef);
    assert.equal(session.queries.filter((sql) => sql === "COMMIT").length, 1);
    assert.equal(session.queries.filter((sql) => sql.startsWith("INSERT")).length, operation === "new reserve" ? 1 : 0);
    assert.equal(session.queries.filter((sql) => sql.startsWith("UPDATE")).length, operation === "heartbeat" ? 1 : 0);
    discarded(session);
  });
  for (const phase of ["BEGIN", "lock", "COMMIT"] as const) {
    it(`reservation ${operation} preserves uncertain ${phase} despite failed rollback without automatic replay`, async () => {
      const session = new ReservationSession(operation); session.failAt = phase; session.rollbackFails = true;
      await assert.rejects(session.invoke(), (error) => error === session.failure);
      assert.equal(session.queries.at(-1), "ROLLBACK"); discarded(session);
      assert.equal(session.row?.revision, operation === "new reserve" && phase !== "COMMIT" ? undefined : operation === "heartbeat" && phase === "COMMIT" ? 2 : 1);
      assert.equal(session.queries.filter((sql) => sql === "BEGIN").length, 1);
    });
    it(`reservation ${operation} fences queries after a physical error during ${phase}`, async () => {
      const session = new ReservationSession(operation); session.emitAt = phase;
      await assert.rejects(session.invoke(), (error) => error === session.failure);
      assert.ok(!session.queries.includes("ROLLBACK"));
      assert.ok(phase === "lock" ? session.queries.at(-1)?.includes("lock_worktree_reservation") : session.queries.at(-1) === phase);
      discarded(session);
    });
  }
}
