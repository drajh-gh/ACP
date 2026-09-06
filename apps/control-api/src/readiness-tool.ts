import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  capabilityReadinessStates, evidenceAccessibilityStates, evidenceFreshnessStates,
  parseProjectReadiness, parseProjectReadinessQuery, projectReadinessSchemaVersion,
  readinessCurrentReasonCodes, readinessEvidenceLimit, readinessKeyLimit,
} from "@acp/domain";
import type { ProjectReadinessPersistence } from "@acp/storage";

const stableId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, "u"));
const text = (maximum: number) => z.string().min(1).max(maximum);
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u);
const scope = { projectId: stableId("prj"), profileId: stableId("pro"), profileVersion: text(100) };
const key = { capability: text(200), resourceKey: text(512), resourceVersion: text(200) };
const keySchema = z.object(key).strict();
const querySchema = z.object({ ...scope, keys: z.array(keySchema).min(1).max(readinessKeyLimit) }).strict();
const recordedSchema = z.object({
  ...scope, ...key, assessmentId: stableId("cra"), recordedState: z.enum(capabilityReadinessStates), recordedReason: text(2000),
  assessedAt: timestamp, validUntil: timestamp, evidenceIds: z.array(stableId("evd")).max(readinessEvidenceLimit),
  evaluatorVersion: text(200), provenanceId: stableId("prv"), supersedesAssessmentId: stableId("cra").nullable(),
}).strict();
const readinessSchema = z.object({
  ...scope, schemaVersion: z.literal(projectReadinessSchemaVersion), asOf: timestamp,
  assessment: z.object({ kind: z.literal("recorded_only"), freshness: z.literal("recorded_deadline_and_evidence_metadata"),
    authority: z.literal("none"), liveProbes: z.literal("not_performed") }).strict(),
  entries: z.array(z.object({ ...key, recorded: recordedSchema.nullable(), evidenceIdentityMatches: z.boolean().nullable(),
    currentState: z.enum(capabilityReadinessStates), currentReasonCode: z.enum(readinessCurrentReasonCodes),
  }).strict()).min(1).max(readinessKeyLimit),
  evidence: z.array(z.object({ evidenceId: stableId("evd"), observedAt: timestamp, retrievedAt: timestamp,
    contentHashPresent: z.boolean(), freshness: z.enum(evidenceFreshnessStates), accessibility: z.enum(evidenceAccessibilityStates),
  }).strict()).max(readinessKeyLimit * readinessEvidenceLimit),
}).strict();

/** Uses the control API's existing trusted bearer-client boundary, not a per-project ACL. */
export function registerReadinessTool(server: McpServer, persistence: ProjectReadinessPersistence): void {
  server.registerTool("get_project_readiness", {
    title: "Get recorded ACP project readiness",
    description: "Read a bounded recorded-only matrix for one exact registered project profile/version and 1–50 explicit capability/resource/version keys. Each state is independent; unknown is not unconfigured. This does not probe providers, assert the profile is currently active, or grant permission to act.",
    inputSchema: querySchema,
    outputSchema: z.object({ readiness: readinessSchema }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async input => {
    try {
      // Do not trim or alias identity-bearing keys. Recompute all derived response states.
      const query = parseProjectReadinessQuery(input);
      const recorded = await persistence.getProjectReadiness(query);
      if (recorded === undefined) throw new Error("no recorded profile");
      const readiness = parseProjectReadiness(recorded, query);
      return { structuredContent: { readiness }, content: [{ type: "text" as const,
        text: `Read ${readiness.entries.length} independent recorded readiness entries. These are not grants or live probes.` }] };
    } catch {
      // Neither persistence exceptions nor rejected private metadata reach the SDK's error formatter.
      return { isError: true, content: [{ type: "text" as const, text: "ACP readiness is unavailable; no partial snapshot returned." }] };
    }
  });
}
