import { parseStableId, type StableId } from "./ids.ts";
import {
  expectArray,
  expectEnum,
  expectIsoTimestamp,
  expectOptionalIsoTimestamp,
  expectOptionalString,
  expectRecord,
  expectOnlyKeys,
  expectString,
  expectStringArray,
  timestampMilliseconds,
} from "./validation.ts";

export const missionStates = [
  "received",
  "triaging",
  "needs_input",
  "ready",
  "planning",
  "awaiting_approval",
  "executing",
  "verifying",
  "awaiting_external",
  "complete_for_scope",
  "failed",
  "cancelled",
] as const;

export const candidateStates = [
  "not_started",
  "workspace_ready",
  "modified",
  "locally_verified",
  "review_pending",
  "reviewed",
  "pr_open",
  "ci_pending",
  "merge_ready",
  "merged",
  "superseded",
  "abandoned",
] as const;

export const deploymentStates = [
  "not_configured",
  "not_deployed",
  "deployment_proposed",
  "authorized",
  "deploying",
  "deployed",
  "verifying",
  "verified",
  "failed",
  "unknown_outcome",
  "rolled_back",
] as const;

export const acceptanceStates = [
  "not_required",
  "pending",
  "running",
  "passed",
  "failed",
  "waived",
  "invalidated",
] as const;

export const effectStates = [
  "proposed",
  "previewed",
  "authorized",
  "revalidating",
  "executing",
  "applied",
  "verifying",
  "verified",
  "failed",
  "unknown_outcome",
  "rolled_back",
  "invalidated",
] as const;

export const trackerSemanticCategories = [
  "intake",
  "selected",
  "in_progress",
  "on_development",
  "ready_for_release",
  "released",
  "done",
  "rejected",
] as const;

export const businessCompletionStates = [
  "not_evaluated",
  "pending",
  "complete",
  "not_required",
] as const;

export type MissionState = (typeof missionStates)[number];
export type CandidateState = (typeof candidateStates)[number];
export type DeploymentState = (typeof deploymentStates)[number];
export type AcceptanceState = (typeof acceptanceStates)[number];
export type EffectState = (typeof effectStates)[number];
export type TrackerSemanticCategory = (typeof trackerSemanticCategories)[number];
export type BusinessCompletionState = (typeof businessCompletionStates)[number];

export interface VersionedReference<K extends string = string> {
  readonly id: K;
  readonly version: string;
}

export interface CandidateRevision {
  readonly repositoryId: StableId<"repository">;
  readonly worktreePath: string;
  readonly branch: string;
  readonly headSha: string;
  readonly evidenceIds: readonly StableId<"evidence">[];
}

/** Exact append-only observation. Record IDs retain the storage domain's generic prefix. */
export interface LifecycleObservation {
  readonly recordId: string;
  readonly observedAt: string;
}

export interface ObservedLifecycle {
  /** Absent for legacy packets or an explicitly unobserved default. */
  readonly observation?: LifecycleObservation;
}

export interface CandidateLifecycle extends ObservedLifecycle {
  readonly candidateId?: StableId<"candidate">;
  readonly state: CandidateState;
  readonly revision: CandidateRevision;
}

export interface DeploymentLifecycle extends ObservedLifecycle {
  readonly environment: string;
  /** Legacy 1.0.0 representation; new packets distinguish unknown explicitly. */
  readonly artifactDigest?: string;
  readonly artifactVersion?: { readonly status: "known"; readonly digest: string } | { readonly status: "unknown" };
  readonly state: DeploymentState;
}

export interface AcceptanceWaiver {
  readonly authority: string;
  readonly reason: string;
  readonly candidateRevision: string;
  readonly scope: string;
  readonly waivedAt: string;
  readonly expiresAt?: string;
  readonly tolerance?: string;
}

export interface NonWaivedAcceptanceLifecycle extends ObservedLifecycle {
  readonly state: Exclude<AcceptanceState, "waived">;
  readonly candidateRevision?: string;
  readonly evidenceIds?: readonly StableId<"evidence">[];
}

export interface WaivedAcceptanceLifecycle extends ObservedLifecycle {
  readonly state: "waived";
  readonly candidateRevision: string;
  readonly evidenceIds: readonly StableId<"evidence">[];
  readonly waiver: AcceptanceWaiver;
}

export type AcceptanceLifecycle =
  | NonWaivedAcceptanceLifecycle
  | WaivedAcceptanceLifecycle;

