import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  parseStableId,acceptanceStates,businessCompletionStates,candidateStates,deploymentStates,effectStates,trackerSemanticCategories,
  missionStates, workerRoles,
} from "@acp/domain";
import { counterpartMissionNodeStates, parseCounterpartMissionStatus, parseCounterpartMissionCreation,
  parseCounterpartActiveMissions, snapshotCounterpartMissionData } from "@acp/storage";
import type { CounterpartMissionPersistence } from "@acp/storage";
import { z } from "zod";
import { registerReadinessTool } from "./readiness-tool.ts";
import { registerProfileProposalTools } from "./profile-proposal-tool.ts";
import { registerAttentionTool } from "./attention-tool.ts";
import { registerRequestHistoryTool } from "./request-history-tool.ts";
import { controlApiVersion } from "./config.ts";

const stableId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\\s\\S])`, "u"));

const missionSummarySchema = z.object({
  missionId: stableId("mis"),
  projectId: stableId("prj"),
  state: z.enum(missionStates),
  requestedScope: z.string().min(1).max(4096),
  workflowId: stableId("wfl"),
  workflowVersion: z.string().min(1).max(4096),
  completionContractId: stableId("cct"),
  completionContractVersion: z.string().min(1).max(4096),
  createdAt: z.string().max(128),
  updatedAt: z.string().max(128),
}).strict();

const missionProjectionSchema = missionSummarySchema.extend({
  nodes: z.array(z.object({
    nodeId: stableId("nod"),
    nodeType: z.string().min(1).max(4096),
    workerRole: z.enum(workerRoles),
    state: z.enum(counterpartMissionNodeStates),
    graphRevision: z.string().min(1).max(4096),
  }).strict()).max(200),
}).strict();

const observationSchema=z.object({ recordId:z.string(),observedAt:z.string() }).strict();
const evidenceIdsSchema=z.array(stableId("evd")).max(200);
const evaluationSchema=z.object({
  evaluationId:stableId("cev"),missionId:stableId("mis"),contract:z.object({ id:stableId("cct"),version:z.string() }).strict(),
  status:z.enum(["passed","failed"]),evaluatedAt:z.string(),reasons:z.array(z.string()).max(200),disqualifiers:z.array(z.string()).max(200),
  requiredReceiptsVerified:z.boolean(),evidenceFreshnessVerified:z.boolean(),lifecycleDigest:z.string(),provenanceId:stableId("prv"),
}).strict();
const missionStatusSchema=missionProjectionSchema.extend({
  nodes:missionProjectionSchema.shape.nodes.max(200),statusSchemaVersion:z.literal("1.0.0"),asOf:z.string(),
  lifecycle:z.object({
    candidate:z.object({ candidateId:stableId("can"),state:z.enum(candidateStates),observation:observationSchema,
      revision:z.object({ repositoryId:stableId("repo"),worktreePath:z.string(),branch:z.string(),headSha:z.string(),evidenceIds:evidenceIdsSchema }).strict() }).strict().nullable(),
    deployments:z.array(z.object({ environment:z.string(),state:z.enum(deploymentStates),observation:observationSchema,evidenceIds:evidenceIdsSchema,
      artifactVersion:z.union([z.object({ status:z.literal("unknown") }).strict(),z.object({ status:z.literal("known"),digest:z.string() }).strict()]) }).strict()).max(50),
    acceptance:z.object({ state:z.enum(acceptanceStates),candidateRevision:z.string().optional(),evidenceIds:evidenceIdsSchema,observation:observationSchema,
      waiver:z.object({ authority:z.string(),reason:z.string(),candidateRevision:z.string(),scope:z.string(),waivedAt:z.string(),expiresAt:z.string().optional(),tolerance:z.string().optional() }).strict().optional() }).strict().nullable(),
    tracker:z.object({ adapterId:z.string(),externalId:z.string(),nativeState:z.string(),semanticCategory:z.enum(trackerSemanticCategories).optional(),
      sourceVersion:z.string(),observation:observationSchema }).strict().nullable(),
    effects:z.array(z.object({ effectId:stableId("eff"),state:z.enum(effectStates) }).strict()).max(200),
    businessCompletion:z.object({ state:z.enum(businessCompletionStates),evidenceIds:evidenceIdsSchema,observation:observationSchema }).strict().nullable(),
  }).strict(),
  completion:z.object({ appliedEvaluationId:stableId("cev").nullable(),appliedEvaluation:evaluationSchema.nullable(),latestEvaluation:evaluationSchema.nullable() }).strict(),
  assessment:z.object({ kind:z.literal("recorded_only"),freshness:z.literal("not_assessed"),conflicts:z.literal("not_assessed") }).strict(),
  evidence:z.array(z.object({ evidenceId:stableId("evd"),observedAt:z.string(),freshness:z.enum(["current","stale","unknown"]),
    accessibility:z.enum(["available","inaccessible","missing","malformed","unknown"]) }).strict()).max(200),
}).strict();
const creationResultSchema = z.object({ mission: missionProjectionSchema, replayed: z.boolean() }).strict();
const statusResultSchema = z.object({ mission: missionStatusSchema }).strict();
const listResultSchema = z.object({ missions: z.array(missionSummarySchema).max(200) }).strict();

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
      inputSchema: z.object({
        clientRequestId: z.string().trim().min(1).max(200),
        projectId: stableId("prj"),
        objective: z.string().trim().min(1).max(4_000),
        requestedScope: z.string().trim().min(1).max(4_000),
        workflowKey: stableId("wfl").describe("Legacy-named exact workflow definition ID (wfl_…), not a name alias. The authoritative binding pins its version.").optional(),
      }).strict(),
      outputSchema: creationResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const projectId = parseStableId(input.projectId, "project");
        const workflowId = input.workflowKey === undefined ? undefined : parseStableId(input.workflowKey, "workflow");
        const recorded = await persistence.createMission({
          clientRequestId: input.clientRequestId,
          projectId,
          objective: input.objective,
          requestedScope: input.requestedScope,
          ...(workflowId === undefined ? {} : { workflowKey: workflowId }),
        });
        const created = creationResultSchema.parse(parseCounterpartMissionCreation(recorded));
        if (created.mission.projectId !== projectId || created.mission.requestedScope !== input.requestedScope
          || (workflowId !== undefined && created.mission.workflowId !== workflowId)) throw new Error("mission creation identity mismatch");
        return missionResult(
          created,
          created.replayed ? "Found the existing ACP mission." : "Created the ACP mission.",
        );
      } catch {
        // A database COMMIT may already have happened. Neither success nor absence is established here.
        return missionError("ACP mission creation could not be confirmed. Reuse the same request ID only with unchanged terms.");
      }
    },
  );

  server.registerTool(
    "get_mission_status",
    {
      title: "Get ACP mission status",
      description:
        "Read one bounded durable snapshot of an exact ACP mission, nodes, independent recorded lifecycle dimensions and historical completion evaluations. Null means unobserved; this read does not assess freshness, resolve conflicts or grant authority.",
      inputSchema: z.object({ missionId: stableId("mis") }).strict(),
      outputSchema: statusResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ missionId }) => {
      try {
        const parsed = parseStableId(missionId, "mission");
        const recorded = await persistence.getMissionStatus(parsed);
        if (recorded === undefined) throw new Error("ACP mission does not exist");
        const detached = statusResultSchema.parse(snapshotCounterpartMissionData({ mission: recorded }));
        const mission=parseCounterpartMissionStatus(detached.mission);
        if(mission.missionId!==parsed) throw new Error("ACP mission status identity mismatch");
        return missionResult(statusResultSchema.parse({ mission }), `ACP mission ${mission.missionId} is ${mission.state}. Lifecycle and evaluations are recorded observations, not new execution authority.`);
      } catch { return missionError("ACP mission status is unavailable; no partial snapshot returned."); }
    },
  );

  server.registerTool(
    "list_active_missions",
    {
      title: "List active ACP missions",
      description:
        "List a bounded set of nonterminal ACP mission projections, optionally for one exact project.",
      inputSchema: z.object({
        projectId: stableId("prj").optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }).strict(),
      outputSchema: listResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ projectId, limit }) => {
      try {
        const parsedProject = projectId === undefined ? undefined : parseStableId(projectId, "project");
        const recorded = await persistence.listActiveMissions(parsedProject, limit);
        const missions = parseCounterpartActiveMissions(recorded, parsedProject, limit);
        return missionResult(
          listResultSchema.parse({ missions }),
          `Found ${missions.length} active ACP mission${missions.length === 1 ? "" : "s"}.`,
        );
      } catch { return missionError("ACP active missions are unavailable; no partial list returned."); }
    },
  );

  registerReadinessTool(server, persistence);
  registerProfileProposalTools(server, persistence);
  registerAttentionTool(server, persistence);
  registerRequestHistoryTool(server, persistence);
  return server;
}

function missionResult(structuredContent: Record<string, unknown>, text: string) {
  return {
    structuredContent,
    content: [{ type: "text" as const, text }],
  };
}

function missionError(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
