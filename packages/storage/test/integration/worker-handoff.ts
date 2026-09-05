// Synthetic process identities only, inside the gate's disposable PostgreSQL.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { createStableId, createWorkerFailureResult, type StableId } from "@acp/domain";
import { PostgresContextStore, PostgresDispatchStore, PostgresWorkerRuntimeStore, PostgresWorkerRecoveryStore,
  type WorkerAssignment, type WorkerHostRegistration, type HostRuntimeRegistration, type WorkerProcessRegistration } from "../../src/index.ts";
import { HostDispatchRuntime } from "../../../../apps/worker/src/host-dispatch.ts";
import { WorkerManager, WorkerTerminationUnconfirmedError } from "../../../../apps/worker/src/worker-manager.ts";
import { WorkerRecoveryRuntime } from "../../../../apps/worker/src/worker-recovery.ts";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("owned database port required");
const pool = new Pool({ connectionString: `postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test`, max: 4,
  statement_timeout: 5000, lock_timeout: 3000, connectionTimeoutMillis: 3000 });
const contexts = new PostgresContextStore(pool), dispatches = new PostgresDispatchStore(pool), workers = new PostgresWorkerRuntimeStore(pool);
const legacy = (prefix: string) => `${prefix}_00000000-0000-4000-8000-000000000001`;
const profile = createStableId("projectProfile"), binding = createStableId("workflowBinding"), template = createStableId("provenance");
const hostIdentifier = "host:handoff-check", applicationVersion = "handoff-check-v1";
const host: WorkerHostRegistration = { hostIdentifier, hostKind: "vps", state: "active", maximumCpuIntensive: 1, maximumModerateCompute: 1,
  maximumLightweightRead: 4, maximumNetworkBound: 1, heartbeatTtlSeconds: 300, provenanceId: template, transitionProvenanceId: template };
let runtime: HostRuntimeRegistration = { hostIdentifier, applicationVersion, sessionId: createStableId("workerHostSession"),
  bindings: [{ workflowBindingId: binding, templateProvenanceId: template }] };
