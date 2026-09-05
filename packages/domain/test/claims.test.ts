import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { calculateClaimConfidence, parseClaim } from "../src/claims.ts";
import { createStableId } from "../src/ids.ts";

function clientRequestClaim() {
  return {
    claimId: createStableId("claim"),
    projectId: createStableId("project"),
    type: "request",
    statement: "The client asked for automatic production deployment.",
    status: "unverified",
    authority: 1,
    freshness: 1,
    corroboration: 1,
    completeness: 1,
    inferenceDistance: 0,
    confidence: 1,
    sourceEvidenceIds: [createStableId("evidence")],
    assertedBy: "client:17",
    createdByRunId: createStableId("run"),
  } as const;
}

describe("claim schema", () => {
  it("does not turn a high-confidence request into a decision or commitment", () => {
    const parsed = parseClaim(clientRequestClaim());

    assert.equal(parsed.type, "request");
    assert.equal(parsed.status, "unverified");
    assert.equal(parsed.confidence, 1);
  });

  it("rejects unexplained out-of-range confidence dimensions", () => {
    assert.throws(
      () => parseClaim({ ...clientRequestClaim(), authority: -0.1 }),
      /authority/,
    );
    assert.throws(
      () => parseClaim({ ...clientRequestClaim(), confidence: Number.NaN }),
      /confidence/,
    );
    assert.throws(
      () => parseClaim({ ...clientRequestClaim(), confidence: 0.9 }),
      /derived from its dimensions/,
    );
  });

  it("computes confidence deterministically from every dimension", () => {
    assert.equal(
      calculateClaimConfidence({
        authority: 0.5,
        freshness: 1,
        corroboration: 0.5,
        completeness: 0.75,
        inferenceDistance: 1,
      }),
      0.625,
    );
  });
});
