import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createStableId } from "../src/ids.ts";
import {
  advanceSourceCursor,
  parseCapabilityReadiness,
  parseCoverageWindow,
  parseSourceCursor,
} from "../src/reconciliation.ts";

function sourceCursor() {
  return parseSourceCursor({
    cursorId: createStableId("sourceCursor"),
    projectId: createStableId("project"),
    sourceId: "github:installation:42",
    cursorType: "updated_at",
    cursorValueEncryptedOrOpaque: "opaque:page-17",
    lastCoveredThrough: "2026-09-04T11:00:00.000Z",
    status: "valid",
    lastValidatedAt: "2026-09-04T11:01:00.000Z",
    recoveryStrategy: "bounded_rescan",
  });
}

describe("readiness and reconciliation contracts", () => {
  it("keeps degraded capability distinct from blocked or available", () => {
    const readiness = parseCapabilityReadiness({
      projectId: createStableId("project"),
      capability: "run_required_tests",
      state: "degraded",
      reason: "Only targeted tests are configured.",
      assessedAt: "2026-09-04T12:00:00.000Z",
      evidenceIds: [createStableId("evidence")],
    });

    assert.equal(readiness.state, "degraded");
  });

  it("advances a cursor only after durable, complete coverage", () => {
    const cursor = sourceCursor();
    const changeSetId = createStableId("changeSet");
    const coverage = parseCoverageWindow({
      sourceId: cursor.sourceId,
      requestedFrom: cursor.lastCoveredThrough,
      requestedThrough: "2026-09-04T12:00:00.000Z",
      coveredFrom: cursor.lastCoveredThrough,
      coveredThrough: "2026-09-04T12:00:00.000Z",
      state: "complete",
      gaps: [],
      changeSetId,
    });
    const after = advanceSourceCursor(cursor, coverage, {
      changeSetId,
      projectId: cursor.projectId,
      sourceId: cursor.sourceId,
      cursorValueEncryptedOrOpaque: "opaque:page-18",
      durablyProcessed: true,
      processedAt: "2026-09-04T12:01:00.000Z",
    });

    assert.equal(after.lastCoveredThrough, coverage.coveredThrough);
    assert.equal(after.cursorValueEncryptedOrOpaque, "opaque:page-18");
  });

  it("refuses undurable or incomplete cursor advancement", () => {
    const cursor = sourceCursor();
    const changeSetId = createStableId("changeSet");
    const partial = parseCoverageWindow({
      sourceId: cursor.sourceId,
      requestedThrough: "2026-09-04T12:00:00.000Z",
      coveredThrough: "2026-09-04T11:30:00.000Z",
      state: "partial",
      gaps: [
        {
          from: "2026-09-04T11:30:00.000Z",
          through: "2026-09-04T12:00:00.000Z",
          reason: "provider timeout",
        },
      ],
      changeSetId,
    });
    const processed = {
      changeSetId,
      projectId: cursor.projectId,
      sourceId: cursor.sourceId,
      cursorValueEncryptedOrOpaque: "opaque:page-18",
      durablyProcessed: true,
      processedAt: "2026-09-04T12:01:00.000Z",
    } as const;

    assert.throws(
      () => advanceSourceCursor(cursor, partial, processed),
      /complete coverage/,
    );
    assert.throws(
      () =>
        advanceSourceCursor(
          cursor,
          { ...partial, state: "complete", gaps: [] },
          { ...processed, durablyProcessed: false },
        ),
      /durably processed/,
    );
  });

  it("refuses source mismatch, incomplete boundaries, and cursor regression", () => {
    const cursor = sourceCursor();
    const changeSetId = createStableId("changeSet");
    const coverage = parseCoverageWindow({
      sourceId: cursor.sourceId,
      requestedFrom: cursor.lastCoveredThrough,
      requestedThrough: "2026-09-04T12:00:00.000Z",
      coveredFrom: cursor.lastCoveredThrough,
      coveredThrough: "2026-09-04T12:00:00.000Z",
      state: "complete",
      gaps: [],
      changeSetId,
    });
    const processed = {
      changeSetId,
      projectId: cursor.projectId,
      sourceId: cursor.sourceId,
      cursorValueEncryptedOrOpaque: "opaque:page-18",
      durablyProcessed: true,
      processedAt: "2026-09-04T12:01:00.000Z",
    } as const;

    assert.throws(
      () => advanceSourceCursor(cursor, { ...coverage, sourceId: "slack:T1" }, processed),
      /source boundaries/,
    );
    assert.throws(
      () =>
        advanceSourceCursor(
          cursor,
          { ...coverage, coveredThrough: "2026-09-04T11:30:00.000Z" },
          processed,
        ),
      /requested coverage boundary/,
    );
    assert.throws(
      () =>
        advanceSourceCursor(
          cursor,
          {
            ...coverage,
            requestedThrough: "2026-09-04T10:00:00.000Z",
            coveredThrough: "2026-09-04T10:00:00.000Z",
          },
          processed,
        ),
      /move backward/,
    );
  });
});
