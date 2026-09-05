// Owned disposable PostgreSQL + real DBOS queue; synthetic transport, no model credentials.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import { Pool } from "pg";
import { createStableId, createWorkerFailureResult, type StableId } from "@acp/domain";
import { PostgresContextStore, PostgresDispatchStore, PostgresWorkerRuntimeStore, PostgresRuntimeStore, PostgresWorkerRecoveryStore,
  type HostRuntimeRegistration, type WorkerAssignment, type WorkerDispatchRequest,
  type WorkerHostRegistration, type WorkerProcessRegistration } from "../../src/index.ts";
import { HostDispatchRuntime, hostWorkerQueueName, postgresWorkerEnqueuer, registerHostDispatchWorkflow,
  type WorkerDispatchOutcome } from "../../../../apps/worker/src/host-dispatch.ts";
import { WorkerManager, type WorkerTransport } from "../../../../apps/worker/src/worker-manager.ts";
import { SupervisedWorkerTransport } from "../../../../apps/worker/src/supervised-worker-transport.ts";
import { WindowsWorkerLauncher, parseWindowsSupervisionScope } from "../../../../apps/worker/src/windows-worker-launcher.ts";
import { WindowsWorkerTreeInspector } from "../../../../apps/worker/src/windows-worker-recovery.ts";
import { minimalCodexEnvironment } from "../../../../apps/worker/src/codex-sdk-transport.ts";
import { WorkerRecoveryRuntime } from "../../../../apps/worker/src/worker-recovery.ts";
import type { ConnectionPool } from "../../src/database.ts";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("owned database port required");
const databaseUrl = `postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test`;
const pool = new Pool({ connectionString: databaseUrl, max: 4, statement_timeout: 5000,
  lock_timeout: 3000, connectionTimeoutMillis: 3000 });
const dispatches = new PostgresDispatchStore(pool);
const contexts = new PostgresContextStore(pool);
const workers = new PostgresWorkerRuntimeStore(pool);
const workflowStore = new PostgresRuntimeStore(pool);
const legacy = (prefix: string) => `${prefix}_00000000-0000-4000-8000-000000000001`;
const appVersion = "dispatch-integration-v1";
const profileId = createStableId("projectProfile");
const bindingId = createStableId("workflowBinding");
const liveSession = createStableId("workerHostSession");
let dbos: DBOSClient | undefined;
let live: HostDispatchRuntime | undefined;
let calls = 0;
let checks = 0;

