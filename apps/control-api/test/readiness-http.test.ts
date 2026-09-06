import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { buildProjectReadiness, capabilityReadinessStates, createStableId,
  type ProjectReadiness, type ProjectReadinessQuery } from "@acp/domain";
import type { CounterpartMissionPersistence } from "@acp/storage";
import { createControlApiServer } from "../src/http-server.ts";

const bearerToken = "a-high-entropy-readiness-test-token-not-a-real-secret";
const unavailable = "ACP readiness is unavailable; no partial snapshot returned.";

function fixture() {
  const projectId = createStableId("project"), profileId = createStableId("projectProfile");
  const evidenceId = createStableId("evidence"), provenanceId = createStableId("provenance");
  const keys = capabilityReadinessStates.map(state => ({ capability: "read_artifacts", resourceKey: `source:${state}`, resourceVersion: "Exact:1" }));
  const query: ProjectReadinessQuery = { projectId, profileId, profileVersion: "1.0.0", keys };
  const assessments = capabilityReadinessStates.map((recordedState, index) => ({ ...keys[index]!,
    assessmentId: createStableId("capabilityReadinessAssessment"), projectId, profileId, profileVersion: "1.0.0",
    recordedState, recordedReason: "Synthetic recorded observation; no grant.", assessedAt: "2026-09-06T00:00:00.000001Z",
    validUntil: "2026-09-06T01:00:00.000001Z", evidenceIds: [evidenceId], evaluatorVersion: "synthetic:1", provenanceId,
    supersedesAssessmentId: null }));
  const readiness = buildProjectReadiness(query, "2026-09-06T00:01:00.000001Z", assessments, [{
    evidenceId, projectId, observedAt: "2026-09-05T23:00:00.000001Z", retrievedAt: "2026-09-05T23:00:01.000001Z",
    contentHash: "synthetic-hash", freshness: "current", accessibility: "available", sensitivity: "project_confidential",
  }], assessments.map(row => ({ assessmentId: row.assessmentId, matches: true })));
  let reads = 0, mutations = 0;
  const persistence: CounterpartMissionPersistence = {
    async getRequestHistory() { throw new Error("unexpected request history read"); },
    async getAttentionQueue() { throw new Error("unexpected attention read"); },
    async getProjectProfileProposal() { throw new Error("unexpected profile proposal read"); },
    async getProfileConfirmationRequest() { throw new Error("unexpected profile request read"); },
    async getProjectReadiness(input: ProjectReadinessQuery) { reads++; assert.deepEqual(input, query); return readiness; },
    async createMission() { mutations++; throw new Error("unexpected mutation"); },
    async getMission() { throw new Error("unexpected mission read"); },
    async getMissionStatus() { throw new Error("unexpected status read"); },
    async listActiveMissions() { throw new Error("unexpected discovery"); },
  };
  return { query, readiness, persistence, reads: () => reads, mutations: () => mutations };
}

