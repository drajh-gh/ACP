import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { canonicalJsonDigest, createStableId, expectRecord, parseProfileConfirmationRequest, parseProjectProfileProposal,
  prepareProfileProposalFields, profileFieldIds, type StableId } from "@acp/domain";
import { PostgresCounterpartMissionStore, PostgresProfileProposalStore, type ProfileProposalWrite } from "@acp/storage";
import { createControlApiServer } from "../../src/http-server.ts";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("owned database port required");
const limits = { max: 4, connectionTimeoutMillis: 3000, statement_timeout: 5000, lock_timeout: 2000 };
const pool = new Pool({ ...limits, connectionString: `postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test` });
const readerPool = new Pool({ ...limits, connectionString: `postgresql://acp_profile_http_reader:synthetic_reader_password@127.0.0.1:${port}/acp_test` });
const legacy = (prefix: string) => `${prefix}_00000000-0000-4000-8000-000000000001`;
const projectId = legacy("prj") as StableId<"project">, provenanceId = legacy("prv") as StableId<"provenance">;
const producer = { component: "synthetic-profile-http", version: "1", artifactDigest: canonicalJsonDigest({ synthetic: true }) };
const writer = new PostgresProfileProposalStore(pool, producer);
const bearerToken = "synthetic-profile-review-http-token-not-a-real-secret", sentinel = "synthetic-private-source-not-for-profile-http";
const server = createControlApiServer({ persistence: new PostgresCounterpartMissionStore(readerPool, provenanceId), bearerToken });
const client = new Client({ name: "acp-profile-postgres-http", version: "1.0.0" });
const toolNames = ["get_project_profile_proposal", "get_profile_confirmation_request"] as const;
let checks = 0;
async function check(name: string, action: () => Promise<void>) { await action(); checks++; process.stdout.write(`PASS profile HTTP: ${name}\n`); }
function fields(rationale = "Synthetic proposed applicability.") {
  return Object.fromEntries(profileFieldIds.map(id => [id, { status: "not_applicable", rationale, evidenceIds: [] }]));
}
function terms(overrides: Partial<ProfileProposalWrite> = {}): ProfileProposalWrite {
  return { proposalId: createStableId("projectProfileProposal"), projectId,
    candidateProfile: { profileId: createStableId("projectProfile"), profileVersion: "1.0.0" },
    baseProfile: null, supersedesProposalId: null, fields: fields(), ...overrides };
}
const query = (row: ProfileProposalWrite) => ({ projectId: row.projectId, proposalId: row.proposalId });
const call = (name: typeof toolNames[number], row: ProfileProposalWrite) => client.callTool({ name, arguments: query(row) });
function content(result: Awaited<ReturnType<typeof call>>) {
  assert.notEqual(result.isError, true); assert.ok(result.structuredContent);
  assert.equal(JSON.stringify(result).includes(sentinel), false);
  return expectRecord(result.structuredContent, "profile HTTP structured result");
}
function denied(result: Awaited<ReturnType<typeof call>>) {
  assert.equal(result.isError, true); assert.equal(result.structuredContent, undefined);
  assert.deepEqual(result.content, [{ type: "text", text: "ACP profile review is unavailable; no partial document returned." }]);
  assert.equal(JSON.stringify(result).includes(sentinel), false);
}
async function clone(table: string, key: string, source: string, overrides: object) {
  assert.equal((await pool.query(`INSERT INTO acp.${table} SELECT (jsonb_populate_record(NULL::acp.${table},to_jsonb(source)||$1::jsonb)).*
    FROM acp.${table} source WHERE ${key}=$2`, [JSON.stringify(overrides), source])).rowCount, 1);
}
async function counts() {
  return (await pool.query(`SELECT jsonb_build_object('proposals',(SELECT count(*) FROM acp.project_profile_proposals),
    'pins',(SELECT count(*) FROM acp.project_profile_proposal_evidence),'profiles',(SELECT count(*) FROM acp.project_profiles),
    'assessments',(SELECT count(*) FROM acp.capability_readiness_assessments),'grants',(SELECT count(*) FROM acp.capability_grants),
    'runs',(SELECT count(*) FROM acp.worker_runs),'effects',(SELECT count(*) FROM acp.effect_proposals),'missions',(SELECT count(*) FROM acp.missions)) AS counts`)).rows[0].counts;
}