let recovery = new PostgresWorkerRecoveryStore(pool, runtime), checks = 0, processId = 800000;
const message = (a: WorkerAssignment) => ({ runId: a.runId, generation: a.generation, hostSessionId: a.hostSessionId });
async function clone(table: string, key: string, source: string, overrides: object) {
  await pool.query(`INSERT INTO acp.${table} SELECT (jsonb_populate_record(NULL::acp.${table}, to_jsonb(source) || $1::jsonb)).*
    FROM acp.${table} source WHERE ${key} = $2`, [JSON.stringify(overrides), source]);
}
async function check(name: string, action: () => Promise<void>) { await action(); checks++; process.stdout.write(`PASS handoff: ${name}\n`); }
async function assignSample() {
  const missionId = createStableId("mission"), nodeId = createStableId("node"), grantId = createStableId("capabilityGrant");
  await clone("missions", "mission_id", legacy("mis"), { mission_id: missionId, workflow_binding_id: binding, state: "executing",
    requested_scope: "Synthetic owner handoff.", completed_by_evaluation_id: null, transition_provenance_id: template });
  await clone("mission_nodes", "node_id", legacy("nod"), { node_id: nodeId, mission_id: missionId, state: "runnable", dependencies: [],
    graph_revision: "handoff-check", started_at: null, completed_at: null, provenance_id: template, transition_provenance_id: template });
  const evaluation = createStableId("capabilityGrantEvaluation"), fields = { mission_id: missionId, node_id: nodeId, provenance_id: template,
    valid_from: "2000-01-01", expires_at: "2099-01-01", maximum_attempts: 3 };
  await clone("capability_grant_evaluations", "evaluation_id", legacy("cge"), { ...fields, evaluation_id: evaluation });
  await clone("capability_grants", "grant_id", legacy("cgr"), { ...fields, grant_id: grantId, evaluation_id: evaluation });
  await contexts.publishNodeContext({ contextRevisionId: createStableId("nodeContextRevision"), missionId, nodeId, expectedRevision: 0,
    graphRevision: "handoff-check", provenanceId: template, content: { objective: "Test exact recovery ownership.", nonGoals: ["No external actions."],
      behavioralContract: {}, acceptanceCriteria: [], conflicts: [], unresolvedQuestions: [], nextAction: "Return a synthetic result.",
      evidenceIds: [], activeClaimIds: [], previousRunIds: [], approvalIds: [], limits: { wallTimeMs: 30000, maximumTurns: 1, maximumOutputBytes: 4096 } } });
  const runId = createStableId("run");
  await dispatches.request({ runId, missionId, nodeId, grantId, attemptNumber: 1, applicationVersion, operation: "synthetic.read",
    resource: "synthetic:record:1", preferredHostIdentifier: hostIdentifier, provenanceId: template });
  const a = await dispatches.assign(runId, async () => {}); assert.ok(a);
  return a;
}
async function sample(journal = true) {
  const a = await assignSample();
  const { runId, missionId, nodeId, grantId } = a;
  assert.equal((await dispatches.prepare(message(a), hostIdentifier, applicationVersion, runtime.sessionId)).state, "ready");
  const packet = await contexts.buildAndRecordContextPacket({ contextPacketId: a.contextPacketId, missionId, nodeId, capabilityGrantId: grantId,
    runtimeTemplateProvenanceId: template, provenanceId: a.packetProvenanceId });
  const grant = await workers.loadCapabilityGrant(grantId); assert.ok(grant);
  const started = await workers.startRun({ runId, dispatchGeneration: a.generation, packet, attemptNumber: 1, hostIdentifier,
    resourceClass: grant.resourceClass, wallTimeMs: packet.limits.wallTimeMs, provenanceId: a.packetProvenanceId,
    request: { missionId, nodeId, projectId: packet.projectId, role: packet.workerRole, resourceClass: grant.resourceClass,
      operation: a.operation, resource: a.resource, mode: grant.mode, workspace: grant.workspace, networkAccess: "none", at: new Date().toISOString() } });
  const workerProcessId = createStableId("workerProcess");
  const registration: WorkerProcessRegistration = { workerProcessId, runId, processId: ++processId, processStartToken: "win32-filetime:134329999999999999",
    startedAt: new Date(Date.parse(started.startedAt) + 1).toISOString(), purpose: "Synthetic handoff fixture; no OS process",
    provenanceId: a.packetProvenanceId, transitionProvenanceId: a.packetProvenanceId,
    supervision: { kind: "windows_job", treeIdentifier: `Local\\ACP.Worker.${workerProcessId}`,
      scope: { machineFingerprint: "a".repeat(64), bootedAt: "2026-09-01T00:00:00Z", sessionId: 1 } } };
  await new Promise((resolve) => setTimeout(resolve, 2));
  if (journal) await workers.recordWorkerProcessFromRun(registration);
  const finishProcess = () => workers.finishWorkerProcess({ ...registration, state: "terminated", exitCode: 137, terminationReason: "Synthetic stopped tree." });
  const finishRun = () => workers.completeRun({ result: createWorkerFailureResult({ runId, packet, attemptNumber: 1,
    status: "failed", code: "terminated", conclusion: "Synthetic owner result.", wallMilliseconds: 1 }), completedAt: new Date().toISOString(), transitionProvenanceId: a.packetProvenanceId });
  return { a, packet, registration, finishProcess, finishRun };
}
type Sample = Awaited<ReturnType<typeof sample>>;
async function repair(s: Sample) {
  const candidate = (await recovery.listCandidates(undefined, 25)).find((item) => item.runId === s.a.runId); assert.ok(candidate);
  const prepared = await recovery.prepare(candidate); assert.ok(prepared);
  assert.notEqual(prepared.provenanceId, s.a.packetProvenanceId);
  if (prepared.claim) {
    assert.equal(prepared.claim.reason, "owner_handoff");
    const observed = await workers.reconcileClaimedWorkerProcess(s.registration.workerProcessId, prepared.claim.reconciliationId, async () => ({
      state: "lost", terminationReason: "Synthetic fixture has no native process; exact test observation.", transitionProvenanceId: prepared.provenanceId }), recovery.authority);
    assert.equal(observed.state, "terminalized");
  }
  assert.equal(await workers.recoverStoppedRun({ runId: s.a.runId, hostIdentifier, transitionProvenanceId: prepared.provenanceId, authority: recovery.authority }), "recovered");
}
try {
  await clone("project_profiles", "profile_id", legacy("pro"), { profile_id: profile, profile: { sourceAuthorityRules: { synthetic: "canonical" } } });
  await clone("project_workflow_bindings", "binding_id", legacy("wfb"), { binding_id: binding, profile_id: profile });
  await clone("runtime_provenance", "provenance_id", legacy("prv"), { provenance_id: template, workflow_binding_id: binding,
    project_profile_id: profile, host_identifier: hostIdentifier, database_schema_version: "0010" });
  await dispatches.registerRuntime(runtime, host);
  const a = await sample(), healthy = await sample();
  await check("healthy current owners remain excluded and wrong handoff identities cannot yield them", async () => {
    assert.deepEqual(await recovery.listCandidates(), []);
    assert.equal(await recovery.handoff({ ...message(a.a), generation: 2 }), "obsolete");
    assert.equal(await recovery.handoff({ ...message(a.a), hostSessionId: createStableId("workerHostSession") }), "obsolete");
    assert.equal(await new PostgresWorkerRecoveryStore(pool, { ...runtime, applicationVersion: "other" }).handoff(message(a.a)), "obsolete");
    await assert.rejects(pool.query(`INSERT INTO acp.worker_run_recovery_handoffs(run_id, worker_process_id, generation, host_identifier,
      owner_session_id, application_version, provenance_id, reason) VALUES($1,$2,1,$3,$4,$5,$6,'manager_dispatch_ended_without_result')`,
    [a.a.runId, a.registration.workerProcessId, hostIdentifier, runtime.sessionId, applicationVersion, template]), /exact current owner/);
  });
  await check("handoff commits before blocked late heartbeat, process finish and run result checks", async () => {
    const fence = await pool.connect(); const writes: Promise<unknown>[] = []; let settled = 0;
    try {
      await fence.query("BEGIN");
      assert.equal((await fence.query("SELECT acp.handoff_worker_run($1,$2,$3,$4,$5) AS outcome", [a.a.runId, 1, hostIdentifier, runtime.sessionId, applicationVersion])).rows[0].outcome, "handed_off");
      for (const write of [workers.heartbeatWorkerProcess(a.registration.workerProcessId, a.registration.processId, a.registration.processStartToken), a.finishProcess(), a.finishRun()]) {
        const pending = write.finally(() => { settled++; }); void pending.catch(() => {}); writes.push(pending);
      }
      await new Promise((resolve) => setTimeout(resolve, 50)); assert.equal(settled, 0);
      await fence.query("COMMIT");
      for (const write of writes) await assert.rejects(write, /handed-off/);
    } finally { await fence.query("ROLLBACK"); fence.release(); await Promise.allSettled(writes); }
    assert.equal(await recovery.handoff(message(a.a)), "handed_off"); // acknowledgement replay
    const newId = createStableId("workerProcess");
    await assert.rejects(workers.recordWorkerProcessFromRun({ ...a.registration, workerProcessId: newId,
      supervision: { ...a.registration.supervision!, treeIdentifier: `Local\\ACP.Worker.${newId}` } }), /handed-off/);
    assert.equal((await pool.query("SELECT count(*)::integer AS n FROM acp.mission_events WHERE mission_id = $1 AND event_type = 'worker.recovery-handed-off'", [a.a.missionId])).rows[0].n, 1);
  });
  await check("one handed-off run recovers immediately without retiring the daemon or another run", async () => {
    const list = await recovery.listCandidates(); assert.equal(list.length, 1); assert.equal(list[0]?.runId, a.a.runId);
    assert.equal((await pool.query("SELECT acp.worker_host_load($1,'lightweight_read')::integer AS n", [hostIdentifier])).rows[0].n, 2);
    await repair(a);
    assert.equal(await dispatches.heartbeatRuntime(hostIdentifier, runtime.sessionId), true);
    await workers.heartbeatWorkerProcess(healthy.registration.workerProcessId, healthy.registration.processId, healthy.registration.processStartToken);
    assert.equal((await pool.query("SELECT state FROM acp.worker_runs WHERE run_id = $1", [healthy.a.runId])).rows[0].state, "started");
    assert.equal((await pool.query("SELECT state FROM acp.mission_nodes WHERE node_id = $1", [a.a.nodeId])).rows[0].state, "failed");
  });
  await check("terminal owner result wins over a later handoff, including lost result acknowledgement", async () => {
    await healthy.finishProcess(); await healthy.finishRun();
    assert.equal(await recovery.handoff(message(healthy.a)), "terminal");
    assert.equal((await pool.query("SELECT 1 FROM acp.worker_run_recovery_handoffs WHERE run_id = $1", [healthy.a.runId])).rowCount, 0);
    assert.equal(await healthy.finishRun(), false);
  });
  await check("handoff identity and audit records are append-only", async () => {
    for (const sql of ["UPDATE acp.worker_run_recovery_handoffs SET reason = reason", "DELETE FROM acp.worker_run_recovery_handoffs", "TRUNCATE acp.worker_run_recovery_handoffs"]) {
      await assert.rejects(pool.query(sql), /append-only/);
    }
    const receipt = (await pool.query("SELECT payload FROM acp.mission_events WHERE mission_id = $1 AND event_type = 'worker.recovery-handed-off'", [a.a.missionId])).rows[0].payload;
    assert.equal(receipt.run_id, a.a.runId); assert.equal(receipt.worker_process_id, a.registration.workerProcessId);
  });
  await check("an unjournaled gap stays pending until the exact late journal becomes durable", async () => {
    const s = await sample(false);
    assert.equal(await recovery.handoff(message(s.a)), "pending");
    assert.equal((await pool.query("SELECT state FROM acp.worker_runs WHERE run_id = $1", [s.a.runId])).rows[0].state, "started");
    assert.equal((await recovery.listCandidates()).some((item) => item.runId === s.a.runId), false);
    await workers.recordWorkerProcessFromRun(s.registration);
    assert.equal(await recovery.handoff(message(s.a)), "handed_off"); await repair(s);
  });
  await check("unresolved handoff blocks downgrade and marker alone cannot manufacture a result", async () => {
    const s = await sample(); await recovery.handoff(message(s.a));
    assert.equal(await workers.recoverStoppedRun({ runId: s.a.runId, hostIdentifier, transitionProvenanceId: s.a.packetProvenanceId, authority: recovery.authority }), "pending");
    const down = await readFile(new URL("../../migrations/0010_worker_handoff.down.sql", import.meta.url), "utf8"), client = await pool.connect();
    try { await client.query("BEGIN"); await assert.rejects(client.query(down), /downgrade requires all handed-off runs/); }
    finally { await client.query("ROLLBACK"); client.release(); }
    await repair(s);
  });
  await check("current-owner terminal journal recovery preserves durable cancellation", async () => {
    const s = await sample(); await s.finishProcess(); await recovery.handoff(message(s.a));
    await pool.query("UPDATE acp.missions SET state = 'cancelled', transition_provenance_id = $2 WHERE mission_id = $1", [s.a.missionId, template]);
    await repair(s);
    assert.equal((await pool.query("SELECT state FROM acp.worker_runs WHERE run_id = $1", [s.a.runId])).rows[0].state, "cancelled");
  });
  await check("retiring recovery authority cannot close a handed-off gap; a fresh session can", async () => {
    const s = await sample(); await s.finishProcess(); await recovery.handoff(message(s.a));
    const candidate = (await recovery.listCandidates()).find((item) => item.runId === s.a.runId); assert.ok(candidate);
    const prepared = await recovery.prepare(candidate); assert.ok(prepared);
    const oldAuthority = recovery.authority;
    await dispatches.closeRuntime(hostIdentifier, runtime.sessionId);
    assert.equal(await workers.recoverStoppedRun({ runId: s.a.runId, hostIdentifier, transitionProvenanceId: prepared.provenanceId, authority: oldAuthority }), "pending");
    runtime = { ...runtime, sessionId: createStableId("workerHostSession") };
    await dispatches.registerRuntime(runtime, host); recovery = new PostgresWorkerRecoveryStore(pool, runtime);
    await repair(s);
  });
  await check("dispatch hands off a failed manager, retries a lost acknowledgement and recovers without another transport", async () => {
    const a = await assignSample(); let calls = 0, handoffs = 0, inspections = 0;
    let signal: AbortSignal | undefined;
    const manager = new WorkerManager(workers, { async run(request) {
      calls++; signal = request.signal;
      const workerProcessId = createStableId("workerProcess");
      await new Promise((resolve) => setTimeout(resolve, 2));
      await workers.recordWorkerProcessFromRun({ workerProcessId, runId: request.runId, processId: ++processId,
        processStartToken: "win32-filetime:134329999999999999", startedAt: new Date(Date.parse(request.execution.startedAt) + 1).toISOString(),
        purpose: "Synthetic manager handoff; no OS process", provenanceId: request.execution.provenanceId,
        transitionProvenanceId: request.execution.transitionProvenanceId,
        supervision: { kind: "windows_job", treeIdentifier: `Local\\ACP.Worker.${workerProcessId}`,
          scope: { machineFingerprint: "a".repeat(64), bootedAt: "2026-09-01T00:00:00Z", sessionId: 1 } } });
      throw new WorkerTerminationUnconfirmedError();
    } }, { localHostIdentifier: hostIdentifier });
    const recovering = new WorkerRecoveryRuntime({ store: recovery, workers, inspector: { async stop(claim) {
      inspections++; assert.equal(claim.runId, a.runId);
      assert.equal(signal?.aborted, true);
      return { state: "lost", reason: "Synthetic exact tree-absence observation; no native process." };
    } } });
    const live = new HostDispatchRuntime({ host, runtime, workers, contexts, dispatches, manager, enqueue: async () => {},
      recovery: { authority: recovery.authority, maintain: (abort) => recovering.maintain(abort), async handoff(input) {
        handoffs++; assert.equal(signal?.aborted, true);
        const outcome = await recovering.handoff(input);
        if (handoffs === 1) throw new Error("Synthetic lost handoff acknowledgement");
        return outcome;
      } } });
    try {
      assert.equal((await live.execute(message(a))).state, "reconciliation_required");
      assert.equal((await live.execute(message(a))).state, "reconciliation_required");
      assert.equal(calls, 1); assert.equal(handoffs, 1); assert.equal(inspections, 0);
      assert.equal((await pool.query("SELECT state FROM acp.worker_runs WHERE run_id = $1", [a.runId])).rows[0].state, "started");
      await live.heartbeat(); await live.maintain();
      assert.equal(handoffs, 2); assert.equal(inspections, 1); assert.equal(calls, 1);
      const replay = await live.execute(message(a)); assert.equal(replay.state, "terminal");
      if (replay.state === "terminal") assert.equal(replay.result.status, "failed");
      assert.equal(await dispatches.heartbeatRuntime(hostIdentifier, runtime.sessionId), true);
      assert.equal((await pool.query("SELECT state FROM acp.mission_nodes WHERE node_id = $1", [a.nodeId])).rows[0].state, "failed");
      assert.equal((await pool.query("SELECT count(*)::integer AS n FROM acp.worker_run_recovery_handoffs WHERE run_id = $1", [a.runId])).rows[0].n, 1);
    } finally { await live.stop(); }
  });
  await dispatches.closeRuntime(hostIdentifier, runtime.sessionId);
  process.stdout.write(`Worker handoff integration: ${checks} checks passed.\n`);
} finally { await pool.end(); }
