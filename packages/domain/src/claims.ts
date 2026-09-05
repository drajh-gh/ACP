import { parseStableId, type StableId } from "./ids.ts";
import type { Sensitivity } from "./intake.ts";
import {
  expectEnum,
  expectFiniteNumber,
  expectIsoTimestamp,
  expectOptionalIsoTimestamp,
  expectOptionalString,
  expectRecord,
  expectString,
  expectStringArray,
  timestampMilliseconds,
} from "./validation.ts";

export const claimTypes = [
  "agreed_fact",
  "reported_assertion",
  "observation",
  "hypothesis",
  "inference",
  "request",
  "decision",
  "commitment",
  "requirement",
  "acceptance_criterion",
  "superseded_claim",
  "disputed_claim",
] as const;

export const claimStatuses = [
  "active",
  "unverified",
  "conflicted",
  "superseded",
  "rejected",
] as const;

export const evidenceFreshnessStates = ["current", "stale", "unknown"] as const;
export const evidenceAccessibilityStates = [
  "available",
  "inaccessible",
  "missing",
  "malformed",
  "unknown",
] as const;

export type ClaimType = (typeof claimTypes)[number];
export type ClaimStatus = (typeof claimStatuses)[number];
export type EvidenceFreshnessState = (typeof evidenceFreshnessStates)[number];
export type EvidenceAccessibilityState =
  (typeof evidenceAccessibilityStates)[number];

export interface Claim {
  readonly claimId: StableId<"claim">;
  readonly projectId?: StableId<"project">;
  readonly type: ClaimType;
  readonly statement: string;
  readonly status: ClaimStatus;
  readonly authority: number;
  readonly freshness: number;
  readonly corroboration: number;
  readonly completeness: number;
  readonly inferenceDistance: number;
  readonly confidence: number;
  readonly sourceEvidenceIds: readonly StableId<"evidence">[];
  readonly assertedBy?: string;
  readonly validFrom?: string;
  readonly validUntil?: string;
  readonly supersedes?: readonly StableId<"claim">[];
  readonly createdByRunId: StableId<"run">;
}

export interface EvidenceRecord {
  readonly evidenceId: StableId<"evidence">;
  readonly projectId: StableId<"project">;
  readonly sourceType: string;
  readonly sourceRef: string;
  readonly observedAt: string;
  readonly retrievedAt: string;
  readonly contentHash?: string;
  readonly sourceVersion?: string;
  readonly sensitivity: Sensitivity;
  readonly retentionPolicy: string;
  readonly redactedSummary: string;
  readonly rawContentRef?: string;
  readonly freshness: EvidenceFreshnessState;
  readonly accessibility: EvidenceAccessibilityState;
}

export interface ClaimConfidenceDimensions {
  readonly authority: number;
  readonly freshness: number;
  readonly corroboration: number;
  readonly completeness: number;
  readonly inferenceDistance: number;
}

export function calculateClaimConfidence(
  dimensions: ClaimConfidenceDimensions,
): number {
  const inferenceProximity = 1 / (1 + dimensions.inferenceDistance);
  return (
    dimensions.authority * 0.3 +
    dimensions.freshness * 0.15 +
    dimensions.corroboration * 0.2 +
    dimensions.completeness * 0.2 +
    inferenceProximity * 0.15
  );
}

