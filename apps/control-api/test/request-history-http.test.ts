import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createStableId, parseRequestHistory, type RequestHistory, type RequestHistoryQuery } from "@acp/domain";
import type { CounterpartMissionPersistence } from "@acp/storage";
import { createControlApiServer } from "../src/http-server.ts";

const bearerToken = "synthetic-request-history-http-token-not-a-real-secret", toolName = "get_request_history";
const unavailable = "ACP recorded request history is unavailable; no partial history returned.";
function fixture() {
  const query = { projectId: createStableId("project"), requestId: createStableId("request") };
  const history = parseRequestHistory(query, { schemaVersion: "1.0.0", asOf: "2026-09-06T18:00:00.000003Z",
    request: { ...query, sourceIntakeId: createStableId("intake"), title: "Original question", summary: "Original report, not an approved scope or diagnosis." },
    recordedAt: "2026-09-06T18:00:00.000001Z", missionAssociations: [{ missionId: createStableId("mission"), reason: "Investigation", recordedAt: "2026-09-06T18:00:00.000002Z" }],
    coverage: "recorded_associations_only", freshness: "not_assessed", authority: "not_granted" });
  const reads: RequestHistoryQuery[] = []; let output: unknown = history, writes = 0;
  const persistence = { async getRequestHistory(q: RequestHistoryQuery) { reads.push(q); return output as RequestHistory | undefined; },
    async createMission() { writes++; throw new Error("unexpected mutation"); } } as unknown as CounterpartMissionPersistence;
  return { query, history, persistence, reads, writes: () => writes, set output(value: unknown) { output = value; } };
}
async function withClient(action: (client: Client, data: ReturnType<typeof fixture>, url: string) => Promise<void>, version = "0.5.0", allowedPluginVersions?: readonly string[]) {
  const data = fixture(), server = createControlApiServer({ persistence: data.persistence, bearerToken, ...(allowedPluginVersions ? { allowedPluginVersions } : {}) });
  const client = new Client({ name: "acp-request-history-http-test", version: "1.0.0" });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${bearerToken}`, "X-ACP-Plugin-Version": version } } });
    await client.connect(transport as unknown as Transport); await action(client, data, url);
  } finally { await client.close(); if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
function denied(result: Awaited<ReturnType<Client["callTool"]>>) {
  assert.equal(result.isError, true); assert.equal(result.structuredContent, undefined); assert.deepEqual(result.content, [{ type: "text", text: unavailable }]);
}
for (const version of ["0.1.0", "0.2.0", "0.3.0", "0.4.0", "0.5.0"]) it(`request history reads exact non-authoritative history for compatible plugin ${version}`, async () => {
  await withClient(async (client, data) => {
    const tool = (await client.listTools()).tools.find(row => row.name === toolName); assert.ok(tool);
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.equal(tool.inputSchema.additionalProperties, false); assert.ok(tool.outputSchema);
    assert.deepEqual(client.getServerVersion(), { name: "acp-control", version: "0.5.0" });
    const result = await client.callTool({ name: toolName, arguments: data.query }); assert.notEqual(result.isError, true);
    assert.deepEqual(result.structuredContent, { history: data.history }); assert.deepEqual(data.reads, [data.query]); assert.equal(data.writes(), 0);
    assert.match(JSON.stringify(result.content), /not.*permission/u);
  }, version);
});
it("request history rejects missing IDs, aliases and action-shaped fields before persistence", async () => {
  await withClient(async (client, data) => {
    for (const input of [{ projectId: data.query.projectId }, { ...data.query, requestId: createStableId("mission") },
      { ...data.query, requestId: `${data.query.requestId}\n` }, { ...data.query, projectId: "project-name" },
      { ...data.query, limit: 1 }, { ...data.query, approve: true }, { ...data.query, close: true }]) {
      const result = await client.callTool({ name: toolName, arguments: input }); assert.equal(result.isError, true); assert.equal(result.structuredContent, undefined);
    }
    assert.equal(data.reads.length, 0); assert.equal(data.writes(), 0);
  });
});
it("request history masks absent, malformed, substituted and private persistence responses", async () => {
  await withClient(async (client, data) => {
    const sentinel = "synthetic-private-request-history-must-not-escape";
    for (const output of [undefined, { ...data.history, request: { ...data.history.request, requestId: createStableId("request") } },
      { ...data.history, request: { ...data.history.request, projectId: createStableId("project") } },
      { ...data.history, schemaVersion: "2.0.0" }, { ...data.history, authority: "approved" }, { ...data.history, freshness: "current" },
      { ...data.history, provenanceId: sentinel }, { ...data.history, missionAssociations: null },
      { ...data.history, missionAssociations: [data.history.missionAssociations[0], data.history.missionAssociations[0]] },
      { ...data.history, request: { ...data.history.request, summary: sentinel.repeat(5000) } }]) {
      data.output = output; const result = await client.callTool({ name: toolName, arguments: data.query }); denied(result); assert.equal(JSON.stringify(result).includes(sentinel), false);
    }
    Object.assign(data.persistence, { async getRequestHistory() { throw new Error(sentinel); } });
    const result = await client.callTool({ name: toolName, arguments: data.query }); denied(result); assert.equal(JSON.stringify(result).includes(sentinel), false);
    assert.equal(data.writes(), 0);
  });
});
it("request history never invokes returned getters or serialization hooks", async () => {
  await withClient(async (client, data) => {
    let calls = 0;
    const getter = Object.defineProperty({ ...data.history }, "request", { enumerable: true, get() { calls++; throw new Error("private getter"); } });
    for (const output of [getter, { ...data.history, toJSON() { calls++; return data.history; } }]) { data.output = output; denied(await client.callTool({ name: toolName, arguments: data.query })); }
    assert.equal(calls, 0);
  });
});
it("request history includes the public envelope in its whole 64 KiB cap", async () => {
  await withClient(async (client, data) => {
    const missionAssociations = Array.from({ length: 100 }, () => createStableId("mission")).sort().map(missionId => ({ missionId, reason: "R", recordedAt: data.history.recordedAt }));
    const value = { ...data.history, missionAssociations }; let remaining = 65536 - Buffer.byteLength(JSON.stringify(value));
    assert.ok(remaining > 0);
    for (const row of missionAssociations) { const extra = Math.min(1000 - row.reason.length, remaining); row.reason += "x".repeat(extra); remaining -= extra; }
    assert.equal(remaining, 0); assert.equal(Buffer.byteLength(JSON.stringify(value)), 65536);
    data.output = parseRequestHistory(data.query, value); denied(await client.callTool({ name: toolName, arguments: data.query })); assert.equal(data.reads.length, 1);
  });
});
it("request history preserves explicit version restrictions and aligns the source plugin's nine tools", async () => {
  for (const [version, allowed] of [["0.5.0", ["0.4.0"]], ["0.4.0", ["0.5.0"]]] as const)
    await assert.rejects(withClient(async () => assert.fail("unexpected dispatch"), version, allowed), error => error instanceof Error && "code" in error && error.code === 426);
  const manifest = JSON.parse(await readFile(new URL("../../../plugins/codex-counterpart/.codex-plugin/plugin.json", import.meta.url), "utf8"));
  const mcp = JSON.parse(await readFile(new URL("../../../plugins/codex-counterpart/.mcp.json", import.meta.url), "utf8"));
  assert.equal(manifest.version, "0.5.0"); assert.equal(mcp.mcpServers["acp-control"].http_headers["X-ACP-Plugin-Version"], manifest.version);
  assert.deepEqual(mcp.mcpServers["acp-control"].enabled_tools.slice().sort(), ["create_mission", "get_mission_attention", "get_mission_status",
    "get_profile_confirmation_request", "get_project_profile_proposal", "get_project_readiness", "get_request_brief", "get_request_history", "list_active_missions"]);
});
it("request history rejects unauthenticated and untrusted-origin traffic before persistence", async () => {
  await withClient(async (_client, data, url) => {
    for (const [authorization, origin, expected] of [[undefined, undefined, 401], [`Bearer ${bearerToken}`, "https://untrusted.example", 403]] as const) {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-ACP-Plugin-Version": "0.5.0",
        ...(authorization ? { Authorization: authorization } : {}), ...(origin ? { Origin: origin } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: data.query } }) });
      assert.equal(response.status, expected); assert.equal((await response.text()).includes(bearerToken), false);
    }
    assert.equal(data.reads.length, 0); assert.equal(data.writes(), 0);
  });
});
