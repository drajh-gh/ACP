import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assessApprovalCoverage,
  canonicalJsonDigest,
  parseApprovalEnvelope,
  parseEffectProposal,
  parseVerificationRecord,
} from "../src/effects.ts";
import type { EffectProposal } from "../src/effects.ts";
import { createStableId } from "../src/ids.ts";

function effectProposal() {
  return {
    effectId: createStableId("effect"),
    missionId: createStableId("mission"),
    projectId: createStableId("project"),
    type: "github.pull_request.create",
    adapterId: "github",
    adapterVersion: "1.0.0",
    adapterAccountId: "github:drajh-gh",
    target: {
      type: "repository",
      externalId: "drajh-gh/ACP",
      displayName: "ACP",
    },
    payload: {
      title: "Establish M0 contracts",
      head: "codex/m0-domain",
      base: "main",
    },
    preview: "Open a pull request from codex/m0-domain to main.",
    riskClass: "R2",
    rationale: "Make the exact reviewed candidate available for integration.",
    evidenceIds: [createStableId("evidence")],
    candidateRevision: "a".repeat(40),
    idempotencyKey: "github:pr:drajh-gh/ACP:codex/m0-domain",
    requiredPreconditions: [
      {
        type: "branch_head",
        sourceRef: "github:branch:codex/m0-domain",
        expected: "a".repeat(40),
      },
    ],
    verificationPlan: [
      {
        type: "read_pull_request",
        expected: { headSha: "a".repeat(40), state: "open" },
      },
    ],
    proposedByRunId: createStableId("run"),
  } as const;
}

function approvalEnvelope(proposal: EffectProposal = effectProposal()) {
  return {
    approvalId: createStableId("approval"),
    approverId: "operator:david",
    projectId: proposal.projectId,
    missionId: proposal.missionId,
    allowedEffectTypes: [proposal.type],
    allowedAdapterAccountIds: [proposal.adapterAccountId],
    allowedTargetIds: [proposal.target.externalId],
    ...(proposal.candidateRevision === undefined
      ? {}
      : { candidateRevisions: [proposal.candidateRevision] }),
    maximumRiskClass: "R2",
    allowedEnvironments: [],
    requiredGates: ["domain-tests"],
    allowedRepairClasses: [],
    preconditionSnapshotIds: [createStableId("preconditionSnapshot")],
    validFrom: "2026-09-04T11:00:00.000Z",
    expiresAt: "2026-09-04T13:00:00.000Z",
    quietHoursBehavior: "defer",
  } as const;
}

