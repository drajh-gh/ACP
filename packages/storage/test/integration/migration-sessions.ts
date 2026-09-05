import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { applyMigrations, rollbackMigrations, type ConnectionPool } from "../../src/index.ts";
const port=Number(process.argv[2]); if (!Number.isInteger(port) || port<1024 || port>65535) throw new Error("owned database port required");
const configuration={ max:3,statement_timeout:5000,lock_timeout:3000,connectionTimeoutMillis:3000 };
const admin=new Pool({ ...configuration,connectionString:`postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test` });
const pool=new Pool({ ...configuration,connectionString:`postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_migration_session_probe` });
const directory=fileURLToPath(new URL("../fixtures/migration-session",import.meta.url));
let created=false,checks=0;
type Fault="lock"|"BEGIN"|"sql"|"record"|"COMMIT"|"connection"|undefined;
function intercepted(fault: Fault, reentrant=false) {
  let pid=0,releases=0; const queries: string[]=[],discard: (Error|boolean|undefined)[]=[];
  const connection: ConnectionPool={ query:pool.query.bind(pool),async connect() {
    const client=await pool.connect(); pid=(await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    if (reentrant) await client.query("SELECT pg_advisory_lock(hashtext('acp:schema-migrations'))");
    return { on:client.on.bind(client),off:client.off.bind(client),release:(error?: Error|boolean) => { releases++; discard.push(error); client.release(error); },
      async query<R extends QueryResultRow>(text: string,values?: unknown[]): Promise<QueryResult<R>> {
        queries.push(text); const result=await client.query<R>(text,values);
        const phase=text.includes("pg_advisory_lock") ? "lock" : text==="BEGIN" ? "BEGIN" : text==="COMMIT" ? "COMMIT"
          : text.startsWith("CREATE SCHEMA") || text.startsWith("DROP TABLE") ? "sql"
          : text.startsWith("INSERT INTO acp.schema_migrations") || text.startsWith("DELETE FROM acp.schema_migrations") ? "record" : undefined;
        if (fault==="connection" && phase==="lock") {
          await admin.query("SELECT pg_terminate_backend($1)",[pid]);
          return client.query<R>("SELECT 1"); // The actual dead connection must reject.
        }
        if (fault!==undefined && phase===fault) throw new Error(`synthetic lost ${fault} acknowledgement`);
        return result;
      } };
  } };
  return { connection,queries,get pid() { return pid; },get releases() { return releases; },discard };
}
async function closed(probe: ReturnType<typeof intercepted>) {
  const until=Date.now()+2000; let remains=true;
  while (Date.now()<until) {
    remains=(await admin.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS remains",[probe.pid])).rows[0].remains;
    if (!remains) break; await new Promise((done) => setTimeout(done,10));
  }
  assert.equal(remains,false,"migration physical backend must close"); assert.equal(probe.releases,1); assert.deepEqual(probe.discard,[true]);
  assert.ok(!probe.queries.some((q) => q.includes("pg_advisory_unlock") || q==="ROLLBACK"));
  const client=await pool.connect(); // Advisory locks are scoped to this exact database.
  try {
    assert.equal((await client.query("SELECT pg_try_advisory_lock(hashtext('acp:schema-migrations')) AS acquired")).rows[0].acquired,true);
    assert.equal((await client.query("SELECT pg_advisory_unlock(hashtext('acp:schema-migrations')) AS released")).rows[0].released,true);
  } finally { client.release(); }
}
try {
  await admin.query("CREATE DATABASE acp_migration_session_probe"); created=true;
  for (const direction of ["apply","rollback"] as const) {
    for (const fault of [undefined,"lock","BEGIN","sql","record","COMMIT","connection"] as const) {
      if (direction==="rollback") await applyMigrations(pool,directory);
      const probe=intercepted(fault,true),action=direction==="apply" ? applyMigrations(probe.connection,directory) : rollbackMigrations(probe.connection,directory);
      if (fault===undefined) await action; else await assert.rejects(action);
      await closed(probe);
      if (fault==="COMMIT") {
        if (direction==="apply") assert.deepEqual(await applyMigrations(pool,directory),{ applied:[],alreadyApplied:["0001"] });
        else assert.deepEqual(await rollbackMigrations(pool,directory),[]);
      }
      await rollbackMigrations(pool,directory);
      assert.equal((await admin.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=$1) AS held",[probe.pid])).rows[0].held,false);
      checks++; process.stdout.write(`PASS migration session: ${direction} ${fault ?? "success"} closes exact backend and all reentrant locks\n`);
    }
    for (const key of ["checksum_sha256","down_checksum_sha256"] as const) {
      await applyMigrations(pool,directory);
      const original=(await pool.query(`SELECT ${key} AS checksum FROM acp.schema_migrations WHERE version='0001'`)).rows[0].checksum;
      await pool.query(`UPDATE acp.schema_migrations SET ${key}='different' WHERE version='0001'`);
      const probe=intercepted(undefined);
      await assert.rejects(direction==="apply" ? applyMigrations(probe.connection,directory) : rollbackMigrations(probe.connection,directory),/different checksum/u);
      await closed(probe);
      assert.equal((await pool.query("SELECT count(*)::integer AS count FROM acp.migration_session_probe")).rows[0].count,1);
      await pool.query(`UPDATE acp.schema_migrations SET ${key}=$1 WHERE version='0001'`,[original]);
      await rollbackMigrations(pool,directory);
      checks++; process.stdout.write(`PASS migration session: ${direction} ${key} mismatch closes backend without schema mutation\n`);
    }
  }
  const incumbent=await pool.connect(),left=intercepted(undefined),right=intercepted(undefined);
  let pending: Promise<unknown>[]=[];
  try {
    await incumbent.query("SELECT pg_advisory_lock(hashtext('acp:schema-migrations'))");
    const results=[applyMigrations(left.connection,directory),applyMigrations(right.connection,directory)]; pending=results;
    for (const action of results) void action.catch(() => {});
    const until=Date.now()+1500; let waiters=0;
    while (Date.now()<until) {
      waiters=(await admin.query("SELECT count(*)::integer AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted AND pid=ANY($1)",[[left.pid,right.pid]])).rows[0].count;
      if (waiters===2) break; await new Promise((done) => setTimeout(done,10));
    }
    assert.equal(waiters,2,"both runners must wait on the existing lock namespace");
    await incumbent.query("SELECT pg_advisory_unlock(hashtext('acp:schema-migrations'))");
    const completed=await Promise.all(results);
    assert.equal(completed.filter((r) => r.applied.length===1).length,1);
    assert.equal(completed.filter((r) => r.alreadyApplied.length===1).length,1);
    await closed(left); await closed(right);
    await rollbackMigrations(pool,directory);
    checks++; process.stdout.write("PASS migration session: concurrent runners share the incumbent lock and commit one migration\n");
  } finally { incumbent.release(true); await Promise.allSettled(pending); }
  const actualMigrations=fileURLToPath(new URL("../../migrations",import.meta.url));
  const applied=await applyMigrations(pool,actualMigrations);
  assert.equal(applied.applied.length,14); assert.equal(applied.alreadyApplied.length,0);
  assert.deepEqual(await applyMigrations(pool,actualMigrations),{ applied:[],alreadyApplied:applied.applied });
  assert.deepEqual(await rollbackMigrations(pool,actualMigrations),[...applied.applied].reverse());
  assert.equal((await pool.query("SELECT to_regnamespace('acp') IS NULL AS absent")).rows[0].absent,true);
  checks++; process.stdout.write("PASS migration session: all 14 actual migrations apply, checksum-replay and reverse on an empty database\n");
  process.stdout.write(`Migration session integration: ${checks} checks passed.\n`);
} finally {
  await pool.end();
  if (created) await admin.query("DROP DATABASE acp_migration_session_probe");
  await admin.end();
}
