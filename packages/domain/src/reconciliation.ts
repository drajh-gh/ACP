import { parseStableId, type StableId } from "./ids.ts";
import {
  expectArray,
  expectEnum,
  expectIsoTimestamp,
  expectOptionalIsoTimestamp,
  expectRecord,
  expectString,
  expectStringArray,
  timestampMilliseconds,
} from "./validation.ts";

export const capabilityReadinessStates = [
  "available",
  "degraded",
  "unconfigured",
  "blocked",
  "stale",
  "revoked",
  "unknown",
] as const;

export const sourceCursorStates = [
  "valid",
  "expired",
  "invalid",
  "unknown",
] as const;

export const coverageStates = ["complete", "partial", "unknown"] as const;

export type CapabilityReadinessState =
  (typeof capabilityReadinessStates)[number];
export type SourceCursorState = (typeof sourceCursorStates)[number];
export type CoverageState = (typeof coverageStates)[number];

export interface CapabilityReadiness {
  readonly projectId: StableId<"project">;
  readonly capability: string;
  readonly state: CapabilityReadinessState;
  readonly reason: string;
  readonly assessedAt: string;
  readonly evidenceIds: readonly StableId<"evidence">[];
}

export interface SourceCursor {
  readonly cursorId: StableId<"sourceCursor">;
  readonly projectId: StableId<"project">;
  readonly sourceId: string;
  readonly cursorType: string;
  readonly cursorValueEncryptedOrOpaque: string;
  readonly lastCoveredThrough?: string;
  readonly status: SourceCursorState;
  readonly lastValidatedAt: string;
  readonly recoveryStrategy: string;
}

export interface CoverageGap {
  readonly from?: string;
  readonly through?: string;
  readonly reason: string;
}

export interface CoverageWindow {
  readonly sourceId: string;
  readonly requestedFrom?: string;
  readonly requestedThrough: string;
  readonly coveredFrom?: string;
  readonly coveredThrough?: string;
  readonly state: CoverageState;
  readonly gaps: readonly CoverageGap[];
  readonly changeSetId?: StableId<"changeSet">;
}

export interface DurableChangeSet {
  readonly changeSetId: StableId<"changeSet">;
  readonly projectId: StableId<"project">;
  readonly sourceId: string;
  readonly cursorValueEncryptedOrOpaque: string;
  readonly durablyProcessed: boolean;
  readonly processedAt: string;
}

export function parseCapabilityReadiness(value: unknown): CapabilityReadiness {
  const input = expectRecord(value, "capabilityReadiness");
  return {
    projectId: parseStableId(input.projectId, "project"),
    capability: expectString(input.capability, "capabilityReadiness.capability"),
    state: expectEnum(
      input.state,
      capabilityReadinessStates,
      "capabilityReadiness.state",
    ),
    reason: expectString(input.reason, "capabilityReadiness.reason"),
    assessedAt: expectIsoTimestamp(
      input.assessedAt,
      "capabilityReadiness.assessedAt",
    ),
    evidenceIds: expectStringArray(
      input.evidenceIds,
      "capabilityReadiness.evidenceIds",
    ).map((id) => parseStableId(id, "evidence")),
  };
}

export function parseSourceCursor(value: unknown): SourceCursor {
  const input = expectRecord(value, "sourceCursor");
  const lastCoveredThrough = expectOptionalIsoTimestamp(
    input.lastCoveredThrough,
    "sourceCursor.lastCoveredThrough",
  );
  return {
    cursorId: parseStableId(input.cursorId, "sourceCursor"),
    projectId: parseStableId(input.projectId, "project"),
    sourceId: expectString(input.sourceId, "sourceCursor.sourceId"),
    cursorType: expectString(input.cursorType, "sourceCursor.cursorType"),
    cursorValueEncryptedOrOpaque: expectString(
      input.cursorValueEncryptedOrOpaque,
      "sourceCursor.cursorValueEncryptedOrOpaque",
    ),
    ...(lastCoveredThrough === undefined ? {} : { lastCoveredThrough }),
    status: expectEnum(input.status, sourceCursorStates, "sourceCursor.status"),
    lastValidatedAt: expectIsoTimestamp(
      input.lastValidatedAt,
      "sourceCursor.lastValidatedAt",
    ),
    recoveryStrategy: expectString(
      input.recoveryStrategy,
      "sourceCursor.recoveryStrategy",
    ),
  };
}