export interface TrackerLifecycle extends ObservedLifecycle {
  readonly sourceVersion?: string;
  readonly adapterId: string;
  readonly externalId: string;
  readonly nativeState: string;
  readonly semanticCategory?: TrackerSemanticCategory;
}

export interface EffectLifecycle {
  readonly effectId: StableId<"effect">;
  readonly state: EffectState;
}

export interface BusinessCompletionLifecycle extends ObservedLifecycle {
  readonly state: BusinessCompletionState;
  readonly evidenceIds?: readonly StableId<"evidence">[];
}

type NonCompleteMissionState = Exclude<MissionState, "complete_for_scope">;

export interface InProgressMissionLifecycle {
  readonly state: NonCompleteMissionState;
}

export interface CompletedMissionLifecycle {
  readonly state: "complete_for_scope";
  readonly completionContract: VersionedReference<StableId<"completionContract">>;
  readonly completionEvaluationId: StableId<"completionEvaluation">;
}

export type MissionLifecycle =
  | InProgressMissionLifecycle
  | CompletedMissionLifecycle;

export interface LifecycleVector {
  readonly mission: MissionLifecycle;
  readonly candidate?: CandidateLifecycle;
  readonly deployments: readonly DeploymentLifecycle[];
  readonly acceptance: AcceptanceLifecycle;
  readonly tracker?: TrackerLifecycle;
  readonly effects: readonly EffectLifecycle[];
  readonly businessCompletion: BusinessCompletionLifecycle;
}

export interface CompletionEvaluation {
  readonly evaluationId: StableId<"completionEvaluation">;
  readonly missionId: StableId<"mission">;
  readonly contract: VersionedReference<StableId<"completionContract">>;
  readonly status: "passed" | "failed";
  readonly evaluatedAt: string;
  readonly reasons: readonly string[];
  readonly disqualifiers: readonly string[];
  readonly requiredReceiptsVerified: boolean;
  readonly evidenceFreshnessVerified: boolean;
  readonly lifecycleDigest: string;
  readonly provenanceId: StableId<"provenance">;
}

export interface CompletionContractDefinition {
  readonly contract: VersionedReference<StableId<"completionContract">>;
  readonly allowedCandidateStates?: readonly CandidateState[];
  readonly allowedAcceptanceStates?: readonly AcceptanceState[];
  readonly requiredDeployments?: readonly {
    readonly environment: string;
    readonly allowedStates: readonly DeploymentState[];
    /** Optional exact release artifact; state alone cannot establish this match. */
    readonly artifactDigest?: string;
  }[];
  readonly allowedTrackerCategories?: readonly TrackerSemanticCategory[];
  readonly allowedBusinessCompletionStates?: readonly BusinessCompletionState[];
  readonly requireAllEffectsVerified: boolean;
}

export interface CompletionFacts {
  readonly evaluationId: StableId<"completionEvaluation">;
  readonly missionId: StableId<"mission">;
  readonly evaluatedAt: string;
  readonly requiredReceiptsVerified: boolean;
  readonly evidenceFreshnessVerified: boolean;
  readonly conflicts: readonly string[];
  readonly unresolvedFindings: readonly string[];
  readonly lifecycleDigest: string;
  readonly provenanceId: StableId<"provenance">;
}

const allowedMissionTransitions: Readonly<
  Record<MissionState, readonly MissionState[]>
> = {
  received: ["triaging", "cancelled", "failed"],
  triaging: ["needs_input", "ready", "cancelled", "failed"],
  needs_input: ["triaging", "planning", "cancelled", "failed"],
  ready: ["planning", "executing", "cancelled", "failed"],
  planning: ["needs_input", "awaiting_approval", "executing", "cancelled", "failed"],
  awaiting_approval: ["executing", "needs_input", "cancelled", "failed"],
  executing: [
    "awaiting_approval",
    "verifying",
    "needs_input",
    "awaiting_external",
    "cancelled",
    "failed",
  ],
  verifying: [
    "executing",
    "needs_input",
    "awaiting_external",
    "complete_for_scope",
    "cancelled",
    "failed",
  ],
  awaiting_external: ["executing", "verifying", "needs_input", "cancelled", "failed"],
  complete_for_scope: [],
  failed: [],
  cancelled: [],
};

export function transitionMissionState(
  current: MissionState,
  next: MissionState,
): MissionState {
  if (current === next) return current;
  if (!allowedMissionTransitions[current].includes(next)) {
    throw new Error(`Illegal mission transition: ${current} -> ${next}`);
  }
  return next;
}

