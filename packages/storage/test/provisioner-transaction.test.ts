import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { it } from "node:test";
import type { QueryResult, QueryResultRow } from "pg";
import type { ConnectionPool, TransactionClient } from "../src/database.ts";
import { withProvisionerPlanTransaction } from "../src/provisioner-transaction.ts";

class Session extends EventEmitter implements ConnectionPool, TransactionClient {
  readonly queries: string[] = [];
  readonly releases: (Error | boolean | undefined)[] = [];
  readonly primary = new Error("original plan session failure");
  readonly cleanup = new Error("rollback failure must not mask the original");
  failAt?: string;
  emitAt?: string;
  rollbackFails = false;
  listenerAtRelease = 0;
  async connect() { return this; }
  release(discard?: Error | boolean) {
    this.listenerAtRelease = this.listenerCount("error");
    this.releases.push(discard);
    this.emit("error", new Error("socket close while discarding"));
  }
  async query<R extends QueryResultRow>(sql: string): Promise<QueryResult<R>> {
    this.queries.push(sql);
    if (sql === this.emitAt) this.emit("error", this.primary);
    if (sql === this.failAt) throw this.primary;
    if (sql === "ROLLBACK" && this.rollbackFails) throw this.cleanup;
    return { rows: [], rowCount: 0, command: sql, fields: [], oid: 0 };
  }
}
function discarded(session: Session) {
  assert.deepEqual(session.releases, [true]);
  assert.equal(session.listenerAtRelease, 1);
  assert.equal(session.listenerCount("error"), 0);
}
it("provisioner transaction physically discards even a successful exact replay session", async () => {
  const session = new Session();
  const result = await withProvisionerPlanTransaction(session, async (client) => {
    await client.query("historical plan"); return "inert history";
  });
  assert.equal(result, "inert history");
  assert.deepEqual(session.queries, ["BEGIN", "historical plan", "COMMIT"]);
  discarded(session);
});
for (const phase of ["BEGIN", "plan statement", "COMMIT"]) {
  it(`provisioner transaction preserves uncertain ${phase} when rollback also fails`, async () => {
    const session = new Session(); session.failAt = phase; session.rollbackFails = true;
    await assert.rejects(withProvisionerPlanTransaction(session, async (client) => {
      await client.query("plan statement"); return "not confirmed";
    }), (error) => error === session.primary);
    assert.equal(session.queries.at(-1), "ROLLBACK");
    if (phase !== "COMMIT") assert.ok(!session.queries.includes("COMMIT"));
    discarded(session);
  });
}
for (const phase of ["BEGIN", "plan statement", "COMMIT"]) {
  it(`provisioner transaction denies a successful query response after a physical error during ${phase}`, async () => {
    const session = new Session(); session.emitAt = phase; session.rollbackFails = true;
    await assert.rejects(withProvisionerPlanTransaction(session, async (client) => {
      await client.query("plan statement"); return "not confirmed";
    }), (error) => error === session.primary);
    assert.equal(session.queries.at(-1), phase);
    assert.ok(!session.queries.includes("ROLLBACK"), "a known failed physical session receives no further query");
    discarded(session);
  });
}
it("provisioner transaction observes socket loss between statements before issuing COMMIT", async () => {
  const session = new Session();
  await assert.rejects(withProvisionerPlanTransaction(session, async () => {
    session.emit("error", session.primary); return "not confirmed";
  }), (error) => error === session.primary);
  assert.deepEqual(session.queries, ["BEGIN"]); discarded(session);
});
