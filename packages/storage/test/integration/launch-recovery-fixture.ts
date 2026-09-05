import assert from "node:assert/strict";
import type { Pool } from "pg";
import { createStableId, createWorkerFailureResult, type StableId } from "@acp/domain";
import { PostgresContextStore, PostgresDispatchStore, PostgresWorkerRuntimeStore, PostgresWorkerLaunchStore,
  type WorkerProcessRegistration, type WindowsLaunchFenceDescriptor } from "../../src/index.ts";

/** Synthetic authority/process fixture. Native callers replace the root explicitly. */
export async function launchRecoveryFixture(pool: Pool, hostIdentifier = "host:launch-recovery-check", databaseSchemaVersion = "0012", hostProvenanceId?: StableId<"provenance">) {
  const contexts = new PostgresContextStore(pool), dispatches = new PostgresDispatchStore(pool), workers = new PostgresWorkerRuntimeStore(pool);
  const legacy = (prefix: string) => `${prefix}_00000000-0000-4000-8000-000000000001`;
  const profile = createStableId("projectProfile"), binding = createStableId("workflowBinding"), template = createStableId("provenance");
  const applicationVersion = "launch-recovery-v1";
  const host = { hostIdentifier, hostKind: "vps" as const, state: "active" as const, maximumCpuIntensive: 1, maximumModerateCompute: 1,
    maximumLightweightRead: 32, maximumNetworkBound: 1, heartbeatTtlSeconds: 300, provenanceId: hostProvenanceId ?? template, transitionProvenanceId: template };
  let runtime = { hostIdentifier, applicationVersion, sessionId: createStableId("workerHostSession"),
    bindings: [{ workflowBindingId: binding, templateProvenanceId: template }] };
  let launches = new PostgresWorkerLaunchStore(pool, runtime), processId = 920000;
  const syntheticFence: WindowsLaunchFenceDescriptor = { directory: "C:\\ACP-test-only\\recovery seals",
    directoryIdentity: "win32-dir:12345678:0000000000000002", scope: { machineFingerprint: "b".repeat(64), bootedAt: "2026-09-01T00:00:00.000Z", sessionId: 1 } };
  async function clone(table: string, key: string, source: string, overrides: object) {
    await pool.query(`INSERT INTO acp.${table} SELECT (jsonb_populate_record(NULL::acp.${table}, to_jsonb(source) || $1::jsonb)).*
      FROM acp.${table} source WHERE ${key} = $2`, [JSON.stringify(overrides), source]);
  }
  await clone("project_profiles", "profile_id", legacy("pro"), { profile_id: profile, profile: { sourceAuthorityRules: { synthetic: "canonical" } } });
  await clone("project_workflow_bindings", "binding_id", legacy("wfb"), { binding_id: binding, profile_id: profile });
  await clone("runtime_provenance", "provenance_id", legacy("prv"), { provenance_id: template, workflow_binding_id: binding,
    project_profile_id: profile, host_identifier: hostIdentifier, database_schema_version: databaseSchemaVersion });
  await dispatches.registerRuntime(runtime, host);
  async function assignment(fence = syntheticFence, workspace?: string, delivery = false, wallTimeMs = 60000, assignmentTtlMs = 60000) {
    const missionId = createStableId("mission"), nodeId = createStableId("node"), grantId = createStableId("capabilityGrant");
    await clone("missions", "mission_id", legacy("mis"), { mission_id: missionId, workflow_binding_id: binding, state: "executing",
      requested_scope: "Synthetic launch recovery.", completed_by_evaluation_id: null, transition_provenance_id: template });
    await clone("mission_nodes", "node_id", legacy("nod"), { node_id: nodeId, mission_id: missionId, state: "runnable", dependencies: [],
      graph_revision: "launch-recovery-check", started_at: null, completed_at: null, provenance_id: template, transition_provenance_id: template,
      ...(delivery ? { worker_role: "delivery" } : {}) });
    const evaluation = createStableId("capabilityGrantEvaluation"), fields = { mission_id: missionId, node_id: nodeId, provenance_id: template,
      valid_from: "2000-01-01", expires_at: "2099-01-01", maximum_attempts: 3,
      ...(workspace === undefined ? {} : { workspace }), ...(delivery ? { role: "delivery", mode: "write" } : {}) };
    await clone("capability_grant_evaluations", "evaluation_id", legacy("cge"), { ...fields, evaluation_id: evaluation });
    await clone("capability_grants", "grant_id", legacy("cgr"), { ...fields, grant_id: grantId, evaluation_id: evaluation });
    await contexts.publishNodeContext({ contextRevisionId: createStableId("nodeContextRevision"), missionId, nodeId, expectedRevision: 0,
      graphRevision: "launch-recovery-check", provenanceId: template, content: { objective: "Test durable launch recovery.", nonGoals: ["No external actions."],
        behavioralContract: {}, acceptanceCriteria: [], conflicts: [], unresolvedQuestions: [], nextAction: "Return a synthetic result.",
        evidenceIds: [], activeClaimIds: [], previousRunIds: [], approvalIds: [], limits: { wallTimeMs, maximumTurns: 1, maximumOutputBytes: 4096 } } });
    const runId = createStableId("run");
    await dispatches.request({ runId, missionId, nodeId, grantId, attemptNumber: 1, applicationVersion: runtime.applicationVersion,
      operation: "synthetic.read", resource: "synthetic:record:1", preferredHostIdentifier: hostIdentifier, provenanceId: template });
    const a = await dispatches.assign(runId, async () => {}, assignmentTtlMs); assert.ok(a);
    const message = { runId, generation: a.generation, hostSessionId: runtime.sessionId };
    assert.equal((await dispatches.prepare(message, hostIdentifier, runtime.applicationVersion, runtime.sessionId)).state, "ready");
    const packet = await contexts.buildAndRecordContextPacket({ contextPacketId: a.contextPacketId, missionId, nodeId, capabilityGrantId: grantId,
      runtimeTemplateProvenanceId: template, provenanceId: a.packetProvenanceId });
    const grant = await workers.loadCapabilityGrant(grantId); assert.ok(grant);
    const workerProcessId = createStableId("workerProcess");
    const start = { runId, dispatchGeneration: a.generation, packet, attemptNumber: 1, hostIdentifier,
      resourceClass: grant.resourceClass, wallTimeMs: packet.limits.wallTimeMs, provenanceId: a.packetProvenanceId,
      launchIntent: { workerProcessId, fence }, request: { missionId, nodeId, projectId: packet.projectId, role: packet.workerRole,
        resourceClass: grant.resourceClass, operation: a.operation, resource: a.resource, mode: grant.mode, workspace: grant.workspace,
        networkAccess: "none" as const, at: new Date().toISOString() } };
    return { a, packet, start, message };
  }
  async function sample(journal = false, fence = syntheticFence, workspace?: string, delivery = false, wallTimeMs = 60000) {
    const { a, packet, start, message } = await assignment(fence, workspace, delivery, wallTimeMs);
    const { runId } = start, { workerProcessId } = start.launchIntent;
    const started = await workers.startRun(start);
    const registration: WorkerProcessRegistration = { workerProcessId, runId, processId: ++processId, processStartToken: "win32-filetime:134329999999999999",
      startedAt: new Date(Date.parse(started.startedAt) + 1).toISOString(), purpose: "Synthetic launch recovery; no OS process",
      provenanceId: a.packetProvenanceId, transitionProvenanceId: a.packetProvenanceId,
      supervision: { kind: "windows_job", treeIdentifier: `Local\\ACP.Worker.${workerProcessId}`, scope: fence.scope } };
    if (journal) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      await workers.recordWorkerProcessFromRun(registration);
    }
    const owner = launches, originalRuntime = runtime;
    return { a, packet, start, started, registration, message, candidate: { runId, workerProcessId }, owner, originalRuntime,
      handoff: async () => (await pool.query("SELECT acp.handoff_worker_run($1,$2,$3,$4,$5) AS outcome",
        [runId, a.generation, hostIdentifier, originalRuntime.sessionId, originalRuntime.applicationVersion])).rows[0].outcome as string,
      finishOwner: (record = registration) => owner.finishOwnedLaunch({ ...record, state: "terminated", exitCode: 137,
        terminationReason: "Synthetic owner tree closure.", launchSealed: true }),
      finishRun: () => workers.completeRun({ result: createWorkerFailureResult({ runId, packet, attemptNumber: 1,
        status: "failed", code: "terminated", conclusion: "Synthetic owner result.", wallMilliseconds: 1 }),
        completedAt: new Date().toISOString(), transitionProvenanceId: a.packetProvenanceId }) };
  }
  async function replaceOwner() {
    await dispatches.closeRuntime(hostIdentifier, runtime.sessionId);
    runtime = { ...runtime, sessionId: createStableId("workerHostSession") };
    await dispatches.registerRuntime(runtime, host); launches = new PostgresWorkerLaunchStore(pool, runtime);
  }
  return { contexts, dispatches, workers, host, template, binding, clone, assignment, sample, replaceOwner,
    get runtime() { return runtime; }, get launches() { return launches; } };
}