export type CompletedLifecycleVector<T extends LifecycleVector> = Omit<
  T,
  "mission"
> & {
  readonly mission: CompletedMissionLifecycle;
};

export type CandidateUpdatedLifecycleVector<T extends LifecycleVector> = Omit<
  T,
  "candidate"
> & {
  readonly candidate: CandidateLifecycle;
};

export function parseLifecycleVector(value: unknown): LifecycleVector {
  const input = expectRecord(value, "lifecycle");
  const candidate =
    input.candidate === undefined
      ? undefined
      : parseCandidateLifecycle(input.candidate);
  const tracker =
    input.tracker === undefined ? undefined : parseTrackerLifecycle(input.tracker);

  return {
    mission: parseMissionLifecycle(input.mission),
    ...(candidate === undefined ? {} : { candidate }),
    deployments: expectArray(input.deployments, "lifecycle.deployments").map(
      parseDeploymentLifecycle,
    ),
    acceptance: parseAcceptanceLifecycle(input.acceptance),
    ...(tracker === undefined ? {} : { tracker }),
    effects: expectArray(input.effects, "lifecycle.effects").map(
      (effect, index) => {
        const record = expectRecord(effect, `lifecycle.effects[${index}]`);
        return {
          effectId: parseStableId(record.effectId, "effect"),
          state: expectEnum(
            record.state,
            effectStates,
            `lifecycle.effects[${index}].state`,
          ),
        };
      },
    ),
    businessCompletion: parseBusinessCompletion(input.businessCompletion),
  };
}

export function applyCompletionEvaluation<T extends LifecycleVector>(
  vector: T,
  evaluation: CompletionEvaluation,
): CompletedLifecycleVector<T> {
  if (evaluation.status !== "passed") {
    throw new Error("Completion evaluation did not pass");
  }

  if (evaluation.disqualifiers.length > 0) {
    throw new Error("Completion evaluation contains disqualifying conditions");
  }

  if (!evaluation.requiredReceiptsVerified) {
    throw new Error("Completion evaluation did not verify required receipts");
  }
  if (!evaluation.evidenceFreshnessVerified) {
    throw new Error("Completion evaluation did not verify evidence freshness");
  }

  if (vector.effects.some((effect) => effect.state === "unknown_outcome")) {
    throw new Error("Cannot complete a mission with an unknown effect outcome");
  }

  return {
    ...vector,
    mission: {
      state: "complete_for_scope",
      completionContract: evaluation.contract,
      completionEvaluationId: evaluation.evaluationId,
    },
  };
}

