import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  createStableId,
  type StableId,
} from "@acp/domain";
import type {
  CounterpartMissionCreate,
  CounterpartMissionCreation,
  CounterpartMissionPersistence,
  CounterpartMissionProjection,
  CounterpartMissionSummary,
} from "@acp/storage";

import { createControlApiServer } from "../src/http-server.ts";

const bearerToken = "a-high-entropy-test-token-that-is-long-enough";
const pluginVersion = "0.1.0";

class MemoryCounterpartService implements CounterpartMissionPersistence {
  readonly mission = missionFor();
  readonly creations: CounterpartMissionCreate[] = [];

  async createMission(
    input: CounterpartMissionCreate,
  ): Promise<CounterpartMissionCreation> {
    this.creations.push(input);
    return { mission: this.mission, replayed: false };
  }

  async getMission(
    missionId: StableId<"mission">,
  ): Promise<CounterpartMissionProjection | undefined> {
    return missionId === this.mission.missionId ? this.mission : undefined;
  }

  async listActiveMissions(
    projectId?: StableId<"project">,
  ): Promise<readonly CounterpartMissionSummary[]> {
    if (projectId !== undefined && projectId !== this.mission.projectId) return [];
    const { nodes: _nodes, ...summary } = this.mission;
    return [summary];
  }
}

describe("authenticated counterpart MCP", () => {
  it("rejects unauthenticated requests without exposing the configured token", async () => {
    const persistence = new MemoryCounterpartService();
    const server = createControlApiServer({ persistence, bearerToken });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/mcp`);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("www-authenticate"), 'Bearer realm="acp-control"');
      assert.doesNotMatch(await response.text(), new RegExp(bearerToken, "u"));
    } finally {
      await close(server);
    }
  });

  it("rejects an unapproved browser Origin before dispatch", async () => {
    const persistence = new MemoryCounterpartService();
    const server = createControlApiServer({ persistence, bearerToken });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/mcp`, {
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          Origin: "https://attacker.example",
          "X-ACP-Plugin-Version": pluginVersion,
        },
      });
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "invalid_origin" });
    } finally {
      await close(server);
    }
  });

  it("rejects incompatible plugin versions", async () => {
    const persistence = new MemoryCounterpartService();
    const server = createControlApiServer({ persistence, bearerToken });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/mcp`, {
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          "X-ACP-Plugin-Version": "9.9.9",
        },
      });
      assert.equal(response.status, 426);
      assert.deepEqual(await response.json(), {
        error: "incompatible_plugin_version",
      });
    } finally {
      await close(server);
    }
  });

  it("does not trust a spoofed forwarded-proto header from an untrusted peer", async () => {
    const persistence = new MemoryCounterpartService();
    const server = createControlApiServer({
      persistence,
      bearerToken,
      requireForwardedHttps: true,
      trustedProxyAddresses: [],
    });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/mcp`, {
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          "X-ACP-Plugin-Version": pluginVersion,
          "X-Forwarded-Proto": "https",
        },
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "https_required" });
    } finally {
      await close(server);
    }
  });

  it("exposes typed mission creation and status tools over streamable HTTP", async () => {
    const persistence = new MemoryCounterpartService();
    const server = createControlApiServer({ persistence, bearerToken });
    const baseUrl = await listen(server);
    const client = new Client({ name: "acp-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp`),
      { requestInit: { headers: {
        Authorization: `Bearer ${bearerToken}`,
        "X-ACP-Plugin-Version": pluginVersion,
      } } },
    );
    try {
      await client.connect(transport as unknown as Transport);
      const tools = await client.listTools();
      assert.deepEqual(
        tools.tools.map((tool) => tool.name).sort(),
        ["create_mission", "get_mission_status", "list_active_missions"],
      );

      const created = await client.callTool({
        name: "create_mission",
        arguments: {
          clientRequestId: "request-1",
          projectId: persistence.mission.projectId,
          objective: "Implement the selected change.",
          requestedScope: "Prepare and verify one candidate.",
        },
      });
      assert.equal(
        (created.structuredContent as { mission?: { missionId?: string } })
          .mission?.missionId,
        persistence.mission.missionId,
      );
      assert.equal(persistence.creations.length, 1);

      const status = await client.callTool({
        name: "get_mission_status",
        arguments: { missionId: persistence.mission.missionId },
      });
      assert.equal(
        (status.structuredContent as { mission?: { state?: string } })
          .mission?.state,
        "executing",
      );
    } finally {
      await client.close();
      await close(server);
    }
  });
});

function missionFor(): CounterpartMissionProjection {
  return {
    missionId: createStableId("mission"),
    projectId: createStableId("project"),
    state: "executing",
    requestedScope: "Prepare and verify one candidate.",
    workflowId: createStableId("workflow"),
    workflowVersion: "1.0.0",
    completionContractId: createStableId("completionContract"),
    completionContractVersion: "1.0.0",
    createdAt: "2026-09-04T12:00:00.000Z",
    updatedAt: "2026-09-04T12:01:00.000Z",
    nodes: [{
      nodeId: createStableId("node"),
      nodeType: "delivery",
      workerRole: "delivery",
      state: "running",
      graphRevision: "1",
    }],
  };
}

async function listen(server: ReturnType<typeof createControlApiServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createControlApiServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}
