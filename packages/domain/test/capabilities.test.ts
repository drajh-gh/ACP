import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assessCapabilityGrant,
  parseCapabilityGrant,
} from "../src/runtime.ts";
import { createStableId } from "../src/ids.ts";

function capabilityGrant() {
  return {
    grantId: createStableId("capabilityGrant"),
    evaluationId: createStableId("capabilityGrantEvaluation"),
    missionId: createStableId("mission"),
    nodeId: createStableId("node"),
    projectId: createStableId("project"),
    role: "delivery",
    resourceClass: "cpu_intensive",
    allowedOperations: ["repository.write"],
    allowedResources: ["repo:repo_acp:worktree:mission-1"],
    mode: "write",
    workspace: "/worktrees/mission-1",
    networkDestinations: [],
    validFrom: "2026-09-04T11:00:00.000Z",
    expiresAt: "2026-09-04T13:00:00.000Z",
    maximumAttempts: 2,
    attemptsUsed: 0,
  } as const;
}

describe("capability grants", () => {
  it("allows only an exact in-scope operation", () => {
    const grant = parseCapabilityGrant(capabilityGrant());
    const assessment = assessCapabilityGrant(grant, {
      missionId: grant.missionId,
      nodeId: grant.nodeId,
      projectId: grant.projectId,
      role: grant.role,
      resourceClass: grant.resourceClass,
      operation: "repository.write",
      resource: "repo:repo_acp:worktree:mission-1",
      mode: "write",
      workspace: "/worktrees/mission-1",
      networkAccess: "none",
      at: "2026-09-04T12:00:00.000Z",
    });

    assert.deepEqual(assessment, { allowed: true, reasons: [] });
  });

  it("denies expired, wrong-target, and ungranted operations by default", () => {
    const grant = parseCapabilityGrant(capabilityGrant());
    const assessment = assessCapabilityGrant(grant, {
      missionId: grant.missionId,
      nodeId: grant.nodeId,
      projectId: grant.projectId,
      role: grant.role,
      resourceClass: "lightweight_read",
      operation: "github.pull_request.create",
      resource: "repo:another-repository",
      mode: "write",
      workspace: "/worktrees/mission-1",
      networkAccess: "none",
      at: "2026-09-04T14:00:00.000Z",
    });

    assert.equal(assessment.allowed, false);
    assert.ok(assessment.reasons.includes("grant_expired"));
    assert.ok(assessment.reasons.includes("operation_not_granted"));
    assert.ok(assessment.reasons.includes("resource_not_granted"));
    assert.ok(assessment.reasons.includes("resource_class_not_granted"));
  });

  it("denies network access when the destination is omitted", () => {
    const grant = parseCapabilityGrant({
      ...capabilityGrant(),
      networkDestinations: ["api.github.com"],
    });
    const assessment = assessCapabilityGrant(grant, {
      missionId: grant.missionId,
      nodeId: grant.nodeId,
      projectId: grant.projectId,
      role: grant.role,
      resourceClass: grant.resourceClass,
      operation: "repository.write",
      resource: "repo:repo_acp:worktree:mission-1",
      mode: "write",
      workspace: "/worktrees/mission-1",
      networkAccess: "required",
      at: "2026-09-04T12:00:00.000Z",
    });

    assert.equal(assessment.allowed, false);
    assert.ok(assessment.reasons.includes("network_destination_required"));
  });
});