export function evaluateCompletionContract(
  contract: CompletionContractDefinition,
  vector: LifecycleVector,
  facts: CompletionFacts,
): CompletionEvaluation {
  expectIsoTimestamp(facts.evaluatedAt, "completionFacts.evaluatedAt");
  expectString(facts.lifecycleDigest, "completionFacts.lifecycleDigest");
  const disqualifiers: string[] = [];

  if (!facts.requiredReceiptsVerified) disqualifiers.push("missing_required_receipt");
  if (!facts.evidenceFreshnessVerified) disqualifiers.push("stale_or_unknown_evidence");
  if (facts.conflicts.length > 0) disqualifiers.push("unresolved_conflict");
  if (facts.unresolvedFindings.length > 0) {
    disqualifiers.push("unresolved_finding");
  }
  if (
    contract.requireAllEffectsVerified &&
    vector.effects.some((effect) => effect.state !== "verified")
  ) {
    disqualifiers.push("effect_not_verified");
  }
  if (
    contract.allowedCandidateStates !== undefined &&
    (vector.candidate === undefined ||
      !contract.allowedCandidateStates.includes(vector.candidate.state))
  ) {
    disqualifiers.push("candidate_state_not_satisfied");
  }
  if (
    contract.allowedAcceptanceStates !== undefined &&
    !contract.allowedAcceptanceStates.includes(vector.acceptance.state)
  ) {
    disqualifiers.push("acceptance_state_not_satisfied");
  }
  if (
    (vector.acceptance.state === "passed" ||
      vector.acceptance.state === "waived") &&
    (vector.candidate === undefined ||
      vector.acceptance.candidateRevision !== vector.candidate.revision.headSha)
  ) {
    disqualifiers.push("acceptance_candidate_mismatch");
  }
  for (const requirement of contract.requiredDeployments ?? []) {
    const deployment = vector.deployments.find(
      (candidate) => candidate.environment === requirement.environment,
    );
    if (
      deployment === undefined ||
      !requirement.allowedStates.includes(deployment.state)
    ) {
      disqualifiers.push(`deployment_state_not_satisfied:${requirement.environment}`);
    }
    const artifactDigest = deployment?.artifactVersion === undefined
      ? deployment?.artifactDigest
      : deployment.artifactVersion.status === "known" ? deployment.artifactVersion.digest : undefined;
    if (deployment && ["deployed", "verifying", "verified", "rolled_back"].includes(deployment.state)
      && (artifactDigest === undefined || artifactDigest.trim().length === 0)) {
      disqualifiers.push(`deployment_artifact_unknown:${requirement.environment}`);
    }
    if (requirement.artifactDigest !== undefined) {
      expectString(requirement.artifactDigest, "completionContract.requiredDeployments.artifactDigest");
      if (artifactDigest !== requirement.artifactDigest) {
        disqualifiers.push(`deployment_artifact_mismatch:${requirement.environment}`);
      }
    }
  }
  if (
    contract.allowedTrackerCategories !== undefined &&
    (vector.tracker?.semanticCategory === undefined ||
      !contract.allowedTrackerCategories.includes(vector.tracker.semanticCategory))
  ) {
    disqualifiers.push("tracker_state_not_satisfied");
  }
  if (
    contract.allowedBusinessCompletionStates !== undefined &&
    !contract.allowedBusinessCompletionStates.includes(vector.businessCompletion.state)
  ) {
    disqualifiers.push("business_completion_not_satisfied");
  }
  if (
    vector.acceptance.state === "waived" &&
    vector.acceptance.waiver.expiresAt !== undefined &&
    timestampMilliseconds(
      vector.acceptance.waiver.expiresAt,
      "lifecycle.acceptance.waiver.expiresAt",
    ) <= timestampMilliseconds(facts.evaluatedAt, "completionFacts.evaluatedAt")
  ) {
    disqualifiers.push("acceptance_waiver_expired");
  }

  return {
    evaluationId: facts.evaluationId,
    missionId: facts.missionId,
    contract: contract.contract,
    status: disqualifiers.length === 0 ? "passed" : "failed",
    evaluatedAt: facts.evaluatedAt,
    reasons:
      disqualifiers.length === 0
        ? ["All pinned completion contract conditions passed."]
        : disqualifiers.map((reason) => `Completion blocked: ${reason}.`),
    disqualifiers,
    requiredReceiptsVerified: facts.requiredReceiptsVerified,
    evidenceFreshnessVerified: facts.evidenceFreshnessVerified,
    lifecycleDigest: facts.lifecycleDigest,
    provenanceId: facts.provenanceId,
  };
}

export function recordCandidateState<T extends LifecycleVector>(
  vector: T,
  candidate: CandidateLifecycle,
): CandidateUpdatedLifecycleVector<T> {
  return {
    ...vector,
    candidate,
  };
}

function parseMissionLifecycle(value: unknown): MissionLifecycle {
  const input = expectRecord(value, "lifecycle.mission");
  const state = expectEnum(input.state, missionStates, "lifecycle.mission.state");
  if (state !== "complete_for_scope") return { state };

  const contract = expectRecord(
    input.completionContract,
    "lifecycle.mission.completionContract",
  );
  return {
    state,
    completionContract: {
      id: parseStableId(contract.id, "completionContract"),
      version: expectString(
        contract.version,
        "lifecycle.mission.completionContract.version",
      ),
    },
    completionEvaluationId: parseStableId(
      input.completionEvaluationId,
      "completionEvaluation",
    ),
  };
}

