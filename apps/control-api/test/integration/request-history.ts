import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Pool, type QueryResultRow } from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createStableId, type RequestHistory, type RequestRegistration, type StableId } from "@acp/domain";
import { PostgresRequestStore, PostgresCounterpartMissionStore, type ConnectionPool } from "@acp/storage";
import { createControlApiServer } from "../../src/http-server.ts";

const port = Number(process.argv[2]); assert.ok(Number.isInteger(port) && port > 1023 && port < 65536);
const limits = { max: 4, connectionTimeoutMillis: 3000, statement_timeout: 5000, lock_timeout: 2000 };
const pool = new Pool({ ...limits, connectionString: `postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test` });
const reader = new Pool({ ...limits, connectionString: `postgresql://acp_request_http_reader:synthetic_request_reader_password@127.0.0.1:${port}/acp_test` });
const legacy = (prefix: string, suffix = "001") => `${prefix}_00000000-0000-4000-8000-000000000${suffix}`;
const projectId = legacy("prj") as StableId<"project">, missionId = legacy("mis") as StableId<"mission">, provenanceId = legacy("prv") as StableId<"provenance">;
const bearerToken = "synthetic-request-pg-http-token-not-a-real-secret", sentinel = "synthetic-private-intake-must-not-escape";
let reads = 0, connects = 0, checks = 0;
const projection: ConnectionPool = {
  query<R extends QueryResultRow>(sql: string, values?: unknown[]) { reads++; return reader.query<R>(sql, values); },
  async connect() { connects++; return reader.connect(); },
};
const writer = new PostgresRequestStore(pool, { provenanceId }), persistence = new PostgresCounterpartMissionStore(projection, provenanceId);
const server = createControlApiServer({ persistence, bearerToken }), client = new Client({ name: "acp-request-pg-http", version: "1.0.0" });
async function check(name: string, action: () => Promise<void>) { await action(); checks++; process.stdout.write(`PASS request HTTP: ${name}\n`); }
async function request(): Promise<RequestRegistration> {
  const sourceIntakeId = createStableId("intake");
  await pool.query("INSERT INTO acp.intake_records(intake_id,project_id,origin,immutable_source_ref,received_at,envelope) VALUES($1,$2,'codex',$3,clock_timestamp(),$4::jsonb)",
    [sourceIntakeId, projectId, `${sentinel}:${sourceIntakeId}`, JSON.stringify({ privateNote: sentinel })]);
  return { requestId: createStableId("request"), projectId, sourceIntakeId, title: "Synthetic original request", summary: "Original report; not an approved plan." };
}
async function counts() { return (await pool.query(`SELECT jsonb_build_object('requests',(SELECT count(*) FROM acp.request_records),
  'links',(SELECT count(*) FROM acp.request_mission_associations),'missions',(SELECT count(*) FROM acp.missions),
  'runs',(SELECT count(*) FROM acp.worker_runs),'effects',(SELECT count(*) FROM acp.effect_proposals),
  'approvals',(SELECT count(*) FROM acp.approval_envelopes),'events',(SELECT count(*) FROM acp.mission_events)) AS counts`)).rows[0].counts; }
