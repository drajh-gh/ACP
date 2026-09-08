import { type StableId } from "@acp/domain";

/** Independently authored answer key. Source builders do not import this module. */
export const recoveryExpected = Object.freeze({
  projectId: "prj_00000000-0000-4000-8000-000000000033" as StableId<"project">,
  requestId: "req_00000000-0000-4000-8000-000000000033" as StableId<"request">,
  missionIds: ["mis_00000000-0000-4000-8000-000000000033", "mis_00000000-0000-4000-8000-000000000034"] as const,
  originalWording: "Please recover request req_00000000-0000-4000-8000-000000000033 and identify what is still unknown; do not approve or execute anything.",
  observationAt: "2026-09-08T11:00:00.000001Z",
  firstMissionState: "executing",
  historyPin: "sha256:c64ef293e2af868a0e8ff6dd84d85cbf85cfd56ce357ae72a0043ac40862a644",
  firstMissionPinBefore: "sha256:f435b84eef61dd60887329d22f309a23d61ca6d99c81430f234df9e3f982ff5b",
  firstMissionPinAfter: "sha256:0f8bdebffc29ea8a3c120ad8348dc195d4050be5839e0aff22ab73a463e2c27d",
  firstAttentionPin: "sha256:4dc9ddae2d440e4146e4b6adbe5e320b9037ad54cc09517363225e563f89380b",
  evidenceGap: "Archived attachment evidence is unavailable; record an explicit evidence gap before any proposal.",
  overflowCursor: "ati_00000000-0000-4000-8000-000000000119",
  unavailable: ["destination_decisions", "obligations", "communications"] as const,
});
