import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createStableId } from "../src/ids.ts";
import {
  applyCompletionEvaluation,
  evaluateCompletionContract,
  parseLifecycleVector,
  recordCandidateState,
  transitionMissionState,
} from "../src/lifecycle.ts";

const revision = {
  repositoryId: createStableId("repository"),
  worktreePath: "/worktrees/mission-1",
  branch: "codex/m0-domain",
  headSha: "a".repeat(40),
  evidenceIds: [createStableId("evidence")],
} as const;

function lifecycleVector() {
  return {
    mission: { state: "verifying" as const },
    candidate: { state: "locally_verified" as const, revision },
    deployments: [
      {
        environment: "production",
        artifactDigest: "sha256:" + "b".repeat(64),
        state: "not_deployed" as const,
      },
    ],
    acceptance: {
      state: "passed" as const,
      candidateRevision: revision.headSha,
      evidenceIds: [createStableId("evidence")],
    },
    tracker: {
      adapterId: "synthetic-tracker",
      externalId: "ACP-1",
      nativeState: "On Dev",
      semanticCategory: "on_development" as const,
    },
    effects: [
      {
        effectId: createStableId("effect"),
        state: "verified" as const,
      },
    ],
    businessCompletion: { state: "pending" as const },
  };
}

describe("orthogonal lifecycle state", () => {
  it("records scoped mission completion without changing sibling facts", () => {
    const before = lifecycleVector();
    const after = applyCompletionEvaluation(before, {
      evaluationId: createStableId("completionEvaluation"),
      missionId: createStableId("mission"),
      contract: {
        id: createStableId("completionContract"),
        version: "1.0.0",
      },
      status: "passed",
      evaluatedAt: "2026-09-04T12:00:00.000Z",
      reasons: ["All requirements for the requested scope passed."],
      disqualifiers: [],
      requiredReceiptsVerified: true,
      evidenceFreshnessVerified: true,
      lifecycleDigest: "sha256:lifecycle",
      provenanceId: createStableId("provenance"),
    });

    assert.equal(after.mission.state, "complete_for_scope");
    assert.equal(after.mission.completionContract.version, "1.0.0");
    assert.strictEqual(after.candidate, before.candidate);
    assert.strictEqual(after.deployments, before.deployments);
    assert.strictEqual(after.acceptance, before.acceptance);
    assert.strictEqual(after.tracker, before.tracker);
    assert.strictEqual(after.effects, before.effects);
    assert.strictEqual(after.businessCompletion, before.businessCompletion);
    assert.equal(after.deployments[0]?.state, "not_deployed");
    assert.equal(after.tracker?.nativeState, "On Dev");
    assert.equal(after.businessCompletion.state, "pending");
  });

  it("refuses failed evaluations and unresolved effect outcomes", () => {
    const failedEvaluation = {
      evaluationId: createStableId("completionEvaluation"),
      missionId: createStableId("mission"),
      contract: {
        id: createStableId("completionContract"),
        version: "1.0.0",
      },
      status: "failed" as const,
      evaluatedAt: "2026-09-04T12:00:00.000Z",
      reasons: ["A required receipt is missing."],
      disqualifiers: ["missing_receipt"],
      requiredReceiptsVerified: false,
      evidenceFreshnessVerified: true,
      lifecycleDigest: "sha256:lifecycle",
      provenanceId: createStableId("provenance"),
    };

    assert.throws(
      () => applyCompletionEvaluation(lifecycleVector(), failedEvaluation),
      /did not pass/,
    );

    const withUnknownOutcome = {
      ...lifecycleVector(),
      effects: [
        {
          effectId: createStableId("effect"),
          state: "unknown_outcome" as const,
        },
      ],
    };

    assert.throws(
      () =>
        applyCompletionEvaluation(withUnknownOutcome, {
          ...failedEvaluation,
          status: "passed",
          disqualifiers: [],
          requiredReceiptsVerified: true,
        }),
      /unknown effect outcome/,
    );
  });

  it("changes candidate state without advancing mission or tracker state", () => {
    const before = lifecycleVector();
    const after = recordCandidateState(before, {
      state: "merged",
      revision: {
        ...revision,
        headSha: "c".repeat(40),
        evidenceIds: [createStableId("evidence")],
      },
    });

    assert.equal(after.candidate?.state, "merged");
    assert.equal(after.mission.state, "verifying");
    assert.strictEqual(after.tracker, before.tracker);
    assert.equal(after.tracker?.nativeState, "On Dev");
  });

  it("requires a fully auditable acceptance waiver", () => {
    const candidateRevision = "d".repeat(40);
    assert.throws(
      () =>
        parseLifecycleVector({
          mission: { state: "verifying" },
          deployments: [],
          acceptance: {
            state: "waived",
            candidateRevision,
            evidenceIds: [createStableId("evidence")],
            waiver: {},
          },
          effects: [],
          businessCompletion: { state: "pending" },
        }),
      /waivedAt/,
    );

    const parsed = parseLifecycleVector({
      mission: { state: "verifying" },
      deployments: [],
      acceptance: {
        state: "waived",
        candidateRevision,
        evidenceIds: [createStableId("evidence")],
        waiver: {
          authority: "operator:david",
          reason: "No configured acceptance environment.",
          candidateRevision,
          scope: "Synthetic issue workflow only.",
          waivedAt: "2026-09-04T12:00:00Z",
          expiresAt: "2026-09-05T12:00:00Z",
        },
      },
      effects: [],
      businessCompletion: { state: "pending" },
    });
    assert.equal(parsed.acceptance.state, "waived");
  });

  it("derives completion status from the pinned contract and current facts", () => {
    const before = lifecycleVector();
    const evaluation = evaluateCompletionContract(
      {
        contract: {
          id: createStableId("completionContract"),
          version: "1.0.0",
        },
        allowedCandidateStates: ["locally_verified"],
        allowedAcceptanceStates: ["passed"],
        requireAllEffectsVerified: true,
      },
      before,
      {
        evaluationId: createStableId("completionEvaluation"),
        missionId: createStableId("mission"),
        evaluatedAt: "2026-09-04T12:00:00Z",
        requiredReceiptsVerified: true,
        evidenceFreshnessVerified: true,
        conflicts: [],
        unresolvedFindings: [],
        lifecycleDigest: "sha256:lifecycle",
        provenanceId: createStableId("provenance"),
      },
    );
    assert.equal(evaluation.status, "passed");

    const staleAcceptance = evaluateCompletionContract(
      {
        contract: evaluation.contract,
        allowedAcceptanceStates: ["passed"],
        requireAllEffectsVerified: false,
      },
      {
        ...before,
        acceptance: {
          ...before.acceptance,
          candidateRevision: "f".repeat(40),
        },
      },
      {
        evaluationId: createStableId("completionEvaluation"),
        missionId: evaluation.missionId,
        evaluatedAt: "2026-09-04T12:00:00Z",
        requiredReceiptsVerified: true,
        evidenceFreshnessVerified: true,
        conflicts: [],
        unresolvedFindings: [],
        lifecycleDigest: "sha256:stale-acceptance",
        provenanceId: createStableId("provenance"),
      },
    );
    assert.ok(
      staleAcceptance.disqualifiers.includes("acceptance_candidate_mismatch"),
    );

    const blocked = evaluateCompletionContract(
      {
        contract: evaluation.contract,
        allowedAcceptanceStates: ["passed"],
        requireAllEffectsVerified: true,
      },
      {
        ...before,
        effects: [
          { effectId: createStableId("effect"), state: "unknown_outcome" },
        ],
      },
      {
        evaluationId: createStableId("completionEvaluation"),
        missionId: evaluation.missionId,
        evaluatedAt: "2026-09-04T12:00:00Z",
        requiredReceiptsVerified: false,
        evidenceFreshnessVerified: true,
        conflicts: [],
        unresolvedFindings: [],
        lifecycleDigest: "sha256:blocked",
        provenanceId: createStableId("provenance"),
      },
    );
    assert.equal(blocked.status, "failed");
    assert.ok(blocked.disqualifiers.includes("missing_required_receipt"));
    assert.ok(blocked.disqualifiers.includes("effect_not_verified"));
  });

  it("rejects mission lifecycle shortcuts", () => {
    assert.equal(transitionMissionState("ready", "executing"), "executing");
    assert.throws(
      () => transitionMissionState("received", "complete_for_scope"),
      /Illegal mission transition/,
    );
  });
});