try {
  await pool.query("CREATE ROLE acp_profile_http_reader LOGIN PASSWORD 'synthetic_reader_password'");
  await pool.query("GRANT USAGE ON SCHEMA acp TO acp_profile_http_reader");
  await pool.query("GRANT SELECT ON ALL TABLES IN SCHEMA acp TO acp_profile_http_reader");
  await pool.query("ALTER ROLE acp_profile_http_reader SET default_transaction_read_only=on");
  const evidenceId = createStableId("evidence");
  await clone("evidence_records", "evidence_id", legacy("evd"), { evidence_id: evidenceId,
    observed_at: "2026-09-04T00:00:00Z", retrieved_at: "2026-09-04T00:00:01Z", content_hash: "sha256:synthetic-profile-http",
    source_ref: sentinel, redacted_summary: sentinel, freshness: "current", accessibility: "available", sensitivity: "project_confidential" });
  const row = terms({ fields: { ...fields(), "context.product": { status: "observed", value: { name: "Synthetic", nested: [0.1, 1e-7, null, true, { "ž": "界" }] }, evidenceIds: [evidenceId] } } });
  const saved = (await writer.record(row)).proposal;
  const draft = terms({ fields: {} }), draftSaved = (await writer.record(draft)).proposal;
  const large = terms({ fields: fields('"'.repeat(1800)) }), largeSaved = (await writer.record(large)).proposal;
  await check("actual route identity is SELECT-only and cannot create database objects", async () => {
    const identity = (await readerPool.query("SELECT current_user AS role,current_setting('transaction_read_only') AS readonly")).rows[0];
    assert.equal(identity.role, "acp_profile_http_reader"); assert.equal(identity.readonly, "on");
    await assert.rejects(readerPool.query("CREATE TABLE acp.synthetic_forbidden_profile_http_write(id integer)"), error => error instanceof Error && "code" in error && error.code === "25006");
    assert.equal((await pool.query("SELECT to_regclass('acp.synthetic_forbidden_profile_http_write') AS object")).rows[0].object, null);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: {
    Authorization: `Bearer ${bearerToken}`, "X-ACP-Plugin-Version": "0.3.0",
  } } }) as unknown as Transport);
  const before = await counts();
  await check("both authenticated tools preserve full documents, exact digests and inert authority", async () => {
    assert.deepEqual(parseProjectProfileProposal(content(await call(toolNames[0], row)).proposal), saved);
    const request = parseProfileConfirmationRequest(content(await call(toolNames[1], row)).request, query(row));
    assert.deepEqual(request.proposal, saved); assert.equal(request.evidence.length, 1);
    assert.equal(request.kind, "confirmation_request_only"); assert.equal(request.activation, "not_authorized");
    assert.equal(request.evidence[0]?.identityDigest, saved.evidencePins[0]?.identityDigest);
    for (const key of ["sourceRef", "rawContentRef", "redactedSummary", "operatorId", "confirmedAt"]) assert.equal(JSON.stringify(request).includes(`"${key}"`), false);
  });
  await check("incomplete history remains complete as a draft, not as a review request", async () => {
    assert.deepEqual(content(await call(toolNames[0], draft)).proposal, draftSaved);
    assert.equal(Object.keys(draftSaved.fields).length, 62); denied(await call(toolNames[1], draft));
  });
  await check("large escaped review documents survive storage, wire schema and client validation intact", async () => {
    assert.ok(Buffer.byteLength(JSON.stringify(largeSaved)) > 220_000);
    assert.deepEqual(content(await call(toolNames[0], large)).proposal, largeSaved);
    assert.deepEqual(parseProfileConfirmationRequest(content(await call(toolNames[1], large)).request, query(large)).proposal, largeSaved);
  });
  await check("unknown IDs and wrong project scope do not fall back to the latest draft", async () => {
    for (const name of toolNames) {
      denied(await call(name, { ...row, projectId: createStableId("project") }));
      denied(await call(name, { ...row, proposalId: createStableId("projectProfileProposal") }));
    }
  });
  await check("read-only calls do not change any retained record counts", async () => assert.deepEqual(await counts(), before));
  await check("identity drift denies the request while preserving attributable historical fields", async () => {
    await pool.query("UPDATE acp.evidence_records SET content_hash='sha256:changed-profile-http' WHERE evidence_id=$1", [evidenceId]);
    assert.deepEqual(content(await call(toolNames[0], row)).proposal, saved); denied(await call(toolNames[1], row));
    await pool.query("UPDATE acp.evidence_records SET content_hash='sha256:synthetic-profile-http' WHERE evidence_id=$1", [evidenceId]);
  });
  await check("stale or inaccessible current evidence cannot produce a review request", async () => {
    await pool.query("UPDATE acp.evidence_records SET freshness='stale' WHERE evidence_id=$1", [evidenceId]);
    assert.deepEqual(content(await call(toolNames[0], row)).proposal, saved); denied(await call(toolNames[1], row));
    await pool.query("UPDATE acp.evidence_records SET freshness='current',accessibility='inaccessible' WHERE evidence_id=$1", [evidenceId]);
    denied(await call(toolNames[1], row));
    await pool.query("UPDATE acp.evidence_records SET accessibility='available' WHERE evidence_id=$1", [evidenceId]);
  });
  await check("restricted evidence closes both complete documents without private diagnostics", async () => {
    await pool.query("UPDATE acp.evidence_records SET sensitivity='restricted' WHERE evidence_id=$1", [evidenceId]);
    for (const name of toolNames) denied(await call(name, row));
    await pool.query("UPDATE acp.evidence_records SET sensitivity='project_confidential' WHERE evidence_id=$1", [evidenceId]);
  });
  await check("cross-project evidence closes both complete documents", async () => {
    const otherProject = createStableId("project"); await clone("projects", "project_id", projectId, { project_id: otherProject });
    await pool.query("UPDATE acp.evidence_records SET project_id=$1 WHERE evidence_id=$2", [otherProject, evidenceId]);
    for (const name of toolNames) denied(await call(name, row));
    await pool.query("UPDATE acp.evidence_records SET project_id=$1 WHERE evidence_id=$2", [projectId, evidenceId]);
  });
  await check("superseded exact drafts remain readable without replacing their review request", async () => {
    const successor = { ...row, proposalId: createStableId("projectProfileProposal"), supersedesProposalId: row.proposalId };
    await writer.record(successor);
    assert.deepEqual(content(await call(toolNames[0], row)).proposal, saved); denied(await call(toolNames[1], row));
    assert.equal(parseProfileConfirmationRequest(content(await call(toolNames[1], successor)).request, query(successor)).proposalId, successor.proposalId);
  });
  await check("a published target denies review but does not rewrite its historical proposal", async () => {
    await pool.query("INSERT INTO acp.project_profiles(profile_id,version,project_id,profile,published_at) VALUES($1,$2,$3,'{}',clock_timestamp())",
      [large.candidateProfile.profileId, large.candidateProfile.profileVersion, projectId]);
    assert.deepEqual(content(await call(toolNames[0], large)).proposal, largeSaved); denied(await call(toolNames[1], large));
  });
  await check("privileged SQL precision outside the JSON domain cannot be rounded onto the wire", async () => {
    const direct = terms(), selected = { ...prepareProfileProposalFields({}).fields, "context.product": { status: "proposed", value: "EXACT_DECIMAL_FIXTURE", rationale: "Synthetic precision", evidenceIds: [] } };
    const encoded = JSON.stringify(selected).replace('"EXACT_DECIMAL_FIXTURE"', "0.1000000000000000000001");
    await pool.query(`INSERT INTO acp.project_profile_proposals(proposal_id,project_id,profile_id,profile_version,producer,fields)
      VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`, [direct.proposalId, projectId, direct.candidateProfile.profileId, direct.candidateProfile.profileVersion, JSON.stringify(producer), encoded]);
    for (const name of toolNames) denied(await call(name, direct));
  });
  await check("unauthenticated calls cannot dispatch and final read-side counts are unchanged", async () => {
    const finalCounts = await counts();
    for (const name of toolNames) {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-ACP-Plugin-Version": "0.3.0" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: query(row) } }) });
      assert.equal(response.status, 401); assert.equal((await response.text()).includes(bearerToken), false);
      denied(await call(name, { ...row, proposalId: createStableId("projectProfileProposal") }));
    }
    assert.deepEqual(await counts(), finalCounts);
  });
  process.stdout.write(`Profile proposal PostgreSQL/HTTP integration passed: ${checks} checks.\n`);
} finally {
  try { await client.close(); }
  finally {
    try { if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    finally { await readerPool.end(); await pool.end(); }
  }
}
