// Run only by check-postgres.ps1 against its owned disposable database.
import assert from "node:assert/strict";
import pg from "pg";
import {
  canonicalJsonDigest, createStableId, createWorkerFailureResult,
  type NodeContextContent,
} from "@acp/domain";
import { PostgresContextStore } from "../../src/context-store.ts";
import { PostgresWorkerRuntimeStore } from "../../src/worker-runtime-store.ts";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("test database port required");
const pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres",
  password: "acp_test_password", database: "acp_test", max: 3,
  statement_timeout: 5000, lock_timeout: 3000, connectionTimeoutMillis: 3000 });
const store = new PostgresContextStore(pool);
const workers = new PostgresWorkerRuntimeStore(pool);
const legacy = (prefix: string) => `${prefix}_00000000-0000-4000-8000-000000000001`;
const missionId = createStableId("mission");
const nodeId = createStableId("node");
const provenanceId = createStableId("provenance");
const bindingId = createStableId("workflowBinding");
const profileId = createStableId("projectProfile");
const grantId = createStableId("capabilityGrant");
const evaluationId = createStableId("capabilityGrantEvaluation");
const evidenceId = createStableId("evidence");
const content: NodeContextContent = {
  objective: "Inspect the exact candidate.", nonGoals: ["No external writes."],
  behavioralContract: { operation: "inspect" }, acceptanceCriteria: ["Return a bounded result."],
  conflicts: [], unresolvedQuestions: [], nextAction: "Read the candidate files.",
  limits: { wallTimeMs: 1000, maximumTurns: 1, maximumOutputBytes: 4096 },
  evidenceIds: [evidenceId], activeClaimIds: [], previousRunIds: [], approvalIds: [],
};
const request = () => ({ contextPacketId: createStableId("contextPacket"), missionId, nodeId,
  capabilityGrantId: grantId, runtimeTemplateProvenanceId: provenanceId,
  provenanceId: createStableId("provenance") });
