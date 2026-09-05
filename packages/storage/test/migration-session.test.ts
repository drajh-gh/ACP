import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import type { QueryResult, QueryResultRow } from "pg";
import { applyMigrations, rollbackMigrations, type ConnectionPool, type TransactionClient } from "../src/index.ts";
const directory=fileURLToPath(new URL("./fixtures/migration-session",import.meta.url));
type Failure="lock"|"BEGIN"|"sql"|"record"|"COMMIT"|"connection";
class MigrationSession extends EventEmitter implements ConnectionPool,TransactionClient {
  readonly queries: string[]=[]; readonly releases: (Error|boolean|undefined)[]=[];
  schema=false; record: QueryResultRow|undefined; transaction: { schema:boolean;record:QueryResultRow|undefined }|undefined;
  fail: Failure|undefined; migrationStatements=0;
  async connect() { return this; }
  release(discard?: Error|boolean) {
    this.releases.push(discard);
    if (this.transaction) { this.schema=this.transaction.schema; this.record=this.transaction.record; this.transaction=undefined; }
  }
  async query<R extends QueryResultRow>(text: string,values?: unknown[]): Promise<QueryResult<R>> {
    this.queries.push(text); let phase: Failure|undefined; let rows: QueryResultRow[]=[];
    if (text.includes("pg_advisory_lock")) phase="lock";
    else if (text==="BEGIN") { this.transaction={ schema:this.schema,record:this.record }; phase="BEGIN"; }
    else if (text==="COMMIT") { this.transaction=undefined; phase="COMMIT"; }
    else if (text.includes("to_regclass")) { rows=[{ exists:this.schema }]; phase="connection"; }
    else if (text.startsWith("SELECT checksum_sha256")) rows=this.record ? [this.record] : [];
    else if (text.startsWith("CREATE SCHEMA")) { this.migrationStatements++; this.schema=true; phase="sql"; }
    else if (text.startsWith("DROP TABLE")) { this.migrationStatements++; this.schema=false; this.record=undefined; phase="sql"; }
    else if (text.startsWith("INSERT INTO acp.schema_migrations")) { this.record={ checksum_sha256:values![2],down_checksum_sha256:values![3] }; phase="record"; }
    else if (text.startsWith("DELETE FROM acp.schema_migrations")) { this.record=undefined; phase="record"; }
    else throw new Error(`unexpected migration query: ${text}`);
    if (phase===this.fail && phase!==undefined) {
      this.fail=undefined; const error=new Error(`uncertain ${phase}`);
      if (phase==="connection") this.emit("error",error); else throw error;
    }
    return { rows:rows as R[],rowCount:rows.length,command:"SELECT",oid:0,fields:[] };
  }
}
for (const direction of ["apply","rollback"] as const) {
  it(`${direction} migration always destroys its physical session, including successful replay`,async () => {
    const pool=new MigrationSession(); await applyMigrations(pool,directory);
    if (direction==="apply") assert.deepEqual(await applyMigrations(pool,directory),{ applied:[],alreadyApplied:["0001"] });
    else { assert.deepEqual(await rollbackMigrations(pool,directory),["0001"]); assert.deepEqual(await rollbackMigrations(pool,directory),[]); }
    assert.ok(pool.releases.every((r) => r===true)); assert.equal(pool.listenerCount("error"),0);
    assert.ok(!pool.queries.some((q) => q.includes("pg_advisory_unlock")));
  });
  it(`${direction} checksum rejection destroys the session without running a migration`,async () => {
    for (const key of ["checksum_sha256","down_checksum_sha256"]) {
      const pool=new MigrationSession(); await applyMigrations(pool,directory);
      const statements=pool.migrationStatements; pool.record={ ...pool.record,[key]:"different" };
      await assert.rejects(direction==="apply" ? applyMigrations(pool,directory) : rollbackMigrations(pool,directory),/different checksum/u);
      assert.equal(pool.migrationStatements,statements); assert.equal(pool.releases.at(-1),true); assert.equal(pool.listenerCount("error"),0);
    }
  });
  for (const phase of ["lock","BEGIN","sql","record","COMMIT","connection"] as const) {
    it(`${direction} migration destroys the session after an uncertain ${phase} without cleanup queries`,async () => {
      const pool=new MigrationSession();
      if (direction==="rollback") await applyMigrations(pool,directory);
      const released=pool.releases.length; pool.fail=phase;
      await assert.rejects(direction==="apply" ? applyMigrations(pool,directory) : rollbackMigrations(pool,directory),new RegExp(`uncertain ${phase}`,"u"));
      assert.equal(pool.releases.length,released+1); assert.equal(pool.releases.at(-1),true); assert.equal(pool.transaction,undefined);
      assert.equal(pool.listenerCount("error"),0); assert.ok(!pool.queries.includes("ROLLBACK"));
      const statements=pool.migrationStatements;
      if (phase==="COMMIT") {
        if (direction==="apply") assert.deepEqual(await applyMigrations(pool,directory),{ applied:[],alreadyApplied:["0001"] });
        else assert.deepEqual(await rollbackMigrations(pool,directory),[]);
        assert.equal(pool.migrationStatements,statements,"lost commit replay must not execute the migration again");
      }
    });
  }
}
