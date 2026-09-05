import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createStableId,
  idPrefixes,
  isStableId,
  parseStableId,
} from "../src/ids.ts";

describe("stable identifiers", () => {
  it("creates an opaque identifier with an entity-specific prefix", () => {
    const missionId = createStableId("mission");

    assert.match(
      missionId,
      /^mis_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(isStableId(missionId, "mission"), true);
    assert.equal(isStableId(missionId, "effect"), false);
  });

  it("rejects malformed and cross-entity identifiers", () => {
    assert.throws(
      () => parseStableId("eff_not-a-uuid", "effect"),
      /Invalid effect identifier/,
    );
    assert.throws(
      () => parseStableId("mis_00000000-0000-4000-8000-000000000000", "effect"),
      /Invalid effect identifier/,
    );
  });

  it("keeps every persisted entity prefix unique", () => {
    const prefixes = Object.values(idPrefixes);

    assert.equal(new Set(prefixes).size, prefixes.length);
  });

  it("uses a distinct stable identifier for precondition evaluations", () => {
    const evaluationId = createStableId("executionPreconditionEvaluation");

    assert.match(
      evaluationId,
      /^epe_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(
      isStableId(evaluationId, "executionPreconditionEvaluation"),
      true,
    );
    assert.equal(isStableId(evaluationId, "preconditionSnapshot"), false);
  });

  it("uses a distinct stable identifier for approval evaluations", () => {
    const evaluationId = createStableId("approvalEvaluation");

    assert.match(
      evaluationId,
      /^ape_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(isStableId(evaluationId, "approvalEvaluation"), true);
    assert.equal(
      isStableId(evaluationId, "executionPreconditionEvaluation"),
      false,
    );
  });
});
