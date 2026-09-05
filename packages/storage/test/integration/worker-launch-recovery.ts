import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { launchRecoveryFixture } from "./launch-recovery-fixture.ts";
import { PostgresWorkerLaunchStore } from "../../src/worker-launch-store.ts";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("owned database port required");
const pool = new Pool({ connectionString: `postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test`, max: 4,
  statement_timeout: 5000, lock_timeout: 3000, connectionTimeoutMillis: 3000 });
let checks = 0;
async function check(name: string, action: () => Promise<void>) { await action(); checks++; process.stdout.write(`PASS launch recovery: ${name}\n`); }
const signal = () => new AbortController().signal;
try {
  const f = await launchRecoveryFixture(pool);
  await check("owner process completion and sealed receipt commit together before result projection", async () => {
    const s = await f.sample(true);
    await assert.rejects(f.workers.finishWorkerProcess({ ...s.registration, state: "terminated", exitCode: 137,
      terminationReason: "Missing sealed receipt." }), /must commit together/u);
    assert.equal((await f.workers.loadWorkerProcess(s.registration.workerProcessId))?.state, "running");
    await s.finishOwner(); await s.finishOwner();
    assert.equal((await f.launches.listCandidates()).some((c) => c.runId === s.a.runId), false);
    assert.equal(await s.finishRun(), true);
    assert.equal(await s.handoff(), "terminal");
    assert.equal((await pool.query("SELECT state FROM acp.mission_nodes WHERE node_id=$1", [s.a.nodeId])).rows[0].state, "failed");
  });
  await check("a no-journal current-owner handoff seals under a fresh claim and projects without a fake journal", async () => {
    const s = await f.sample(); assert.equal(await s.handoff(), "handed_off"); assert.equal(await s.handoff(), "handed_off");
    await assert.rejects(f.workers.recordWorkerProcessFromRun(s.registration), /revoked launch/u);
    await assert.rejects(s.finishRun(), /fresh current recovery failure/u);
    const prepared = await f.launches.prepare(s.candidate); assert.ok(prepared?.claim);
    assert.notEqual(prepared.provenanceId, s.start.provenanceId);
    assert.equal(await f.launches.prepare(s.candidate), undefined);
    assert.equal(await f.launches.observe(prepared.claim, async (claim) => {
      assert.deepEqual(claim.intent, s.start.launchIntent);
      return { state: "lost", sealed: true, reason: "sealed_launch_job_absent" };
    }, signal()), "stopped");
    assert.equal(await f.launches.recover(s.a.runId, prepared.provenanceId), "recovered");
    assert.equal((await pool.query("SELECT 1 FROM acp.worker_processes WHERE run_id=$1", [s.a.runId])).rowCount, 0);
    assert.equal((await pool.query("SELECT state FROM acp.worker_runs WHERE run_id=$1", [s.a.runId])).rows[0].state, "failed");
    assert.equal((await pool.query("SELECT 1 FROM acp.worker_run_recovery_handoffs WHERE run_id=$1", [s.a.runId])).rowCount, 0);
  });
  await check("resolved no-journal evidence still refuses an incompatible downgrade", async () => {
    assert.equal((await pool.query("SELECT 1 FROM acp.worker_runs WHERE launch_worker_process_id IS NOT NULL AND state='started'")).rowCount, 0);
    const client = await pool.connect();
    try { await client.query("BEGIN"); await assert.rejects(client.query(await readFile(new URL("../../migrations/0012_worker_launch_recovery.down.sql", import.meta.url), "utf8")), /independent legacy-compatible stop journals/u); }
    finally { await client.query("ROLLBACK"); client.release(); }
  });
  await check("revoked journal recovery rejects mismatched roots and atomically closes the exact root", async () => {
    const s = await f.sample(true); await s.handoff();
    const prepared = await f.launches.prepare(s.candidate); assert.ok(prepared?.claim);
    const root = { processId: s.registration.processId, processStartToken: s.registration.processStartToken, startedAt: s.registration.startedAt };
    const contradictory = await pool.connect();
    try {
      await contradictory.query("SELECT pg_advisory_lock(hashtextextended('acp:worker-launch-reconciliation:' || $1,0))", [s.candidate.workerProcessId]);
      await contradictory.query("BEGIN"); await contradictory.query("SELECT acp.lock_worker_launch($1)", [s.a.runId]);
      await contradictory.query(`UPDATE acp.worker_processes SET state='terminated',exit_code=137,completed_at=clock_timestamp(),
        termination_reason='Contradictory synthetic evidence.',transition_provenance_id=$2 WHERE worker_process_id=$1`, [s.candidate.workerProcessId, prepared.provenanceId]);
      await contradictory.query(`INSERT INTO acp.worker_launch_stops(run_id,actor_kind,owner_session_id,application_version,provenance_id,
        reconciliation_id,launch_sealed,process_state,reason,root_process_id,root_process_start_token,root_started_at)
        VALUES($1,'recovery',$2,$3,$4,$5,true,'lost','owned_job_empty',$6,$7,$8)`,
      [s.a.runId,f.runtime.sessionId,f.runtime.applicationVersion,prepared.provenanceId,prepared.claim.reconciliationId,
        root.processId,root.processStartToken,root.startedAt]);
      await assert.rejects(contradictory.query("COMMIT"), /must commit together/u);
    } finally {
      await contradictory.query("ROLLBACK");
      await contradictory.query("SELECT pg_advisory_unlock(hashtextextended('acp:worker-launch-reconciliation:' || $1,0))", [s.candidate.workerProcessId]);
      contradictory.release();
    }
    await assert.rejects(f.launches.observe(prepared.claim, async () => ({ state: "terminated", sealed: true,
      exitCode: 137, reason: "exact_owned_tree_terminated", root: { ...root, processId: root.processId + 1 } }), signal()), /exact journal/u);
    assert.equal((await f.workers.loadWorkerProcess(s.registration.workerProcessId))?.state, "running");
    assert.equal((await pool.query("SELECT 1 FROM acp.worker_launch_stops WHERE run_id=$1", [s.a.runId])).rowCount, 0);
    await assert.rejects(s.finishOwner(), /revoked launch owner/u);
    assert.equal(await f.launches.observe(prepared.claim, async () => ({ state: "terminated", sealed: true,
      exitCode: 0, reason: "exact_owned_tree_terminated", root }), signal()), "stopped");
    const record = await f.workers.loadWorkerProcess(s.registration.workerProcessId);
    assert.equal(record?.state, "terminated"); assert.equal(record?.exitCode, 0);
    assert.equal(record?.transitionProvenanceId, prepared.provenanceId);
    assert.equal(await f.launches.recover(s.a.runId, prepared.provenanceId), "recovered");
    assert.equal(await f.launches.recover(s.a.runId, prepared.provenanceId), "already_terminal");
  });
  await check("a receipt requires its held physical session and all recovery evidence is immutable", async () => {
    const s = await f.sample(); await s.handoff();
    const prepared = await f.launches.prepare(s.candidate); assert.ok(prepared?.claim);
    await assert.rejects(pool.query(`INSERT INTO acp.worker_launch_stops(run_id,actor_kind,owner_session_id,application_version,
      provenance_id,reconciliation_id,launch_sealed,process_state,reason) VALUES($1,'recovery',$2,$3,$4,$5,true,'lost','sealed_launch_job_absent')`,
    [s.a.runId, f.runtime.sessionId, f.runtime.applicationVersion, prepared.provenanceId, prepared.claim.reconciliationId]), /held live recovery claim/u);
    await f.launches.observe(prepared.claim, async () => ({ state: "lost", sealed: true, reason: "sealed_launch_job_absent" }), signal());
    for (const table of ["worker_launch_revocations", "worker_launch_claims", "worker_launch_stops"]) {
      for (const sql of [`UPDATE acp.${table} SET run_id=run_id WHERE run_id=$1`, `DELETE FROM acp.${table} WHERE run_id=$1`]) {
        await assert.rejects(pool.query(sql, [s.a.runId]), /append-only/u);
      }
      await assert.rejects(pool.query(`TRUNCATE acp.${table} CASCADE`), /append-only|truncate/u);
    }
    assert.equal(await f.launches.recover(s.a.runId, prepared.provenanceId), "recovered");
  });
  await check("lost observation connection aborts cleanup without a receipt or fabricated result", async () => {
    const s = await f.sample(); await s.handoff();
    const prepared = await f.launches.prepare(s.candidate); assert.ok(prepared?.claim);
    const isolatedPool = new Pool({ ...pool.options, max: 1 });
    const isolated = new PostgresWorkerLaunchStore(isolatedPool, f.runtime); let cleaned = false;
    try {
      await assert.rejects(isolated.observe(prepared.claim, async (_claim, lease) => {
        const aborted = new Promise<void>((resolve) => lease.addEventListener("abort", () => resolve(), { once: true }));
        const victim = await pool.query(`SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted AND objsubid=1
          AND classid=((hashtextextended('acp:worker-launch-reconciliation:' || $1,0) >> 32) & 4294967295)::oid
          AND objid=(hashtextextended('acp:worker-launch-reconciliation:' || $1,0) & 4294967295)::oid`, [s.candidate.workerProcessId]);
        assert.equal(victim.rowCount, 1);
        await pool.query("SELECT pg_terminate_backend($1)", [victim.rows[0].pid]);
        await aborted; cleaned = true; return { state: "lost", sealed: true, reason: "sealed_launch_job_absent" };
      }, signal()), /authority ended/u);
      assert.equal(cleaned, true);
      assert.equal((await pool.query("SELECT 1 FROM acp.worker_launch_stops WHERE run_id=$1", [s.a.runId])).rowCount, 0);
      assert.equal(await f.launches.recover(s.a.runId, prepared.provenanceId), "pending");
      // The same unexpired durable claim can be re-observed by its actor, never cached.
      await f.launches.observe(prepared.claim, async () => ({ state: "lost", sealed: true, reason: "sealed_launch_job_absent" }), signal());
      assert.equal(await f.launches.recover(s.a.runId, prepared.provenanceId), "recovered");
    } finally { await isolatedPool.end(); }
  });
  await check("same-template replacement cannot reuse a previous recovery session's provenance", async () => {
    const s = await f.sample(); await s.handoff();
    const prepared = await f.launches.prepare(s.candidate); assert.ok(prepared?.claim);
    await f.launches.observe(prepared.claim, async () => ({ state: "lost", sealed: true, reason: "sealed_launch_job_absent" }), signal());
    await f.replaceOwner();
    assert.equal(await f.launches.recover(s.a.runId, prepared.provenanceId), "pending");
    const replacement = await f.launches.prepare(s.candidate); assert.ok(replacement); assert.equal(replacement.claim, undefined);
    assert.notEqual(replacement.provenanceId, prepared.provenanceId);
    assert.equal(await f.launches.recover(s.a.runId, replacement.provenanceId), "recovered");
  });
  await check("retired owners recover with replacement provenance and retain prior owner stop receipts", async () => {
    const stopped = await f.sample(true), missing = await f.sample(); await stopped.finishOwner();
    const originalReceipt = (await pool.query("SELECT * FROM acp.worker_launch_stops WHERE run_id=$1", [stopped.a.runId])).rows[0];
    await f.replaceOwner();
    const prepared = await f.launches.prepare(stopped.candidate); assert.ok(prepared); assert.equal(prepared.claim, undefined);
    assert.equal(await f.launches.recover(stopped.a.runId, prepared.provenanceId), "recovered");
    assert.deepEqual((await pool.query("SELECT * FROM acp.worker_launch_stops WHERE run_id=$1", [stopped.a.runId])).rows[0], originalReceipt);
    const claim = await f.launches.prepare(missing.candidate); assert.ok(claim?.claim);
    assert.equal(await f.launches.observe(claim.claim, async () => ({ state: "lost", sealed: true, reason: "sealed_launch_job_empty" }), signal()), "stopped");
    assert.equal(await f.launches.recover(missing.a.runId, claim.provenanceId), "recovered");
    await assert.rejects(missing.finishRun(), /different terminal result|terminal/u);
  });
  process.stdout.write(`Worker launch recovery integration: ${checks} checks passed.\n`);
} finally { await pool.end(); }
