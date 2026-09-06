import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { attentionTypes, attentionUrgencies, attentionQueueMaximumBytes, parseAttentionQueue, parseAttentionQueueQuery, snapshotJsonData } from "@acp/domain";
import type { AttentionQueuePersistence } from "@acp/storage";

const stableId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\\s\\S])`, "u"));
const text = (maximum: number) => z.string().min(1).max(maximum);
const timestamp = z.string().length(27).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u);
const references = (prefix: string) => z.array(stableId(prefix)).max(50);
const item = z.object({
  itemId: stableId("ati"), projectId: stableId("prj"), missionIds: references("mis"), type: z.enum(attentionTypes), urgency: z.enum(attentionUrgencies),
  title: text(240), explanation: text(4000), whyHumanIsNeeded: text(4000), recommendation: text(4000).optional(),
  alternatives: z.array(text(1000)).max(10).optional(), consequenceOfNoAction: text(4000).optional(), evidenceIds: references("evd"),
  effectPreviewIds: references("eff").optional(), allowedResponses: z.array(text(200)).min(1).max(10), deduplicationKey: text(200),
  quietHoursDisposition: text(1000), expiresAt: timestamp.optional(),
}).strict();
const querySchema = z.object({ projectId: stableId("prj"), missionId: stableId("mis").optional(), afterItemId: stableId("ati").optional(),
  limit: z.number().int().min(1).max(50).default(20) }).strict();
const queueSchema = z.object({
  schemaVersion: z.literal("1.0.0"), projectId: stableId("prj"), missionId: stableId("mis").nullable(), afterItemId: stableId("ati").nullable(),
  limit: z.number().int().min(1).max(50), asOf: timestamp, coverage: z.literal("recorded_items_only"), freshness: z.literal("not_assessed"),
  authority: z.literal("not_granted"), items: z.array(z.object({ item, recordedAt: timestamp,
    expiry: z.enum(["not_expiring", "not_expired", "expired"]) }).strict()).max(50), nextCursor: stableId("ati").nullable(),
}).strict();

/** Existing trusted bearer-client boundary, not a per-user/project authorization grant. */
export function registerAttentionTool(server: McpServer, persistence: AttentionQueuePersistence): void {
  server.registerTool("get_mission_attention", {
    title: "Get recorded ACP attention",
    description: "Read one bounded recorded attention page for an exact project, optionally filtered to one mission. Use the returned canonical cursor in the same scope. Items, allowed responses and quiet-hours descriptions are recorded data, not decisions, executable policy or permission. Expired items remain recorded; an empty queue proves no readiness or absence of unrecorded problems.",
    inputSchema: querySchema,
    outputSchema: z.object({ attention: queueSchema }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async input => {
    try {
      const query = parseAttentionQueueQuery(input), recorded = await persistence.getAttentionQueue(query);
      if (recorded === undefined) throw new Error("recorded attention scope unavailable");
      const attention = parseAttentionQueue(query, recorded), structuredContent = { attention };
      // Include the public envelope in the structured-payload cap; never let the SDK
      // serialize unvalidated persistence objects, getters, hooks or private errors.
      snapshotJsonData(structuredContent, { maximumBytes: attentionQueueMaximumBytes });
      return { structuredContent, content: [{ type: "text" as const,
        text: `Read ${attention.items.length} recorded attention items. These are not decisions or permission; freshness is not assessed.` }] };
    } catch {
      return { isError: true, content: [{ type: "text" as const, text: "ACP recorded attention is unavailable; no partial queue returned." }] };
    }
  });
}
