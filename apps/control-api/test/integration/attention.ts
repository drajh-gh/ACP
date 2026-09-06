import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Pool, type QueryResultRow } from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { attentionTypes, createStableId, parseAttentionItem, type AttentionItem, type AttentionQueue, type StableId } from "@acp/domain";
import { PostgresAttentionStore, PostgresCounterpartMissionStore, type ConnectionPool } from "@acp/storage";
import { createControlApiServer } from "../../src/http-server.ts";

const port = Number(process.argv[2]);
assert.ok(Number.isInteger(port) && port > 1023 && port < 65536);
const limits = { max: 4, connectionTimeoutMillis: 3000, statement_timeout: 5000, lock_timeout: 2000 };
const pool = new Pool({ ...limits, connectionString: `postgresql://postgres:acp_test_password@127.0.0.1:${port}/acp_test` });
const readerPool = new Pool({ ...limits, connectionString: `postgresql://acp_attention_http_reader:synthetic_attention_reader_password@127.0.0.1:${port}/acp_test` });
const legacy = (prefix: string) => `${prefix}_00000000-0000-4000-8000-000000000001`;
const projectId = legacy("prj") as StableId<"project">, missionId = legacy("mis") as StableId<"mission">, provenanceId = legacy("prv") as StableId<"provenance">;
const bearerToken = "synthetic-attention-pg-http-token-not-a-real-secret", sentinel = "synthetic-private-attention-source-not-for-http";
const writer = new PostgresAttentionStore(pool, { provenanceId });
let reads = 0, connects = 0, checks = 0;
const projection: ConnectionPool = {
  query<R extends QueryResultRow>(sql: string, values?: unknown[]) { reads++; return readerPool.query<R>(sql, values); },
  async connect() { connects++; return readerPool.connect(); },
};
const persistence = new PostgresCounterpartMissionStore(projection, provenanceId), server = createControlApiServer({ persistence, bearerToken });
const client = new Client({ name: "acp-attention-postgres-http", version: "1.0.0" });
async function check(name: string, action: () => Promise<void>) { await action(); checks++; process.stdout.write(`PASS attention HTTP: ${name}\n`); }
function item(change: Partial<AttentionItem> = {}): AttentionItem {
  return parseAttentionItem({ itemId: createStableId("attentionItem"), projectId, missionIds: [missionId], type: "material_ambiguity", urgency: "normal",
    title: "Synthetic decision request", explanation: "Recorded alternatives differ.", whyHumanIsNeeded: "A person selects the intended result.",
    evidenceIds: [], allowedResponses: ["Clarify", "Defer"], deduplicationKey: createStableId("event"), quietHoursDisposition: "Not evaluated; no notification sent.", ...change });
}
async function counts() { return (await pool.query(`SELECT jsonb_build_object('items',(SELECT count(*) FROM acp.attention_items),
  'requests',(SELECT count(*) FROM acp.attention_requests),'missionRefs',(SELECT count(*) FROM acp.attention_item_missions),
  'evidenceRefs',(SELECT count(*) FROM acp.attention_item_evidence),'previewRefs',(SELECT count(*) FROM acp.attention_item_effect_previews),
  'missions',(SELECT count(*) FROM acp.missions),'runs',(SELECT count(*) FROM acp.worker_runs),'effects',(SELECT count(*) FROM acp.effect_proposals),
  'approvals',(SELECT count(*) FROM acp.approval_envelopes),'events',(SELECT count(*) FROM acp.mission_events)) AS counts`)).rows[0].counts; }
