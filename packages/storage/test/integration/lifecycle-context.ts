// Bounded phases around migration 0009; only the gate's disposable database.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { canonicalJsonDigest, createStableId, createWorkerFailureResult, createContextPacket, parseContextPacket, evaluateCompletionContract,
  type ContextPacket, type StableId, type NodeContextContent, type JsonValue } from "@acp/domain";
import { PostgresContextStore, PostgresDispatchStore, PostgresWorkerRuntimeStore, PostgresWorkerRecoveryStore,
  type HostRuntimeRegistration, type WorkerHostRegistration, type WorkerAssignment } from "../../src/index.ts";

const port = Number(process.argv[2]), phase = process.argv[3];
if (!Number.isInteger(port) || port < 1024 || port > 65535 || !["before", "preflight", "after", "rollback"].includes(phase!)) throw new Error("owned database port and upgrade phase required");
const pool = new Pool({ connectionString: `postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test`, max: 3,
  statement_timeout: 5000, lock_timeout: 3000, connectionTimeoutMillis: 3000 });
const contexts = new PostgresContextStore(pool), dispatches = new PostgresDispatchStore(pool), workers = new PostgresWorkerRuntimeStore(pool);
const hostIdentifier = "host:lifecycle-upgrade", applicationVersion = "lifecycle-test-v1";
const legacy = (prefix: string) => `${prefix}_00000000-0000-4000-8000-000000000001`;
const content: NodeContextContent = { objective: "Inspect exact lifecycle identity.", nonGoals: ["No external actions."], behavioralContract: {},
  acceptanceCriteria: ["Preserve independent states and exact observed identities."], conflicts: [], unresolvedQuestions: [], nextAction: "Return a synthetic result.",
  evidenceIds: [], activeClaimIds: [], previousRunIds: [], approvalIds: [], limits: { wallTimeMs: 30000, maximumTurns: 1, maximumOutputBytes: 4096 } };
async function clone(table: string, key: string, source: string, overrides: object) {
  await pool.query(`INSERT INTO acp.${table} SELECT (jsonb_populate_record(NULL::acp.${table}, to_jsonb(source) || $1::jsonb)).*
    FROM acp.${table} source WHERE ${key} = $2`, [JSON.stringify(overrides), source]);
}
function registration(provenanceId: StableId<"provenance">): WorkerHostRegistration {
  return { hostIdentifier, hostKind: "vps", state: "active", maximumCpuIntensive: 1, maximumModerateCompute: 1,
    maximumLightweightRead: 1, maximumNetworkBound: 1, heartbeatTtlSeconds: 300, provenanceId, transitionProvenanceId: provenanceId };
}
const message = (a: WorkerAssignment) => ({ runId: a.runId, generation: a.generation, hostSessionId: a.hostSessionId });
const packetRequest = (a: WorkerAssignment) => ({ contextPacketId: a.contextPacketId, missionId: a.missionId, nodeId: a.nodeId,
  capabilityGrantId: a.grantId, runtimeTemplateProvenanceId: a.templateProvenanceId, provenanceId: a.packetProvenanceId });
