import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  parseStableId,acceptanceStates,businessCompletionStates,candidateStates,deploymentStates,effectStates,trackerSemanticCategories,
  type StableId,
} from "@acp/domain";
import { parseCounterpartMissionStatus } from "@acp/storage";
import type {
  CounterpartMissionPersistence,
  CounterpartMissionProjection,
  CounterpartMissionSummary,
} from "@acp/storage";
import { z } from "zod";
import { registerReadinessTool } from "./readiness-tool.ts";
import { registerProfileProposalTools } from "./profile-proposal-tool.ts";
import { controlApiVersion } from "./config.ts";

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

const observationSchema=z.object({ recordId:z.string(),observedAt:z.string() });
const evidenceIdsSchema=z.array(stableId("evd")).max(200);
const evaluationSchema=z.object({
  evaluationId:stableId("cev"),missionId:stableId("mis"),contract:z.object({ id:stableId("cct"),version:z.string() }),
  status:z.enum(["passed","failed"]),evaluatedAt:z.string(),reasons:z.array(z.string()).max(200),disqualifiers:z.array(z.string()).max(200),
  requiredReceiptsVerified:z.boolean(),evidenceFreshnessVerified:z.boolean(),lifecycleDigest:z.string(),provenanceId:stableId("prv"),
});
const missionStatusSchema=missionProjectionSchema.extend({
  nodes:missionProjectionSchema.shape.nodes.max(200),statusSchemaVersion:z.literal("1.0.0"),asOf:z.string(),
  lifecycle:z.object({
    candidate:z.object({ candidateId:stableId("can"),state:z.enum(candidateStates),observation:observationSchema,
      revision:z.object({ repositoryId:stableId("repo"),worktreePath:z.string(),branch:z.string(),headSha:z.string(),evidenceIds:evidenceIdsSchema }) }).nullable(),
    deployments:z.array(z.object({ environment:z.string(),state:z.enum(deploymentStates),observation:observationSchema,evidenceIds:evidenceIdsSchema,
      artifactVersion:z.union([z.object({ status:z.literal("unknown") }),z.object({ status:z.literal("known"),digest:z.string() })]) })).max(50),
    acceptance:z.object({ state:z.enum(acceptanceStates),candidateRevision:z.string().optional(),evidenceIds:evidenceIdsSchema,observation:observationSchema,
      waiver:z.object({ authority:z.string(),reason:z.string(),candidateRevision:z.string(),scope:z.string(),waivedAt:z.string(),expiresAt:z.string().optional(),tolerance:z.string().optional() }).optional() }).nullable(),
    tracker:z.object({ adapterId:z.string(),externalId:z.string(),nativeState:z.string(),semanticCategory:z.enum(trackerSemanticCategories).optional(),
      sourceVersion:z.string(),observation:observationSchema }).nullable(),
    effects:z.array(z.object({ effectId:stableId("eff"),state:z.enum(effectStates) })).max(200),
    businessCompletion:z.object({ state:z.enum(businessCompletionStates),evidenceIds:evidenceIdsSchema,observation:observationSchema }).nullable(),
  }),
  completion:z.object({ appliedEvaluationId:stableId("cev").nullable(),appliedEvaluation:evaluationSchema.nullable(),latestEvaluation:evaluationSchema.nullable() }),
  assessment:z.object({ kind:z.literal("recorded_only"),freshness:z.literal("not_assessed"),conflicts:z.literal("not_assessed") }),
  evidence:z.array(z.object({ evidenceId:stableId("evd"),observedAt:z.string(),freshness:z.enum(["current","stale","unknown"]),
    accessibility:z.enum(["available","inaccessible","missing","malformed","unknown"]) })).max(200),
});

export function createCounterpartMcpServer(
  persistence: CounterpartMissionPersistence,
): McpServer {
  const server = new McpServer(
    { name: "acp-control", version: controlApiVersion },
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
        "Read one bounded durable snapshot of an exact ACP mission, nodes, independent recorded lifecycle dimensions and historical completion evaluations. Null means unobserved; this read does not assess freshness, resolve conflicts or grant authority.",
      inputSchema: { missionId: stableId("mis") },
      outputSchema: { mission: missionStatusSchema },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ missionId }) => {
      const parsed = parseStableId(missionId, "mission");
      const recorded = await persistence.getMissionStatus(parsed);
      if (recorded === undefined) throw new Error("ACP mission does not exist");
      const mission=parseCounterpartMissionStatus(recorded);
      if(mission.missionId!==parsed) throw new Error("ACP mission status identity mismatch");
      return missionResult({ mission }, `ACP mission ${mission.missionId} is ${mission.state}. Lifecycle and evaluations are recorded observations, not new execution authority.`);
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

  registerReadinessTool(server, persistence);
  registerProfileProposalTools(server, persistence);
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