function parseCandidateLifecycle(value: unknown): CandidateLifecycle {
  const input = expectRecord(value, "lifecycle.candidate");
  const revision = expectRecord(
    input.revision,
    "lifecycle.candidate.revision",
  );
  const evidenceIds = expectStringArray(
    revision.evidenceIds,
    "lifecycle.candidate.revision.evidenceIds",
  ).map((id) => parseStableId(id, "evidence"));
  if (evidenceIds.length === 0) {
    throw new TypeError("lifecycle.candidate.revision.evidenceIds cannot be empty");
  }
  const headSha = expectString(
    revision.headSha,
    "lifecycle.candidate.revision.headSha",
  );
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(headSha)) {
    throw new TypeError("lifecycle.candidate.revision.headSha must be a Git SHA");
  }

  return {
    ...parseObservation(input, "lifecycle.candidate"),
    ...(input.candidateId === undefined ? {} : { candidateId: parseStableId(input.candidateId, "candidate") }),
    state: expectEnum(input.state, candidateStates, "lifecycle.candidate.state"),
    revision: {
      repositoryId: parseStableId(revision.repositoryId, "repository"),
      worktreePath: expectString(
        revision.worktreePath,
        "lifecycle.candidate.revision.worktreePath",
      ),
      branch: expectString(revision.branch, "lifecycle.candidate.revision.branch"),
      headSha,
      evidenceIds,
    },
  };
}

function parseDeploymentLifecycle(
  value: unknown,
  index: number,
): DeploymentLifecycle {
  const path = `lifecycle.deployments[${index}]`;
  const input = expectRecord(value, path);
  const artifactDigest = expectOptionalString(
    input.artifactDigest,
    `${path}.artifactDigest`,
  );
  return {
    ...parseObservation(input, path),
    ...(input.artifactVersion === undefined ? {} : { artifactVersion: parseArtifactVersion(input.artifactVersion, path) }),
    environment: expectString(input.environment, `${path}.environment`),
    ...(artifactDigest === undefined ? {} : { artifactDigest }),
    state: expectEnum(input.state, deploymentStates, `${path}.state`),
  };
}

function parseArtifactVersion(value: unknown, path: string): NonNullable<DeploymentLifecycle["artifactVersion"]> {
  const version = expectRecord(value, `${path}.artifactVersion`);
  const status = expectEnum(version.status, ["known", "unknown"] as const, `${path}.artifactVersion.status`);
  expectOnlyKeys(version, status === "known" ? ["status", "digest"] : ["status"], `${path}.artifactVersion`);
  return status === "unknown" ? { status } : { status, digest: expectString(version.digest, `${path}.artifactVersion.digest`) };
}

function parseAcceptanceLifecycle(value: unknown): AcceptanceLifecycle {
  const input = expectRecord(value, "lifecycle.acceptance");
  const state = expectEnum(
    input.state,
    acceptanceStates,
    "lifecycle.acceptance.state",
  );
  const candidateRevision = expectOptionalString(
    input.candidateRevision,
    "lifecycle.acceptance.candidateRevision",
  );
  const evidenceIds =
    input.evidenceIds === undefined
      ? undefined
      : expectStringArray(
          input.evidenceIds,
          "lifecycle.acceptance.evidenceIds",
        ).map((id) => parseStableId(id, "evidence"));

  if (state === "waived") {
    if (candidateRevision === undefined || evidenceIds === undefined) {
      throw new TypeError("waived acceptance requires candidate and evidence");
    }
    const waiver = expectRecord(input.waiver, "lifecycle.acceptance.waiver");
    const waivedAt = expectIsoTimestamp(
      waiver.waivedAt,
      "lifecycle.acceptance.waiver.waivedAt",
    );
    const expiresAt = expectOptionalIsoTimestamp(
      waiver.expiresAt,
      "lifecycle.acceptance.waiver.expiresAt",
    );
    if (
      expiresAt !== undefined &&
      timestampMilliseconds(expiresAt, "lifecycle.acceptance.waiver.expiresAt") <=
        timestampMilliseconds(waivedAt, "lifecycle.acceptance.waiver.waivedAt")
    ) {
      throw new TypeError("acceptance waiver expiry must follow its timestamp");
    }
    const waiverCandidate = expectString(
      waiver.candidateRevision,
      "lifecycle.acceptance.waiver.candidateRevision",
    );
    if (waiverCandidate !== candidateRevision) {
      throw new TypeError("acceptance waiver must name the exact candidate");
    }
    const tolerance = expectOptionalString(
      waiver.tolerance,
      "lifecycle.acceptance.waiver.tolerance",
    );
    return {
      ...parseObservation(input, "lifecycle.acceptance"),
      state,
      candidateRevision,
      evidenceIds,
      waiver: {
        authority: expectString(
          waiver.authority,
          "lifecycle.acceptance.waiver.authority",
        ),
        reason: expectString(waiver.reason, "lifecycle.acceptance.waiver.reason"),
        candidateRevision: waiverCandidate,
        scope: expectString(waiver.scope, "lifecycle.acceptance.waiver.scope"),
        waivedAt,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(tolerance === undefined ? {} : { tolerance }),
      },
    };
  }

  if (input.waiver !== undefined) {
    throw new TypeError("only waived acceptance may carry a waiver");
  }
  if (
    state === "passed" &&
    (candidateRevision === undefined || evidenceIds === undefined || evidenceIds.length === 0)
  ) {
    throw new TypeError("passed acceptance requires an exact candidate and evidence");
  }
  return {
    ...parseObservation(input, "lifecycle.acceptance"),
    state,
    ...(candidateRevision === undefined ? {} : { candidateRevision }),
    ...(evidenceIds === undefined ? {} : { evidenceIds }),
  };
}

