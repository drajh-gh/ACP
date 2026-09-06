import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { capabilityReadinessStates, createStableId, type ProjectReadiness, type StableId } from "@acp/domain";
import { PostgresCounterpartMissionStore, PostgresReadinessAssessmentStore, type ReadinessAssessmentWrite } from "@acp/storage";
import { createControlApiServer } from "../../src/http-server.ts";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("owned database port required");
const limits = { max: 4, connectionTimeoutMillis: 3000, statement_timeout: 5000, lock_timeout: 2000 };
const pool = new Pool({ ...limits, connectionString: `postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test` });
const readerPool = new Pool({ ...limits, connectionString: `postgresql://acp_readiness_http_reader:synthetic_reader_password@127.0.0.1:${port}/acp_test` });
const legacy = (prefix: string) => `${prefix}_00000000-0000-4000-8000-000000000001`;
const projectId = legacy("prj") as StableId<"project">, profileId = legacy("pro") as StableId<"projectProfile">;
const provenanceId = legacy("prv") as StableId<"provenance">;
const bearerToken = "synthetic-readiness-http-token-not-a-real-secret";
const sentinel = "synthetic-private-source-not-for-http";
const writer = new PostgresReadinessAssessmentStore(pool, { provenanceId, evaluatorVersion: "synthetic-http:1" });
const persistence = new PostgresCounterpartMissionStore(readerPool, provenanceId);
const server = createControlApiServer({ persistence, bearerToken });
const client = new Client({ name: "acp-readiness-postgres-http", version: "1.0.0" });
let checks = 0;
async function check(name: string, action: () => Promise<void>) { await action(); checks++; process.stdout.write(`PASS readiness HTTP: ${name}\n`); }
async function clone(table: string, key: string, source: string, overrides: object) {
  const result = await pool.query(`INSERT INTO acp.${table} SELECT (jsonb_populate_record(NULL::acp.${table},to_jsonb(source)||$1::jsonb)).*
    FROM acp.${table} source WHERE ${key}=$2`, [JSON.stringify(overrides), source]);
  assert.equal(result.rowCount, 1);
}
async function counts() {
  return (await pool.query(`SELECT jsonb_build_object('assessments',(SELECT count(*) FROM acp.capability_readiness_assessments),
    'pins',(SELECT count(*) FROM acp.capability_readiness_evidence),'grants',(SELECT count(*) FROM acp.capability_grants),
    'runs',(SELECT count(*) FROM acp.worker_runs),'effects',(SELECT count(*) FROM acp.effect_proposals),'missions',(SELECT count(*) FROM acp.missions)) AS counts`)).rows[0].counts;
}
const query = { projectId, profileId, profileVersion: "1.0.0", keys: capabilityReadinessStates.map(state => ({
  capability: "read_artifacts", resourceKey: `source:${state}`, resourceVersion: "Exact:1",
})) };
const call = (input: object = query) => client.callTool({ name: "get_project_readiness", arguments: { ...input } });
function parsed(result: Awaited<ReturnType<typeof call>>): ProjectReadiness {
  assert.notEqual(result.isError, true); assert.ok(result.structuredContent);
  assert.equal(JSON.stringify(result).includes(sentinel), false);
  return (result.structuredContent as { readiness: ProjectReadiness }).readiness;
}
function denied(result: Awaited<ReturnType<typeof call>>) {
  assert.equal(result.isError, true); assert.equal(result.structuredContent, undefined);
  assert.deepEqual(result.content, [{ type: "text", text: "ACP readiness is unavailable; no partial snapshot returned." }]);
  assert.equal(JSON.stringify(result).includes(sentinel), false);
}