export function parseClaim(value: unknown): Claim {
  const input = expectRecord(value, "claim");
  const projectId =
    input.projectId === undefined
      ? undefined
      : parseStableId(input.projectId, "project");
  const assertedBy = expectOptionalString(input.assertedBy, "claim.assertedBy");
  const validFrom = expectOptionalIsoTimestamp(input.validFrom, "claim.validFrom");
  const validUntil = expectOptionalIsoTimestamp(input.validUntil, "claim.validUntil");
  const supersedes =
    input.supersedes === undefined
      ? undefined
      : expectStringArray(input.supersedes, "claim.supersedes").map((id) =>
          parseStableId(id, "claim"),
        );

  if (
    validFrom !== undefined &&
    validUntil !== undefined &&
    timestampMilliseconds(validUntil, "claim.validUntil") <=
      timestampMilliseconds(validFrom, "claim.validFrom")
  ) {
    throw new TypeError("claim.validUntil must be later than claim.validFrom");
  }

  const authority = expectFiniteNumber(input.authority, "claim.authority", {
    minimum: 0,
    maximum: 1,
  });
  const freshness = expectFiniteNumber(input.freshness, "claim.freshness", {
    minimum: 0,
    maximum: 1,
  });
  const corroboration = expectFiniteNumber(
    input.corroboration,
    "claim.corroboration",
    { minimum: 0, maximum: 1 },
  );
  const completeness = expectFiniteNumber(
    input.completeness,
    "claim.completeness",
    { minimum: 0, maximum: 1 },
  );
  const inferenceDistance = expectFiniteNumber(
    input.inferenceDistance,
    "claim.inferenceDistance",
    { minimum: 0 },
  );
  const confidence = expectFiniteNumber(input.confidence, "claim.confidence", {
    minimum: 0,
    maximum: 1,
  });
  const explainedConfidence = calculateClaimConfidence({
    authority,
    freshness,
    corroboration,
    completeness,
    inferenceDistance,
  });
  if (Math.abs(confidence - explainedConfidence) > 1e-9) {
    throw new TypeError(
      "claim.confidence must equal the confidence derived from its dimensions",
    );
  }

  return {
    claimId: parseStableId(input.claimId, "claim"),
    ...(projectId === undefined ? {} : { projectId }),
    type: expectEnum(input.type, claimTypes, "claim.type"),
    statement: expectString(input.statement, "claim.statement"),
    status: expectEnum(input.status, claimStatuses, "claim.status"),
    authority,
    freshness,
    corroboration,
    completeness,
    inferenceDistance,
    confidence,
    sourceEvidenceIds: expectStringArray(
      input.sourceEvidenceIds,
      "claim.sourceEvidenceIds",
    ).map((id) => parseStableId(id, "evidence")),
    ...(assertedBy === undefined ? {} : { assertedBy }),
    ...(validFrom === undefined ? {} : { validFrom }),
    ...(validUntil === undefined ? {} : { validUntil }),
    ...(supersedes === undefined ? {} : { supersedes }),
    createdByRunId: parseStableId(input.createdByRunId, "run"),
  };
}

export function parseEvidenceRecord(value: unknown): EvidenceRecord {
  const input = expectRecord(value, "evidence");
  const contentHash = expectOptionalString(input.contentHash, "evidence.contentHash");
  const sourceVersion = expectOptionalString(
    input.sourceVersion,
    "evidence.sourceVersion",
  );
  const rawContentRef = expectOptionalString(
    input.rawContentRef,
    "evidence.rawContentRef",
  );

  return {
    evidenceId: parseStableId(input.evidenceId, "evidence"),
    projectId: parseStableId(input.projectId, "project"),
    sourceType: expectString(input.sourceType, "evidence.sourceType"),
    sourceRef: expectString(input.sourceRef, "evidence.sourceRef"),
    observedAt: expectIsoTimestamp(input.observedAt, "evidence.observedAt"),
    retrievedAt: expectIsoTimestamp(input.retrievedAt, "evidence.retrievedAt"),
    ...(contentHash === undefined ? {} : { contentHash }),
    ...(sourceVersion === undefined ? {} : { sourceVersion }),
    sensitivity: expectEnum(
      input.sensitivity,
      ["public", "project_confidential", "restricted"] as const,
      "evidence.sensitivity",
    ),
    retentionPolicy: expectString(
      input.retentionPolicy,
      "evidence.retentionPolicy",
    ),
    redactedSummary: expectString(
      input.redactedSummary,
      "evidence.redactedSummary",
      { allowEmpty: true },
    ),
    ...(rawContentRef === undefined ? {} : { rawContentRef }),
    freshness: expectEnum(
      input.freshness,
      evidenceFreshnessStates,
      "evidence.freshness",
    ),
    accessibility: expectEnum(
      input.accessibility,
      evidenceAccessibilityStates,
      "evidence.accessibility",
    ),
  };
}
