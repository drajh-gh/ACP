import { parseStableId, type StableId } from "./ids.ts";
import {
  expectArray,
  expectEnum,
  expectFiniteNumber,
  expectIsoTimestamp,
  expectOptionalIsoTimestamp,
  expectOptionalString,
  expectRecord,
  expectString,
  expectStringArray,
} from "./validation.ts";

export const intakeOrigins = [
  "codex",
  "gmail",
  "slack",
  "sentry",
  "bugsink",
  "tracker",
  "meeting",
  "drive",
  "schedule",
  "other",
] as const;

export const sensitivityLevels = [
  "public",
  "project_confidential",
  "restricted",
] as const;

export const intakeDispositions = [
  "verified_or_likely_defect",
  "feature_or_change_request",
  "support_or_usage_question",
  "incident",
  "duplicate_or_continuation",
  "already_resolved",
  "not_warranted_or_out_of_scope",
  "insufficient_evidence",
  "wrong_project_or_source",
  "requires_business_decision",
] as const;

export type IntakeOrigin = (typeof intakeOrigins)[number];
export type Sensitivity = (typeof sensitivityLevels)[number];
export type IntakeDisposition = (typeof intakeDispositions)[number];

export interface ProjectCandidate {
  readonly projectId: StableId<"project">;
  readonly confidence: number;
  readonly basis: readonly string[];
}

export interface IntakeReporter {
  readonly externalId?: string;
  readonly displayName?: string;
  readonly organization?: string;
}

export interface IntakeEnvelope {
  readonly intakeId: StableId<"intake">;
  readonly receivedAt: string;
  readonly origin: IntakeOrigin;
  readonly immutableSourceRef: string;
  readonly externalEventId?: string;
  readonly projectCandidates: readonly ProjectCandidate[];
  readonly reporter?: IntakeReporter;
  readonly occurredAt?: string;
  readonly subject?: string;
  readonly rawEvidenceRefs: readonly string[];
  readonly relatedSourceRefs: readonly string[];
  readonly correlationKeys: readonly string[];
  readonly sensitivity: Sensitivity;
}

export interface IntakeDispositionRecord {
  readonly dispositionClaimId: StableId<"claim">;
  readonly intakeId: StableId<"intake">;
  readonly projectId?: StableId<"project">;
  readonly disposition: IntakeDisposition;
  readonly confidence: number;
  readonly reason: string;
  readonly evidenceIds: readonly StableId<"evidence">[];
  readonly provenanceId: StableId<"provenance">;
  readonly unresolvedReason?: string;
  readonly classifiedAt: string;
}

export function parseIntakeEnvelope(value: unknown): IntakeEnvelope {
  const input = expectRecord(value, "intake");
  const externalEventId = expectOptionalString(
    input.externalEventId,
    "intake.externalEventId",
  );
  const occurredAt = expectOptionalIsoTimestamp(
    input.occurredAt,
    "intake.occurredAt",
  );
  const subject = expectOptionalString(input.subject, "intake.subject");
  const reporter = parseReporter(input.reporter);

  return {
    intakeId: parseStableId(input.intakeId, "intake"),
    receivedAt: expectIsoTimestamp(input.receivedAt, "intake.receivedAt"),
    origin: expectEnum(input.origin, intakeOrigins, "intake.origin"),
    immutableSourceRef: expectString(
      input.immutableSourceRef,
      "intake.immutableSourceRef",
    ),
    ...(externalEventId === undefined ? {} : { externalEventId }),
    projectCandidates: expectArray(
      input.projectCandidates,
      "intake.projectCandidates",
    ).map(parseProjectCandidate),
    ...(reporter === undefined ? {} : { reporter }),
    ...(occurredAt === undefined ? {} : { occurredAt }),
    ...(subject === undefined ? {} : { subject }),
    rawEvidenceRefs: expectStringArray(
      input.rawEvidenceRefs,
      "intake.rawEvidenceRefs",
    ),
    relatedSourceRefs: expectStringArray(
      input.relatedSourceRefs,
      "intake.relatedSourceRefs",
    ),
    correlationKeys: expectStringArray(
      input.correlationKeys,
      "intake.correlationKeys",
    ),
    sensitivity: expectEnum(
      input.sensitivity,
      sensitivityLevels,
      "intake.sensitivity",
    ),
  };
}

export function parseIntakeDisposition(
  value: unknown,
): IntakeDispositionRecord {
  const input = expectRecord(value, "intakeDisposition");
  const projectId =
    input.projectId === undefined
      ? undefined
      : parseStableId(input.projectId, "project");
  const unresolvedReason = expectOptionalString(
    input.unresolvedReason,
    "intakeDisposition.unresolvedReason",
  );
  const evidenceIds = expectStringArray(
    input.evidenceIds,
    "intakeDisposition.evidenceIds",
  ).map((id) => parseStableId(id, "evidence"));
  if (evidenceIds.length === 0) {
    throw new TypeError("intakeDisposition.evidenceIds cannot be empty");
  }
  const disposition = expectEnum(
    input.disposition,
    intakeDispositions,
    "intakeDisposition.disposition",
  );
  if (
    (disposition === "insufficient_evidence" ||
      disposition === "wrong_project_or_source" ||
      disposition === "requires_business_decision") &&
    unresolvedReason === undefined
  ) {
    throw new TypeError(
      "unresolved intake dispositions require an unresolved reason",
    );
  }

  return {
    dispositionClaimId: parseStableId(input.dispositionClaimId, "claim"),
    intakeId: parseStableId(input.intakeId, "intake"),
    ...(projectId === undefined ? {} : { projectId }),
    disposition,
    confidence: expectFiniteNumber(
      input.confidence,
      "intakeDisposition.confidence",
      { minimum: 0, maximum: 1 },
    ),
    reason: expectString(input.reason, "intakeDisposition.reason"),
    evidenceIds,
    provenanceId: parseStableId(input.provenanceId, "provenance"),
    ...(unresolvedReason === undefined ? {} : { unresolvedReason }),
    classifiedAt: expectIsoTimestamp(
      input.classifiedAt,
      "intakeDisposition.classifiedAt",
    ),
  };
}

function parseProjectCandidate(value: unknown, index: number): ProjectCandidate {
  const path = `intake.projectCandidates[${index}]`;
  const input = expectRecord(value, path);

  return {
    projectId: parseStableId(input.projectId, "project"),
    confidence: expectFiniteNumber(input.confidence, `${path}.confidence`, {
      minimum: 0,
      maximum: 1,
    }),
    basis: expectStringArray(input.basis, `${path}.basis`),
  };
}

function parseReporter(value: unknown): IntakeReporter | undefined {
  if (value === undefined) {
    return undefined;
  }

  const input = expectRecord(value, "intake.reporter");
  const externalId = expectOptionalString(
    input.externalId,
    "intake.reporter.externalId",
  );
  const displayName = expectOptionalString(
    input.displayName,
    "intake.reporter.displayName",
  );
  const organization = expectOptionalString(
    input.organization,
    "intake.reporter.organization",
  );

  return {
    ...(externalId === undefined ? {} : { externalId }),
    ...(displayName === undefined ? {} : { displayName }),
    ...(organization === undefined ? {} : { organization }),
  };
}