const call = (query: object) => client.callTool({ name: "get_request_history", arguments: { ...query } });
function parsed(result: Awaited<ReturnType<typeof call>>): RequestHistory {
  assert.notEqual(result.isError, true); assert.ok(result.structuredContent); const text = JSON.stringify(result);
  assert.equal(text.includes(sentinel), false); assert.equal(text.includes(provenanceId), false);
  assert.ok(Buffer.byteLength(JSON.stringify(result.structuredContent)) <= 65536);
  return (result.structuredContent as { history: RequestHistory }).history;
}
function denied(result: Awaited<ReturnType<typeof call>>) {
  assert.equal(result.isError, true); assert.equal(result.structuredContent, undefined);
  assert.deepEqual(result.content, [{ type: "text", text: "ACP recorded request history is unavailable; no partial history returned." }]);
  assert.equal(JSON.stringify(result).includes(sentinel), false);
}
try {
  await pool.query("CREATE ROLE acp_request_http_reader LOGIN PASSWORD 'synthetic_request_reader_password'");
  await pool.query("GRANT USAGE ON SCHEMA acp TO acp_request_http_reader");
  await pool.query("GRANT SELECT ON acp.request_records,acp.request_mission_associations TO acp_request_http_reader");
  await pool.query("ALTER ROLE acp_request_http_reader SET default_transaction_read_only=on");
  const original = await request(), registration = await writer.recordRequest(original), unlinked = await request(); await writer.recordRequest(unlinked);
  const association = await writer.associateMission({ requestId: original.requestId, projectId, missionId, reason: "Investigate the retained question." });
  const query = { projectId, requestId: original.requestId }, before = await counts();
  await check("actual route role has only bounded SELECT history access", async () => {
    assert.equal((await reader.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "on");
    await assert.rejects(reader.query("SELECT * FROM acp.runtime_provenance")); await assert.rejects(reader.query("SELECT * FROM acp.intake_records"));
    await assert.rejects(reader.query("CREATE TABLE acp.forbidden_request_http_write(id integer)"));
    await assert.rejects(new PostgresRequestStore(reader, { provenanceId }).recordRequest({ ...original, requestId: createStableId("request") }));
    assert.deepEqual(await counts(), before);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${bearerToken}`, "X-ACP-Plugin-Version": "0.5.0" } } });
  await client.connect(transport as unknown as Transport);
  await check("real route returns exact original statement and links without source or producer metadata", async () => {
    const prior = reads, result = parsed(await call(query)); assert.equal(reads, prior + 1); assert.equal(connects, 0);
    assert.deepEqual(result.request, original); assert.equal(result.recordedAt, registration.recordedAt);
    assert.deepEqual(result.missionAssociations, [{ missionId, reason: association.record.reason, recordedAt: association.recordedAt }]);
    assert.equal(result.coverage, "recorded_associations_only"); assert.equal(result.freshness, "not_assessed"); assert.equal(result.authority, "not_granted");
  });
  await check("an unlinked request stays a readable record rather than a closed or missing request", async () => {
    const result = parsed(await call({ projectId, requestId: unlinked.requestId })); assert.deepEqual(result.missionAssociations, []);
    assert.deepEqual(result.request, unlinked); assert.equal(result.authority, "not_granted");
  });
  await check("missing and foreign scopes return the same bounded public error", async () => {
    denied(await call({ ...query, requestId: createStableId("request") }));
    denied(await call({ ...query, projectId: legacy("prj", "900") })); denied(await call({ ...query, projectId: createStableId("project") }));
  });
  await check("invalid, unauthenticated and untrusted-origin calls perform zero actual SQL", async () => {
    const prior = reads;
    for (const input of [{ ...query, approve: true }, { ...query, limit: 1 }, { ...query, requestId: "latest" }, { projectId }]) {
      const result = await call(input); assert.equal(result.isError, true); assert.equal(result.structuredContent, undefined);
    }
    for (const [authorization, origin, status] of [[undefined, undefined, 401], [`Bearer ${bearerToken}`, "https://untrusted.example", 403]] as const) {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-ACP-Plugin-Version": "0.5.0",
        ...(authorization ? { Authorization: authorization } : {}), ...(origin ? { Origin: origin } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_request_history", arguments: query } }) });
      assert.equal(response.status, status); assert.equal((await response.text()).includes(bearerToken), false);
    }
    assert.equal(reads, prior); assert.equal(connects, 0); assert.deepEqual(await counts(), before);
  });
  await check("producer retirement retains history and actual query denial never masquerades as empty success", async () => {
    await pool.query("UPDATE acp.project_workflow_bindings SET retired_at=clock_timestamp() WHERE binding_id=$1", [legacy("wfb")]);
    assert.equal(parsed(await call(query)).recordedAt, registration.recordedAt);
    await pool.query("REVOKE SELECT ON acp.request_mission_associations FROM acp_request_http_reader");
    denied(await call(query)); assert.deepEqual(await counts(), before);
  });
  process.stdout.write(`Request PostgreSQL/HTTP integration passed: ${checks} checks; no mutations or authority inferred.\n`);
} finally {
  try { await client.close(); }
  finally { try { if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    finally { await reader.end(); await pool.end(); } }
}
