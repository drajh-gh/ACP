import { createHash } from "node:crypto";

import { parseStableId, type StableId } from "./ids.ts";
import type { EffectState } from "./lifecycle.ts";
import {
  expectArray,
  expectEnum,
  expectInteger,
  expectIsoTimestamp,
  expectJsonValue,
  expectOptionalIsoTimestamp,
  expectOptionalString,
  expectRecord,
  expectString,
  expectStringArray,
  timestampMilliseconds,
  type JsonValue,
} from "./validation.ts";

export const riskClasses = ["R0", "R1", "R2", "R3", "R4"] as const;
export type RiskClass = (typeof riskClasses)[number];

export interface EffectTarget {
  readonly type: string;
  readonly externalId: string;
  readonly displayName: string;
}

export interface PreconditionSpec {
  readonly type: string;
  readonly sourceRef: string;
  readonly expected: JsonValue;
}

export interface VerificationStep {
  readonly type: string;
  readonly expected: JsonValue;
}

export interface VerificationStepResult {
  readonly stepIndex: number;
  readonly type: string;
  readonly expected: JsonValue;
  readonly observed: JsonValue;
  readonly observedDigest: string;
  readonly matched: true;
  readonly observedAt: string;
  readonly evidenceIds: readonly StableId<"evidence">[];
}

export interface VerificationRecord {
  readonly result: "passed";
  readonly steps: readonly VerificationStepResult[];
}

export interface RollbackStep {
  readonly type: string;
  readonly payload: JsonValue;
  readonly verification: VerificationStep;
}

export interface EffectProposal {
  readonly effectId: StableId<"effect">;
  readonly missionId: StableId<"mission">;
  readonly projectId: StableId<"project">;
  readonly type: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly adapterAccountId: string;
  readonly target: EffectTarget;
  readonly payload: JsonValue;
  readonly preview: string;
  readonly riskClass: RiskClass;
  readonly rationale: string;
  readonly evidenceIds: readonly StableId<"evidence">[];
  readonly candidateRevision?: string;
  readonly idempotencyKey: string;
  readonly requiredPreconditions: readonly PreconditionSpec[];
  readonly verificationPlan: readonly VerificationStep[];
  readonly rollbackPlan?: readonly RollbackStep[];
  readonly proposedByRunId: StableId<"run">;
}

export interface ApprovalEnvelope {
  readonly approvalId: StableId<"approval">;
  readonly approverId: string;
  readonly projectId: StableId<"project">;
  readonly missionId?: StableId<"mission">;
  readonly allowedEffectTypes: readonly string[];
  readonly allowedAdapterAccountIds: readonly string[];
  readonly allowedTargetIds: readonly string[];
  readonly payloadDigests?: readonly string[];
  readonly candidateRevisions?: readonly string[];
  readonly behavioralContractId?: string;
  readonly maximumRiskClass: RiskClass;
  readonly maximumChangeSize?: Readonly<Record<string, JsonValue>>;
  readonly allowedEnvironments: readonly string[];
  readonly requiredGates: readonly string[];
  readonly allowedRepairClasses: readonly string[];
  readonly nonMaterialDriftPolicy?: Readonly<Record<string, JsonValue>>;
  readonly preconditionSnapshotIds: readonly StableId<"preconditionSnapshot">[];
  readonly rollbackAuthorization?: readonly string[];
  readonly validFrom: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
  readonly quietHoursBehavior: "defer" | "continue_if_preapproved";
}

export interface ApprovalAssessmentContext {
  readonly at: string;
  readonly payloadDigest?: string;
  readonly environment?: string;
  readonly environmentRequired?: boolean;
  readonly behavioralContractId?: string;
  readonly changeSize?: Readonly<Record<string, number>>;
  readonly repairClass?: string;
  readonly repairClassRequired?: boolean;
  readonly preconditionSnapshotIds: readonly StableId<"preconditionSnapshot">[];
  readonly rollbackEffectType?: string;
  readonly drift?: { readonly material: boolean };
  readonly passedGates: readonly string[];
}