const call = (input: object = { projectId, missionId }) => client.callTool({ name: "get_mission_attention", arguments: { ...input } });
function parsed(result: Awaited<ReturnType<typeof call>>): AttentionQueue {
  assert.notEqual(result.isError, true); assert.ok(result.structuredContent);
  const body = JSON.stringify(result); assert.equal(body.includes(sentinel), false); assert.equal(body.includes(provenanceId), false);
  assert.ok(Buffer.byteLength(JSON.stringify(result.structuredContent)) <= 65536);
  return (result.structuredContent as { attention: AttentionQueue }).attention;
}
function denied(result: Awaited<ReturnType<typeof call>>) {
  assert.equal(result.isError, true); assert.equal(result.structuredContent, undefined);
  assert.deepEqual(result.content, [{ type: "text", text: "ACP recorded attention is unavailable; no partial queue returned." }]);
  assert.equal(JSON.stringify(result).includes(sentinel), false);
}
try {
  await pool.query("CREATE ROLE acp_attention_http_reader LOGIN PASSWORD 'synthetic_attention_reader_password'");
  await pool.query("GRANT USAGE ON SCHEMA acp TO acp_attention_http_reader");
  await pool.query("GRANT SELECT ON ALL TABLES IN SCHEMA acp TO acp_attention_http_reader");
  await pool.query("ALTER ROLE acp_attention_http_reader SET default_transaction_read_only=on");
  const evidenceId = createStableId("evidence");
  assert.equal((await pool.query(`INSERT INTO acp.evidence_records SELECT (jsonb_populate_record(NULL::acp.evidence_records,to_jsonb(e)||$1::jsonb)).*
    FROM acp.evidence_records e WHERE evidence_id=$2`, [JSON.stringify({ evidence_id: evidenceId, source_ref: sentinel, redacted_summary: sentinel,
      observed_at: "2026-09-04T00:00:00Z", retrieved_at: "2026-09-04T00:00:01Z", freshness: "stale", accessibility: "inaccessible", sensitivity: "project_confidential" }), legacy("evd")])).rowCount, 1);
  const originals: AttentionItem[] = [];
  for (const type of attentionTypes) { const source = item({ type, evidenceIds: [evidenceId], expiresAt: "2026-09-05T00:00:00.000001Z" }); originals.push(source); await writer.record(source); }
  const global = item({ missionIds: [], urgency: "critical" }); await writer.record(global);
  await check("actual route role is SELECT-only with no DDL or attention producer authority", async () => {
    const identity = (await readerPool.query("SELECT current_user AS role,current_setting('transaction_read_only') AS readonly")).rows[0];
    assert.equal(identity.role, "acp_attention_http_reader"); assert.equal(identity.readonly, "on"); const before = await counts();
    await assert.rejects(readerPool.query("CREATE TABLE acp.synthetic_forbidden_attention_http_write(id integer)"), error => error instanceof Error && "code" in error && error.code === "25006");
    await assert.rejects(new PostgresAttentionStore(readerPool, { provenanceId }).record(item())); assert.deepEqual(await counts(), before);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${bearerToken}`, "X-ACP-Plugin-Version": "0.4.0" } },
  });
  await client.connect(transport as unknown as Transport);
  const before = await counts();
  await check("real storage returns all twelve recorded types and exact expiry without private receipt or source fields", async () => {
    const prior = reads, queue = parsed(await call()); assert.equal(reads, prior + 1);
    assert.deepEqual(queue.items.map(row => row.item.type), attentionTypes); assert.ok(queue.items.every(row => row.expiry === "expired"));
    assert.equal(queue.coverage, "recorded_items_only"); assert.equal(queue.freshness, "not_assessed"); assert.equal(queue.authority, "not_granted");
    assert.equal(queue.items.some(row => row.item.itemId === global.itemId), false); assert.equal(connects, 0);
  });
  await check("actual cursor pages preserve exact scope and every canonical item once", async () => {
    const ids: string[] = []; let afterItemId: StableId<"attentionItem"> | undefined;
    for (let index = 0; index < 5; index++) {
      const page = parsed(await call({ projectId, missionId, limit: 3, ...(afterItemId ? { afterItemId } : {}) }));
      ids.push(...page.items.map(row => row.item.itemId)); if (!page.nextCursor) break; afterItemId = page.nextCursor;
    }
    assert.deepEqual(ids, originals.map(row => row.itemId)); assert.equal(new Set(ids).size, 12);
    assert.equal(parsed(await call({ projectId, limit: 1 })).items[0]?.item.itemId, global.itemId);
  });
  await check("absent scopes and invalid or foreign-scope anchors have the same bounded public error", async () => {
    denied(await call({ projectId: createStableId("project") })); denied(await call({ projectId, missionId: createStableId("mission") }));
    denied(await call({ projectId, afterItemId: createStableId("attentionItem") })); denied(await call({ projectId, missionId, afterItemId: global.itemId }));
  });
  await check("restricted evidence denies both a full page and an otherwise valid prefix with restricted lookahead", async () => {
    await pool.query("UPDATE acp.evidence_records SET sensitivity='restricted' WHERE evidence_id=$1", [evidenceId]);
    try { denied(await call()); denied(await call({ projectId, limit: 1 })); }
    finally { await pool.query("UPDATE acp.evidence_records SET sensitivity='project_confidential' WHERE evidence_id=$1", [evidenceId]); }
    assert.equal(parsed(await call()).items.length, 12);
  });
  await check("invalid action inputs and unauthenticated requests never reach actual SQL", async () => {
    const prior = reads;
    for (const input of [{ projectId, decide: true }, { projectId, limit: 51 }, { projectId, afterItemId: "latest" }]) {
      const result = await call(input); assert.equal(result.isError, true); assert.equal(result.structuredContent, undefined);
    }
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-ACP-Plugin-Version": "0.4.0" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_mission_attention", arguments: { projectId } } }) });
    assert.equal(response.status, 401); assert.equal((await response.text()).includes(bearerToken), false);
    assert.equal(reads, prior); assert.equal(connects, 0); assert.deepEqual(await counts(), before);
  });
  process.stdout.write(`Attention PostgreSQL/HTTP integration passed: ${checks} checks; no decisions or notifications.\n`);
} finally {
  try { await client.close(); }
  finally { try { if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    finally { await readerPool.end(); await pool.end(); } }
}