try {
  await pool.query("CREATE ROLE acp_readiness_http_reader LOGIN PASSWORD 'synthetic_reader_password'");
  await pool.query("GRANT USAGE ON SCHEMA acp TO acp_readiness_http_reader");
  await pool.query("GRANT SELECT ON ALL TABLES IN SCHEMA acp TO acp_readiness_http_reader");
  await pool.query("ALTER ROLE acp_readiness_http_reader SET default_transaction_read_only=on");
  const evidenceId = createStableId("evidence");
  await clone("evidence_records", "evidence_id", legacy("evd"), { evidence_id: evidenceId,
    observed_at: "2026-09-04T00:00:00Z", retrieved_at: "2026-09-04T00:00:01Z", content_hash: "sha256:synthetic-http",
    source_ref: sentinel, redacted_summary: sentinel, freshness: "current", accessibility: "available", sensitivity: "project_confidential" });
  const clock = (await pool.query("SELECT acp.readiness_timestamp(clock_timestamp()) AS assessed,acp.readiness_timestamp(clock_timestamp()+interval '1 hour') AS until")).rows[0];
  for (const [index, recordedState] of capabilityReadinessStates.entries()) {
    const row: ReadinessAssessmentWrite = { assessmentId: createStableId("capabilityReadinessAssessment"),
      projectId, profileId, profileVersion: "1.0.0", ...query.keys[index]!, recordedState,
      recordedReason: "Synthetic readiness observation.", assessedAt: clock.assessed as string, validUntil: clock.until as string,
      evidenceIds: [evidenceId], supersedesAssessmentId: null };
    await writer.record(row);
  }
  const before = await counts();
  await check("actual route credential is read-only and cannot create database objects", async () => {
    const identity = (await readerPool.query("SELECT current_user AS role,current_setting('transaction_read_only') AS readonly")).rows[0];
    assert.equal(identity.role, "acp_readiness_http_reader"); assert.equal(identity.readonly, "on");
    await assert.rejects(readerPool.query("CREATE TABLE acp.synthetic_forbidden_readiness_http_write(id integer)"), error =>
      error instanceof Error && "code" in error && error.code === "25006");
    assert.equal((await pool.query("SELECT to_regclass('acp.synthetic_forbidden_readiness_http_write') AS object")).rows[0].object, null);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const httpPort = (server.address() as AddressInfo).port, url = `http://127.0.0.1:${httpPort}/mcp`;
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: {
    Authorization: `Bearer ${bearerToken}`, "X-ACP-Plugin-Version": "0.2.0",
  } } });
  await client.connect(transport as unknown as Transport);
  await check("authenticated real storage preserves seven states and metadata-only schema 2", async () => {
    const matrix = parsed(await call());
    assert.equal(matrix.schemaVersion, "2.0.0");
    assert.deepEqual(matrix.entries.map(entry => entry.currentState), capabilityReadinessStates);
    assert.ok(matrix.entries.every(entry => entry.evidenceIdentityMatches === true));
    assert.equal(matrix.assessment.authority, "none"); assert.equal(matrix.assessment.liveProbes, "not_performed");
    assert.ok(Buffer.byteLength(JSON.stringify(matrix)) <= 65_536);
  });
  await check("unobserved case-distinct resource stays unknown without inventory inference", async () => {
    const matrix = parsed(await call({ ...query, keys: [{ ...query.keys[0], resourceKey: query.keys[0]!.resourceKey.toUpperCase() }] }));
    assert.equal(matrix.entries[0]?.currentState, "unknown"); assert.equal(matrix.entries[0]?.recorded, null);
    assert.equal(matrix.entries[0]?.currentReasonCode, "not_assessed"); assert.deepEqual(matrix.evidence, []);
  });
  await check("absent exact profile versions produce generic whole denial", async () => {
    denied(await call({ ...query, profileVersion: "1.0.0-preview.1+Fixture" }));
    denied(await call({ ...query, profileId: createStableId("projectProfile") }));
    denied(await call({ ...query, projectId: createStableId("project") }));
  });
  await check("supporting identity changes stale only positive states without rewriting hash presence", async () => {
    await pool.query("UPDATE acp.evidence_records SET content_hash='sha256:changed-http' WHERE evidence_id=$1", [evidenceId]);
    const matrix = parsed(await call());
    for (const entry of matrix.entries) {
      assert.equal(entry.evidenceIdentityMatches, false);
      if (["available", "degraded"].includes(entry.recorded!.recordedState)) {
        assert.equal(entry.currentState, "stale"); assert.equal(entry.currentReasonCode, "supporting_evidence_identity_changed");
      } else assert.equal(entry.currentState, entry.recorded!.recordedState);
    }
    assert.equal(matrix.evidence[0]?.contentHashPresent, true);
  });
  await check("restricted evidence cannot expose a favorable subset or private diagnostics", async () => {
    await pool.query("UPDATE acp.evidence_records SET sensitivity='restricted' WHERE evidence_id=$1", [evidenceId]);
    denied(await call());
    await pool.query("UPDATE acp.evidence_records SET sensitivity='project_confidential' WHERE evidence_id=$1", [evidenceId]);
  });
  await check("cross-project evidence is indistinguishable from a missing profile", async () => {
    const otherProject = createStableId("project");
    await clone("projects", "project_id", projectId, { project_id: otherProject, project_key: `synthetic-http:${otherProject}` });
    await pool.query("UPDATE acp.evidence_records SET project_id=$1 WHERE evidence_id=$2", [otherProject, evidenceId]);
    denied(await call());
    await pool.query("UPDATE acp.evidence_records SET project_id=$1 WHERE evidence_id=$2", [projectId, evidenceId]);
  });
  await check("missing bearer is rejected before MCP execution and all read-side counts remain unchanged", async () => {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-ACP-Plugin-Version": "0.2.0" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_project_readiness", arguments: query } }) });
    assert.equal(response.status, 401); assert.equal((await response.text()).includes(bearerToken), false);
    assert.deepEqual(await counts(), before);
  });
  process.stdout.write(`Readiness PostgreSQL/HTTP integration passed: ${checks} checks.\n`);
} finally {
  try { await client.close(); }
  finally {
    try { if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    finally { await readerPool.end(); await pool.end(); }
  }
}
