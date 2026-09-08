import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createStableId, type AttentionQueueQuery, type RequestHistoryQuery, type StableId } from "@acp/domain";
import type { CounterpartMissionPersistence } from "@acp/storage";
import { statusFixture } from "../../../packages/storage/test/fixtures/counterpart-status.ts";
import { createControlApiServer } from "../src/http-server.ts";

const bearerToken = "synthetic-request-brief-token-not-a-real-secret", toolName = "get_request_brief";
const unavailable = "ACP request brief is unavailable; no partial projection returned.";
function fixture() {
  const projectId = createStableId("project"), requestId = createStableId("request"), missionId = createStableId("mission");
  const query = { projectId, requestId }, at = "2026-09-08T12:00:00.000001Z";
  const history = { schemaVersion: "1.0.0", asOf: at, request: { ...query, sourceIntakeId: createStableId("intake"), title: "Original question", summary: "Reported wording, not approved scope." },
    recordedAt: at, missionAssociations: [{ missionId, reason: "Recorded association", recordedAt: at }],
    coverage: "recorded_associations_only", freshness: "not_assessed", authority: "not_granted" };
  const status = { ...statusFixture(), projectId, missionId, asOf: at };
  const queue = { schemaVersion: "1.0.0", projectId, missionId, afterItemId: null, limit: 20, asOf: at,
    coverage: "recorded_items_only", freshness: "not_assessed", authority: "not_granted", items: [], nextCursor: null };
  const calls: string[] = []; let historyOutput: unknown = history, statusOutput: unknown = status, attentionOutput: unknown = queue;
  const persistence = {
    async getRequestHistory(value: RequestHistoryQuery) { calls.push(`history:${value.projectId}:${value.requestId}`); return historyOutput; },
    async getMissionStatus(value: StableId<"mission">) { calls.push(`status:${value}`); return statusOutput; },
    async getAttentionQueue(value: AttentionQueueQuery) { calls.push(`attention:${value.projectId}:${value.missionId}:${value.limit}`); return attentionOutput; },
  } as unknown as CounterpartMissionPersistence;
  return { query, missionId, calls, persistence,
    setHistory(value: unknown) { historyOutput = value; }, setStatus(value: unknown) { statusOutput = value; }, setAttention(value: unknown) { attentionOutput = value; } };
}
async function withClient(action: (client: Client, data: ReturnType<typeof fixture>, url: string) => Promise<void>) {
  const data = fixture(), server = createControlApiServer({ persistence: data.persistence, bearerToken });
  const client = new Client({ name: "acp-request-brief-test", version: "1.0.0" });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${bearerToken}`, "X-ACP-Plugin-Version": "0.5.0" } } });
    await client.connect(transport as unknown as Transport); await action(client, data, url);
  } finally { await client.close(); if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
function denied(result: Awaited<ReturnType<Client["callTool"]>>) {
  assert.equal(result.isError, true); assert.equal(result.structuredContent, undefined);
  assert.deepEqual(result.content, [{ type: "text", text: unavailable }]);
}

it("registers the strict read-only brief and returns bounded observed coverage", async () => {
  await withClient(async (client, data) => {
    const tool = (await client.listTools()).tools.find(value => value.name === toolName); assert.ok(tool);
    assert.equal(tool.inputSchema.additionalProperties, false); assert.equal(tool.outputSchema?.additionalProperties, false);
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    const result = await client.callTool({ name: toolName, arguments: data.query }); assert.notEqual(result.isError, true);
    const brief = (result.structuredContent as { brief: Record<string, unknown> }).brief;
    assert.equal(brief.projectId, data.query.projectId); assert.equal(brief.requestId, data.query.requestId);
    assert.deepEqual(brief.unavailable, ["destination_decisions", "obligations", "communications"]);
    assert.equal(brief.authority, "not_granted"); assert.match(JSON.stringify(result.content), /nextCursor/u);
    assert.deepEqual(data.calls, [`history:${data.query.projectId}:${data.query.requestId}`, `status:${data.missionId}`, `status:${data.missionId}`,
      `attention:${data.query.projectId}:${data.missionId}:20`, `attention:${data.query.projectId}:${data.missionId}:20`, `history:${data.query.projectId}:${data.query.requestId}`]);
  });
});

it("rejects invalid and cross-scope selectors before any persistence I/O", async () => {
  await withClient(async (client, data) => {
    for (const input of [{ requestId: data.query.requestId }, { ...data.query, projectId: "project-name" }, { ...data.query, missionId: data.missionId }, { ...data.query, approve: true }]) {
      const result = await client.callTool({ name: toolName, arguments: input }); assert.equal(result.isError, true);
    }
    assert.deepEqual(data.calls, []);
  });
});

it("masks missing, malformed, substituted, overflowing and tampered reader output", async () => {
  await withClient(async (client, data) => {
    const sentinel = "private-database-detail-must-not-escape";
    data.setHistory(undefined); denied(await client.callTool({ name: toolName, arguments: data.query }));
    data.setHistory({ get projectId() { throw new Error(sentinel); } }); denied(await client.callTool({ name: toolName, arguments: data.query }));
    data.setHistory({ schemaVersion: "1.0.0", authority: "granted" }); denied(await client.callTool({ name: toolName, arguments: data.query }));
    data.setHistory({ ...fixtureHistory(data), missionAssociations: Array.from({ length: 51 }, (_, index) => ({ missionId: `mis_00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, reason: "x", recordedAt: "2026-09-08T12:00:00.000001Z" })) });
    denied(await client.callTool({ name: toolName, arguments: data.query }));
    data.setHistory(fixtureHistory(data)); data.setStatus({ ...statusFixture(), projectId: createStableId("project"), missionId: data.missionId });
    const result = await client.callTool({ name: toolName, arguments: data.query }); denied(result); assert.equal(JSON.stringify(result).includes(sentinel), false);
  });
});

it("rejects unauthenticated brief traffic before persistence", async () => {
  await withClient(async (_client, data, url) => {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-ACP-Plugin-Version": "0.5.0" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: data.query } }) });
    assert.equal(response.status, 401); assert.deepEqual(data.calls, []);
  });
});

function fixtureHistory(data: ReturnType<typeof fixture>) {
  const at = "2026-09-08T12:00:00.000001Z";
  return { schemaVersion: "1.0.0", asOf: at, request: { ...data.query, sourceIntakeId: createStableId("intake"), title: "Original", summary: "Report" }, recordedAt: at,
    missionAssociations: [{ missionId: data.missionId, reason: "Link", recordedAt: at }], coverage: "recorded_associations_only", freshness: "not_assessed", authority: "not_granted" };
}
