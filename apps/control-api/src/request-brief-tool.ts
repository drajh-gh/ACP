import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  attentionTypes, attentionUrgencies, missionStates, parseRequestBrief,
  parseRequestHistoryQuery, requestBriefMaximumBytes, snapshotJsonData,
} from "@acp/domain";
import { readRequestBrief, type RequestBriefReaders } from "@acp/storage";

const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\\s\\S])`, "u"));
const timestamp = z.string().length(27).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u);
const pin = z.string().min(1).max(512);
const querySchema = z.object({ projectId: id("prj"), requestId: id("req") }).strict();
const attentionQuery = z.object({ projectId: id("prj"), missionId: id("mis"), afterItemId: id("ati").optional(), limit: z.literal(20) }).strict();
const attentionItem = z.object({
  itemId: id("ati"), projectId: id("prj"), missionIds: z.array(id("mis")).max(50),
  type: z.enum(attentionTypes), urgency: z.enum(attentionUrgencies), title: z.string().min(1).max(240),
  explanation: z.string().min(1).max(4000), whyHumanIsNeeded: z.string().min(1).max(4000),
  recommendation: z.string().min(1).max(4000).optional(), alternatives: z.array(z.string().min(1).max(1000)).max(10).optional(),
  consequenceOfNoAction: z.string().min(1).max(4000).optional(), evidenceIds: z.array(id("evd")).max(50),
  effectPreviewIds: z.array(id("eff")).max(50).optional(), allowedResponses: z.array(z.string().min(1).max(200)).min(1).max(10),
  expiresAt: timestamp.optional(), deduplicationKey: z.string().min(1).max(200), quietHoursDisposition: z.string().min(1).max(1000),
}).strict();
const historyReference = z.object({ read: z.literal("get_request_history"), selectors: querySchema, observedAt: timestamp, pin,
  fields: z.tuple([z.literal("request"), z.literal("recordedAt"), z.literal("missionAssociations"), z.literal("coverage"), z.literal("freshness"), z.literal("authority")]) }).strict();
const statusReference = z.object({ read: z.literal("get_mission_status"), selectors: z.object({ missionId: id("mis") }).strict(), observedAt: timestamp, pin,
  fields: z.tuple([z.literal("state"), z.literal("assessment")]) }).strict();
const attentionReference = z.object({ read: z.literal("get_mission_attention"), selectors: attentionQuery, observedAt: timestamp, pin,
  fields: z.tuple([z.literal("items"), z.literal("nextCursor"), z.literal("coverage"), z.literal("freshness"), z.literal("authority")]) }).strict();
const briefSchema = z.object({
  schemaVersion: z.literal("1.0.0"), projectId: id("prj"), requestId: id("req"),
  originalRequest: z.object({ requestId: id("req"), projectId: id("prj"), sourceIntakeId: id("int"), title: z.string().min(1).max(240), summary: z.string().min(1).max(4000) }).strict(),
  recordedAt: timestamp, assembledAt: timestamp,
  missions: z.array(z.object({
    association: z.object({ missionId: id("mis"), reason: z.string().min(1).max(1000), recordedAt: timestamp }).strict(),
    observation: z.object({ state: z.enum(missionStates), observedAt: timestamp, freshness: z.enum(["current", "stale", "unknown"]), sourceReference: statusReference }).strict().nullable(),
    attention: z.union([z.object({ availability: z.literal("unavailable") }).strict(), z.object({ availability: z.literal("observed"), query: attentionQuery,
      asOf: timestamp, coverage: z.literal("recorded_items_only"), freshness: z.literal("not_assessed"), authority: z.literal("not_granted"),
      items: z.array(z.object({ item: attentionItem, recordedAt: timestamp, expiry: z.enum(["not_expiring", "not_expired", "expired"]) }).strict()).max(20),
      nextCursor: id("ati").nullable(), sourceReference: attentionReference }).strict()]),
  }).strict()).max(50),
  evidence: z.array(z.union([historyReference, statusReference, attentionReference])).max(101),
  coverage: z.object({ history: z.literal("recorded_associations_only"), missionStatus: z.literal("selected_observations_only"), attention: z.literal("selected_recorded_pages_only") }).strict(),
  freshness: z.literal("not_assessed"), issues: z.array(z.enum(["missing_mission_status", "missing_attention", "stale_mission_status", "source_changed_during_assembly"])).max(4),
  sourceChanges: z.array(z.object({ source: z.enum(["request_history", "mission_status", "attention"]), missionId: id("mis").nullable(), pinBefore: pin, pinAfter: pin }).strict()).max(101),
  overflow: z.literal("none"), unavailable: z.tuple([z.literal("destination_decisions"), z.literal("obligations"), z.literal("communications")]),
  supportedNextAction: z.literal("unavailable"), authority: z.literal("not_granted"),
}).strict();

const unavailable = "ACP request brief is unavailable; no partial projection returned.";

/** Registers a read-only projection on the existing trusted bearer boundary.
 * That bearer is not a per-user ACL, so every underlying reader must retain its
 * exact project/request and mission scope checks. */
export function registerRequestBriefTool(server: McpServer, readers: RequestBriefReaders): void {
  server.registerTool("get_request_brief", {
    title: "Get bounded ACP request brief",
    description: "Read one exact project/request brief from retained history and selected recorded mission and attention observations. Coverage, unavailable sources, changes and attention continuation cursors remain explicit. This sequential read is not atomic or a live freshness assessment, may stop before another source read when its acquisition budget expires, and grants no write, execution, approval, closure or next-action authority.",
    inputSchema: querySchema, outputSchema: z.object({ brief: briefSchema }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input, extra) => {
    try {
      const query = parseRequestHistoryQuery(input);
      const brief = await readRequestBrief(readers, query, {
        monotonicMilliseconds: () => performance.now(),
      }, extra.signal);
      if (brief === undefined) throw new Error("missing request brief");
      const validated = parseRequestBrief(query, brief);
      const structuredContent = z.object({ brief: briefSchema }).strict().parse({ brief: validated });
      snapshotJsonData(structuredContent, { maximumBytes: requestBriefMaximumBytes });
      return { structuredContent, content: [{ type: "text" as const,
        text: `Read a bounded brief for ${validated.missions.length} recorded mission association${validated.missions.length === 1 ? "" : "s"}. It is a non-authoritative projection; freshness is not assessed, unavailable fields are not empty, and attention nextCursor values identify additional recorded pages.` }] };
    } catch {
      return { isError: true, content: [{ type: "text" as const, text: unavailable }] };
    }
  });
}