describe("effect and approval schemas", () => {
  it("requires a deterministic read-back verification plan", () => {
    const proposal = effectProposal();

    assert.equal(parseEffectProposal(proposal).verificationPlan.length, 1);
    assert.throws(
      () => parseEffectProposal({ ...proposal, verificationPlan: [] }),
      /verificationPlan/,
    );
  });

  it("requires complete structured verification evidence", () => {
    const observed = { headSha: "a".repeat(40), state: "open" };
    const record = parseVerificationRecord({
      result: "passed",
      steps: [{
        stepIndex: 0,
        type: "read_pull_request",
        expected: observed,
        observed,
        observedDigest: canonicalJsonDigest(observed),
        matched: true,
        observedAt: "2026-09-04T12:00:00.000Z",
        evidenceIds: [createStableId("evidence")],
      }],
    });
    assert.equal(record.steps.length, 1);

    assert.throws(() => parseVerificationRecord({}), /result/);
    assert.throws(
      () => parseVerificationRecord({ ...record, steps: [] }),
      /at least one/,
    );
    assert.throws(
      () => parseVerificationRecord({
        ...record,
        steps: [{ ...record.steps[0], observedDigest: "sha256:wrong" }],
      }),
      /must match/,
    );
  });

  it("covers only the exact approved target and candidate revision", () => {
    const proposal = parseEffectProposal(effectProposal());
    const envelope = parseApprovalEnvelope(approvalEnvelope(proposal));
    const exact = assessApprovalCoverage(envelope, proposal, {
      at: "2026-09-04T12:00:00.000Z",
      passedGates: ["domain-tests"],
      preconditionSnapshotIds: envelope.preconditionSnapshotIds,
    });

    assert.deepEqual(exact, { covered: true, reasons: [] });

    const drifted = assessApprovalCoverage(
      envelope,
      { ...proposal, candidateRevision: "b".repeat(40) },
      {
        at: "2026-09-04T12:00:00.000Z",
        passedGates: ["domain-tests"],
        preconditionSnapshotIds: envelope.preconditionSnapshotIds,
      },
    );

    assert.equal(drifted.covered, false);
    assert.ok(drifted.reasons.includes("candidate_revision_not_approved"));
  });

  it("requires mission-bound exact approval for R4 effects", () => {
    const production = parseEffectProposal({
      ...effectProposal(),
      type: "deployment.production",
      riskClass: "R4",
    });
    const broadEnvelope = parseApprovalEnvelope({
      ...approvalEnvelope(production),
      missionId: undefined,
      maximumRiskClass: "R4",
    });

    const coverage = assessApprovalCoverage(broadEnvelope, production, {
      at: "2026-09-04T12:00:00.000Z",
      passedGates: ["domain-tests"],
      preconditionSnapshotIds: broadEnvelope.preconditionSnapshotIds,
    });

    assert.equal(coverage.covered, false);
    assert.ok(coverage.reasons.includes("r4_requires_mission_bound_approval"));
  });

  it("compares approval windows as instants across timezone offsets", () => {
    const proposal = parseEffectProposal(effectProposal());
    const envelope = parseApprovalEnvelope({
      ...approvalEnvelope(proposal),
      validFrom: "2026-09-04T13:00:00+02:00",
      expiresAt: "2026-09-04T15:00:00+02:00",
    });

    const coverage = assessApprovalCoverage(envelope, proposal, {
      at: "2026-09-04T12:00:00Z",
      passedGates: ["domain-tests"],
      preconditionSnapshotIds: envelope.preconditionSnapshotIds,
    });

    assert.deepEqual(coverage, { covered: true, reasons: [] });
  });

  it("fails closed on missing precondition snapshots and revoked approval", () => {
    const proposal = parseEffectProposal(effectProposal());
    const envelope = parseApprovalEnvelope({
      ...approvalEnvelope(proposal),
      revokedAt: "2026-09-04T11:30:00.000Z",
    });

    const coverage = assessApprovalCoverage(envelope, proposal, {
      at: "2026-09-04T12:00:00.000Z",
      passedGates: ["domain-tests"],
      preconditionSnapshotIds: [],
    });

    assert.equal(coverage.covered, false);
    assert.ok(coverage.reasons.includes("approval_revoked"));
    assert.ok(coverage.reasons.includes("precondition_snapshot_not_approved"));
  });

  it("requires an exact payload digest for R4 effects", () => {
    const proposal = parseEffectProposal({
      ...effectProposal(),
      type: "database.migrate",
      riskClass: "R4",
    });
    const authoritativeDigest = canonicalJsonDigest(proposal.payload);
    const envelope = parseApprovalEnvelope({
      ...approvalEnvelope(proposal),
      maximumRiskClass: "R4",
      payloadDigests: [authoritativeDigest],
    });

    const missingDigest = assessApprovalCoverage(envelope, proposal, {
      at: "2026-09-04T12:00:00.000Z",
      passedGates: ["domain-tests"],
      preconditionSnapshotIds: envelope.preconditionSnapshotIds,
    });
    assert.equal(missingDigest.covered, true);

    const exact = assessApprovalCoverage(envelope, proposal, {
      at: "2026-09-04T12:00:00.000Z",
      payloadDigest: authoritativeDigest,
      passedGates: ["domain-tests"],
      preconditionSnapshotIds: envelope.preconditionSnapshotIds,
    });
    assert.deepEqual(exact, { covered: true, reasons: [] });

    const spoofed = assessApprovalCoverage(envelope, proposal, {
      at: "2026-09-04T12:00:00.000Z",
      payloadDigest: "sha256:caller-controlled",
      passedGates: ["domain-tests"],
      preconditionSnapshotIds: envelope.preconditionSnapshotIds,
    });
    assert.ok(spoofed.reasons.includes("payload_digest_not_authoritative"));
  });
});