async function clone(table: string, key: string, source: string, overrides: object) {
  await pool.query(`INSERT INTO acp.${table} SELECT (jsonb_populate_record(NULL::acp.${table},
    to_jsonb(source) || $1::jsonb)).* FROM acp.${table} source WHERE ${key} = $2`, [JSON.stringify(overrides), source]);
}
async function host(name: string, kind: WorkerHostRegistration["hostKind"] = "vps", sessionId = createStableId("workerHostSession")) {
  const template = createStableId("provenance");
  await clone("runtime_provenance", "provenance_id", legacy("prv"), {
    provenance_id: template, workflow_binding_id: bindingId, project_profile_id: profileId,
    host_identifier: name, database_schema_version: "0010",
  });
  const registration: WorkerHostRegistration = { hostIdentifier: name, hostKind: kind, state: "active",
    maximumCpuIntensive: kind === 'operator_laptop' ? 1 : 2, maximumModerateCompute: 1,
    maximumLightweightRead: 1, maximumNetworkBound: 1, heartbeatTtlSeconds: 300,
    provenanceId: template, transitionProvenanceId: template };
  const runtime: HostRuntimeRegistration = { hostIdentifier: name, sessionId, applicationVersion: appVersion,
    bindings: [{ workflowBindingId: bindingId, templateProvenanceId: template }] };
  await dispatches.registerRuntime(runtime, registration);
  return { registration, runtime, template };
}
async function fixture(template: StableId<"provenance">, preferredHostIdentifier?: string, expired = false, withDependency = false, wallTimeMs = 5000, workspace?: string, selectedBinding = bindingId): Promise<WorkerDispatchRequest> {
  const missionId = createStableId("mission"), nodeId = createStableId("node"), grantId = createStableId("capabilityGrant");
  const evaluationId = createStableId("capabilityGrantEvaluation");
  await clone("missions", "mission_id", legacy("mis"), { mission_id: missionId, workflow_binding_id: selectedBinding,
    state: "executing", requested_scope: "One synthetic worker result.", completed_by_evaluation_id: null,
    transition_provenance_id: template });
  const priorId = createStableId("node");
  if (withDependency) await clone("mission_nodes", "node_id", legacy("nod"), { node_id: priorId, mission_id: missionId,
    state: "succeeded", dependencies: [], graph_revision: "dispatch-test", completed_at: new Date().toISOString(),
    provenance_id: template, transition_provenance_id: template });
  await clone("mission_nodes", "node_id", legacy("nod"), { node_id: nodeId, mission_id: missionId,
    state: "runnable", dependencies: withDependency ? [priorId] : [], graph_revision: "dispatch-test", started_at: null, completed_at: null,
    provenance_id: template, transition_provenance_id: template });
  const grantFields = { mission_id: missionId, node_id: nodeId, provenance_id: template,
    ...(workspace === undefined ? {} : { workspace }),
    valid_from: "2000-01-01", expires_at: expired ? "2001-01-01" : "2099-01-01", maximum_attempts: 3 };
  await clone("capability_grant_evaluations", "evaluation_id", legacy("cge"), { ...grantFields, evaluation_id: evaluationId });
  await clone("capability_grants", "grant_id", legacy("cgr"), { ...grantFields, grant_id: grantId, evaluation_id: evaluationId });
  await contexts.publishNodeContext({ contextRevisionId: createStableId("nodeContextRevision"), missionId, nodeId,
    expectedRevision: 0, graphRevision: "dispatch-test", provenanceId: template, content: {
      objective: "Return a synthetic bounded result.", nonGoals: ["No external actions."], behavioralContract: {},
      acceptanceCriteria: ["Persist one result."], conflicts: [], unresolvedQuestions: [], nextAction: "Return JSON.",
      evidenceIds: [], activeClaimIds: [], previousRunIds: [], approvalIds: [],
      limits: { wallTimeMs, maximumTurns: 1, maximumOutputBytes: 4096 },
    } });
  const request: WorkerDispatchRequest = { runId: createStableId("run"), missionId, nodeId, grantId, attemptNumber: 1,
    applicationVersion: appVersion, operation: "synthetic.read", resource: "synthetic:record:1",
    ...(preferredHostIdentifier === undefined ? {} : { preferredHostIdentifier }), provenanceId: template };
  await dispatches.request(request);
  return request;
}
function runtimeFor(h: Awaited<ReturnType<typeof host>>, transport?: WorkerTransport): HostDispatchRuntime {
  assert.ok(dbos);
  return new HostDispatchRuntime({ host: h.registration, runtime: h.runtime, workers, contexts, dispatches,
    enqueue: postgresWorkerEnqueuer(dbos), manager: new WorkerManager(workers, transport ?? { async run(request) {
      calls++;
      return createWorkerFailureResult({ runId: request.runId, packet: request.packet,
        attemptNumber: request.attemptNumber, status: "failed", code: "invalid_output",
        conclusion: "Synthetic terminal result.", wallMilliseconds: 1 });
    } }, { localHostIdentifier: h.registration.hostIdentifier }) });
}
async function startInput(a: WorkerAssignment) {
  const packet = await contexts.buildAndRecordContextPacket({ contextPacketId: a.contextPacketId,
    missionId: a.missionId, nodeId: a.nodeId, capabilityGrantId: a.grantId,
    runtimeTemplateProvenanceId: a.templateProvenanceId, provenanceId: a.packetProvenanceId });
  const grant = await workers.loadCapabilityGrant(a.grantId); assert.ok(grant);
  return { runId: a.runId, dispatchGeneration: a.generation, packet, attemptNumber: 1,
    hostIdentifier: a.hostIdentifier, resourceClass: grant.resourceClass, wallTimeMs: packet.limits.wallTimeMs,
    provenanceId: a.packetProvenanceId, request: { missionId: packet.missionId, nodeId: packet.nodeId,
      projectId: packet.projectId, role: packet.workerRole, resourceClass: grant.resourceClass,
      operation: a.operation, resource: a.resource, mode: grant.mode, workspace: grant.workspace,
      networkAccess: 'none' as const, at: new Date().toISOString() } };
}
async function cancellationIntent(request: WorkerDispatchRequest) {
  const execution = createStableId("workflowExecution"), dbosWorkflowId = `test-cancel:${request.missionId}`;
  const run = await pool.query(`INSERT INTO acp.mission_workflow_runs (workflow_execution_id, mission_id,
    dbos_workflow_id, workflow_id, workflow_version, workflow_binding_id, dbos_application_version,
    graph_revision, state, provenance_id, transition_provenance_id)
    SELECT $1, mission_id, $2, workflow_id, workflow_version, workflow_binding_id, $3,
      'dispatch-test', 'running', $4, $4 FROM acp.missions WHERE mission_id = $5 RETURNING workflow_version`,
  [execution, dbosWorkflowId, appVersion, request.provenanceId, request.missionId]);
  return { target: { workflowExecutionId: execution, dbosWorkflowId, missionId: request.missionId,
    workflowVersion: run.rows[0]!.workflow_version as string, graphRevision: "dispatch-test", provenanceId: request.provenanceId },
    eventId: createStableId("event"), idempotencyKey: `test-cancel:${execution}`,
    reason: "Synthetic stop request.", requestedBy: "test:operator", occurredAt: new Date().toISOString() };
}
const message = (a: WorkerAssignment) => ({ runId: a.runId, generation: a.generation, hostSessionId: a.hostSessionId });
async function retire(runId: string) {
  await pool.query(`UPDATE acp.worker_dispatches SET state = 'cancelled', reason = 'Synthetic check complete.'
    WHERE run_id = $1 AND state IN ('pending', 'assigned')`, [runId]);
}
async function check(name: string, operation: () => Promise<void>) {
  await operation(); checks++; process.stdout.write(`PASS dispatch: ${name}\n`);
}
try {
  await clone("project_profiles", "profile_id", legacy("pro"), { profile_id: profileId,
    profile: { sourceAuthorityRules: { synthetic: "test" } } });
  await clone("project_workflow_bindings", "binding_id", legacy("wfb"), { binding_id: bindingId, profile_id: profileId });
  // Launch only the final live-test session queues. Reservation probes remain queued.
  DBOS.setConfig({ name: "acp-worker", systemDatabaseUrl: databaseUrl, applicationVersion: appVersion,
    executorID: "dispatch-integration", runMigrations: true, systemDatabasePoolSize: 3,
    maxConcurrentQueueDispatches: 1, systemDatabasePollingConcurrency: 1,
    listenQueues: [hostWorkerQueueName("host:dispatch-live", "lightweight_read", liveSession)] });
  // Registration must precede launch; delegate is supplied only before the live test.
  registerHostDispatchWorkflow({ execute: (value: unknown) => {
    if (!live) throw new Error("live test consumer not ready");
    return live.execute(value);
  } });
  await DBOS.launch();
  dbos = await DBOSClient.create({ systemDatabaseUrl: databaseUrl, applicationName: "acp-worker",
    systemDatabasePoolSize: 2, systemDatabasePollingConcurrency: 1 });
  const enqueue = postgresWorkerEnqueuer(dbos);
  const laptop = await host("host:dispatch-laptop", "operator_laptop");
  await check("laptop is excluded unless explicitly selected", async () => {
    const ordinary = await fixture(laptop.template);
    assert.equal(await dispatches.assign(ordinary.runId, enqueue), undefined);
    await retire(ordinary.runId);
    const explicit = await fixture(laptop.template, laptop.registration.hostIdentifier);
    const assigned = await dispatches.assign(explicit.runId, enqueue);
    assert.equal(assigned?.hostIdentifier, laptop.registration.hostIdentifier);
    await retire(explicit.runId);
  });
  const reservation = await host("host:dispatch-reservation");
  await check("request and runtime identity replay is exact", async () => {
    await dispatches.registerRuntime(reservation.runtime);
    await assert.rejects(dispatches.registerRuntime({ ...reservation.runtime, sessionId: createStableId("workerHostSession") }), /fenced/);
    await assert.rejects(dispatches.registerRuntime({ ...reservation.runtime, sessionId: createStableId("workerHostSession") },
      { ...reservation.registration, state: "offline", heartbeatTtlSeconds: 5 }), /fenced/);
    const incumbent = (await pool.query("SELECT state, heartbeat_ttl_seconds FROM acp.worker_hosts WHERE host_identifier = $1",
      [reservation.registration.hostIdentifier])).rows[0];
    assert.deepEqual(incumbent, { state: "active", heartbeat_ttl_seconds: 300 });
    const request = await fixture(reservation.template, reservation.registration.hostIdentifier);
    await dispatches.request(request);
    await assert.rejects(dispatches.request({ ...request, operation: "different" }), /aliases/);
    await retire(request.runId);
  });
  await check("reservation and real DBOS enqueue roll back atomically", async () => {
    const request = await fixture(reservation.template, reservation.registration.hostIdentifier);
    let workflowId = "";
    await assert.rejects(dispatches.assign(request.runId, async (client, assignment) => {
      workflowId = assignment.workflowId; await enqueue(client, assignment); throw new Error("synthetic rollback");
    }), /synthetic rollback/);
    assert.equal((await pool.query("SELECT 1 FROM acp.worker_dispatch_assignments WHERE run_id = $1", [request.runId])).rowCount, 0);
    assert.equal(await dbos!.retrieveWorkflow(workflowId).getStatus(), null);
    await retire(request.runId);
  });
  await check("concurrent schedulers cannot oversubscribe reserved host capacity", async () => {
    const requests = await Promise.all([fixture(reservation.template, reservation.registration.hostIdentifier),
      fixture(reservation.template, reservation.registration.hostIdentifier)]);
    const assignments = await Promise.all(requests.map((r) => dispatches.assign(r.runId, enqueue)));
    assert.equal(assignments.filter(Boolean).length, 1);
    for (const r of requests) await retire(r.runId);
  });
  await check("expired reservation can replace itself; old generations cannot execute", async () => {
    const request = await fixture(reservation.template, reservation.registration.hostIdentifier);
    const first = await dispatches.assign(request.runId, enqueue, 1000); assert.ok(first);
    assert.equal((await dispatches.assign(request.runId, async () => { throw new Error("must not enqueue replay"); }))?.workflowId, first.workflowId);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const replacement = await dispatches.assign(request.runId, enqueue); assert.ok(replacement);
    assert.equal(replacement.generation, 2);
    assert.notEqual(replacement.contextPacketId, first.contextPacketId);
    assert.equal((await dispatches.prepare(message(first), reservation.registration.hostIdentifier, appVersion,
      reservation.runtime.sessionId)).state, "obsolete");
    assert.equal((await dispatches.prepare(message(replacement), reservation.registration.hostIdentifier, appVersion,
      createStableId("workerHostSession"))).state, "obsolete");
    await retire(request.runId);
  });
  await check("session replacement fences old heartbeat and changes queue affinity", async () => {
    await dispatches.closeRuntime(reservation.registration.hostIdentifier, reservation.runtime.sessionId);
    const old = reservation.runtime;
    reservation.runtime = { ...old, sessionId: createStableId("workerHostSession") };
    await dispatches.registerRuntime(reservation.runtime);
    assert.equal(await dispatches.heartbeatRuntime(old.hostIdentifier, old.sessionId), false);
    assert.notEqual(hostWorkerQueueName(old.hostIdentifier, 'lightweight_read', old.sessionId),
      hostWorkerQueueName(old.hostIdentifier, 'lightweight_read', reservation.runtime.sessionId));
    await dispatches.closeRuntime(reservation.registration.hostIdentifier, reservation.runtime.sessionId);
    await assert.rejects(dispatches.registerRuntime(old), /historical/);
    reservation.runtime = { ...old, sessionId: createStableId("workerHostSession") };
    await dispatches.registerRuntime(reservation.runtime);
  });
  await check("expired grants block durably and unavailable work rotates behind other requests", async () => {
    const expired = await fixture(reservation.template, reservation.registration.hostIdentifier, true);
    assert.equal(await dispatches.assign(expired.runId, enqueue), undefined);
    assert.equal((await pool.query("SELECT state FROM acp.worker_dispatches WHERE run_id = $1", [expired.runId])).rows[0].state, 'blocked');
    const impossible = await fixture(reservation.template, reservation.registration.hostIdentifier);
    // A future app version is not advertised by this host session.
    await retire(impossible.runId);
    const unavailable = { ...impossible, runId: createStableId('run'), applicationVersion: 'not-installed' };
    await dispatches.request(unavailable);
    await dispatches.assign(unavailable.runId, enqueue);
    const eligible = await fixture(reservation.template, reservation.registration.hostIdentifier);
    assert.equal((await dispatches.listPending(1))[0], eligible.runId);
    await retire(unavailable.runId); await retire(eligible.runId);
  });
  await check("admitted run replay requires reconciliation and never invokes a second transport", async () => {
    const request = await fixture(reservation.template, reservation.registration.hostIdentifier);
    const assigned = await dispatches.assign(request.runId, enqueue); assert.ok(assigned);
    assert.equal((await dispatches.prepare(message(assigned), assigned.hostIdentifier, appVersion, assigned.hostSessionId)).state, 'ready');
    const input = await startInput(assigned), packet = input.packet;
    await assert.rejects(workers.startRun({ ...input, dispatchGeneration: 999 }), /exact current host dispatch/);
    await workers.startRun(input);
    assert.equal((await pool.query("SELECT acp.worker_host_load($1, 'lightweight_read') AS load", [assigned.hostIdentifier])).rows[0].load, '1');
    const executor = runtimeFor(reservation);
    assert.equal((await executor.execute(message(assigned))).state, 'reconciliation_required');
    assert.equal(calls, 0);
    const result = createWorkerFailureResult({ runId: assigned.runId, packet, attemptNumber: 1,
      status: 'failed', code: 'terminated', conclusion: 'Synthetic recovered terminal result.', wallMilliseconds: 1 });
    const fence = await pool.connect();
    let completion: Promise<boolean> | undefined;
    let settled = false;
    try {
      await fence.query("BEGIN");
      await fence.query("SELECT mission_id FROM acp.missions WHERE mission_id = $1 FOR UPDATE", [assigned.missionId]);
      completion = workers.completeRun({ result, completedAt: new Date().toISOString(), transitionProvenanceId: assigned.packetProvenanceId })
        .finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(settled, false, "completion must acquire the mission fence before projecting a result");
      await fence.query("COMMIT");
      await Promise.all([completion, executor.execute(message(assigned))]);
    } finally {
      await fence.query("ROLLBACK"); fence.release(); await completion;
    }
    const replay = await executor.execute(message(assigned)); assert.equal(replay.state, 'terminal');
    if (replay.state === 'terminal') assert.equal(replay.result.digest, result.digest);
    assert.equal(calls, 0);
  });
  await check("unstarted failure projects needs_input and retry preparation clears stale completion time", async () => {
    const request = await fixture(reservation.template, reservation.registration.hostIdentifier);
    const a = await dispatches.assign(request.runId, enqueue); assert.ok(a);
    await pool.query("UPDATE acp.mission_nodes SET completed_at = statement_timestamp() WHERE node_id = $1", [request.nodeId]);
    assert.equal((await dispatches.prepare(message(a), a.hostIdentifier, appVersion, a.hostSessionId)).state, "ready");
    assert.equal((await pool.query("SELECT completed_at FROM acp.mission_nodes WHERE node_id = $1", [request.nodeId])).rows[0].completed_at, null);
    assert.equal(await dispatches.blockUnstarted({ ...message(a), hostSessionId: createStableId("workerHostSession") }, "Wrong session."), false);
    assert.equal(await dispatches.blockUnstarted(message(a), "Synthetic invalid context."), true);
    assert.equal((await pool.query("SELECT state FROM acp.mission_nodes WHERE node_id = $1", [request.nodeId])).rows[0].state, "needs_input");
    assert.equal(await dispatches.blockUnstarted(message(a), "Replay."), false);
  });
  await check("dependency drift between preparation and run admission is denied", async () => {
    const request = await fixture(reservation.template, reservation.registration.hostIdentifier, false, true);
    const a = await dispatches.assign(request.runId, enqueue); assert.ok(a);
    assert.equal((await dispatches.prepare(message(a), a.hostIdentifier, appVersion, a.hostSessionId)).state, "ready");
    const input = await startInput(a);
    await pool.query("UPDATE acp.mission_nodes SET state = 'needs_input' WHERE mission_id = $1 AND node_id <> $2", [request.missionId, request.nodeId]);
    await assert.rejects(workers.startRun(input), /prerequisites/);
    await dispatches.blockUnstarted(message(a), "Dependency changed.");
  });
  await check("accepted cancellation denies admission before terminal mission projection", async () => {
    const request = await fixture(reservation.template, reservation.registration.hostIdentifier);
    const a = await dispatches.assign(request.runId, enqueue); assert.ok(a);
    assert.equal((await dispatches.prepare(message(a), a.hostIdentifier, appVersion, a.hostSessionId)).state, "ready");
    const input = await startInput(a), intent = await cancellationIntent(request);
    await assert.rejects(workflowStore.recordWorkflowCancellationIntent({ ...intent,
      target: { ...intent.target, graphRevision: "wrong" } }));
    assert.equal(await workflowStore.recordWorkflowCancellationIntent(intent), true);
    assert.equal(await workflowStore.recordWorkflowCancellationIntent(intent), false);
    await assert.rejects(workers.startRun(input), /exact current host dispatch/);
    assert.deepEqual(await dispatches.cancellationRequests([request.runId], a.hostIdentifier, a.hostSessionId), [request.runId]);
    assert.equal((await pool.query("SELECT state FROM acp.missions WHERE mission_id = $1", [request.missionId])).rows[0].state, "executing");
    assert.equal(await dispatches.assign(request.runId, enqueue), undefined);
    assert.equal((await pool.query("SELECT state FROM acp.worker_dispatches WHERE run_id = $1", [request.runId])).rows[0].state, "cancelled");
  });
  await check("durable stop intent cancels an admitted transport; draining alone does not", async () => {
    const h = await host("host:dispatch-cancel");
    const request = await fixture(h.template, h.registration.hostIdentifier);
    const a = await dispatches.assign(request.runId, enqueue); assert.ok(a);
    let started: () => void = () => {}, aborted = false;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const executor = runtimeFor(h, { run: (r) => new Promise((_resolve, reject) => {
      r.signal.addEventListener("abort", () => { aborted = true; reject(new Error("Synthetic stop.")); }, { once: true });
      started();
    }) });
    try {
      const pending = executor.execute(message(a)); await ready;
      await pool.query("UPDATE acp.worker_hosts SET state = 'draining' WHERE host_identifier = $1", [a.hostIdentifier]);
      await executor.heartbeat(); assert.equal(aborted, false);
      await workflowStore.recordWorkflowCancellationIntent(await cancellationIntent(request));
      await executor.heartbeat();
      const outcome = await pending; assert.equal(outcome.state, "terminal");
      if (outcome.state === "terminal") assert.equal(outcome.result.status, "cancelled");
      assert.equal(aborted, true);
    } finally { await executor.stop(); }
  });
  await check("real DBOS host queue executes once and persists run, node and dispatch outcomes", async () => {
    const runningHost = await host("host:dispatch-live", "vps", liveSession);
    live = runtimeFor(runningHost); await live.start();
    const request = await fixture(runningHost.template, runningHost.registration.hostIdentifier);
    const assignment = await dispatches.assign(request.runId, enqueue); assert.ok(assignment);
    const handle = dbos!.retrieveWorkflow<WorkerDispatchOutcome>(assignment.workflowId);
    const deadline = Date.now() + 8000;
    let status: Awaited<ReturnType<typeof handle.getStatus>>;
    do {
      status = await handle.getStatus();
      if (status?.status === 'SUCCESS' || status?.status === 'ERROR') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.equal(status?.status, 'SUCCESS');
    assert.equal((await handle.getResult()).state, 'terminal');
    assert.equal(calls, 1);
    assert.equal((await live.execute(message(assignment))).state, 'terminal');
    assert.equal(calls, 1);
    const projection = (await pool.query(`SELECT d.state AS dispatch_state, n.state AS node_state, r.state AS run_state
      FROM acp.worker_dispatches d JOIN acp.worker_runs r USING (run_id) JOIN acp.mission_nodes n ON n.node_id = d.node_id
      WHERE d.run_id = $1`, [assignment.runId])).rows[0];
    assert.deepEqual(projection, { dispatch_state: 'completed', node_state: 'failed', run_state: 'failed' });
  });
  const supervisedHost = await host("host:supervised");
  const syntheticScope = { machineFingerprint: "a".repeat(64), bootedAt: "2026-09-01T00:00:00.000Z", sessionId: 1 };
  let syntheticProcessId = 900000;
  async function admitted(h = supervisedHost, wallTimeMs = 30000, selectedBinding = bindingId) {
    const request = await fixture(h.template, h.registration.hostIdentifier, false, false, wallTimeMs, undefined, selectedBinding);
    const assignment = await dispatches.assign(request.runId, enqueue); assert.ok(assignment);
    assert.equal((await dispatches.prepare(message(assignment), assignment.hostIdentifier, appVersion, assignment.hostSessionId)).state, "ready");
    const input = await startInput(assignment), admittedRun = await workers.startRun(input);
    // This is a fabricated process, not an OS observation. Derive its timestamp
    // from database admission so sub-millisecond Windows/VM clock skew cannot
    // violate journal chronology. Advance past Date's truncated microseconds.
    const syntheticStartedAt = new Date(Date.parse(admittedRun.startedAt) + 1).toISOString();
    await new Promise((resolve) => setTimeout(resolve, 2));
    const workerProcessId = createStableId("workerProcess");
    const registration: WorkerProcessRegistration = { workerProcessId, runId: assignment.runId,
      processId: ++syntheticProcessId, processStartToken: "win32-filetime:134329999999999999", startedAt: syntheticStartedAt,
      purpose: "Synthetic native journal identity", provenanceId: assignment.packetProvenanceId,
      transitionProvenanceId: assignment.packetProvenanceId,
      supervision: { kind: "windows_job", treeIdentifier: `Local\\ACP.Worker.${workerProcessId}`, scope: syntheticScope } };
    const finishRun = () => workers.completeRun({ result: createWorkerFailureResult({ runId: assignment.runId,
      packet: input.packet, attemptNumber: 1, status: "failed", code: "terminated", conclusion: "Synthetic process probe ended.",
      wallMilliseconds: 1 }), completedAt: new Date().toISOString(), transitionProvenanceId: assignment.packetProvenanceId });
    return { request, assignment, registration, finishRun };
  }
  await check("supervised journal binds native identity and permanently fences a second root", async () => {
    const a = await admitted();
    await assert.rejects(workers.recordWorkerProcessFromRun({ ...a.registration, supervision: undefined } as unknown as WorkerProcessRegistration), /supervised run authority/);
    await assert.rejects(workers.recordWorkerProcessFromRun({ ...a.registration, processStartToken: "pid-only" }), /supervised run authority/);
    await assert.rejects(workers.recordWorkerProcessFromRun({ ...a.registration,
      supervision: { kind: "windows_job", treeIdentifier: a.registration.supervision!.treeIdentifier } }), /OS machine\/boot\/session/);
    const record = await workers.recordWorkerProcessFromRun(a.registration);
    assert.equal(record.supervision?.treeIdentifier, a.registration.supervision?.treeIdentifier);
    assert.deepEqual(await workers.recordWorkerProcessFromRun(a.registration), record);
    await assert.rejects(workers.recordWorkerProcessFromRun({ ...a.registration, processId: 900002 }), /aliases/);
    await assert.rejects(a.finishRun(), /cannot finish while its process is running/);
    await workers.heartbeatWorkerProcess(record.workerProcessId, record.processId, record.processStartToken);
    await assert.rejects(workers.heartbeatWorkerProcess(record.workerProcessId, record.processId, "wrong-start"), /does not exist/);
    await assert.rejects(pool.query("UPDATE acp.worker_processes SET tree_identifier = NULL WHERE worker_process_id = $1", [record.workerProcessId]));
    const completion = { workerProcessId: record.workerProcessId, processId: record.processId, processStartToken: record.processStartToken,
      state: "terminated" as const, exitCode: 137, terminationReason: "Synthetic tree-empty evidence.", transitionProvenanceId: record.provenanceId };
    assert.equal(await workers.finishWorkerProcess(completion), true);
    assert.equal(await workers.finishWorkerProcess(completion), false);
    const secondId = createStableId("workerProcess");
    await assert.rejects(workers.recordWorkerProcessFromRun({ ...a.registration, workerProcessId: secondId, processId: 999999,
      supervision: { kind: "windows_job", treeIdentifier: `Local\\ACP.Worker.${secondId}`, scope: syntheticScope } }), /one_owned_root_per_run/);
    await a.finishRun();
  });
  await check("journal admission waits for and observes concurrent mission cancellation", async () => {
    const a = await admitted(); const fence = await pool.connect();
    let insertion: Promise<unknown> | undefined, settled = false;
    try {
      await fence.query("BEGIN");
      await fence.query("SELECT mission_id FROM acp.missions WHERE mission_id = $1 FOR UPDATE", [a.request.missionId]);
      insertion = workers.recordWorkerProcessFromRun(a.registration).finally(() => { settled = true; });
      void insertion.catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 50)); assert.equal(settled, false);
      await fence.query("UPDATE acp.missions SET state = 'cancelled' WHERE mission_id = $1", [a.request.missionId]);
      await fence.query("COMMIT");
      await assert.rejects(insertion, /supervised run authority/);
      assert.equal(await workers.loadWorkerProcess(a.registration.workerProcessId), undefined);
    } finally { await fence.query("ROLLBACK"); fence.release(); await insertion?.catch(() => {}); }
    await a.finishRun();
  });
  await check("journal admission checks the actual deadline after waiting for a host-session fence", async () => {
    const a = await admitted(supervisedHost, 1000), fence = await pool.connect();
    let insertion: Promise<unknown> | undefined, settled = false;
    try {
      await fence.query("BEGIN");
      await fence.query("SELECT host_identifier FROM acp.worker_host_sessions WHERE host_identifier = $1 FOR UPDATE", [a.assignment.hostIdentifier]);
      insertion = workers.recordWorkerProcessFromRun(a.registration).finally(() => { settled = true; });
      void insertion.catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 50)); assert.equal(settled, false);
      await new Promise((resolve) => setTimeout(resolve, 1050));
      await fence.query("COMMIT");
      await assert.rejects(insertion, /supervised run authority/);
      assert.equal(await workers.loadWorkerProcess(a.registration.workerProcessId), undefined);
    } finally { await fence.query("ROLLBACK"); fence.release(); await insertion?.catch(() => {}); }
    await a.finishRun();
  });
  await check("accepted stop intent and a closed host session each deny process admission", async () => {
    const a = await admitted();
    await workflowStore.recordWorkflowCancellationIntent(await cancellationIntent(a.request));
    await assert.rejects(workers.recordWorkerProcessFromRun(a.registration), /supervised run authority/);
    await a.finishRun();
    const h = await host("host:supervised-retired"), b = await admitted(h);
    await dispatches.closeRuntime(h.runtime.hostIdentifier, h.runtime.sessionId);
    await assert.rejects(workers.recordWorkerProcessFromRun(b.registration), /session is no longer authoritative/);
    await b.finishRun();
  });
  if (process.platform === "win32") await check("native supervised transport persists tree closure before run and node projection", async () => {
    const request = await fixture(supervisedHost.template, supervisedHost.registration.hostIdentifier, false, false, 30000, process.cwd());
    const assignment = await dispatches.assign(request.runId, enqueue); assert.ok(assignment);
    const launcher = new WindowsWorkerLauncher({ runnerPath: fileURLToPath(new URL(
      "../../../../apps/worker/test/integration/synthetic-owned-result-runner.ts", import.meta.url)),
      onSpawn: ({ processId, purpose }) => process.stdout.write(`Owned PID ${processId}: ${purpose}\n`) });
    const runtime = runtimeFor(supervisedHost, new SupervisedWorkerTransport({ launcher, processes: workers }));
    const result = await runtime.execute(message(assignment)); assert.equal(result.state, "terminal");
    const row = (await pool.query(`SELECT p.state AS process_state, p.supervision_kind,
      r.state AS run_state, n.state AS node_state FROM acp.worker_processes p
      JOIN acp.worker_runs r USING (run_id) JOIN acp.mission_nodes n ON n.node_id = p.node_id WHERE p.run_id = $1`, [request.runId])).rows[0];
    assert.deepEqual(row, { process_state: "exited", supervision_kind: "windows_job", run_state: "failed", node_state: "failed" });
  });
  await check("recovery preserves a healthy owner's terminal-journal/result gap and retires it only under a new session", async () => {
    const h = await host("host:recovery-gap"), a = await admitted(h);
    const record = await workers.recordWorkerProcessFromRun(a.registration);
    await workers.finishWorkerProcess({ ...record, state: "terminated", exitCode: 137, terminationReason: "Synthetic exact tree stopped." });
    const currentStore = new PostgresWorkerRecoveryStore(pool, h.runtime);
    assert.equal((await currentStore.listCandidates()).length, 0);
    assert.equal(await workers.recoverStoppedRun({ runId: a.request.runId, hostIdentifier: h.runtime.hostIdentifier,
      authority: currentStore.authority, transitionProvenanceId: a.assignment.packetProvenanceId }), "pending");
    await dispatches.closeRuntime(h.runtime.hostIdentifier, h.runtime.sessionId);
    const replacement = { ...h.runtime, sessionId: createStableId("workerHostSession") };
    await dispatches.registerRuntime(replacement, h.registration);
    const store = new PostgresWorkerRecoveryStore(pool, replacement);
    const runtime = new WorkerRecoveryRuntime({ store, workers, inspector: { async stop() { throw new Error("terminal journal must not invoke OS inspector"); } } });
    assert.equal((await runtime.maintain(new AbortController().signal)).recovered, 1);
    const row = (await pool.query("SELECT state, result, transition_provenance_id FROM acp.worker_runs WHERE run_id = $1", [a.request.runId])).rows[0];
    assert.equal(row.state, "failed"); assert.notEqual(row.transition_provenance_id, a.assignment.packetProvenanceId);
    assert.equal(row.result.status, "failed");
    assert.equal((await runtime.maintain(new AbortController().signal)).recovered, 0);
    assert.equal(await workers.recoverStoppedRun({ runId: a.request.runId, hostIdentifier: h.runtime.hostIdentifier,
      authority: store.authority, transitionProvenanceId: a.assignment.packetProvenanceId }), "already_terminal");
  });
  await check("an exact stale-process claim uses new runtime provenance and preserves PostgreSQL microseconds", async () => {
    const h = await host("host:recovery-claim"), a = await admitted(h, 1000);
    const record = await workers.recordWorkerProcessFromRun(a.registration);
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert.equal((await new PostgresWorkerRecoveryStore(pool, h.runtime).listCandidates()).length, 0);
    await dispatches.closeRuntime(h.runtime.hostIdentifier, h.runtime.sessionId);
    const freshTemplate = createStableId("provenance");
    await clone("runtime_provenance", "provenance_id", h.template, { provenance_id: freshTemplate, worker_implementation_version: "2.0.0" });
    const replacement = { ...h.runtime, sessionId: createStableId("workerHostSession"),
      bindings: [{ workflowBindingId: bindingId, templateProvenanceId: freshTemplate }] };
    await dispatches.registerRuntime(replacement, h.registration);
    const store = new PostgresWorkerRecoveryStore(pool, replacement);
    const candidates = await store.listCandidates(); assert.equal(candidates.length, 1);
    const prepared = await store.prepare(candidates[0]!); assert.ok(prepared?.claim);
    const provenance = (await pool.query("SELECT * FROM acp.runtime_provenance WHERE provenance_id = $1", [prepared.provenanceId])).rows[0];
    assert.equal(provenance.worker_implementation_version, "2.0.0");
    assert.notEqual(prepared.provenanceId, record.provenanceId);
    assert.equal(prepared.claim.workerProcessId, record.workerProcessId);
    assert.equal(await store.prepare(candidates[0]!), undefined); // Live claim cannot be stolen.
    const reconciled = await workers.reconcileClaimedWorkerProcess(record.workerProcessId, prepared.claim.reconciliationId,
      async (claim, signal) => {
        assert.equal(signal.aborted, false); assert.equal(claim.processStartToken, record.processStartToken);
        return { state: "lost", terminationReason: "Synthetic exact namespace and root absence.", transitionProvenanceId: prepared.provenanceId };
      }, store.authority);
    assert.equal(reconciled.state, "terminalized");
    assert.equal(await workers.recoverStoppedRun({ runId: a.request.runId, hostIdentifier: replacement.hostIdentifier,
      transitionProvenanceId: prepared.provenanceId, authority: store.authority }), "recovered");
    const row = (await pool.query("SELECT state, result FROM acp.worker_runs WHERE run_id = $1", [a.request.runId])).rows[0];
    assert.equal(row.state, "failed"); assert.equal(row.result.findings[0].code, "timeout");
  });
  await check("retired recovery authority cannot project, and durable cancellation survives recovery", async () => {
    const h = await host("host:recovery-cancel"), a = await admitted(h);
    const record = await workers.recordWorkerProcessFromRun(a.registration);
    await workers.finishWorkerProcess({ ...record, state: "terminated", exitCode: 137, terminationReason: "Synthetic exact tree stopped." });
    await workflowStore.recordWorkflowCancellationIntent(await cancellationIntent(a.request));
    await dispatches.closeRuntime(h.runtime.hostIdentifier, h.runtime.sessionId);
    const stale = new PostgresWorkerRecoveryStore(pool, h.runtime);
    assert.equal(await stale.prepare({ workerProcessId: record.workerProcessId, runId: record.runId, processState: "terminated" }), undefined);
    const replacement = { ...h.runtime, sessionId: createStableId("workerHostSession") };
    await dispatches.registerRuntime(replacement, h.registration);
    const store = new PostgresWorkerRecoveryStore(pool, replacement);
    const runtime = new WorkerRecoveryRuntime({ store, workers, inspector: { async stop() { throw new Error("already stopped"); } } });
    assert.equal((await runtime.maintain(new AbortController().signal)).recovered, 1);
    const row = (await pool.query(`SELECT r.state, n.state AS node_state FROM acp.worker_runs r
      JOIN acp.mission_nodes n ON n.node_id = r.node_id WHERE r.run_id = $1`, [record.runId])).rows[0];
    assert.deepEqual(row, { state: "cancelled", node_state: "cancelled" });
  });
  await check("a durable result wins over a prepared recovery projection", async () => {
    const h = await host("host:recovery-winner"), a = await admitted(h);
    const record = await workers.recordWorkerProcessFromRun(a.registration);
    await workers.finishWorkerProcess({ ...record, state: "terminated", exitCode: 137, terminationReason: "Synthetic exact tree stopped." });
    await dispatches.closeRuntime(h.runtime.hostIdentifier, h.runtime.sessionId);
    const replacement = { ...h.runtime, sessionId: createStableId("workerHostSession") };
    await dispatches.registerRuntime(replacement, h.registration);
    const store = new PostgresWorkerRecoveryStore(pool, replacement);
    const prepared = await store.prepare((await store.listCandidates())[0]!); assert.ok(prepared);
    assert.equal(await a.finishRun(), true);
    assert.equal(await workers.recoverStoppedRun({ runId: record.runId, hostIdentifier: replacement.hostIdentifier,
      transitionProvenanceId: prepared.provenanceId, authority: store.authority }), "already_terminal");
    const result = (await pool.query("SELECT result FROM acp.worker_runs WHERE run_id = $1", [record.runId])).rows[0].result;
    assert.equal(result.conclusion, "Synthetic process probe ended.");
  });
  if (process.platform === "win32") await check("a killed native owner is recovered through the durable journal without a duplicate launch", async () => {
    const h = await host("host:recovery-native"), a = await admitted(h, 6000);
    const deadline = (await pool.query("SELECT timeout_at FROM acp.worker_runs WHERE run_id = $1", [a.request.runId])).rows[0].timeout_at as Date;
    const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL(
      "../../../../apps/worker/test/integration/synthetic-recovery-daemon.ts", import.meta.url)), a.registration.workerProcessId, deadline.toISOString()],
    { windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"], env: minimalCodexEnvironment() });
    process.stdout.write(`Owned PID ${child.pid}: sacrificial journaled worker daemon\n`);
    const closed = once(child, "close"); const descendants: number[] = [];
    const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
      child.on("message", (value: Record<string, unknown>) => {
        if (value.type === "spawn") { descendants.push(value.processId as number); process.stdout.write(`Owned PID ${value.processId}: ${value.purpose}\n`); }
        if (value.type === "ready") resolve(value);
      }); child.once("error", reject); child.once("exit", () => reject(new Error("owner exited before identity acknowledgement")));
    });
    try {
      const identity = await ready;
      const record = await workers.recordWorkerProcessFromRun({ ...a.registration, processId: identity.processId as number,
        processStartToken: identity.processStartToken as string, startedAt: identity.startedAt as string,
        supervision: { ...a.registration.supervision!, scope: parseWindowsSupervisionScope(identity.scope) } });
      const released = new Promise<void>((resolve) => child.on("message", (value: Record<string, unknown>) => { if (value.type === "released") resolve(); }));
      child.send("go"); await released; child.kill(); await closed;
      await dispatches.closeRuntime(h.runtime.hostIdentifier, h.runtime.sessionId);
      const replacement = { ...h.runtime, sessionId: createStableId("workerHostSession") };
      await dispatches.registerRuntime(replacement, h.registration);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline.getTime() - Date.now() + 50)));
      const store = new PostgresWorkerRecoveryStore(pool, replacement);
      const recovery = new WorkerRecoveryRuntime({ store, workers, inspector: new WindowsWorkerTreeInspector({
        onSpawn: (pid, purpose) => process.stdout.write(`Owned PID ${pid}: ${purpose}\n`) }) });
      const outcome = await recovery.maintain(new AbortController().signal);
      assert.equal(outcome.recovered, 1); assert.deepEqual(outcome.errors, []);
      const journal = await workers.loadWorkerProcess(record.workerProcessId); assert.equal(journal?.state, "lost");
      const row = (await pool.query(`SELECT r.state, n.state AS node_state,
        (SELECT count(*)::int FROM acp.worker_processes p WHERE p.run_id = r.run_id) AS process_count
        FROM acp.worker_runs r JOIN acp.mission_nodes n ON n.node_id = r.node_id WHERE r.run_id = $1`, [record.runId])).rows[0];
      assert.deepEqual(row, { state: "failed", node_state: "failed", process_count: 1 });
      for (const pid of descendants) assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; }
  });
  await check("mixed bindings recover with separate current templates and exact claims", async () => {
    const h = await host("host:recovery-bindings"), otherBinding = createStableId("workflowBinding"), otherTemplate = createStableId("provenance");
    await clone("project_workflow_bindings", "binding_id", bindingId, { binding_id: otherBinding });
    await clone("runtime_provenance", "provenance_id", h.template, { provenance_id: otherTemplate, workflow_binding_id: otherBinding });
    const registration = { ...h.registration, maximumLightweightRead: 2 };
    const runtime = { ...h.runtime, bindings: [...h.runtime.bindings, { workflowBindingId: otherBinding, templateProvenanceId: otherTemplate }] };
    await dispatches.registerRuntime(runtime, registration);
    const a = await admitted({ ...h, registration, runtime }, 1000);
    const b = await admitted({ ...h, registration, runtime, template: otherTemplate }, 1000, otherBinding);
    await workers.recordWorkerProcessFromRun(a.registration); await workers.recordWorkerProcessFromRun(b.registration);
    await new Promise((resolve) => setTimeout(resolve, 1050));
    await dispatches.closeRuntime(runtime.hostIdentifier, runtime.sessionId);
    const replacement = { ...runtime, sessionId: createStableId("workerHostSession") };
    await dispatches.registerRuntime(replacement, registration);
    const store = new PostgresWorkerRecoveryStore(pool, replacement), candidates = await store.listCandidates();
    assert.equal(candidates.length, 2);
    for (const item of candidates) {
      const prepared = await store.prepare(item); assert.ok(prepared?.claim);
      const expected = item.runId === a.request.runId ? bindingId : otherBinding;
      const provenance = (await pool.query("SELECT workflow_binding_id FROM acp.runtime_provenance WHERE provenance_id = $1", [prepared.provenanceId])).rows[0];
      assert.equal(provenance.workflow_binding_id, expected);
      assert.equal((await workers.reconcileClaimedWorkerProcess(item.workerProcessId, prepared.claim.reconciliationId,
        async () => ({ state: "lost", terminationReason: "Synthetic exact absence.", transitionProvenanceId: prepared.provenanceId }), store.authority)).state, "terminalized");
      assert.equal(await workers.recoverStoppedRun({ runId: item.runId, hostIdentifier: replacement.hostIdentifier,
        transitionProvenanceId: prepared.provenanceId, authority: store.authority }), "recovered");
    }
  });
  await check("a lost advisory-lock acknowledgement destroys the physical session and releases its lock", async () => {
    const id = createStableId("workerProcess"); let acquired = false, releasedBroken = false;
    const intercepted: ConnectionPool = { query: pool.query.bind(pool), async connect() {
      const client = await pool.connect();
      return { async query(text, values) {
        const result = await client.query(text, values);
        if (text.includes("pg_try_advisory_lock")) { acquired = result.rows[0]?.acquired === true; throw new Error("lost acquired lock acknowledgement"); }
        return result;
      }, release(broken) { releasedBroken = broken === true; client.release(broken); },
      on: client.on.bind(client), off: client.off.bind(client) };
    } };
    await assert.rejects(new PostgresWorkerRuntimeStore(intercepted).reconcileClaimedWorkerProcess(id,
      createStableId("reconciliation"), async () => { assert.fail("uncertain lock must not inspect"); }), /lost acquired lock acknowledgement/u);
    assert.equal(acquired, true); assert.equal(releasedBroken, true);
    let held = true;
    for (let attempt = 0; attempt < 40 && held; attempt++) {
      held = (await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted AND objsubid=1
        AND classid=((hashtextextended('acp:worker-process-reconciliation:' || $1,0) >> 32) & 4294967295)::oid
        AND objid=(hashtextextended('acp:worker-process-reconciliation:' || $1,0) & 4294967295)::oid) AS held`, [id])).rows[0].held;
      if (held) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(held, false);
  });
  await check("database session loss aborts inspection, awaits cleanup, and leaves the journal running", async () => {
    const h = await host("host:recovery-db-loss"), a = await admitted(h, 1000);
    const record = await workers.recordWorkerProcessFromRun(a.registration);
    await new Promise((resolve) => setTimeout(resolve, 1050));
    await dispatches.closeRuntime(h.runtime.hostIdentifier, h.runtime.sessionId);
    const replacement = { ...h.runtime, sessionId: createStableId("workerHostSession") };
    await dispatches.registerRuntime(replacement, h.registration);
    const store = new PostgresWorkerRecoveryStore(pool, replacement), prepared = await store.prepare((await store.listCandidates())[0]!);
    assert.ok(prepared?.claim);
    let backendPid = 0, entered!: () => void, cleaned = false;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const observedWorkers = new PostgresWorkerRuntimeStore({ query: pool.query.bind(pool), connect: async () => {
      const client = await pool.connect(); backendPid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number; return client;
    } });
    const observation = observedWorkers.reconcileClaimedWorkerProcess(record.workerProcessId, prepared.claim.reconciliationId,
      async (_claim, signal) => { entered(); return await new Promise((resolve) => {
        signal.addEventListener("abort", () => setTimeout(() => { cleaned = true; resolve({ state: "running" }); }, 20), { once: true });
      }); }, store.authority);
    void observation.catch(() => {}); await started;
    assert.ok(backendPid > 0); await pool.query("SELECT pg_terminate_backend($1)", [backendPid]);
    await assert.rejects(observation, /observation unconfirmed/); assert.equal(cleaned, true);
    assert.equal((await workers.loadWorkerProcess(record.workerProcessId))?.state, "running");
    assert.equal((await pool.query("SELECT pg_try_advisory_xact_lock(hashtextextended('acp:worker-process-reconciliation:' || $1, 0)) AS acquired", [record.workerProcessId])).rows[0].acquired, true);
    // The synthetic journal intentionally remains pending; the owned database
    // is disposed by the gate. A live reconciliation claim also fences finishWorkerProcess.
  });
  await check("a lock wait past the observation budget cannot commit a terminal process", async () => {
    const h = await host("host:recovery-lock"), a = await admitted(h, 1000);
    const record = await workers.recordWorkerProcessFromRun(a.registration);
    await new Promise((resolve) => setTimeout(resolve, 1050));
    await dispatches.closeRuntime(h.runtime.hostIdentifier, h.runtime.sessionId);
    const replacement = { ...h.runtime, sessionId: createStableId("workerHostSession") };
    await dispatches.registerRuntime(replacement, h.registration);
    const store = new PostgresWorkerRecoveryStore(pool, replacement);
    const prepared = { provenanceId: createStableId("provenance") };
    await clone("runtime_provenance", "provenance_id", a.assignment.packetProvenanceId,
      { provenance_id: prepared.provenanceId, recorded_at: new Date().toISOString() });
    const claim = (await workers.claimWorkerProcessesNeedingReconciliation({ workerProcessId: record.workerProcessId,
      hostIdentifier: replacement.hostIdentifier, staleAfterSeconds: 15, claimTtlSeconds: 5, limit: 1,
      reconciliationId: createStableId("reconciliation"), reconciliationOwner: replacement.sessionId,
      reconciliationProvenanceId: prepared.provenanceId }))[0]; assert.ok(claim);
    const fence = await pool.connect(); let observing: Promise<unknown> | undefined;
    try {
      await fence.query("BEGIN"); await fence.query("SELECT worker_process_id FROM acp.worker_processes WHERE worker_process_id = $1 FOR UPDATE", [record.workerProcessId]);
      let observed!: () => void; const observationReady = new Promise<void>((resolve) => { observed = resolve; });
      observing = workers.reconcileClaimedWorkerProcess(record.workerProcessId, claim.reconciliationId, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1900)); observed();
        return { state: "lost", terminationReason: "Synthetic exact absence.", transitionProvenanceId: prepared.provenanceId };
      }, store.authority);
      void observing.catch(() => {}); await observationReady;
      await new Promise((resolve) => setTimeout(resolve, 2250)); await fence.query("COMMIT");
      await assert.rejects(observing, /observation unconfirmed/);
      assert.equal((await workers.loadWorkerProcess(record.workerProcessId))?.state, "running");
    } finally { await fence.query("ROLLBACK"); fence.release(); await observing?.catch(() => {}); }
  });
  await check("a recovery session closed during observation cannot persist terminal state", async () => {
    const h = await host("host:recovery-retire-race"), a = await admitted(h, 1000);
    const record = await workers.recordWorkerProcessFromRun(a.registration);
    await new Promise((resolve) => setTimeout(resolve, 1050));
    await dispatches.closeRuntime(h.runtime.hostIdentifier, h.runtime.sessionId);
    const replacement = { ...h.runtime, sessionId: createStableId("workerHostSession") };
    await dispatches.registerRuntime(replacement, h.registration);
    const store = new PostgresWorkerRecoveryStore(pool, replacement), prepared = await store.prepare((await store.listCandidates())[0]!); assert.ok(prepared?.claim);
    const fence = await pool.connect(); let observing: Promise<unknown> | undefined;
    try {
      await fence.query("BEGIN"); await fence.query("SELECT host_identifier FROM acp.worker_host_sessions WHERE host_identifier = $1 FOR UPDATE", [replacement.hostIdentifier]);
      let observed!: () => void; const observationReady = new Promise<void>((resolve) => { observed = resolve; });
      observing = workers.reconcileClaimedWorkerProcess(record.workerProcessId, prepared.claim.reconciliationId, async () => {
        observed(); return { state: "lost", terminationReason: "Synthetic exact absence.", transitionProvenanceId: prepared.provenanceId };
      }, store.authority);
      void observing.catch(() => {}); await observationReady;
      await fence.query("UPDATE acp.worker_host_sessions SET state = 'closed' WHERE host_identifier = $1", [replacement.hostIdentifier]);
      await fence.query("COMMIT");
      assert.deepEqual(await observing, { state: "stale_claim" });
      assert.equal((await workers.loadWorkerProcess(record.workerProcessId))?.state, "running");
    } finally { await fence.query("ROLLBACK"); fence.release(); await observing?.catch(() => {}); }
  });
  process.stdout.write(`Host dispatch integration: ${checks} checks passed.\n`);
} finally {
  await live?.stop();
  await DBOS.shutdown({ deregister: true });
  await dbos?.destroy();
  await pool.end();
}
