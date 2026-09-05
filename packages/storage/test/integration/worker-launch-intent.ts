// Database authority tests only. All process identities are synthetic; no native launch.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { createStableId, createWorkerFailureResult } from "@acp/domain";
import { PostgresContextStore, PostgresDispatchStore, PostgresWorkerRuntimeStore,
  type ConnectionPool, type WorkerRunStart, type WorkerProcessRegistration } from "../../src/index.ts";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("owned database port required");
const pool = new Pool({ connectionString: `postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test`, max: 4,
  statement_timeout: 5000, lock_timeout: 3000, connectionTimeoutMillis: 3000 });
const contexts = new PostgresContextStore(pool), dispatches = new PostgresDispatchStore(pool), workers = new PostgresWorkerRuntimeStore(pool);
const legacy = (prefix: string) => `${prefix}_00000000-0000-4000-8000-000000000001`;
const profile = createStableId("projectProfile"), binding = createStableId("workflowBinding"), template = createStableId("provenance");
const hostIdentifier = "host:launch-intent-check", applicationVersion = "launch-intent-check-v1", sessionId = createStableId("workerHostSession");
const defaultAuthority = { hostIdentifier, template, sessionId };
const fence = { directory: "C:\\ACP-test-only\\launches ž 🚀", directoryIdentity: "win32-dir:12345678:0000000000000001",
  scope: { machineFingerprint: "a".repeat(64), bootedAt: "2026-09-01T00:00:00.000Z", sessionId: 1 } };
