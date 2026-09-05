import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  parseStableId,
  type StableId,
} from "@acp/domain";
import type {
  CounterpartMissionPersistence,
  CounterpartMissionProjection,
  CounterpartMissionSummary,
} from "@acp/storage";
import { z } from "zod";

const stableId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9a-f-]+$`, "u"));

const missionSummarySchema = z.object({
  missionId: stableId("mis"),
  projectId: stableId("prj"),
  state: z.string(),
  requestedScope: z.string(),
  workflowId: stableId("wfl"),
  workflowVersion: z.string(),
  completionContractId: stableId("cct"),
  completionContractVersion: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const missionProjectionSchema = missionSummarySchema.extend({
  nodes: z.array(z.object({
    nodeId: stableId("nod"),
    nodeType: z.string(),
    workerRole: z.string(),
    state: z.string(),
    graphRevision: z.string(),
  })),
});

export function createCounterpartMcpServer(
  persistence: CounterpartMissionPersistence,
): McpServer {
  const server = new McpServer(
    { name: "acp-control", version: "0.1.0" },
    {
      instructions:
        "Create ACP missions only from an explicit user objective and completion scope. Treat returned IDs as authoritative. Inspect mission status before describing progress; never infer deployment, acceptance, tracker, effect, or business completion from mission state.",
    },
  );

  server.registerTool(
    "create_mission",
    {
      title: "Create ACP mission",
      description:
        "Create one durable ACP mission from an explicit user objective and requested completion scope. Reusing clientRequestId is idempotent only when every term is unchanged.",
      inputSchema: {
        clientRequestId: z.string().trim().min(1).max(200),
        projectId: stableId("prj"),
        objective: z.string().trim().min(1).max(4_000),
        requestedScope: z.string().trim().min(1).max(4_000),
        workflowKey: z.string().trim().min(1).max(200).optional(),
      },
      outputSchema: {
        mission: missionProjectionSchema,
        replayed: z.boolean(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const created = await persistence.createMission({
        clientRequestId: input.clientRequestId,
        projectId: parseStableId(input.projectId, "project"),
        objective: input.objective,
        requestedScope: input.requestedScope,
        ...(input.workflowKey === undefined
          ? {}
          : { workflowKey: input.workflowKey }),
      });
      return missionResult(
        created,
        created.replayed ? "Found the existing ACP mission." : "Created the ACP mission.",
      );
    },
  );

  server.registerTool(
    "get_mission_status",
    {
      title: "Get ACP mission status",
      description:
        "Read the current durable mission and node projection for an exact ACP mission ID.",
      inputSchema: { missionId: stableId("mis") },
      outputSchema: { mission: missionProjectionSchema },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ missionId }) => {
      const parsed = parseStableId(missionId, "mission");
      const mission = await persistence.getMission(parsed);
      if (mission === undefined) throw new Error("ACP mission does not exist");
      return missionResult({ mission }, `ACP mission ${mission.missionId} is ${mission.state}.`);
    },
  );

  server.registerTool(
    "list_active_missions",
    {
      title: "List active ACP missions",
      description:
        "List a bounded set of nonterminal ACP mission projections, optionally for one exact project.",
      inputSchema: {
        projectId: stableId("prj").optional(),
        limit: z.number().int().min(1).max(200).default(50),
      },
      outputSchema: { missions: z.array(missionSummarySchema) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ projectId, limit }) => {
      const missions = await persistence.listActiveMissions(
        projectId === undefined
          ? undefined
          : parseStableId(projectId, "project"),
        limit,
      );
      return missionResult(
        { missions },
        `Found ${missions.length} active ACP mission${missions.length === 1 ? "" : "s"}.`,
      );
    },
  );

  return server;
}

type MissionStructuredResult =
  | { readonly mission: CounterpartMissionProjection; readonly replayed?: boolean }
  | { readonly missions: readonly CounterpartMissionSummary[] };

function missionResult(structuredContent: MissionStructuredResult, text: string) {
  return {
    structuredContent,
    content: [{ type: "text" as const, text }],
  };
}
