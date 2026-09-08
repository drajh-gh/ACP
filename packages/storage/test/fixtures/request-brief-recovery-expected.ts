import { type StableId } from "@acp/domain";

/** Independently authored answer key. Source builders do not import this module. */
export const recoveryExpected = Object.freeze({
  projectId: "prj_00000000-0000-4000-8000-000000000033" as StableId<"project">,
  requestId: "req_00000000-0000-4000-8000-000000000033" as StableId<"request">,
  missionIds: ["mis_00000000-0000-4000-8000-000000000033", "mis_00000000-0000-4000-8000-000000000034"] as const,
  originalWording: "Please recover request req_00000000-0000-4000-8000-000000000033 and identify what is still unknown; do not approve or execute anything.",
  observationAt: "2026-09-08T11:00:00.000001Z",
  evidenceGap: "Archived attachment evidence is unavailable; record an explicit evidence gap before any proposal.",
  overflowCursor: "ati_00000000-0000-4000-8000-000000000119",
  unavailable: ["destination_decisions", "obligations", "communications"] as const,
});
