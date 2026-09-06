import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { attentionTypes, createStableId, parseAttentionItem, parseAttentionQueue, type AttentionQueue, type AttentionQueueQuery } from "@acp/domain";
import type { CounterpartMissionPersistence } from "@acp/storage";
import { createControlApiServer } from "../src/http-server.ts";

const bearerToken = "synthetic-attention-http-token-not-a-real-secret";
const unavailable = "ACP recorded attention is unavailable; no partial queue returned.";
const toolName = "get_mission_attention";
function fixture() {
  const projectId = createStableId("project"), missionId = createStableId("mission"), asOf = "2026-09-06T14:00:00.000001Z";
  const query = { projectId, missionId, limit: 20 };
  const items = attentionTypes.map((type, index) => ({ item: parseAttentionItem({ itemId: createStableId("attentionItem"), projectId, missionIds: [missionId],
    type, urgency: "normal", title: `Recorded item ${index}`, explanation: "Recorded descriptions differ.", whyHumanIsNeeded: "A person must select the intended scope.",
    recommendation: "Inspect the evidence.", alternatives: ["Option A", "Option B"], consequenceOfNoAction: "The recorded issue remains unresolved.",
    evidenceIds: [createStableId("evidence")], effectPreviewIds: [createStableId("effect")], allowedResponses: ["Clarify", "Defer"],
    deduplicationKey: `recorded:${index}`, quietHoursDisposition: "Not evaluated; no notification sent.", expiresAt: "2026-09-05T00:00:00.000001Z" }),
    recordedAt: `2026-09-06T13:00:00.${String(index).padStart(6, "0")}Z`, expiry: "expired" as const }));
  const queue = parseAttentionQueue(query, { schemaVersion: "1.0.0", projectId, missionId, afterItemId: null, limit: 20, asOf,
    coverage: "recorded_items_only", freshness: "not_assessed", authority: "not_granted", items, nextCursor: null });
  let output: unknown = queue, writes = 0;
  const reads: AttentionQueueQuery[] = [];
  const persistence = {
    async getAttentionQueue(input: AttentionQueueQuery) { reads.push(input); return output as AttentionQueue | undefined; },
    async getProjectProfileProposal() { throw new Error("unexpected profile read"); }, async getProfileConfirmationRequest() { throw new Error("unexpected confirmation read"); },
    async getProjectReadiness() { throw new Error("unexpected readiness read"); }, async getMission() { throw new Error("unexpected mission read"); },
    async getMissionStatus() { throw new Error("unexpected status read"); }, async listActiveMissions() { throw new Error("unexpected inventory"); },
    async createMission() { writes++; throw new Error("unexpected mutation"); },
  } as unknown as CounterpartMissionPersistence;
  return { query, queue, persistence, reads, writes: () => writes, set output(value: unknown) { output = value; } };
}
async function withClient(action: (client: Client, data: ReturnType<typeof fixture>, url: string) => Promise<void>, version = "0.4.0", allowedPluginVersions?: readonly string[]) {
  const data = fixture(), server = createControlApiServer({ persistence: data.persistence, bearerToken, ...(allowedPluginVersions ? { allowedPluginVersions } : {}) });
  const client = new Client({ name: "acp-attention-http-test", version: "1.0.0" });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${bearerToken}`, "X-ACP-Plugin-Version": version } } });
    await client.connect(transport as unknown as Transport); await action(client, data, url);
  } finally { await client.close(); if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
function denied(result: Awaited<ReturnType<Client["callTool"]>>) {
  assert.equal(result.isError, true); assert.equal(result.structuredContent, undefined);
  assert.deepEqual(result.content, [{ type: "text", text: unavailable }]);
}
for (const version of ["0.1.0", "0.2.0", "0.3.0", "0.4.0"]) it(`attention returns all twelve recorded types without acting for compatible plugin ${version}`, async () => {
  await withClient(async (client, data) => {
    const tool = (await client.listTools()).tools.find(tool => tool.name === toolName); assert.ok(tool);
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.equal(tool.inputSchema.additionalProperties, false); assert.ok(tool.outputSchema);
    assert.deepEqual(client.getServerVersion(), { name: "acp-control", version: "0.4.0" });
    const result = await client.callTool({ name: toolName, arguments: data.query }); assert.notEqual(result.isError, true);
    assert.deepEqual(result.structuredContent, { attention: data.queue }); assert.deepEqual(data.reads, [data.query]); assert.equal(data.writes(), 0);
    assert.match(JSON.stringify(result.content), /not decisions|not permission/u);
  }, version);
});
it("attention defaults a project-wide query and preserves exact explicit cursor and page size", async () => {
  await withClient(async (client, data) => {
    const projectQuery = { projectId: data.query.projectId, limit: 20 };
    data.output = { ...data.queue, missionId: null, items: [] };
    const empty = await client.callTool({ name: toolName, arguments: { projectId: data.query.projectId } }); assert.notEqual(empty.isError, true);
    assert.deepEqual(data.reads[0], projectQuery); assert.equal((empty.structuredContent as { attention: AttentionQueue }).attention.authority, "not_granted");
    const afterItemId = createStableId("attentionItem"), query = { ...data.query, afterItemId, limit: 2 };
    data.output = { ...data.queue, afterItemId, limit: 2, items: data.queue.items.slice(0, 2), nextCursor: data.queue.items[1]!.item.itemId };
    const result = await client.callTool({ name: toolName, arguments: query }); assert.notEqual(result.isError, true);
    assert.deepEqual(data.reads[1], query); assert.equal(data.writes(), 0);
  });
});
it("attention rejects action fields, aliases and invalid limits before persistence", async () => {
  await withClient(async (client, data) => {
    for (const input of [{ ...data.query, acknowledge: true }, { ...data.query, resolve: true }, { ...data.query, projectId: "project-name" },
      { ...data.query, projectId: `${data.query.projectId}\n` }, { ...data.query, missionId: createStableId("project") },
      { ...data.query, afterItemId: "latest" }, { ...data.query, limit: 0 }, { ...data.query, limit: 51 }, { ...data.query, limit: 1.5 }]) {
      const result = await client.callTool({ name: toolName, arguments: input }); assert.equal(result.isError, true); assert.equal(result.structuredContent, undefined);
    }
    assert.equal(data.reads.length, 0); assert.equal(data.writes(), 0);
  });
});
it("attention contains private failures and rejects substituted, partial, oversized or authority-shaped queues", async () => {
  await withClient(async (client, data) => {
    const sentinel = "synthetic-private-attention-must-never-escape", first = data.queue.items[0]!;
    for (const output of [undefined, { ...data.queue, projectId: createStableId("project") }, { ...data.queue, missionId: null },
      { ...data.queue, afterItemId: createStableId("attentionItem") }, { ...data.queue, limit: 50 }, { ...data.queue, schemaVersion: "2.0.0" },
      { ...data.queue, authority: "granted" }, { ...data.queue, freshness: "current" }, { ...data.queue, provenanceId: sentinel },
      { ...data.queue, items: [...data.queue.items].reverse() }, { ...data.queue, items: [first, first] },
      { ...data.queue, items: [{ ...first, item: { ...first.item, rawEvidence: sentinel } }] },
      { ...data.queue, items: [{ ...first, item: { ...first.item, explanation: sentinel.repeat(5000) } }] },
      { ...data.queue, items: [{ ...first, expiry: "not_expired" }] }, { ...data.queue, nextCursor: first.item.itemId }]) {
      data.output = output; const result = await client.callTool({ name: toolName, arguments: data.query }); denied(result);
      assert.equal(JSON.stringify(result).includes(sentinel), false);
    }
    data.persistence.getAttentionQueue = async () => { throw new Error(sentinel); };
    const result = await client.callTool({ name: toolName, arguments: data.query }); denied(result); assert.equal(JSON.stringify(result).includes(sentinel), false);
    assert.equal(data.writes(), 0);
  });
});
it("attention never executes persistence getters or serialization hooks while rejecting unsafe results", async () => {
  await withClient(async (client, data) => {
    let calls = 0;
    const getter = Object.defineProperty({ ...data.queue }, "items", { enumerable: true, get() { calls++; throw new Error("private getter"); } });
    for (const output of [getter, { ...data.queue, toJSON() { calls++; return data.queue; } }]) {
      data.output = output; denied(await client.callTool({ name: toolName, arguments: data.query }));
    }
    assert.equal(calls, 0); assert.equal(data.writes(), 0);
  });
});
it("attention includes its public wrapper in the 64 KiB cap even when the exact domain queue fits", async () => {
  await withClient(async (client, data) => {
    const items = data.queue.items.map(row => ({ ...row, item: { ...row.item, explanation: "x".repeat(4000) } }));
    const queue = { ...data.queue, items };
    let remaining = 65536 - Buffer.byteLength(JSON.stringify(queue)); assert.ok(remaining > 0);
    for (const row of items) {
      const extra = Math.min(4000 - row.item.whyHumanIsNeeded.length, remaining);
      row.item.whyHumanIsNeeded += "y".repeat(extra); remaining -= extra;
    }
    assert.equal(remaining, 0); assert.equal(Buffer.byteLength(JSON.stringify(queue)), 65536);
    data.output = parseAttentionQueue(data.query, queue);
    denied(await client.callTool({ name: toolName, arguments: data.query })); assert.equal(data.reads.length, 1); assert.equal(data.writes(), 0);
  });
});
it("attention preserves operator version restrictions and repository plugin feature alignment", async () => {
  for (const [version, allowed] of [["0.4.0", ["0.3.0"]], ["0.3.0", ["0.4.0"]]] as const)
    await assert.rejects(withClient(async () => assert.fail("unexpected dispatch"), version, allowed), error => error instanceof Error && "code" in error && error.code === 426);
  const manifest = JSON.parse(await readFile(new URL("../../../plugins/codex-counterpart/.codex-plugin/plugin.json", import.meta.url), "utf8"));
  const mcp = JSON.parse(await readFile(new URL("../../../plugins/codex-counterpart/.mcp.json", import.meta.url), "utf8"));
  assert.equal(manifest.version, "0.4.0"); assert.equal(mcp.mcpServers["acp-control"].http_headers["X-ACP-Plugin-Version"], manifest.version);
  assert.deepEqual(mcp.mcpServers["acp-control"].enabled_tools.slice().sort(), ["create_mission", "get_mission_attention", "get_mission_status",
    "get_profile_confirmation_request", "get_project_profile_proposal", "get_project_readiness", "list_active_missions"]);
});
it("attention authentication and origin checks reject calls before any persistence read", async () => {
  await withClient(async (_client, data, url) => {
    for (const [authorization, origin, expected] of [[undefined, undefined, 401], [`Bearer ${bearerToken}`, "https://untrusted.example", 403]] as const) {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-ACP-Plugin-Version": "0.4.0",
        ...(authorization ? { Authorization: authorization } : {}), ...(origin ? { Origin: origin } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: data.query } }) });
      assert.equal(response.status, expected); assert.equal((await response.text()).includes(bearerToken), false);
    }
    assert.equal(data.reads.length, 0); assert.equal(data.writes(), 0);
  });
});