export interface ApprovalCoverage {
  readonly covered: boolean;
  readonly reasons: readonly string[];
}

export interface EffectTransitionContext {
  readonly reconciliationOutcome?: "applied" | "not_applied" | "inconclusive";
  readonly verifiedReceiptId?: StableId<"receipt">;
}

const allowedEffectTransitions: Readonly<Record<EffectState, readonly EffectState[]>> = {
  proposed: ["previewed", "invalidated"],
  previewed: ["authorized", "invalidated"],
  authorized: ["revalidating", "invalidated"],
  revalidating: ["executing", "failed", "invalidated"],
  executing: ["applied", "failed", "unknown_outcome"],
  applied: ["verifying", "failed", "unknown_outcome"],
  verifying: ["verified", "failed", "unknown_outcome"],
  verified: [],
  failed: ["rolled_back"],
  unknown_outcome: [
    "revalidating",
    "applied",
    "verifying",
    "failed",
    "rolled_back",
  ],
  rolled_back: [],
  invalidated: [],
};

export function transitionEffectState(
  current: EffectState,
  next: EffectState,
  context: EffectTransitionContext = {},
): EffectState {
  if (current === next) {
    return current;
  }
  if (
    current === "unknown_outcome" &&
    (context.reconciliationOutcome === undefined ||
      context.reconciliationOutcome === "inconclusive")
  ) {
    throw new Error("An unknown effect outcome must be reconciled before transition");
  }
  if (
    current === "unknown_outcome" &&
    context.reconciliationOutcome === "not_applied" &&
    !["revalidating", "failed", "rolled_back"].includes(next)
  ) {
    throw new Error("A not-applied reconciliation may only retry, fail, or roll back");
  }
  if (
    current === "unknown_outcome" &&
    context.reconciliationOutcome === "applied" &&
    !["applied", "verifying", "failed", "rolled_back"].includes(next)
  ) {
    throw new Error("An applied reconciliation cannot re-execute the effect");
  }
  if (!allowedEffectTransitions[current].includes(next)) {
    throw new Error(`Illegal effect transition: ${current} -> ${next}`);
  }
  if (next === "verified") {
    if (context.verifiedReceiptId === undefined) {
      throw new Error("A verified effect requires a persisted verified receipt");
    }
    parseStableId(context.verifiedReceiptId, "receipt");
  }
  return next;
}

export function parseEffectProposal(value: unknown): EffectProposal {
  const input = expectRecord(value, "effect");
  const targetInput = expectRecord(input.target, "effect.target");
  const candidateRevision = expectOptionalString(
    input.candidateRevision,
    "effect.candidateRevision",
  );
  const rollbackPlan =
    input.rollbackPlan === undefined
      ? undefined
      : expectArray(input.rollbackPlan, "effect.rollbackPlan").map(
          parseRollbackStep,
        );
  const evidenceIds = expectStringArray(
    input.evidenceIds,
    "effect.evidenceIds",
  ).map((id) => parseStableId(id, "evidence"));
  const verificationPlan = expectArray(
    input.verificationPlan,
    "effect.verificationPlan",
  ).map(parseVerificationStep);

  if (evidenceIds.length === 0) {
    throw new TypeError("effect.evidenceIds must contain at least one evidence identifier");
  }
  if (verificationPlan.length === 0) {
    throw new TypeError("effect.verificationPlan must contain at least one read-back step");
  }

  return {
    effectId: parseStableId(input.effectId, "effect"),
    missionId: parseStableId(input.missionId, "mission"),
    projectId: parseStableId(input.projectId, "project"),
    type: expectString(input.type, "effect.type"),
    adapterId: expectString(input.adapterId, "effect.adapterId"),
    adapterVersion: expectString(input.adapterVersion, "effect.adapterVersion"),
    adapterAccountId: expectString(
      input.adapterAccountId,
      "effect.adapterAccountId",
    ),
    target: {
      type: expectString(targetInput.type, "effect.target.type"),
      externalId: expectString(
        targetInput.externalId,
        "effect.target.externalId",
      ),
      displayName: expectString(
        targetInput.displayName,
        "effect.target.displayName",
      ),
    },
    payload: expectJsonValue(input.payload, "effect.payload"),
    preview: expectString(input.preview, "effect.preview"),
    riskClass: expectEnum(input.riskClass, riskClasses, "effect.riskClass"),
    rationale: expectString(input.rationale, "effect.rationale"),
    evidenceIds,
    ...(candidateRevision === undefined ? {} : { candidateRevision }),
    idempotencyKey: expectString(input.idempotencyKey, "effect.idempotencyKey"),
    requiredPreconditions: expectArray(
      input.requiredPreconditions,
      "effect.requiredPreconditions",
    ).map(parsePrecondition),
    verificationPlan,
    ...(rollbackPlan === undefined ? {} : { rollbackPlan }),
    proposedByRunId: parseStableId(input.proposedByRunId, "run"),
  };
}