async function start(a: WorkerAssignment, packet: ContextPacket) {
  const grant = await workers.loadCapabilityGrant(a.grantId); assert.ok(grant);
  return workers.startRun({ runId: a.runId, dispatchGeneration: a.generation, packet, attemptNumber: a.attemptNumber,
    hostIdentifier, resourceClass: grant.resourceClass, wallTimeMs: packet.limits.wallTimeMs, provenanceId: a.packetProvenanceId,
    request: { missionId: a.missionId, nodeId: a.nodeId, projectId: packet.projectId, role: packet.workerRole,
      resourceClass: grant.resourceClass, operation: a.operation, resource: a.resource, mode: grant.mode, workspace: grant.workspace,
      networkAccess: "none", at: new Date().toISOString() } });
}
let checks = 0;
async function check(name: string, action: () => Promise<void>) { await action(); checks++; process.stdout.write(`PASS lifecycle: ${name}\n`); }
try {
  if (phase === "before") {
    await check("preserves an admitted 1.0.0 run with stopped journal across the upgrade", async () => {
      const profile = createStableId("projectProfile"), binding = createStableId("workflowBinding"), template = createStableId("provenance");
      const missionId = createStableId("mission"), nodeId = createStableId("node"), grantId = createStableId("capabilityGrant");
      await clone("project_profiles", "profile_id", legacy("pro"), { profile_id: profile, profile: { sourceAuthorityRules: { fixture: "canonical" } } });
      await clone("project_workflow_bindings", "binding_id", legacy("wfb"), { binding_id: binding, profile_id: profile });
      await clone("runtime_provenance", "provenance_id", legacy("prv"), { provenance_id: template,
        workflow_binding_id: binding, project_profile_id: profile, host_identifier: hostIdentifier, database_schema_version: "0008" });
      await clone("missions", "mission_id", legacy("mis"), { mission_id: missionId, workflow_binding_id: binding, state: "executing",
        requested_scope: "Lifecycle migration fixture.", completed_by_evaluation_id: null, transition_provenance_id: template });
      await clone("mission_nodes", "node_id", legacy("nod"), { node_id: nodeId, mission_id: missionId, state: "runnable", dependencies: [],
        graph_revision: "lifecycle-upgrade", started_at: null, completed_at: null, provenance_id: template, transition_provenance_id: template });
      const grantFields = { mission_id: missionId, node_id: nodeId, provenance_id: template, maximum_attempts: 3,
        valid_from: "2000-01-01", expires_at: "2099-01-01" }, evaluation = createStableId("capabilityGrantEvaluation");
      await clone("capability_grant_evaluations", "evaluation_id", legacy("cge"), { ...grantFields, evaluation_id: evaluation });
      await clone("capability_grants", "grant_id", legacy("cgr"), { ...grantFields, grant_id: grantId, evaluation_id: evaluation });
      const runtime: HostRuntimeRegistration = { hostIdentifier, sessionId: createStableId("workerHostSession"), applicationVersion,
        bindings: [{ workflowBindingId: binding, templateProvenanceId: template }] };
      await dispatches.registerRuntime(runtime, registration(template));
      await contexts.publishNodeContext({ contextRevisionId: createStableId("nodeContextRevision"), missionId, nodeId, expectedRevision: 0,
        graphRevision: "lifecycle-upgrade", content, provenanceId: template });
      const runId = createStableId("run");
      await dispatches.request({ runId, missionId, nodeId, grantId, attemptNumber: 1, applicationVersion,
        operation: "synthetic.read", resource: "synthetic:record:1", preferredHostIdentifier: hostIdentifier, provenanceId: template });
      const a = await dispatches.assign(runId, async () => {}); assert.ok(a);
      assert.equal((await dispatches.prepare(message(a), hostIdentifier, applicationVersion, runtime.sessionId)).state, "ready");
      const packet = await contexts.buildAndRecordContextPacket(packetRequest(a)); assert.equal(packet.schemaVersion, "1.0.0");
      const admittedRun = await start(a, packet);
      const syntheticStartedAt = new Date(Date.parse(admittedRun.startedAt) + 1).toISOString();
      await new Promise((resolve) => setTimeout(resolve, 2));
      const workerProcessId = createStableId("workerProcess");
      const record = await workers.recordWorkerProcessFromRun({ workerProcessId, runId, processId: 999991,
        processStartToken: "win32-filetime:134329999999999999", startedAt: syntheticStartedAt, purpose: "Synthetic upgrade fixture",
        provenanceId: a.packetProvenanceId, transitionProvenanceId: a.packetProvenanceId,
        supervision: { kind: "windows_job", treeIdentifier: `Local\\ACP.Worker.${workerProcessId}`,
          scope: { machineFingerprint: "a".repeat(64), bootedAt: "2026-09-01T00:00:00.000Z", sessionId: 1 } } });
      await workers.finishWorkerProcess({ ...record, state: "terminated", exitCode: 137, terminationReason: "Synthetic exact tree stop." });
      await dispatches.closeRuntime(hostIdentifier, runtime.sessionId);
    });
  } else if (phase === "preflight") {
    const migration = await readFile(new URL("../../migrations/0009_lifecycle_context.sql", import.meta.url), "utf8");
    for (const [table, state] of [["candidate_records", "merged"], ["deployment_records", "verified"], ["acceptance_records", "pending"],
      ["tracker_records", "unused"], ["business_completion_records", "pending"]]) {
      await check(`populated future observation in ${table} blocks upgrade atomically`, async () => {
        const client = await pool.connect(), recordId = createStableId("event");
        try {
          await client.query("BEGIN");
          const row = { record_id: recordId, mission_id: legacy("mis"), provenance_id: legacy("prv"), observed_at: "2099-01-01T00:00:00Z", state,
            evidence_ids: [legacy("evd")], candidate_id: createStableId("candidate"), repository_id: createStableId("repository"), worktree_path: "/synthetic", branch: "test",
            head_sha: "a".repeat(40), environment: "staging", adapter_id: "synthetic", external_id: "issue:1", native_state: "Open", source_version: "v1" };
          await client.query(`INSERT INTO acp.${table} SELECT (jsonb_populate_record(NULL::acp.${table}, $1::jsonb)).*`, [JSON.stringify(row)]);
          await assert.rejects(client.query(migration), new RegExp(`0009 preflight: ${table} contains future`));
        } finally { await client.query("ROLLBACK"); client.release(); }
        assert.equal((await pool.query(`SELECT 1 FROM acp.${table} WHERE record_id = $1`, [recordId])).rowCount, 0);
      });
    }
  } else if (phase === "rollback") {
    const row = (await pool.query(`SELECT r.*, p.packet, p.context_revision_id FROM acp.worker_runs r
      JOIN acp.context_packets p USING (context_packet_id) WHERE r.host_identifier = $1 AND p.packet ->> 'schemaVersion' = '1.1.0'`, [hostIdentifier])).rows[0]; assert.ok(row);
    await check("producer rollback preserves new packet digests and observed identities", async () => {
      const packets = await pool.query("SELECT packet FROM acp.context_packets WHERE mission_id = $1", [row.mission_id]);
      for (const item of packets.rows) assert.deepEqual(parseContextPacket(item.packet), item.packet);
      assert.deepEqual(await workers.loadContextPacket(row.context_packet_id), row.packet);
      assert.ok(row.packet.lifecycle.candidate.observation.recordId);
    });
    await check("producer rollback retains immutable observation and time guards", async () => {
      for (const table of ["candidate_records", "deployment_records", "acceptance_records", "tracker_records", "business_completion_records"]) {
        const id = (await pool.query(`SELECT record_id FROM acp.${table} WHERE mission_id = $1 LIMIT 1`, [row.mission_id])).rows[0].record_id;
        await assert.rejects(pool.query(`UPDATE acp.${table} SET observed_at = statement_timestamp() WHERE record_id = $1`, [id]), /append-only/);
        await assert.rejects(pool.query(`DELETE FROM acp.${table} WHERE record_id = $1`, [id]), /append-only/);
        await assert.rejects(pool.query(`TRUNCATE acp.${table}`), /append-only/);
        await assert.rejects(clone(table, "record_id", id, { record_id: createStableId("event"), observed_at: "2099-01-01T00:00:00Z" }), /cannot be in the future/);
      }
    });
    await check("producer rollback restores the legacy packet shape without inventing versions", async () => {
      await pool.query("UPDATE acp.mission_nodes SET state = 'runnable', completed_at = NULL, transition_provenance_id = $2 WHERE node_id = $1", [row.node_id, row.transition_provenance_id]);
      const built = (await pool.query("SELECT acp.build_context_packet_content($1,$2,$3,$4,$5) AS packet",
        [createStableId("contextPacket"), row.mission_id, row.node_id, row.context_revision_id, row.capability_grant_id])).rows[0].packet;
      const packet = createContextPacket(built); assert.equal(packet.schemaVersion, "1.0.0");
      assert.equal(packet.lifecycle.candidate?.candidateId, undefined); assert.equal(packet.lifecycle.candidate?.observation, undefined);
      assert.equal(packet.lifecycle.tracker?.sourceVersion, undefined);
      assert.equal(packet.lifecycle.deployments.find((d) => d.environment === "staging")?.artifactDigest, "sha256:" + "c".repeat(64));
      assert.equal(packet.lifecycle.deployments[0]?.artifactVersion, undefined);
    });
  } else {
    const seed = (await pool.query(`SELECT r.run_id, r.mission_id, r.node_id, r.context_packet_id, r.capability_grant_id,
      p.packet, a.template_provenance_id, m.workflow_binding_id, h.provenance_id AS host_provenance_id
      FROM acp.worker_runs r JOIN acp.context_packets p USING (context_packet_id)
      JOIN acp.worker_dispatch_assignments a ON a.run_id = r.run_id AND a.generation = r.dispatch_generation
      JOIN acp.missions m ON m.mission_id = r.mission_id JOIN acp.worker_hosts h ON h.host_identifier = r.host_identifier
      WHERE r.host_identifier = $1`, [hostIdentifier])).rows[0]; assert.ok(seed);
    const template = createStableId("provenance");
    await clone("runtime_provenance", "provenance_id", seed.template_provenance_id, { provenance_id: template, database_schema_version: "0010" });
    const runtime: HostRuntimeRegistration = { hostIdentifier, sessionId: createStableId("workerHostSession"), applicationVersion,
      bindings: [{ workflowBindingId: seed.workflow_binding_id, templateProvenanceId: template }] };
    await dispatches.registerRuntime(runtime, registration(seed.host_provenance_id));
    await check("old packet bytes remain readable and an already-admitted run can recover", async () => {
      const stored = await workers.loadContextPacket(seed.context_packet_id);
      assert.deepEqual(stored, seed.packet); assert.equal(stored?.schemaVersion, "1.0.0");
      const recovery = new PostgresWorkerRecoveryStore(pool, runtime);
      const prepared = await recovery.prepare((await recovery.listCandidates())[0]!); assert.ok(prepared);
      assert.equal(await workers.recoverStoppedRun({ runId: seed.run_id, hostIdentifier, transitionProvenanceId: prepared.provenanceId,
        authority: recovery.authority }), "recovered");
      const row = (await pool.query("SELECT state, result FROM acp.worker_runs WHERE run_id = $1", [seed.run_id])).rows[0];
      assert.equal(row.state, "failed"); assert.equal(row.result.contextPacketDigest, seed.packet.digest);
    });
    // Trusted supervisor fixture explicitly selects a retry; recovery does not
    // infer retry policy or reopen a failed node on its own.
    assert.equal((await pool.query("SELECT state FROM acp.mission_nodes WHERE node_id = $1", [seed.node_id])).rows[0].state, "failed");
    await pool.query("UPDATE acp.mission_nodes SET state = 'runnable', completed_at = NULL, transition_provenance_id = $2 WHERE node_id = $1", [seed.node_id, template]);
    const nextRun = createStableId("run");
    await dispatches.request({ runId: nextRun, missionId: seed.mission_id, nodeId: seed.node_id, grantId: seed.capability_grant_id,
      attemptNumber: 2, applicationVersion, operation: "synthetic.read", resource: "synthetic:record:1", preferredHostIdentifier: hostIdentifier, provenanceId: template });
    const a = await dispatches.assign(nextRun, async () => {}); assert.ok(a);
    assert.equal((await dispatches.prepare(message(a), hostIdentifier, applicationVersion, runtime.sessionId)).state, "ready");
    await contexts.publishNodeContext({ contextRevisionId: createStableId("nodeContextRevision"), missionId: a.missionId, nodeId: a.nodeId,
      expectedRevision: 1, graphRevision: "lifecycle-upgrade", content: { ...content, previousRunIds: [seed.run_id] }, provenanceId: template });
    const build = () => contexts.buildAndRecordContextPacket({ ...packetRequest(a), contextPacketId: createStableId("contextPacket"), provenanceId: createStableId("provenance") });
    await check("unobserved lifecycle defaults have no invented identities or state", async () => {
      const packet = await build(); assert.equal(packet.schemaVersion, "1.1.0");
      assert.equal(packet.lifecycle.candidate, undefined); assert.equal(packet.lifecycle.tracker, undefined);
      assert.deepEqual(packet.lifecycle.deployments, []); assert.deepEqual(packet.lifecycle.acceptance, { state: "pending" });
      assert.deepEqual(packet.lifecycle.businessCompletion, { state: "not_evaluated" });
    });
    const evidence = createStableId("evidence"), candidateId = createStableId("candidate"), candidateRecord = createStableId("event").replace("evt_", "obs_");
    const trackerRecord = createStableId("event"), acceptanceRecord = createStableId("event"), businessRecord = createStableId("event");
    await clone("evidence_records", "evidence_id", legacy("evd"), { evidence_id: evidence, content_hash: "sha256:" + "d".repeat(64),
      freshness: "current", accessibility: "available", sensitivity: "public" });
    await pool.query(`INSERT INTO acp.candidate_records (record_id, mission_id, candidate_id, state, repository_id, worktree_path, branch,
      head_sha, evidence_ids, observed_at, provenance_id) VALUES ($1,$2,$3,'merged',$4,'/isolated/lifecycle','test',$5,$6::jsonb,statement_timestamp(),$7)`,
    [candidateRecord, a.missionId, candidateId, createStableId("repository"), "b".repeat(40), JSON.stringify([evidence]), template]);
    const deployments: string[] = [];
    for (const [environment, state, digest] of [["staging", "verified", "sha256:" + "c".repeat(64)], ["production", "not_deployed", null], ["preview", "not_configured", null], ["unversioned", "verified", null]]) {
      const id = createStableId("event"); deployments.push(id);
      await pool.query(`INSERT INTO acp.deployment_records (record_id, mission_id, environment, state, artifact_digest, evidence_ids, observed_at, provenance_id)
        VALUES ($1,$2,$3,$4,$5,'[]',statement_timestamp(),$6)`, [id, a.missionId, environment, state, digest, template]);
    }
    await pool.query(`INSERT INTO acp.acceptance_records (record_id, mission_id, state, candidate_revision, evidence_ids, observed_at, provenance_id)
      VALUES ($1,$2,'passed',$3,$4::jsonb,statement_timestamp(),$5)`, [acceptanceRecord, a.missionId, "a".repeat(40), JSON.stringify([evidence]), template]);
    await pool.query(`INSERT INTO acp.tracker_records (record_id, mission_id, adapter_id, external_id, native_state, source_version, observed_at, provenance_id)
      VALUES ($1,$2,'synthetic','issue:1','Open','etag-1',statement_timestamp(),$3)`, [trackerRecord, a.missionId, template]);
    await pool.query(`INSERT INTO acp.business_completion_records (record_id, mission_id, state, evidence_ids, observed_at, provenance_id)
      VALUES ($1,$2,'pending','[]',statement_timestamp(),$3)`, [businessRecord, a.missionId, template]);
    const packet = await contexts.buildAndRecordContextPacket(packetRequest(a));
    await check("exact candidate, deployment and tracker versions remain independent", async () => {
      assert.equal(packet.lifecycle.candidate?.candidateId, candidateId); assert.equal(packet.lifecycle.candidate?.observation?.recordId, candidateRecord);
      assert.equal(packet.lifecycle.candidate?.revision.headSha, "b".repeat(40)); assert.equal(packet.lifecycle.acceptance.candidateRevision, "a".repeat(40));
      assert.equal(packet.lifecycle.acceptance.observation?.recordId, acceptanceRecord); assert.equal(packet.lifecycle.businessCompletion.observation?.recordId, businessRecord);
      assert.equal(packet.lifecycle.tracker?.observation?.recordId, trackerRecord); assert.equal(packet.lifecycle.tracker?.sourceVersion, "etag-1");
      assert.equal(packet.lifecycle.tracker?.externalId, "issue:1"); assert.equal(packet.retryCount, 1); assert.equal(packet.previousResultRefs[0]?.runId, seed.run_id);
      const staging = packet.lifecycle.deployments.find((d) => d.environment === "staging")!;
      assert.equal(staging.observation?.recordId, deployments[0]); assert.deepEqual(staging.artifactVersion, { status: "known", digest: "sha256:" + "c".repeat(64) });
      assert.deepEqual(packet.lifecycle.deployments.find((d) => d.environment === "production")?.artifactVersion, { status: "unknown" });
      assert.deepEqual(packet.lifecycle.deployments.find((d) => d.environment === "preview")?.artifactVersion, { status: "unknown" });
      const exact = (await pool.query("SELECT to_jsonb(observed_at) AS at FROM acp.candidate_records WHERE record_id = $1", [candidateRecord])).rows[0].at;
      assert.equal(packet.lifecycle.candidate?.observation?.observedAt, exact);
    });
    await check("a stored verified deployment with unknown artifact cannot satisfy completion", async () => {
      assert.deepEqual(packet.lifecycle.deployments.find((d) => d.environment === "unversioned")?.artifactVersion, { status: "unknown" });
      const evaluated = evaluateCompletionContract({ contract: packet.completionContract, requireAllEffectsVerified: true,
        requiredDeployments: [{ environment: "unversioned", allowedStates: ["verified"] }] }, packet.lifecycle,
      { evaluationId: createStableId("completionEvaluation"), missionId: a.missionId, evaluatedAt: new Date().toISOString(),
        requiredReceiptsVerified: true, evidenceFreshnessVerified: true, conflicts: [], unresolvedFindings: [], lifecycleDigest: packet.digest, provenanceId: template });
      assert.equal(evaluated.status, "failed"); assert.ok(evaluated.disqualifiers.includes("deployment_artifact_unknown:unversioned"));
    });
    await check("observation identities cannot be edited or deleted", async () => {
      for (const [table, id] of [["candidate_records", candidateRecord], ["deployment_records", deployments[0]], ["acceptance_records", acceptanceRecord],
        ["tracker_records", trackerRecord], ["business_completion_records", businessRecord]]) {
        await assert.rejects(pool.query(`UPDATE acp.${table} SET observed_at = statement_timestamp() WHERE record_id = $1`, [id]), /append-only/);
        await assert.rejects(pool.query(`DELETE FROM acp.${table} WHERE record_id = $1`, [id]), /append-only/);
        await assert.rejects(pool.query(`TRUNCATE acp.${table}`), /append-only/);
        await assert.rejects(clone(table!, "record_id", id!, { record_id: createStableId("event"), observed_at: "2099-01-01T00:00:00Z" }), /cannot be in the future/);
      }
    });
    await check("recomputed digests cannot forge authoritative IDs or source versions", async () => {
      const row = (await pool.query("SELECT * FROM acp.context_packets WHERE context_packet_id = $1", [packet.contextPacketId])).rows[0];
      const forgeries = [ { ...packet, lifecycle: { ...packet.lifecycle, tracker: { ...packet.lifecycle.tracker!, sourceVersion: "etag-forged" } } },
        { ...packet, lifecycle: { ...packet.lifecycle, candidate: { ...packet.lifecycle.candidate!, candidateId: createStableId("candidate") } } },
        { ...packet, lifecycle: { ...packet.lifecycle, deployments: packet.lifecycle.deployments.map((d) => ({ ...d, observation: { ...d.observation!, recordId: createStableId("event") } })) } },
        { ...packet, schemaVersion: "1.0.0" } ];
      for (const forged of forgeries) {
        const { digest: _digest, ...unsigned } = forged; forged.digest = canonicalJsonDigest(unsigned as unknown as JsonValue);
        await assert.rejects(pool.query(`INSERT INTO acp.context_packets SELECT (jsonb_populate_record(NULL::acp.context_packets, $1::jsonb)).*`,
          [JSON.stringify({ ...row, packet: forged, digest: forged.digest })]), /differs from authoritative/);
      }
    });
    const versionRecord = createStableId("event");
    await check("a source-version change invalidates a stale packet before execution", async () => {
      await pool.query(`INSERT INTO acp.tracker_records SELECT (jsonb_populate_record(NULL::acp.tracker_records,
        to_jsonb(source) || jsonb_build_object('record_id', $2::text, 'source_version', 'etag-2', 'observed_at', statement_timestamp()))).*
        FROM acp.tracker_records source WHERE record_id = $1`, [trackerRecord, versionRecord]);
      await assert.rejects(start(a, packet), /fresh authoritative context/);
      assert.deepEqual(await workers.loadContextPacket(packet.contextPacketId), packet); // immutable historical replay
    });
    async function replaceUnadmitted(previous: WorkerAssignment) {
      assert.equal(await dispatches.blockUnstarted(message(previous), "Lifecycle snapshot changed before admission."), true);
      await pool.query("UPDATE acp.mission_nodes SET state = 'runnable', transition_provenance_id = $2 WHERE node_id = $1", [previous.nodeId, template]);
      const runId = createStableId("run");
      await dispatches.request({ runId, missionId: previous.missionId, nodeId: previous.nodeId, grantId: previous.grantId, attemptNumber: 2,
        applicationVersion, operation: "synthetic.read", resource: "synthetic:record:1", preferredHostIdentifier: hostIdentifier, provenanceId: template });
      const replacement = await dispatches.assign(runId, async () => {}); assert.ok(replacement);
      assert.equal((await dispatches.prepare(message(replacement), hostIdentifier, applicationVersion, runtime.sessionId)).state, "ready");
      return replacement;
    }
    const second = await replaceUnadmitted(a), secondPacket = await contexts.buildAndRecordContextPacket(packetRequest(second));
    await check("an observation-only change invalidates admission even with identical source content", async () => {
      const nextObservation = createStableId("event");
      // Keep even the timestamp identical; deterministically select the greater
      // stable ID using the same tie-break as authoritative assembly.
      const newer = nextObservation > versionRecord ? nextObservation : "evt_ffffffff-ffff-4fff-bfff-ffffffffffff";
      await clone("tracker_records", "record_id", versionRecord, { record_id: newer });
      await assert.rejects(start(second, secondPacket), /fresh authoritative context/);
      const current = await build();
      assert.equal(current.lifecycle.tracker?.sourceVersion, secondPacket.lifecycle.tracker?.sourceVersion);
      assert.equal(current.lifecycle.tracker?.observation?.observedAt, secondPacket.lifecycle.tracker?.observation?.observedAt);
      assert.equal(current.lifecycle.tracker?.observation?.recordId, newer);
    });
    await check("a newly selected packet admits the retry without changing historical evidence", async () => {
      const third = await replaceUnadmitted(second), fresh = await contexts.buildAndRecordContextPacket(packetRequest(third));
      assert.equal(fresh.schemaVersion, "1.1.0"); assert.equal(fresh.retryCount, 1);
      await start(third, fresh);
      const result = createWorkerFailureResult({ runId: third.runId, packet: fresh, attemptNumber: 2, status: "failed", code: "terminated",
        conclusion: "Synthetic fixture result; no model or native worker launched.", wallMilliseconds: 1 });
      await workers.completeRun({ result, completedAt: new Date().toISOString(), transitionProvenanceId: third.packetProvenanceId });
      assert.deepEqual(await workers.loadContextPacket(packet.contextPacketId), packet);
    });
    await check("new schema keeps historical packet digests usable for structured results", async () => {
      const old = parseContextPacket(seed.packet), result = createWorkerFailureResult({ runId: seed.run_id, packet: old,
        attemptNumber: 1, status: "failed", code: "terminated", conclusion: "Synthetic recovery.", wallMilliseconds: 1 });
      assert.equal(result.contextPacketDigest, seed.packet.digest); assert.equal(result.schemaVersion, "1.0.0");
    });
  }
  process.stdout.write(`Lifecycle context ${phase}: ${checks} checks passed.\n`);
} finally { await pool.end(); }
