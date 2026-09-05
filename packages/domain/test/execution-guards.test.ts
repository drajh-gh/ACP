import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { transitionEffectState } from "../src/effects.ts";
import { assessRuntimeControls } from "../src/runtime.ts";
import { createStableId } from "../src/ids.ts";

describe("effect execution guards", () => {
  it("keeps applied distinct from verified", () => {
    assert.equal(transitionEffectState("executing", "applied"), "applied");
    assert.throws(
      () => transitionEffectState("executing", "verified"),
      /Illegal effect transition/,
    );
  });

  it("requires a verified receipt before entering verified", () => {
    assert.throws(
      () => transitionEffectState("verifying", "verified"),
      /persisted verified receipt/,
    );
    assert.equal(
      transitionEffectState("verifying", "verified", {
        verifiedReceiptId: createStableId("receipt"),
      }),
      "verified",
    );
  });

  it("requires reconciliation before leaving unknown outcome", () => {
    assert.throws(
      () => transitionEffectState("unknown_outcome", "executing"),
      /must be reconciled/,
    );
    assert.equal(
      transitionEffectState("unknown_outcome", "verifying", {
        reconciliationOutcome: "applied",
      }),
      "verifying",
    );
    assert.equal(
      transitionEffectState("unknown_outcome", "revalidating", {
        reconciliationOutcome: "not_applied",
      }),
      "revalidating",
    );
    assert.throws(
      () =>
        transitionEffectState("unknown_outcome", "verified", {
          reconciliationOutcome: "not_applied",
        }),
      /not-applied reconciliation/,
    );
    assert.throws(
      () =>
        transitionEffectState("unknown_outcome", "verified", {
          reconciliationOutcome: "applied",
          verifiedReceiptId: createStableId("receipt"),
        }),
      /cannot re-execute/,
    );
  });

  it("fails closed when global or project effects are paused", () => {
    const projectId = createStableId("project");
    const globalPaused = assessRuntimeControls(
      {
        scopeType: "global",
        scopeId: "global",
        effectsPaused: true,
        reason: "operator kill switch",
        updatedBy: "operator:david",
        updatedAt: "2026-09-04T12:00:00.000Z",
      },
      undefined,
      projectId,
    );
    assert.deepEqual(globalPaused, {
      allowed: false,
      reasons: ["global_effects_paused"],
    });

    const projectPaused = assessRuntimeControls(
      {
        scopeType: "global",
        scopeId: "global",
        effectsPaused: false,
        reason: "enabled",
        updatedBy: "operator:david",
        updatedAt: "2026-09-04T12:00:00.000Z",
      },
      {
        scopeType: "project",
        scopeId: projectId,
        effectsPaused: true,
        reason: "project maintenance",
        updatedBy: "operator:david",
        updatedAt: "2026-09-04T12:00:00.000Z",
      },
      projectId,
    );
    assert.deepEqual(projectPaused, {
      allowed: false,
      reasons: ["project_effects_paused"],
    });
  });
});