export function parseApprovalEnvelope(value: unknown): ApprovalEnvelope {
  const input = expectRecord(value, "approval");
  const missionId =
    input.missionId === undefined
      ? undefined
      : parseStableId(input.missionId, "mission");
  const payloadDigests =
    input.payloadDigests === undefined
      ? undefined
      : expectStringArray(input.payloadDigests, "approval.payloadDigests");
  const candidateRevisions =
    input.candidateRevisions === undefined
      ? undefined
      : expectStringArray(input.candidateRevisions, "approval.candidateRevisions");
  const behavioralContractId = expectOptionalString(
    input.behavioralContractId,
    "approval.behavioralContractId",
  );
  const maximumChangeSize = parseOptionalJsonRecord(
    input.maximumChangeSize,
    "approval.maximumChangeSize",
  );
  const nonMaterialDriftPolicy = parseOptionalJsonRecord(
    input.nonMaterialDriftPolicy,
    "approval.nonMaterialDriftPolicy",
  );
  const rollbackAuthorization =
    input.rollbackAuthorization === undefined
      ? undefined
      : expectStringArray(
          input.rollbackAuthorization,
          "approval.rollbackAuthorization",
        );
  const validFrom = expectIsoTimestamp(input.validFrom, "approval.validFrom");
  const expiresAt = expectIsoTimestamp(input.expiresAt, "approval.expiresAt");
  const revokedAt = expectOptionalIsoTimestamp(
    input.revokedAt,
    "approval.revokedAt",
  );

  if (
    timestampMilliseconds(expiresAt, "approval.expiresAt") <=
    timestampMilliseconds(validFrom, "approval.validFrom")
  ) {
    throw new TypeError("approval.expiresAt must be later than approval.validFrom");
  }

  return {
    approvalId: parseStableId(input.approvalId, "approval"),
    approverId: expectString(input.approverId, "approval.approverId"),
    projectId: parseStableId(input.projectId, "project"),
    ...(missionId === undefined ? {} : { missionId }),
    allowedEffectTypes: expectStringArray(
      input.allowedEffectTypes,
      "approval.allowedEffectTypes",
    ),
    allowedAdapterAccountIds: expectStringArray(
      input.allowedAdapterAccountIds,
      "approval.allowedAdapterAccountIds",
    ),
    allowedTargetIds: expectStringArray(
      input.allowedTargetIds,
      "approval.allowedTargetIds",
    ),
    ...(payloadDigests === undefined ? {} : { payloadDigests }),
    ...(candidateRevisions === undefined ? {} : { candidateRevisions }),
    ...(behavioralContractId === undefined ? {} : { behavioralContractId }),
    maximumRiskClass: expectEnum(
      input.maximumRiskClass,
      riskClasses,
      "approval.maximumRiskClass",
    ),
    ...(maximumChangeSize === undefined ? {} : { maximumChangeSize }),
    allowedEnvironments: expectStringArray(
      input.allowedEnvironments,
      "approval.allowedEnvironments",
    ),
    requiredGates: expectStringArray(
      input.requiredGates,
      "approval.requiredGates",
    ),
    allowedRepairClasses: expectStringArray(
      input.allowedRepairClasses,
      "approval.allowedRepairClasses",
    ),
    ...(nonMaterialDriftPolicy === undefined ? {} : { nonMaterialDriftPolicy }),
    preconditionSnapshotIds: expectStringArray(
      input.preconditionSnapshotIds,
      "approval.preconditionSnapshotIds",
    ).map((id) => parseStableId(id, "preconditionSnapshot")),
    ...(rollbackAuthorization === undefined ? {} : { rollbackAuthorization }),
    validFrom,
    expiresAt,
    ...(revokedAt === undefined ? {} : { revokedAt }),
    quietHoursBehavior: expectEnum(
      input.quietHoursBehavior,
      ["defer", "continue_if_preapproved"] as const,
      "approval.quietHoursBehavior",
    ),
  };
}

