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
  CounterpartMissionStatus,
} from "@acp/storage";

import { createControlApiServer } from "../src/http-server.ts";

const bearerToken = "a-high-entropy-test-token-that-is-long-enough";
const pluginVersion = "0.1.0";

class MemoryCounterpartService implements CounterpartMissionPersistence {
  async getProjectProfileProposal() { return undefined; }
  async getProfileConfirmationRequest() { return undefined; }
  async getProjectReadiness() { return undefined; }
  readonly mission = missionFor();
  readonly evidenceId=createStableId("evidence");
  readonly creations: CounterpartMissionCreate[] = [];
  statusReads=0;
  readonly status:CounterpartMissionStatus={ ...this.mission,statusSchemaVersion:"1.0.0",asOf:"2026-09-06T00:00:00.123456+00:00",
    lifecycle:{ candidate:{ candidateId:createStableId("candidate"),state:"merged",observation:{ recordId:createStableId("event"),observedAt:"2026-09-05T23:00:00.123456+00:00" },
      revision:{ repositoryId:createStableId("repository"),worktreePath:"C:\\status-test",branch:"feature/ExactCase",headSha:"a".repeat(40),evidenceIds:[this.evidenceId] } },
      deployments:[{ environment:"production",state:"failed",artifactVersion:{ status:"unknown" },evidenceIds:[],
        observation:{ recordId:createStableId("event"),observedAt:"2026-09-05T23:00:00.123456+00:00" } }],
      acceptance:null,tracker:null,effects:[{ effectId:createStableId("effect"),state:"unknown_outcome" }],businessCompletion:null },
    completion:{ appliedEvaluationId:null,appliedEvaluation:null,latestEvaluation:null },
    assessment:{ kind:"recorded_only",freshness:"not_assessed",conflicts:"not_assessed" },
    evidence:[{ evidenceId:this.evidenceId,observedAt:"2026-09-05T22:00:00.123456+00:00",freshness:"stale",accessibility:"available" }] };

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
  async getMissionStatus(missionId:StableId<"mission">):Promise<CounterpartMissionStatus|undefined> {
    this.statusReads++; return missionId===this.mission.missionId ? this.status : undefined;
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
      assert.equal(persistence.statusReads,0);
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
      assert.equal(persistence.statusReads,0);
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
      assert.equal(persistence.statusReads,0);
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
      assert.equal(persistence.statusReads,0);
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
        ["create_mission", "get_mission_status", "get_profile_confirmation_request", "get_project_profile_proposal", "get_project_readiness", "list_active_missions"],
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
      assert.equal("lifecycle" in (created.structuredContent as { mission:object }).mission,false);

      const status = await client.callTool({
        name: "get_mission_status",
        arguments: { missionId: persistence.mission.missionId },
      });
      assert.equal(
        (status.structuredContent as { mission?: { state?: string } })
          .mission?.state,
        "executing",
      );
      assert.deepEqual(status.structuredContent,{ mission:persistence.status });
      assert.equal(persistence.statusReads,1);
      const active=await client.callTool({ name:"list_active_missions",arguments:{} });
      const { nodes:_nodes,...summary }=persistence.mission;
      assert.deepEqual(active.structuredContent,{ missions:[summary] });
    } finally {
      await client.close();
      await close(server);
    }
  });
  it("rejects malformed, oversized or wrong-mission status without exposing rejected metadata",async()=>{
    const persistence=new MemoryCounterpartService(),server=createControlApiServer({ persistence,bearerToken }),baseUrl=await listen(server);
    const client=new Client({ name:"acp-status-negative-test",version:"1.0.0" });
    const transport=new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`),{ requestInit:{ headers:{
      Authorization:`Bearer ${bearerToken}`,"X-ACP-Plugin-Version":pluginVersion,
    } } });
    const sentinel="synthetic-restricted-content-must-not-be-returned";
    try {
      await client.connect(transport as unknown as Transport);
      for(const invalid of [
        { ...persistence.status,lifecycle:{ ...persistence.status.lifecycle,candidate:{ ...persistence.status.lifecycle.candidate,rawContent:sentinel } } },
        { ...persistence.status,missionId:createStableId("mission") },
        { ...persistence.status,requestedScope:"ž".repeat(40000) },
      ]) {
        persistence.getMissionStatus=async()=>invalid as CounterpartMissionStatus;
        const result=await client.callTool({ name:"get_mission_status",arguments:{ missionId:persistence.mission.missionId } });
        assert.equal(result.isError,true); assert.equal(result.structuredContent,undefined);
        assert.equal(JSON.stringify(result).includes(sentinel),false);
      }
    } finally { await client.close(); await close(server); }
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