function parseTrackerLifecycle(value: unknown): TrackerLifecycle {
  const input = expectRecord(value, "lifecycle.tracker");
  const semanticCategory =
    input.semanticCategory === undefined
      ? undefined
      : expectEnum(
          input.semanticCategory,
          trackerSemanticCategories,
          "lifecycle.tracker.semanticCategory",
        );
  return {
    ...parseObservation(input, "lifecycle.tracker"),
    ...(input.sourceVersion === undefined ? {} : { sourceVersion: expectString(input.sourceVersion, "lifecycle.tracker.sourceVersion") }),
    adapterId: expectString(input.adapterId, "lifecycle.tracker.adapterId"),
    externalId: expectString(input.externalId, "lifecycle.tracker.externalId"),
    nativeState: expectString(input.nativeState, "lifecycle.tracker.nativeState"),
    ...(semanticCategory === undefined ? {} : { semanticCategory }),
  };
}

function parseBusinessCompletion(value: unknown): BusinessCompletionLifecycle {
  const input = expectRecord(value, "lifecycle.businessCompletion");
  const evidenceIds =
    input.evidenceIds === undefined
      ? undefined
      : expectStringArray(
          input.evidenceIds,
          "lifecycle.businessCompletion.evidenceIds",
        ).map((id) => parseStableId(id, "evidence"));
  return {
    ...parseObservation(input, "lifecycle.businessCompletion"),
    state: expectEnum(
      input.state,
      businessCompletionStates,
      "lifecycle.businessCompletion.state",
    ),
    ...(evidenceIds === undefined ? {} : { evidenceIds }),
  };
}

function parseObservation(input: Record<string, unknown>, path: string): ObservedLifecycle {
  if (input.observation === undefined) return {};
  const observation = expectRecord(input.observation, `${path}.observation`);
  expectOnlyKeys(observation, ["recordId", "observedAt"], `${path}.observation`);
  const recordId = expectString(observation.recordId, `${path}.observation.recordId`);
  // Matches acp.stable_id; historical lifecycle records are not all event IDs.
  if (!/^[a-z][a-z0-9]{2,4}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(recordId)) {
    throw new TypeError(`${path}.observation.recordId must be a stable record identifier`);
  }
  return { observation: { recordId, observedAt: expectIsoTimestamp(observation.observedAt, `${path}.observation.observedAt`) } };
}

/** Version-specific packet guarantees, separate from legacy lifecycle consumers. */
export function assertLifecyclePacketVersion(vector: LifecycleVector, schemaVersion: string): void {
  const observed = [vector.candidate, ...vector.deployments, vector.acceptance, vector.tracker, vector.businessCompletion];
  if (schemaVersion === "1.0.0") {
    if (observed.some((item) => item?.observation !== undefined) || vector.candidate?.candidateId !== undefined || vector.tracker?.sourceVersion !== undefined
      || vector.deployments.some((item) => item.artifactVersion !== undefined)) {
      throw new TypeError("legacy context lifecycle cannot carry 1.1.0 identity fields");
    }
    return;
  }
  if (vector.candidate && (!vector.candidate.observation || !vector.candidate.candidateId)) {
    throw new TypeError("context lifecycle candidate requires observation and candidate identity");
  }
  if (vector.deployments.some((item) => !item.observation || !item.artifactVersion || item.artifactDigest !== undefined)
    || new Set(vector.deployments.map((item) => item.environment)).size !== vector.deployments.length
    || new Set(vector.deployments.map((item) => item.observation?.recordId)).size !== vector.deployments.length) {
    throw new TypeError("context lifecycle deployments require unique environment and observation identity");
  }
  if (vector.tracker && (!vector.tracker.observation || !vector.tracker.sourceVersion)) {
    throw new TypeError("context lifecycle tracker requires observation and source version");
  }
}