export function assessApprovalCoverage(
  approval: ApprovalEnvelope,
  effect: EffectProposal,
  context: ApprovalAssessmentContext,
): ApprovalCoverage {
  expectIsoTimestamp(context.at, "approvalAssessment.at");
  const reasons: string[] = [];
  const assessedAt = timestampMilliseconds(context.at, "approvalAssessment.at");
  const validFrom = timestampMilliseconds(approval.validFrom, "approval.validFrom");
  const expiresAt = timestampMilliseconds(approval.expiresAt, "approval.expiresAt");

  if (assessedAt < validFrom) {
    reasons.push("approval_not_yet_valid");
  }
  if (assessedAt >= expiresAt) {
    reasons.push("approval_expired");
  }
  if (
    approval.revokedAt !== undefined &&
    assessedAt >= timestampMilliseconds(approval.revokedAt, "approval.revokedAt")
  ) {
    reasons.push("approval_revoked");
  }
  if (approval.projectId !== effect.projectId) {
    reasons.push("project_not_approved");
  }
  if (approval.missionId !== undefined && approval.missionId !== effect.missionId) {
    reasons.push("mission_not_approved");
  }
  if (!approval.allowedEffectTypes.includes(effect.type)) {
    reasons.push("effect_type_not_approved");
  }
  if (!approval.allowedAdapterAccountIds.includes(effect.adapterAccountId)) {
    reasons.push("adapter_account_not_approved");
  }
  if (!approval.allowedTargetIds.includes(effect.target.externalId)) {
    reasons.push("target_not_approved");
  }
  if (riskRank(effect.riskClass) > riskRank(approval.maximumRiskClass)) {
    reasons.push("risk_class_exceeds_approval");
  }
  if (
    approval.candidateRevisions !== undefined &&
    (effect.candidateRevision === undefined ||
      !approval.candidateRevisions.includes(effect.candidateRevision))
  ) {
    reasons.push("candidate_revision_not_approved");
  }
  const payloadDigest = canonicalJsonDigest(effect.payload);
  if (
    context.payloadDigest !== undefined &&
    context.payloadDigest !== payloadDigest
  ) {
    reasons.push("payload_digest_not_authoritative");
  }
  if (
    approval.payloadDigests !== undefined &&
    !approval.payloadDigests.includes(payloadDigest)
  ) {
    reasons.push("payload_digest_not_approved");
  }
  if (
    (context.environmentRequired === true ||
      approval.allowedEnvironments.length > 0) &&
    (context.environment === undefined ||
      !approval.allowedEnvironments.includes(context.environment))
  ) {
    reasons.push("environment_not_approved");
  }
  if (
    approval.behavioralContractId !== undefined &&
    approval.behavioralContractId !== context.behavioralContractId
  ) {
    reasons.push("behavioral_contract_not_approved");
  }
  if (approval.maximumChangeSize !== undefined) {
    if (context.changeSize === undefined) {
      reasons.push("change_size_not_supplied");
    } else if (exceedsChangeLimit(context.changeSize, approval.maximumChangeSize)) {
      reasons.push("change_size_exceeds_approval");
    }
  }
  if (
    (context.repairClassRequired === true || context.repairClass !== undefined) &&
    (context.repairClass === undefined ||
      !approval.allowedRepairClasses.includes(context.repairClass))
  ) {
    reasons.push("repair_class_not_approved");
  }
  if (
    effect.requiredPreconditions.length > 0 &&
    !sameStringSet(
      approval.preconditionSnapshotIds,
      context.preconditionSnapshotIds,
    )
  ) {
    reasons.push("precondition_snapshot_not_approved");
  }
  if (
    context.rollbackEffectType !== undefined &&
    !approval.rollbackAuthorization?.includes(context.rollbackEffectType)
  ) {
    reasons.push("rollback_not_approved");
  }
  if (context.drift?.material === true) {
    reasons.push("material_approval_drift");
  } else if (
    context.drift !== undefined &&
    approval.nonMaterialDriftPolicy === undefined
  ) {
    reasons.push("non_material_drift_not_approved");
  }

  const passedGates = new Set(context.passedGates);
  if (approval.requiredGates.some((gate) => !passedGates.has(gate))) {
    reasons.push("required_gate_missing");
  }
  if (effect.riskClass === "R4" && approval.missionId !== effect.missionId) {
    reasons.push("r4_requires_mission_bound_approval");
  }
  if (
    effect.riskClass === "R4" &&
    (approval.allowedEffectTypes.length !== 1 ||
      approval.allowedEffectTypes[0] !== effect.type)
  ) {
    reasons.push("r4_requires_exact_effect_type");
  }
  if (
    effect.riskClass === "R4" &&
    (approval.allowedAdapterAccountIds.length !== 1 ||
      approval.allowedAdapterAccountIds[0] !== effect.adapterAccountId)
  ) {
    reasons.push("r4_requires_exact_adapter_account");
  }
  if (
    effect.riskClass === "R4" &&
    (approval.allowedTargetIds.length !== 1 ||
      approval.allowedTargetIds[0] !== effect.target.externalId)
  ) {
    reasons.push("r4_requires_exact_target");
  }
  if (
    effect.riskClass === "R4" &&
    (approval.payloadDigests?.length !== 1 ||
      approval.payloadDigests[0] !== payloadDigest)
  ) {
    reasons.push("r4_requires_exact_payload_digest");
  }
  if (
    effect.riskClass === "R4" &&
    effect.candidateRevision !== undefined &&
    (approval.candidateRevisions?.length !== 1 ||
      approval.candidateRevisions[0] !== effect.candidateRevision)
  ) {
    reasons.push("r4_requires_exact_candidate_revision");
  }

  return {
    covered: reasons.length === 0,
    reasons,
  };
}