const publication = (expectedRevision: number, next = content) => ({
  contextRevisionId: createStableId("nodeContextRevision"), missionId, nodeId,
  graphRevision: "context-test-v1", expectedRevision, content: next, provenanceId,
});
async function clone(table: string, key: string, source: string, overrides: object) {
  // Table/key are internal test constants, never request data.
  await pool.query(`INSERT INTO acp.${table} SELECT (jsonb_populate_record(
    NULL::acp.${table}, to_jsonb(source) || $1::jsonb)).* FROM acp.${table} source WHERE ${key} = $2`,
  [JSON.stringify(overrides), source]);
}
let checks = 0;
async function check(name: string, operation: () => Promise<void>) {
  await operation(); checks++; process.stdout.write(`PASS context: ${name}\n`);
}
try {
  await clone("project_profiles", "profile_id", legacy("pro"), {
    profile_id: profileId, profile: { sourceAuthorityRules: { repository: "canonical" } },
  });
  await clone("project_workflow_bindings", "binding_id", legacy("wfb"), {
    binding_id: bindingId, profile_id: profileId,
  });
  await clone("runtime_provenance", "provenance_id", legacy("prv"), {
    provenance_id: provenanceId, workflow_binding_id: bindingId, project_profile_id: profileId,
    host_identifier: "host:context-test", database_schema_version: "0005",
  });
  await clone("missions", "mission_id", legacy("mis"), {
    mission_id: missionId, workflow_binding_id: bindingId, state: "received",
    requested_scope: "Inspect and report only.", completed_by_evaluation_id: null,
    transition_provenance_id: provenanceId,
  });
  await clone("mission_nodes", "node_id", legacy("nod"), {
    node_id: nodeId, mission_id: missionId, state: "running", completed_at: null,
    graph_revision: "context-test-v1", provenance_id: provenanceId, transition_provenance_id: provenanceId,
  });
  await clone("capability_grant_evaluations", "evaluation_id", legacy("cge"), {
    evaluation_id: evaluationId, mission_id: missionId, node_id: nodeId,
    provenance_id: provenanceId, maximum_attempts: 10,
  });
  await clone("capability_grants", "grant_id", legacy("cgr"), {
    grant_id: grantId, evaluation_id: evaluationId, mission_id: missionId, node_id: nodeId,
    provenance_id: provenanceId, maximum_attempts: 10,
  });
  await clone("evidence_records", "evidence_id", legacy("evd"), {
    evidence_id: evidenceId, content_hash: "sha256:" + "b".repeat(64),
    redacted_summary: "Authoritative summary ž.", freshness: "current", accessibility: "available",
    sensitivity: "public",
  });
  const firstPublication = publication(0);
  const firstRequest = request();
  await check("publication and identity-only packet assembly", async () => {
    assert.equal(await store.publishNodeContext(firstPublication), 1);
    const packet = await store.buildAndRecordContextPacket(firstRequest);
    assert.equal(packet.objective, content.objective);
    assert.equal(packet.completionScope, "Inspect and report only.");
    assert.equal(packet.evidence[0]?.summary, "Authoritative summary ž.");
    assert.deepEqual(packet.sourceAuthorityRules, { repository: "canonical" });
    assert.equal(packet.lifecycle.acceptance.state, "pending");
    assert.equal(packet.lifecycle.businessCompletion.state, "not_evaluated");
    assert.equal(packet.retryCount, 0);
    const p = await pool.query("SELECT context_packet_digest FROM acp.runtime_provenance WHERE provenance_id = $1", [firstRequest.provenanceId]);
    assert.equal(p.rows[0].context_packet_digest, packet.digest);
  });
  await check("replay is immutable and identifier aliases are rejected", async () => {
    assert.equal(await store.publishNodeContext(firstPublication), 1);
    await assert.rejects(store.publishNodeContext({ ...firstPublication, content: { ...content, objective: "Other" } }), /different content/);
    const packet = await store.buildAndRecordContextPacket(firstRequest);
    assert.deepEqual(await store.buildAndRecordContextPacket(firstRequest), packet);
    await assert.rejects(store.buildAndRecordContextPacket({ ...firstRequest, provenanceId: createStableId("provenance") }), /different build request/);
    await assert.rejects(pool.query("UPDATE acp.node_context_revisions SET revision = revision + 1 WHERE node_id = $1", [nodeId]), /append-only/);
    await assert.rejects(pool.query("DELETE FROM acp.node_context_revisions WHERE node_id = $1", [nodeId]), /append-only/);
  });
  await check("tampered packet with recomputed digest is rejected", async () => {
    const row = (await pool.query("SELECT * FROM acp.context_packets WHERE context_packet_id = $1", [firstRequest.contextPacketId])).rows[0];
    const forged = { ...row.packet, objective: "Injected instruction." };
    const { digest: _digest, ...unsigned } = forged;
    forged.digest = canonicalJsonDigest(unsigned);
    await assert.rejects(pool.query(`INSERT INTO acp.context_packets SELECT
      (jsonb_populate_record(NULL::acp.context_packets, $1::jsonb)).*`,
    [JSON.stringify({ ...row, packet: forged, digest: forged.digest })]), /differs from authoritative/);
  });
  await check("concurrent publications have one compare-and-swap winner", async () => {
    const results = await Promise.allSettled([store.publishNodeContext(publication(1)), store.publishNodeContext(publication(1))]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    // Idempotent replay still retrieves historical content after revision advancement.
    assert.equal((await store.buildAndRecordContextPacket(firstRequest)).contextPacketId, firstRequest.contextPacketId);
  });
  const admission = async (buildRequest: ReturnType<typeof request>, attemptNumber = 1, wallTimeMs = 1000) => {
    const packet = await store.buildAndRecordContextPacket(buildRequest);
    const grant = await workers.loadCapabilityGrant(grantId);
    assert.ok(grant);
    return workers.startRun({ runId: createStableId("run"), packet, attemptNumber,
      hostIdentifier: "host:context-test", resourceClass: grant.resourceClass, wallTimeMs,
      provenanceId: buildRequest.provenanceId, request: {
        missionId, nodeId, projectId: packet.projectId, role: packet.workerRole,
        resourceClass: grant.resourceClass, networkAccess: "none", at: new Date().toISOString(),
        operation: grant.allowedOperations[0]!, resource: grant.allowedResources[0]!,
        mode: grant.mode, workspace: grant.workspace,
      } });
  };
  await check("superseded and legacy packets cannot admit runs", async () => {
    await assert.rejects(admission(firstRequest), /current node context/);
    const old = (await pool.query("SELECT * FROM acp.worker_runs LIMIT 1")).rows[0];
    await assert.rejects(pool.query(`INSERT INTO acp.worker_runs SELECT
      (jsonb_populate_record(NULL::acp.worker_runs, $1::jsonb)).*`, [JSON.stringify({
      ...old, run_id: createStableId("run"), state: "started", result: null, completed_at: null,
    })]), /legacy context packets/);
  });
  await check("stale, unknown, unavailable, restricted and unhashed evidence fails closed", async () => {
    for (const patch of [{ freshness: "stale" }, { freshness: "unknown" },
      { accessibility: "inaccessible" }, { sensitivity: "restricted" }, { content_hash: null }]) {
      const client = await pool.connect();
      try {
        // Use committed changes so the store's independent transaction sees them.
        await client.query(`UPDATE acp.evidence_records SET freshness = $2, accessibility = $3,
          sensitivity = $4, content_hash = $5 WHERE evidence_id = $1`, [evidenceId,
          "freshness" in patch ? patch.freshness : "current",
          "accessibility" in patch ? patch.accessibility : "available",
          "sensitivity" in patch ? patch.sensitivity : "public",
          "content_hash" in patch ? patch.content_hash : "sha256:" + "b".repeat(64)]);
        await assert.rejects(store.buildAndRecordContextPacket(request()), /selected evidence/);
      } finally { client.release(); }
    }
    await pool.query(`UPDATE acp.evidence_records SET freshness = 'current', accessibility = 'available',
      sensitivity = 'public', content_hash = $2 WHERE evidence_id = $1`, [evidenceId, "sha256:" + "b".repeat(64)]);
  });
  await check("expanded packet overflow rolls back generated provenance", async () => {
    const oversized = request();
    await pool.query("UPDATE acp.evidence_records SET redacted_summary = $2 WHERE evidence_id = $1", [evidenceId, "ž".repeat(140000)]);
    await assert.rejects(store.buildAndRecordContextPacket(oversized), /byte limit/);
    assert.equal((await pool.query("SELECT 1 FROM acp.runtime_provenance WHERE provenance_id = $1", [oversized.provenanceId])).rowCount, 0);
    await pool.query("UPDATE acp.evidence_records SET redacted_summary = 'Updated summary.' WHERE evidence_id = $1", [evidenceId]);
  });
  await check("admission revalidates the snapshot and packet time limit", async () => {
    const stale = request();
    await store.buildAndRecordContextPacket(stale);
    await pool.query("UPDATE acp.evidence_records SET redacted_summary = 'Changed again.' WHERE evidence_id = $1", [evidenceId]);
    await assert.rejects(admission(stale), /fresh authoritative context snapshot/);
    await assert.rejects(admission(request(), 1, 2000), /deadline exceeds/);
  });
  await check("source drift after provenance insertion rolls back the whole packet build", async () => {
    const drifting = request();
    const driftStore = new PostgresContextStore({
      query: (sql, values) => pool.query(sql, values),
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql, values) => {
            if (sql.trimStart().startsWith("INSERT INTO acp.context_packets")) {
              await pool.query("UPDATE acp.evidence_records SET redacted_summary = 'Concurrent source change.' WHERE evidence_id = $1", [evidenceId]);
            }
            return client.query(sql, values);
          },
          release: () => client.release(),
        };
      },
    });
    await assert.rejects(driftStore.buildAndRecordContextPacket(drifting), /differs from authoritative assembly/);
    assert.equal((await pool.query("SELECT 1 FROM acp.runtime_provenance WHERE provenance_id = $1", [drifting.provenanceId])).rowCount, 0);
    assert.equal((await pool.query("SELECT 1 FROM acp.context_packets WHERE context_packet_id = $1", [drifting.contextPacketId])).rowCount, 0);
    assert.equal((await store.buildAndRecordContextPacket(drifting)).evidence[0]?.summary, "Concurrent source change.");
  });
  await workers.registerHost({ hostIdentifier: "host:context-test", hostKind: "other", state: "active",
    maximumCpuIntensive: 1, maximumModerateCompute: 1, maximumLightweightRead: 2, maximumNetworkBound: 2,
    heartbeatTtlSeconds: 300, provenanceId, transitionProvenanceId: provenanceId });
  await check("fresh packet admits exactly one bounded attempt", async () => {
    const fresh = request();
    const packet = await store.buildAndRecordContextPacket(fresh);
    const run = await admission(fresh);
    await assert.rejects(admission(request(), 2), /live predecessor/);
    const result = createWorkerFailureResult({ runId: run.runId, packet, attemptNumber: 1,
      conclusion: "Synthetic failed attempt.", status: "failed", code: "timeout", wallMilliseconds: 1 });
    await workers.completeRun({ result, completedAt: new Date().toISOString(), transitionProvenanceId: fresh.provenanceId });
    await assert.rejects(admission(fresh, 2), /fresh authoritative context snapshot/);
    const retry = await store.buildAndRecordContextPacket(request());
    assert.equal(retry.retryCount, 1);
    assert.equal(packet.retryCount, 0);
  });
  let revisionNumber = 2;
  async function select(next: NodeContextContent) {
    await store.publishNodeContext(publication(revisionNumber, next));
    revisionNumber++;
  }
  await check("cross-project and missing evidence selections are rejected", async () => {
    const foreignId = createStableId("evidence");
    await clone("evidence_records", "evidence_id", evidenceId, {
      evidence_id: foreignId, project_id: "prj_00000000-0000-4000-8000-000000000002",
    });
    for (const id of [foreignId, createStableId("evidence")]) {
      await select({ ...content, evidenceIds: [id] });
      await assert.rejects(store.buildAndRecordContextPacket(request()), /selected evidence/);
    }
    await select(content);
  });
  await check("selected claims are valid at database time and scoped transitively", async () => {
    const claimId = createStableId("claim");
    const run = (await pool.query("SELECT run_id FROM acp.worker_runs WHERE mission_id = $1", [missionId])).rows[0];
    await pool.query(`INSERT INTO acp.claims (claim_id, project_id, claim_type, statement, status,
      authority, freshness, corroboration, completeness, inference_distance, confidence,
      source_evidence_ids, created_by_run_id) VALUES ($1, $2, 'observation', 'Observed fact.',
      'active', 1, 1, 1, 1, 0, 1, $3::jsonb, $4)`,
    [claimId, legacy("prj"), JSON.stringify([evidenceId]), run.run_id]);
    await select({ ...content, activeClaimIds: [claimId] });
    assert.deepEqual((await store.buildAndRecordContextPacket(request())).activeClaimIds, [claimId]);
    for (const [column, value] of [["status", "rejected"], ["valid_from", "2099-01-01"],
      ["valid_until", "2000-01-01"], ["project_id", "prj_00000000-0000-4000-8000-000000000002"]]) {
      await pool.query(`UPDATE acp.claims SET ${column} = $2 WHERE claim_id = $1`, [claimId, value]);
      await assert.rejects(store.buildAndRecordContextPacket(request()), /selected claims/);
      await pool.query(`UPDATE acp.claims SET status = 'active', valid_from = NULL, valid_until = NULL,
        project_id = $2 WHERE claim_id = $1`, [claimId, legacy("prj")]);
    }
    await pool.query("UPDATE acp.claims SET source_evidence_ids = $2::jsonb WHERE claim_id = $1", [claimId,
      JSON.stringify([createStableId("evidence")])]);
    await assert.rejects(store.buildAndRecordContextPacket(request()), /transitive context evidence/);
    await select(content);
  });
  await check("prior results are terminal and tied to this mission", async () => {
    const own = (await pool.query("SELECT run_id FROM acp.worker_runs WHERE mission_id = $1", [missionId])).rows[0];
    await select({ ...content, previousRunIds: [own.run_id] });
    assert.equal((await store.buildAndRecordContextPacket(request())).previousResultRefs[0]?.conclusion, "Synthetic failed attempt.");
    await select({ ...content, previousRunIds: [legacy("run") as `run_${string}`] });
    await assert.rejects(store.buildAndRecordContextPacket(request()), /selected previous results/);
    await select(content);
  });
  await check("approval selection rejects null mission, expiry and revocation", async () => {
    for (const overrides of [{ mission_id: null }, { mission_id: legacy("mis"), provenance_id: legacy("prv") },
      { expires_at: "2001-01-01", valid_from: "2000-01-01" },
      { valid_from: "2098-01-01", expires_at: "2099-01-01" },
      { revoked_at: "2000-01-01" }, {}]) {
      const approvalId = createStableId("approval");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT acp.acquire_effect_authority_lock()");
        await client.query(`INSERT INTO acp.approval_envelopes SELECT (jsonb_populate_record(
          NULL::acp.approval_envelopes, to_jsonb(source) || $1::jsonb)).*
          FROM acp.approval_envelopes source WHERE approval_id = $2`, [JSON.stringify({
          approval_id: approvalId, mission_id: missionId, provenance_id: provenanceId,
          revoked_at: null, valid_from: "2000-01-01", expires_at: "2099-01-01", ...overrides,
        }), legacy("apr")]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
      await select({ ...content, approvalIds: [approvalId] });
      if (Object.keys(overrides).length) {
        await assert.rejects(store.buildAndRecordContextPacket(request()), /selected approvals/);
      } else {
        assert.deepEqual((await store.buildAndRecordContextPacket(request())).approvalIds, [approvalId]);
      }
    }
    await select(content);
  });
  await check("lifecycle dimensions remain independent and profile versions stay pinned", async () => {
    await clone("project_profiles", "profile_id", profileId, {
      version: "2.0.0", profile: { sourceAuthorityRules: { repository: "different" } },
    });
    await pool.query(`INSERT INTO acp.candidate_records (record_id, mission_id, candidate_id, state,
      repository_id, worktree_path, branch, head_sha, evidence_ids, observed_at, provenance_id)
      VALUES ($1, $2, $3, 'merged', $4, '/isolated/context-test', 'test', $5, $6::jsonb,
        statement_timestamp(), $7)`, [createStableId("event"), missionId, createStableId("candidate"),
      createStableId("repository"), "b".repeat(40), JSON.stringify([evidenceId]), provenanceId]);
    await pool.query(`INSERT INTO acp.acceptance_records (record_id, mission_id, state,
      candidate_revision, evidence_ids, observed_at, provenance_id)
      VALUES ($1, $2, 'passed', $3, $4::jsonb, statement_timestamp(), $5)`,
    [createStableId("event"), missionId, "a".repeat(40), JSON.stringify([evidenceId]), provenanceId]);
    for (const [environment, state] of [["staging", "deployed"], ["production", "not_deployed"], ["staging", "verified"]]) {
      await pool.query(`INSERT INTO acp.deployment_records (record_id, mission_id, environment, state,
        evidence_ids, observed_at, provenance_id) VALUES ($1, $2, $3, $4, $5::jsonb, statement_timestamp(), $6)`,
      [createStableId("event"), missionId, environment, state, JSON.stringify([evidenceId]), provenanceId]);
    }
    const packet = await store.buildAndRecordContextPacket(request());
    assert.equal(packet.projectProfile.version, "1.0.0");
    assert.deepEqual(packet.sourceAuthorityRules, { repository: "canonical" });
    assert.equal(packet.lifecycle.candidate?.state, "merged");
    assert.equal(packet.lifecycle.acceptance.candidateRevision, "a".repeat(40));
    assert.equal(packet.lifecycle.candidate?.revision.headSha, "b".repeat(40));
    assert.deepEqual(packet.lifecycle.deployments, [{ environment: "production", state: "not_deployed" },
      { environment: "staging", state: "verified" }]);
    assert.equal(packet.lifecycle.businessCompletion.state, "not_evaluated");
    assert.equal(packet.lifecycle.tracker, undefined);
  });
  await check("admission waits for concurrent mission cancellation and then denies", async () => {
    const fresh = request();
    await store.buildAndRecordContextPacket(fresh);
    const cancelling = await pool.connect();
    let pending: Promise<void> | undefined;
    try {
      await cancelling.query("BEGIN");
      await cancelling.query(`UPDATE acp.missions SET state = 'cancelled', updated_at = statement_timestamp()
        WHERE mission_id = $1`, [missionId]);
      pending = assert.rejects(admission(fresh, 2), /nonterminal mission/);
      // Observe the blocked session instead of relying on a timing-only assertion.
      let waiting = false;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const result = await pool.query(`SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE 'INSERT INTO acp.worker_runs%'`);
        if (result.rowCount) { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(waiting, true, "admission must wait on the mission row");
      await cancelling.query("COMMIT");
      await pending;
    } finally {
      await cancelling.query("ROLLBACK"); cancelling.release();
      await pending;
    }
  });
  process.stdout.write(`Authoritative context integration: ${checks} checks passed.\n`);
} finally {
  await pool.end();
}