let checks = 0, processId = 850000;
async function clone(table: string, key: string, source: string, overrides: object) {
  await pool.query(`INSERT INTO acp.${table} SELECT (jsonb_populate_record(NULL::acp.${table}, to_jsonb(source) || $1::jsonb)).*
    FROM acp.${table} source WHERE ${key} = $2`, [JSON.stringify(overrides), source]);
}
async function check(name: string, action: () => Promise<void>) { await action(); checks++; process.stdout.write(`PASS launch intent: ${name}\n`); }
async function prepare(authority = defaultAuthority): Promise<WorkerRunStart> {
  const { hostIdentifier, template, sessionId } = authority;
  const missionId = createStableId("mission"), nodeId = createStableId("node"), grantId = createStableId("capabilityGrant");
  await clone("missions", "mission_id", legacy("mis"), { mission_id: missionId, workflow_binding_id: binding, state: "executing",
    requested_scope: "Synthetic launch-intent authority.", completed_by_evaluation_id: null, transition_provenance_id: template });
  await clone("mission_nodes", "node_id", legacy("nod"), { node_id: nodeId, mission_id: missionId, state: "runnable", dependencies: [],
    graph_revision: "launch-intent-check", started_at: null, completed_at: null, provenance_id: template, transition_provenance_id: template });
  const evaluation = createStableId("capabilityGrantEvaluation"), fields = { mission_id: missionId, node_id: nodeId, provenance_id: template,
    valid_from: "2000-01-01", expires_at: "2099-01-01", maximum_attempts: 3 };
  await clone("capability_grant_evaluations", "evaluation_id", legacy("cge"), { ...fields, evaluation_id: evaluation });
  await clone("capability_grants", "grant_id", legacy("cgr"), { ...fields, grant_id: grantId, evaluation_id: evaluation });
  await contexts.publishNodeContext({ contextRevisionId: createStableId("nodeContextRevision"), missionId, nodeId, expectedRevision: 0,
    graphRevision: "launch-intent-check", provenanceId: template, content: { objective: "Test durable launch identity.", nonGoals: ["No external actions."],
      behavioralContract: {}, acceptanceCriteria: [], conflicts: [], unresolvedQuestions: [], nextAction: "Return a synthetic result.",
      evidenceIds: [], activeClaimIds: [], previousRunIds: [], approvalIds: [], limits: { wallTimeMs: 30000, maximumTurns: 1, maximumOutputBytes: 4096 } } });
  const runId = createStableId("run");
  await dispatches.request({ runId, missionId, nodeId, grantId, attemptNumber: 1, applicationVersion, operation: "synthetic.read",
    resource: "synthetic:record:1", preferredHostIdentifier: hostIdentifier, provenanceId: template });
  const a = await dispatches.assign(runId, async () => {}); assert.ok(a);
  assert.equal((await dispatches.prepare({ runId, generation: a.generation, hostSessionId: sessionId }, hostIdentifier, applicationVersion, sessionId)).state, "ready");
  const packet = await contexts.buildAndRecordContextPacket({ contextPacketId: a.contextPacketId, missionId, nodeId, capabilityGrantId: grantId,
    runtimeTemplateProvenanceId: template, provenanceId: a.packetProvenanceId });
  const grant = await workers.loadCapabilityGrant(grantId); assert.ok(grant);
  return { runId, dispatchGeneration: a.generation, packet, attemptNumber: 1, hostIdentifier,
    resourceClass: grant.resourceClass, wallTimeMs: packet.limits.wallTimeMs, provenanceId: a.packetProvenanceId,
    launchIntent: { workerProcessId: createStableId("workerProcess"), fence },
    request: { missionId, nodeId, projectId: packet.projectId, role: packet.workerRole, resourceClass: grant.resourceClass,
      operation: a.operation, resource: a.resource, mode: grant.mode, workspace: grant.workspace, networkAccess: "none", at: new Date().toISOString() } };
}
async function registration(start: WorkerRunStart): Promise<WorkerProcessRegistration> {
  const row = (await pool.query("SELECT started_at FROM acp.worker_runs WHERE run_id = $1", [start.runId])).rows[0];
  const workerProcessId = start.launchIntent!.workerProcessId;
  return { workerProcessId, runId: start.runId, processId: ++processId, processStartToken: "win32-filetime:134329999999999999",
    startedAt: new Date(row.started_at.getTime() + 1).toISOString(), purpose: "Synthetic launch-intent fixture; no OS process",
    provenanceId: start.provenanceId, transitionProvenanceId: start.provenanceId,
    supervision: { kind: "windows_job", treeIdentifier: `Local\\ACP.Worker.${workerProcessId}`, scope: fence.scope } };
}
async function finish(start: WorkerRunStart) {
  return workers.completeRun({ result: createWorkerFailureResult({ runId: start.runId, packet: start.packet, attemptNumber: 1,
    status: "failed", code: "terminated", conclusion: "Synthetic fixture result.", wallMilliseconds: 1 }),
    completedAt: new Date().toISOString(), transitionProvenanceId: start.provenanceId });
}
function intercepted(mode: "missing_intent" | "lost_commit" | "wrong_scope"): ConnectionPool {
  return { query: (text, values) => pool.query(text, values), async connect() {
    const client = await pool.connect();
    return { release: () => client.release(), async query<R extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> {
      if (text.includes("INSERT INTO acp.worker_launch_intents")) {
        if (mode === "missing_intent") return { rows: [{ worker_process_id: values![1], directory_path: values![2],
          directory_identity: values![3], supervision_scope: JSON.parse(values![4] as string) }] as unknown as R[], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
        if (mode === "wrong_scope") values = [...values!.slice(0, 4), JSON.stringify({ ...fence.scope, sessionId: -1 })];
      }
      const result = await client.query<R>(text, values);
      if (text === "COMMIT" && mode === "lost_commit") throw new Error("synthetic lost commit acknowledgement");
      return result;
    } };
  } };
}
try {
  await clone("project_profiles", "profile_id", legacy("pro"), { profile_id: profile, profile: { sourceAuthorityRules: { synthetic: "canonical" } } });
  await clone("project_workflow_bindings", "binding_id", legacy("wfb"), { binding_id: binding, profile_id: profile });
  await clone("runtime_provenance", "provenance_id", legacy("prv"), { provenance_id: template, workflow_binding_id: binding,
    project_profile_id: profile, host_identifier: hostIdentifier, database_schema_version: "0011" });
  await dispatches.registerRuntime({ hostIdentifier, applicationVersion, sessionId, bindings: [{ workflowBindingId: binding, templateProvenanceId: template }] },
    { hostIdentifier, hostKind: "vps", state: "active", maximumCpuIntensive: 1, maximumModerateCompute: 1, maximumLightweightRead: 32,
      maximumNetworkBound: 1, heartbeatTtlSeconds: 300, provenanceId: template, transitionProvenanceId: template });
  const start = await prepare();
  await check("atomic admission binds exact database owner, deadline, scope and audit receipt", async () => {
    const admitted = await workers.startRun(start); assert.deepEqual(admitted.launchIntent, start.launchIntent);
    const row = (await pool.query("SELECT * FROM acp.worker_launch_intents WHERE run_id = $1", [start.runId])).rows[0];
    assert.equal(row.worker_process_id, start.launchIntent!.workerProcessId); assert.equal(row.generation, start.dispatchGeneration);
    assert.equal(row.owner_session_id, sessionId); assert.equal(row.host_identifier, hostIdentifier); assert.equal(row.application_version, applicationVersion);
    assert.equal(row.provenance_id, start.provenanceId); assert.equal(row.deadline_at.toISOString(), admitted.timeoutAt);
    assert.equal(row.directory_path, fence.directory); assert.deepEqual(row.supervision_scope, fence.scope);
    assert.equal((await pool.query("SELECT payload ->> 'worker_process_id' AS id FROM acp.mission_events WHERE mission_id = $1 AND event_type = 'worker.launch-admitted'",
      [start.packet.missionId])).rows[0].id, start.launchIntent!.workerProcessId);
  });
  await check("missing intent fails deferred COMMIT and invalid scope rolls back run, use and audit", async () => {
    for (const mode of ["missing_intent", "wrong_scope"] as const) {
      const candidate = await prepare();
      await assert.rejects(new PostgresWorkerRuntimeStore(intercepted(mode)).startRun(candidate), /worker_runs_launch_intent|exact local directory and OS scope/u);
      assert.equal((await pool.query("SELECT 1 FROM acp.worker_runs WHERE run_id = $1", [candidate.runId])).rowCount, 0);
      assert.equal((await pool.query("SELECT 1 FROM acp.capability_grant_uses WHERE run_id = $1", [candidate.runId])).rowCount, 0);
      assert.equal((await pool.query("SELECT 1 FROM acp.mission_events WHERE mission_id = $1 AND event_type = 'worker.launch-admitted'", [candidate.packet.missionId])).rowCount, 0);
    }
  });
  await check("legacy admission remains valid and cannot be upgraded by marker or late intent insertion", async () => {
    const candidate = await prepare(), { launchIntent: _intent, ...legacyStart } = candidate;
    await workers.startRun(legacyStart);
    await assert.rejects(pool.query("UPDATE acp.worker_runs SET launch_worker_process_id = $2 WHERE run_id = $1", [candidate.runId, candidate.launchIntent!.workerProcessId]), /identity/u);
    await assert.rejects(pool.query("INSERT INTO acp.worker_launch_intents(run_id, worker_process_id, protocol, directory_path, directory_identity, supervision_scope) VALUES($1,$2,'windows_fence_v1',$3,$4,$5)",
      [candidate.runId, candidate.launchIntent!.workerProcessId, fence.directory, fence.directoryIdentity, fence.scope]), /newly admitted/u);
    assert.equal(await finish(legacyStart), true);
  });
  await check("intent identities are immutable and cannot be reused by another run", async () => {
    for (const sql of ["UPDATE acp.worker_launch_intents SET protocol = protocol", "DELETE FROM acp.worker_launch_intents", "TRUNCATE acp.worker_launch_intents"]) {
      await assert.rejects(pool.query(sql), /append-only|foreign key constraint/u);
    }
    await assert.rejects(pool.query("UPDATE acp.worker_runs SET launch_worker_process_id = NULL WHERE run_id = $1", [start.runId]), /identity/u);
    const candidate = await prepare();
    await assert.rejects(workers.startRun({ ...candidate, launchIntent: start.launchIntent! }), /unique/u);
    assert.equal((await pool.query("SELECT 1 FROM acp.worker_runs WHERE run_id = $1", [candidate.runId])).rowCount, 0);
  });
  await check("no-journal run, node and mission transitions retain unresolved launch authority", async () => {
    await assert.rejects(finish(start), /launch stop evidence/u);
    await assert.rejects(pool.query("UPDATE acp.mission_nodes SET state = 'failed', completed_at = clock_timestamp(), transition_provenance_id = $2 WHERE node_id = $1",
      [start.packet.nodeId, start.provenanceId]), /unresolved worker launch intent/u);
    await assert.rejects(pool.query("UPDATE acp.missions SET state = 'cancelled', transition_provenance_id = $2 WHERE mission_id = $1",
      [start.packet.missionId, start.provenanceId]), /unresolved worker launch intent/u);
    assert.equal((await pool.query("SELECT available_slots FROM (SELECT 32 - count(*) AS available_slots FROM acp.worker_runs WHERE host_identifier = $1 AND state = 'started') s", [hostIdentifier])).rows[0].available_slots, "31");
  });
  await check("unresolved intent refuses downgrade without changing the schema", async () => {
    const client = await pool.connect();
    try { await client.query("BEGIN"); await assert.rejects(client.query(await readFile(new URL("../../migrations/0011_worker_launch_intents.down.sql", import.meta.url), "utf8")), /all launch-intent runs/u); }
    finally { await client.query("ROLLBACK"); client.release(); }
  });
  const record = await registration(start);
  await check("journal requires the admitted WPR and exact OS scope", async () => {
    const wrongId = createStableId("workerProcess");
    await assert.rejects(workers.recordWorkerProcessFromRun({ ...record, workerProcessId: wrongId,
      supervision: { ...record.supervision!, treeIdentifier: `Local\\ACP.Worker.${wrongId}` } }), /durable launch intent/u);
    await assert.rejects(workers.recordWorkerProcessFromRun({ ...record,
      supervision: { ...record.supervision!, scope: { ...fence.scope, sessionId: 2 } } }), /durable launch intent/u);
    await workers.recordWorkerProcessFromRun(record);
    await assert.rejects(pool.query("SELECT acp.handoff_worker_run($1,$2,$3,$4,$5)", [start.runId, start.dispatchGeneration, hostIdentifier, sessionId, applicationVersion]), /own revocation/u);
    await assert.rejects(pool.query("UPDATE acp.worker_processes SET reconciliation_id = $2 WHERE worker_process_id = $1", [record.workerProcessId, createStableId("reconciliation")]), /legacy process recovery lane/u);
  });
  await check("session retirement fences process writes and owner mutations fail closed until rollback", async () => {
    const client = await pool.connect(); let pending: Promise<unknown> | undefined;
    try {
      await client.query("BEGIN");
      await client.query("UPDATE acp.worker_host_sessions SET state = 'closed' WHERE host_identifier = $1", [hostIdentifier]);
      await client.query("SAVEPOINT owner_probe");
      await assert.rejects(client.query("UPDATE acp.worker_processes SET heartbeat_at = clock_timestamp() WHERE worker_process_id = $1", [record.workerProcessId]), /original live owner provenance/u);
      await client.query("ROLLBACK TO SAVEPOINT owner_probe");
      await assert.rejects(client.query("UPDATE acp.worker_runs SET state = 'failed' WHERE run_id = $1", [start.runId]), /original live owner provenance/u);
      await client.query("ROLLBACK TO SAVEPOINT owner_probe");
      let settled = false;
      pending = workers.heartbeatWorkerProcess(record.workerProcessId, record.processId, record.processStartToken).finally(() => { settled = true; });
      void pending.catch(() => {});
      const ownerPid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const deadline = Date.now() + 2000; let blocked = false;
      while (Date.now() < deadline) {
        blocked = (await pool.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid))) AS blocked", [ownerPid])).rows[0].blocked;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true); assert.equal(settled, false);
    } finally { await client.query("ROLLBACK"); client.release(); await pending; }
    for (const table of ["worker_host_sessions", "worker_host_runtimes"]) {
      await assert.rejects(pool.query(`TRUNCATE acp.${table}`), /append-only|foreign key constraint/u);
    }
  });
  await check("exact stopped journal permits normal result and node projection", async () => {
    const wrongProvenance = createStableId("provenance");
    await clone("runtime_provenance", "provenance_id", start.provenanceId, { provenance_id: wrongProvenance });
    await assert.rejects(workers.finishWorkerProcess({ ...record, transitionProvenanceId: wrongProvenance, state: "terminated", exitCode: 137,
      terminationReason: "Wrong actor must not finish." }), /original live owner provenance/u);
    await assert.rejects(finish(start), /launch stop evidence/u);
    await workers.finishWorkerProcess({ ...record, state: "terminated", exitCode: 137, terminationReason: "Synthetic stopped root; no OS process." });
    await assert.rejects(pool.query("UPDATE acp.worker_runs SET state = 'failed', transition_provenance_id = $2 WHERE run_id = $1", [start.runId, wrongProvenance]), /original live owner provenance/u);
    assert.equal(await finish(start), true); assert.equal(await finish(start), false);
    assert.equal((await pool.query("SELECT state FROM acp.mission_nodes WHERE node_id = $1", [start.packet.nodeId])).rows[0].state, "failed");
  });
  await check("lost commit acknowledgement leaves one exact intent and does not allow readmission", async () => {
    const candidate = await prepare();
    await assert.rejects(new PostgresWorkerRuntimeStore(intercepted("lost_commit")).startRun(candidate), /lost commit/u);
    assert.equal((await pool.query("SELECT worker_process_id FROM acp.worker_launch_intents WHERE run_id = $1", [candidate.runId])).rows[0].worker_process_id, candidate.launchIntent!.workerProcessId);
    await assert.rejects(workers.startRun(candidate));
    const r = await registration(candidate); await workers.recordWorkerProcessFromRun(r);
    await workers.finishWorkerProcess({ ...r, state: "terminated", exitCode: 137, terminationReason: "Synthetic cleanup after lost admission acknowledgement." });
    await finish(candidate);
  });
  await check("launch intents and legacy journals cannot consume each other's process identities", async () => {
    const candidate = await prepare(), { launchIntent: _intent, ...legacyStart } = candidate;
    await workers.startRun(legacyStart);
    const conflicting = await registration({ ...candidate, launchIntent: start.launchIntent! });
    await assert.rejects(workers.recordWorkerProcessFromRun(conflicting), /reserved by a launch intent/u);
    const original = await registration(candidate); await workers.recordWorkerProcessFromRun(original);
    const later = await prepare();
    await assert.rejects(workers.startRun({ ...later, launchIntent: candidate.launchIntent! }), /reserved by a process journal/u);
    await workers.finishWorkerProcess({ ...original, state: "terminated", exitCode: 137, terminationReason: "Synthetic legacy identity cleanup." });
    await finish(legacyStart);
  });
  await check("a concurrent legacy journal reserves its WPR before later intent admission can commit", async () => {
    const candidate = await prepare(), { launchIntent: _intent, ...legacyStart } = candidate;
    await workers.startRun(legacyStart);
    const other = { hostIdentifier: "host:launch-collision-check", template: createStableId("provenance"), sessionId: createStableId("workerHostSession") };
    await clone("runtime_provenance", "provenance_id", template, { provenance_id: other.template, host_identifier: other.hostIdentifier });
    await dispatches.registerRuntime({ hostIdentifier: other.hostIdentifier, sessionId: other.sessionId, applicationVersion,
      bindings: [{ workflowBindingId: binding, templateProvenanceId: other.template }] },
      { hostIdentifier: other.hostIdentifier, hostKind: "vps", state: "active", maximumCpuIntensive: 1, maximumModerateCompute: 1,
        maximumLightweightRead: 32, maximumNetworkBound: 1, heartbeatTtlSeconds: 300, provenanceId: other.template, transitionProvenanceId: other.template });
    const record = await registration(candidate), later = await prepare(other), client = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await client.query("BEGIN");
      const held = new PostgresWorkerRuntimeStore({ query: client.query.bind(client), connect: async () => { throw new Error("unexpected nested transaction"); } });
      await held.recordWorkerProcessFromRun(record);
      let settled = false;
      pending = workers.startRun({ ...later, launchIntent: candidate.launchIntent! }).finally(() => { settled = true; });
      void pending.catch(() => {});
      const deadline = Date.now() + 2000;
      let blocked = false;
      while (Date.now() < deadline) {
        blocked = (await pool.query("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted) AS blocked")).rows[0].blocked;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true); assert.equal(settled, false);
      await client.query("COMMIT");
      await assert.rejects(pending, /reserved by a process journal/u);
      assert.equal((await pool.query("SELECT 1 FROM acp.worker_runs WHERE run_id = $1", [later.runId])).rowCount, 0);
    } finally { await client.query("ROLLBACK"); client.release(); await pending?.catch(() => {}); }
    await workers.finishWorkerProcess({ ...record, state: "terminated", exitCode: 137, terminationReason: "Synthetic concurrent identity cleanup." });
    await finish(legacyStart);
    await dispatches.closeRuntime(other.hostIdentifier, other.sessionId);
  });
  await dispatches.closeRuntime(hostIdentifier, sessionId);
  process.stdout.write(`Worker launch-intent integration: ${checks} checks passed.\n`);
} finally { await pool.end(); }