export function canonicalJsonDigest(value: JsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function parseVerificationRecord(value: unknown): VerificationRecord {
  const input = expectRecord(value, "verificationRecord");
  const result = expectEnum(
    input.result,
    ["passed"] as const,
    "verificationRecord.result",
  );
  const steps = expectArray(input.steps, "verificationRecord.steps").map(
    (step, index) => parseVerificationStepResult(step, index),
  );
  if (steps.length === 0) {
    throw new TypeError("verificationRecord.steps must contain at least one result");
  }
  if (new Set(steps.map((step) => step.stepIndex)).size !== steps.length) {
    throw new TypeError("verificationRecord.steps must use unique step indexes");
  }
  return { result, steps };
}

export function effectProposalDigest(proposal: EffectProposal): string {
  const { effectId: _effectId, ...semanticProposal } = proposal;
  return canonicalJsonDigest(semanticProposal as unknown as JsonValue);
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`)
    .join(",")}}`;
}

function parsePrecondition(value: unknown, index: number): PreconditionSpec {
  const path = `effect.requiredPreconditions[${index}]`;
  const input = expectRecord(value, path);
  return {
    type: expectString(input.type, `${path}.type`),
    sourceRef: expectString(input.sourceRef, `${path}.sourceRef`),
    expected: expectJsonValue(input.expected, `${path}.expected`),
  };
}

function parseVerificationStep(value: unknown, index: number): VerificationStep {
  const path = `effect.verificationPlan[${index}]`;
  const input = expectRecord(value, path);
  return {
    type: expectString(input.type, `${path}.type`),
    expected: expectJsonValue(input.expected, `${path}.expected`),
  };
}

function parseVerificationStepResult(
  value: unknown,
  index: number,
): VerificationStepResult {
  const path = `verificationRecord.steps[${index}]`;
  const input = expectRecord(value, path);
  const observed = expectJsonValue(input.observed, `${path}.observed`);
  const observedDigest = expectString(input.observedDigest, `${path}.observedDigest`);
  const evidenceIds = expectStringArray(input.evidenceIds, `${path}.evidenceIds`).map(
    (id) => parseStableId(id, "evidence"),
  );
  if (evidenceIds.length === 0) {
    throw new TypeError(`${path}.evidenceIds must contain at least one identifier`);
  }
  if (observedDigest !== canonicalJsonDigest(observed)) {
    throw new TypeError(`${path}.observedDigest must match the observed value`);
  }
  if (input.matched !== true) {
    throw new TypeError(`${path}.matched must be true`);
  }
  return {
    stepIndex: expectInteger(input.stepIndex, `${path}.stepIndex`, { minimum: 0 }),
    type: expectString(input.type, `${path}.type`),
    expected: expectJsonValue(input.expected, `${path}.expected`),
    observed,
    observedDigest,
    matched: true,
    observedAt: expectIsoTimestamp(input.observedAt, `${path}.observedAt`),
    evidenceIds,
  };
}

function parseRollbackStep(value: unknown, index: number): RollbackStep {
  const path = `effect.rollbackPlan[${index}]`;
  const input = expectRecord(value, path);
  return {
    type: expectString(input.type, `${path}.type`),
    payload: expectJsonValue(input.payload, `${path}.payload`),
    verification: parseNamedVerificationStep(
      input.verification,
      `${path}.verification`,
    ),
  };
}

function parseNamedVerificationStep(
  value: unknown,
  path: string,
): VerificationStep {
  const input = expectRecord(value, path);
  return {
    type: expectString(input.type, `${path}.type`),
    expected: expectJsonValue(input.expected, `${path}.expected`),
  };
}

function parseOptionalJsonRecord(
  value: unknown,
  path: string,
): Readonly<Record<string, JsonValue>> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = expectJsonValue(value, path);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new TypeError(`${path} must be a JSON object`);
  }
  return parsed as Readonly<Record<string, JsonValue>>;
}

function riskRank(riskClass: RiskClass): number {
  return riskClasses.indexOf(riskClass);
}

function sameStringSet(
  expected: readonly string[],
  actual: readonly string[],
): boolean {
  return (
    expected.length === actual.length &&
    expected.every((value) => actual.includes(value))
  );
}

function exceedsChangeLimit(
  actual: Readonly<Record<string, number>>,
  maximum: Readonly<Record<string, JsonValue>>,
): boolean {
  return Object.entries(maximum).some(([dimension, limit]) => {
    const actualValue = actual[dimension];
    return (
      typeof limit !== "number" ||
      actualValue === undefined ||
      !Number.isFinite(actualValue) ||
      actualValue > limit
    );
  });
}