async function withClient(action: (client: Client, data: ReturnType<typeof fixture>) => Promise<void>, pluginVersion = "0.2.0", allowedPluginVersions?: readonly string[]) {
  const data = fixture(), server = createControlApiServer({ persistence: data.persistence, bearerToken,
    ...(allowedPluginVersions === undefined ? {} : { allowedPluginVersions }) });
  const client = new Client({ name: "acp-readiness-test", version: "1.0.0" });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = (server.address() as AddressInfo).port;
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: {
      Authorization: `Bearer ${bearerToken}`, "X-ACP-Plugin-Version": pluginVersion,
    } } });
    await client.connect(transport as unknown as Transport);
    await action(client, data);
  } finally {
    await client.close();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

describe("recorded readiness MCP", () => {
  for (const pluginVersion of ["0.1.0", "0.2.0", "0.3.0", "0.4.0", "0.5.0"]) it(`serves seven independent schema-2 states to compatible plugin ${pluginVersion}`, async () => {
    await withClient(async (client, data) => {
      assert.deepEqual(client.getServerVersion(), { name: "acp-control", version: "0.5.0" });
      const tool = (await client.listTools()).tools.find(tool => tool.name === "get_project_readiness");
      assert.ok(tool);
      assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.ok(tool.outputSchema);
      const result = await client.callTool({ name: "get_project_readiness", arguments: { ...data.query } });
      assert.notEqual(result.isError, true);
      assert.deepEqual(result.structuredContent, { readiness: data.readiness });
      assert.equal(data.reads(), 1); assert.equal(data.mutations(), 0);
      assert.deepEqual(data.readiness.entries.map(entry => entry.currentState), capabilityReadinessStates);
      assert.match(JSON.stringify(result.content), /not grants or live probes/u);
    }, pluginVersion);
  });

  it("preserves explicit operator compatibility restrictions in either direction", async () => {
    await assert.rejects(withClient(async () => assert.fail("unexpected dispatch"), "0.2.0", ["0.1.0"]), error =>
      error instanceof Error && "code" in error && error.code === 426);
    await assert.rejects(withClient(async () => assert.fail("unexpected dispatch"), "0.1.0", ["0.2.0"]), error =>
      error instanceof Error && "code" in error && error.code === 426);
  });

  it("keeps the source plugin feature version, header and eight-tool allowlist aligned", async () => {
    const manifest = JSON.parse(await readFile(new URL("../../../plugins/codex-counterpart/.codex-plugin/plugin.json", import.meta.url), "utf8"));
    const mcp = JSON.parse(await readFile(new URL("../../../plugins/codex-counterpart/.mcp.json", import.meta.url), "utf8"));
    assert.equal(manifest.version, "0.5.0");
    assert.equal(mcp.mcpServers["acp-control"].http_headers["X-ACP-Plugin-Version"], manifest.version);
    assert.deepEqual(mcp.mcpServers["acp-control"].enabled_tools.slice().sort(), [
      "create_mission", "get_mission_attention", "get_mission_status", "get_profile_confirmation_request", "get_project_profile_proposal", "get_project_readiness", "get_request_history", "list_active_missions",
    ]);
  });

  it("rejects invalid or aliasing queries before persistence", async () => {
    await withClient(async (client, data) => {
      for (const invalid of [
        { ...data.query, authority: "execute" }, { ...data.query, keys: [] },
        { ...data.query, keys: [data.query.keys[0], data.query.keys[0]] },
        { ...data.query, keys: [{ ...data.query.keys[0], alias: "ignored" }] },
        { ...data.query, keys: [{ ...data.query.keys[0], resourceKey: " source:available" }] },
        { ...data.query, keys: [{ ...data.query.keys[0], resourceVersion: "x".repeat(201) }] },
        { ...data.query, projectId: "prj_123" }, { ...data.query, profileVersion: "latest" },
        { ...data.query, keys: Array.from({ length: 51 }, (_, i) => ({ ...data.query.keys[0], resourceKey: `key:${i}` })) },
      ]) {
        const result = await client.callTool({ name: "get_project_readiness", arguments: invalid });
        assert.equal(result.isError, true); assert.equal(result.structuredContent, undefined);
      }
      assert.equal(data.reads(), 0); assert.equal(data.mutations(), 0);
    });
  });

  it("denies the whole snapshot for private errors, mismatches, old schemas and invented favorable labels", async () => {
    await withClient(async (client, data) => {
      const sentinel = "synthetic-private-source-must-never-escape";
      const first = data.readiness.entries[0]!;
      for (const invalid of [undefined,
        { ...data.readiness, projectId: createStableId("project") },
        { ...data.readiness, profileVersion: "2.0.0" },
        { ...data.readiness, schemaVersion: "1.0.0" },
        { ...data.readiness, entries: [...data.readiness.entries].reverse() },
        { ...data.readiness, evidence: data.readiness.evidence.map(item => ({ ...item, rawSource: sentinel })) },
        { ...data.readiness, assessment: { ...data.readiness.assessment, authority: "execute" } },
        { ...data.readiness, entries: [{ ...first, evidenceIdentityMatches: null }, ...data.readiness.entries.slice(1)] },
        { ...data.readiness, entries: [{ ...first, recorded: { ...first.recorded, recordedReason: sentinel.repeat(5000) } }, ...data.readiness.entries.slice(1)] },
        { ...data.readiness, entries: data.readiness.entries.map(entry => entry.currentState === "revoked" ? { ...entry, currentState: "available" } : entry) },
      ]) {
        data.persistence.getProjectReadiness = async () => invalid as ProjectReadiness | undefined;
        const result = await client.callTool({ name: "get_project_readiness", arguments: { ...data.query } });
        assert.equal(result.isError, true); assert.equal(result.structuredContent, undefined);
        assert.deepEqual(result.content, [{ type: "text", text: unavailable }]);
        assert.equal(JSON.stringify(result).includes(sentinel), false);
      }
      data.persistence.getProjectReadiness = async () => { throw new Error(sentinel); };
      const result = await client.callTool({ name: "get_project_readiness", arguments: { ...data.query } });
      assert.deepEqual(result.content, [{ type: "text", text: unavailable }]);
      assert.equal(result.isError, true); assert.equal(result.structuredContent, undefined);
      assert.equal(data.mutations(), 0);
    });
  });

  it("rejects unauthenticated readiness POSTs before database dispatch", async () => {
    const data = fixture(), server = createControlApiServer({ persistence: data.persistence, bearerToken });
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const port = (server.address() as AddressInfo).port;
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      assert.equal(health.status, 200); assert.deepEqual(await health.json(), { status: "ok", version: "0.5.0" });
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: {
        "Content-Type": "application/json", "X-ACP-Plugin-Version": "0.2.0",
      }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_project_readiness", arguments: data.query } }) });
      assert.equal(response.status, 401); assert.equal(data.reads(), 0); assert.equal(data.mutations(), 0);
      assert.equal((await response.text()).includes(bearerToken), false);
    } finally { if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