export function parseCoverageWindow(value: unknown): CoverageWindow {
  const input = expectRecord(value, "coverage");
  const requestedFrom = expectOptionalIsoTimestamp(
    input.requestedFrom,
    "coverage.requestedFrom",
  );
  const coveredFrom = expectOptionalIsoTimestamp(
    input.coveredFrom,
    "coverage.coveredFrom",
  );
  const coveredThrough = expectOptionalIsoTimestamp(
    input.coveredThrough,
    "coverage.coveredThrough",
  );
  const changeSetId =
    input.changeSetId === undefined
      ? undefined
      : parseStableId(input.changeSetId, "changeSet");
  const state = expectEnum(input.state, coverageStates, "coverage.state");
  const gaps = expectArray(input.gaps, "coverage.gaps").map(parseCoverageGap);

  if (state === "complete" && gaps.length > 0) {
    throw new TypeError("coverage.gaps must be empty when coverage.state is complete");
  }
  if (state === "complete" && coveredThrough === undefined) {
    throw new TypeError(
      "coverage.coveredThrough is required when coverage.state is complete",
    );
  }

  return {
    sourceId: expectString(input.sourceId, "coverage.sourceId"),
    ...(requestedFrom === undefined ? {} : { requestedFrom }),
    requestedThrough: expectIsoTimestamp(
      input.requestedThrough,
      "coverage.requestedThrough",
    ),
    ...(coveredFrom === undefined ? {} : { coveredFrom }),
    ...(coveredThrough === undefined ? {} : { coveredThrough }),
    state,
    gaps,
    ...(changeSetId === undefined ? {} : { changeSetId }),
  };
}

export function advanceSourceCursor(
  cursor: SourceCursor,
  coverage: CoverageWindow,
  changeSet: DurableChangeSet,
): SourceCursor {
  if (!changeSet.durablyProcessed) {
    throw new Error("source cursor cannot advance until its change set is durably processed");
  }
  if (coverage.state !== "complete" || coverage.coveredThrough === undefined) {
    throw new Error("source cursor cannot advance without complete coverage");
  }
  if (coverage.changeSetId !== changeSet.changeSetId) {
    throw new Error("source cursor cannot advance for a different change set");
  }
  if (
    cursor.projectId !== changeSet.projectId ||
    cursor.sourceId !== changeSet.sourceId ||
    coverage.sourceId !== cursor.sourceId
  ) {
    throw new Error("source cursor cannot advance across project or source boundaries");
  }

  const coveredThrough = timestampMilliseconds(
    coverage.coveredThrough,
    "coverage.coveredThrough",
  );
  const requestedThrough = timestampMilliseconds(
    coverage.requestedThrough,
    "coverage.requestedThrough",
  );
  if (coveredThrough < requestedThrough) {
    throw new Error("source cursor cannot advance before the requested coverage boundary");
  }
  if (
    coverage.requestedFrom !== undefined &&
    coverage.coveredFrom !== undefined &&
    timestampMilliseconds(coverage.coveredFrom, "coverage.coveredFrom") >
      timestampMilliseconds(coverage.requestedFrom, "coverage.requestedFrom")
  ) {
    throw new Error("source cursor cannot advance across an uncovered range start");
  }
  if (
    cursor.lastCoveredThrough !== undefined &&
    coveredThrough <
      timestampMilliseconds(cursor.lastCoveredThrough, "sourceCursor.lastCoveredThrough")
  ) {
    throw new Error("source cursor cannot move backward");
  }

  expectIsoTimestamp(changeSet.processedAt, "changeSet.processedAt");
  return {
    ...cursor,
    cursorValueEncryptedOrOpaque: expectString(
      changeSet.cursorValueEncryptedOrOpaque,
      "changeSet.cursorValueEncryptedOrOpaque",
    ),
    lastCoveredThrough: coverage.coveredThrough,
    status: "valid",
    lastValidatedAt: changeSet.processedAt,
  };
}

function parseCoverageGap(value: unknown, index: number): CoverageGap {
  const path = `coverage.gaps[${index}]`;
  const input = expectRecord(value, path);
  const from = expectOptionalIsoTimestamp(input.from, `${path}.from`);
  const through = expectOptionalIsoTimestamp(input.through, `${path}.through`);
  return {
    ...(from === undefined ? {} : { from }),
    ...(through === undefined ? {} : { through }),
    reason: expectString(input.reason, `${path}.reason`),
  };
}
