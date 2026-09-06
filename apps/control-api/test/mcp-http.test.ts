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
    return { mission: { ...this.mission, requestedScope: input.requestedScope }, replayed: false };
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

      const workflowId=persistence.mission.workflowId;
      for(const workflowKey of ["WF-ENG",null,"wfl_123",workflowId.toUpperCase()," "+workflowId,workflowId+"\n"]){
        const denied=await client.callTool({name:"create_mission",arguments:{clientRequestId:"invalid-selector",projectId:persistence.mission.projectId,
          objective:"A synthetic request.",requestedScope:"Diagnosis only.",workflowKey}});
        assert.equal(denied.isError,true);assert.equal(denied.structuredContent,undefined);
        assert.equal(persistence.creations.length,1,"invalid legacy workflow selector never reaches persistence");
      }
      const selected=await client.callTool({name:"create_mission",arguments:{clientRequestId:"exact-selector",projectId:persistence.mission.projectId,
        objective:"A synthetic request.",requestedScope:"Diagnosis only.",workflowKey:workflowId}});
      assert.notEqual(selected.isError,true);assert.equal(persistence.creations.length,2);assert.equal(persistence.creations[1]?.workflowKey,workflowId);

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
        { ...persistence.status,lifecycle:{ ...persistence.status.lifecycle,deployments:[{
          ...persistence.status.lifecycle.deployments[0],artifactVersion:{ status:"unknown",privateMetadata:sentinel },
        }] } },
      ]) {
        persistence.getMissionStatus=async()=>invalid as CounterpartMissionStatus;
        const result=await client.callTool({ name:"get_mission_status",arguments:{ missionId:persistence.mission.missionId } });
        assert.equal(result.isError,true); assert.equal(result.structuredContent,undefined);
        assert.equal(JSON.stringify(result).includes(sentinel),false);
      }
    } finally { await client.close(); await close(server); }
  });
});

for (const tool of ["create_mission", "get_mission_status", "list_active_missions"] as const) {
  it(`${tool} contains private persistence exceptions in a fixed whole-response error`, async () => {
    const persistence = new MemoryCounterpartService();
    const sentinel = "private-schema.restricted_table / local-credential-path synthetic-only";
    const fail = async (): Promise<never> => { throw new Error(sentinel); };
    persistence.createMission = fail;
    persistence.getMissionStatus = fail;
    persistence.listActiveMissions = fail;
    await withMissionClient(persistence, async (client) => {
      const result = await client.callTool({ name: tool, arguments: argumentsFor(tool, persistence) });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.equal(JSON.stringify(result).includes(sentinel), false);
      assert.deepEqual(result.content, [{ type: "text", text: missionErrors[tool] }]);
    });
  });
}

const missionErrors = {
  create_mission: "ACP mission creation could not be confirmed. Reuse the same request ID only with unchanged terms.",
  get_mission_status: "ACP mission status is unavailable; no partial snapshot returned.",
  list_active_missions: "ACP active missions are unavailable; no partial list returned.",
};

it("mission creation rejects unexpected fields, substitutions and invalid projections as a whole", async () => {
  const persistence = new MemoryCounterpartService(), base = { mission: persistence.mission, replayed: false };
  const sentinel = "synthetic-private-metadata-must-not-escape";
  const node = persistence.mission.nodes[0]!;
  const variants: unknown[] = [
    { ...base, privateMetadata: sentinel },
    { ...base, mission: { ...base.mission, privateMetadata: sentinel } },
    { ...base, mission: { ...base.mission, nodes: [{ ...node, privateMetadata: sentinel }] } },
    { ...base, mission: { ...base.mission, projectId: createStableId("project") } },
    { ...base, mission: { ...base.mission, requestedScope: "Different requested scope." } },
    { ...base, mission: { ...base.mission, workflowId: createStableId("workflow") } },
    { ...base, mission: { ...base.mission, missionId: "mis_123" } },
    { ...base, mission: { ...base.mission, state: "made_up" } },
    { ...base, mission: { ...base.mission, createdAt: "2026-02-30T00:00:00Z" } },
    { ...base, mission: { ...base.mission, workflowVersion: "latest" } },
    { ...base, mission: { ...base.mission, nodes: [node, node] } },
    { ...base, mission: { ...base.mission, nodes: Array.from({ length: 201 }, () => ({ ...node, nodeId: createStableId("node") })) } },
    { ...base, mission: { ...base.mission, nodes: Array.from({ length: 20 }, () => ({ ...node, nodeId: createStableId("node"), nodeType: "😀".repeat(2000) })) } },
  ];
  await withMissionClient(persistence, async (client) => {
    for (const [index, value] of variants.entries()) {
      persistence.createMission = async () => value as CounterpartMissionCreation;
      const result = await client.callTool({ name: "create_mission", arguments: {
        ...argumentsFor("create_mission", persistence), workflowKey: base.mission.workflowId,
      } });
      assert.equal(result.isError, true, `variant ${index}`);
      assert.equal(result.structuredContent, undefined, `variant ${index}`);
      assert.deepEqual(result.content, [{ type: "text", text: missionErrors.create_mission }], `variant ${index}`);
    }
  });
});

it("active mission lists reject extra fields, wrong projects, duplicates, terminal states and query overruns", async () => {
  const persistence = new MemoryCounterpartService();
  const { nodes: _nodes, ...summary } = persistence.mission;
  const variants: unknown[] = [
    [{ ...summary, privateMetadata: "synthetic-private-list-content" }],
    [{ ...summary, projectId: createStableId("project") }],
    [summary, summary],
    [{ ...summary, state: "cancelled" }],
    [summary, { ...summary, missionId: createStableId("mission") }],
  ];
  await withMissionClient(persistence, async (client) => {
    for (const [index, value] of variants.entries()) {
      persistence.listActiveMissions = async () => value as CounterpartMissionSummary[];
      const result = await client.callTool({ name: "list_active_missions", arguments: { projectId: summary.projectId, limit: index === 2 ? 2 : 1 } });
      assert.equal(result.isError, true, `variant ${index}`);
      assert.equal(result.structuredContent, undefined);
      assert.deepEqual(result.content, [{ type: "text", text: missionErrors.list_active_missions }]);
    }
  });
});

function argumentsFor(tool: keyof typeof missionErrors, persistence: MemoryCounterpartService) {
  if (tool === "create_mission") return { clientRequestId: "bounded-result-test", projectId: persistence.mission.projectId,
    objective: "Synthetic mission.", requestedScope: persistence.mission.requestedScope };
  if (tool === "get_mission_status") return { missionId: persistence.mission.missionId };
  return { projectId: persistence.mission.projectId };
}

async function withMissionClient(persistence: MemoryCounterpartService, action: (client: Client) => Promise<void>) {
  const server = createControlApiServer({ persistence, bearerToken }), baseUrl = await listen(server);
  const client = new Client({ name: "acp-mission-boundary-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: {
    Authorization: `Bearer ${bearerToken}`, "X-ACP-Plugin-Version": pluginVersion,
  } } });
  try { await client.connect(transport as unknown as Transport); await action(client); }
  finally { try { await client.close(); } finally { await close(server); } }
}

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
