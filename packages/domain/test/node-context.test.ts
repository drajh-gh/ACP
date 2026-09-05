import assert from "node:assert/strict";
import { it } from "node:test";
import { createStableId, parseNodeContextContent } from "../src/index.ts";

const content = {
  objective: "Inspect the nominated candidate.", nonGoals: ["No publication."],
  behavioralContract: { mode: "read" }, acceptanceCriteria: ["Return evidence."],
  conflicts: [], unresolvedQuestions: [], nextAction: "Inspect the worktree.",
  limits: { wallTimeMs: 1000, maximumTurns: 1, maximumOutputBytes: 4096 },
  evidenceIds: [], activeClaimIds: [], previousRunIds: [], approvalIds: [],
};

it("parses bounded node intent without caller-injected packet facts", () => {
  assert.deepEqual(parseNodeContextContent(content), content);
  for (const extra of ["lifecycle", "sourceAuthorityRules", "projectProfile", "completionScope"]) {
    assert.throws(() => parseNodeContextContent({ ...content, [extra]: {} }));
  }
});

it("rejects invalid limits and duplicate or excessive references", () => {
  const evidenceId = createStableId("evidence");
  assert.throws(() => parseNodeContextContent({ ...content, evidenceIds: [evidenceId, evidenceId] }));
  assert.throws(() => parseNodeContextContent({ ...content, evidenceIds: [createStableId("claim")] }));
  assert.throws(() => parseNodeContextContent({ ...content,
    evidenceIds: Array.from({ length: 101 }, () => createStableId("evidence")) }));
  assert.throws(() => parseNodeContextContent({ ...content,
    limits: { ...content.limits, wallTimeMs: 0 } }));
  assert.throws(() => parseNodeContextContent({ ...content,
    objective: "ž".repeat(140000) }));
});
