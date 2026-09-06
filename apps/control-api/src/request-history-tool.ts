import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseRequestHistory, parseRequestHistoryQuery, requestHistoryMaximumAssociations, requestHistoryMaximumBytes, snapshotJsonData } from "@acp/domain";
import type { RequestHistoryPersistence } from "@acp/storage";

const stableId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\\s\\S])`, "u"));
const timestamp = z.string().length(27).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u);
const querySchema = z.object({ projectId: stableId("prj"), requestId: stableId("req") }).strict();
const historySchema = z.object({
  schemaVersion: z.literal("1.0.0"), asOf: timestamp, recordedAt: timestamp,
  request: z.object({ requestId: stableId("req"), projectId: stableId("prj"), sourceIntakeId: stableId("int"),
    title: z.string().min(1).max(240), summary: z.string().min(1).max(4000) }).strict(),
  missionAssociations: z.array(z.object({ missionId: stableId("mis"), reason: z.string().min(1).max(1000), recordedAt: timestamp }).strict()).max(requestHistoryMaximumAssociations),
  coverage: z.literal("recorded_associations_only"), freshness: z.literal("not_assessed"), authority: z.literal("not_granted"),
}).strict();

/** Uses the existing trusted bearer-client boundary, not per-user/project ACLs. */
export function registerRequestHistoryTool(server: McpServer, persistence: RequestHistoryPersistence): void {
  server.registerTool("get_request_history", {
    title: "Get recorded ACP request history",
    description: "Read one exact project's retained original request and recorded mission associations. Requires project and request IDs, not a mission ID or name. This historical snapshot does not establish current mission state, approved scope, completion, readiness, complete intake coverage or permission. Missing or oversized history yields no partial result. It cannot create, link, approve, close or execute work.",
    inputSchema: querySchema, outputSchema: z.object({ history: historySchema }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async input => {
    try {
      const query = parseRequestHistoryQuery(input), recorded = await persistence.getRequestHistory(query);
      if (recorded === undefined) throw new Error("recorded request scope unavailable");
      const history = parseRequestHistory(query, recorded), structuredContent = { history };
      snapshotJsonData(structuredContent, { maximumBytes: requestHistoryMaximumBytes });
      return { structuredContent, content: [{ type: "text" as const,
        text: `Read original request history with ${history.missionAssociations.length} recorded mission associations. These are not current status, completed work or permission; freshness is not assessed.` }] };
    } catch {
      return { isError: true, content: [{ type: "text" as const, text: "ACP recorded request history is unavailable; no partial history returned." }] };
    }
  });
}
