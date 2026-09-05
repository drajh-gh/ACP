import { parseClaim, type Claim } from "./claims.ts";
import {
  canonicalJsonDigest,
  parseEffectProposal,
  type EffectProposal,
} from "./effects.ts";
import { parseStableId, type StableId } from "./ids.ts";
import {
  parseLifecycleVector,
  assertLifecyclePacketVersion,
  type LifecycleVector,
  type VersionedReference,
} from "./lifecycle.ts";
import {
  expectArray,
  expectEnum,
  expectInteger,
  expectIsoTimestamp,
  expectJsonValue,
  expectOnlyKeys,
  expectOptionalString,
  expectRecord,
  expectString,
  expectStringArray,
  timestampMilliseconds,
  type JsonValue,
} from "./validation.ts";
import { workerRoles, type WorkerRole } from "./workflows.ts";

export const capabilityModes = ["read", "write"] as const;
export type CapabilityMode = (typeof capabilityModes)[number];
export const workerResourceClasses = [
  "cpu_intensive",
  "moderate_compute",
  "lightweight_read",
  "network_bound",
] as const;
export type WorkerResourceClass = (typeof workerResourceClasses)[number];

export interface CapabilityGrant {
  readonly grantId: StableId<"capabilityGrant">;
  readonly evaluationId: StableId<"capabilityGrantEvaluation">;
  readonly missionId: StableId<"mission">;
  readonly nodeId: StableId<"node">;
  readonly projectId: StableId<"project">;
  readonly role: WorkerRole;
  readonly resourceClass: WorkerResourceClass;
  readonly allowedOperations: readonly string[];
  readonly allowedResources: readonly string[];
  readonly mode: CapabilityMode;
  readonly workspace: string;
  readonly networkDestinations: readonly string[];
  readonly validFrom: string;
  readonly expiresAt: string;
  readonly maximumAttempts: number;
  readonly attemptsUsed: number;
}

export interface CapabilityRequest {
  readonly missionId: StableId<"mission">;
  readonly nodeId: StableId<"node">;
  readonly projectId: StableId<"project">;
  readonly role: WorkerRole;
  readonly resourceClass: WorkerResourceClass;
  readonly operation: string;
  readonly resource: string;
  readonly mode: CapabilityMode;
  readonly workspace: string;
  readonly networkAccess: "none" | "required";
  readonly networkDestination?: string;
  readonly at: string;
}

export interface CapabilityAssessment {
  readonly allowed: boolean;
  readonly reasons: readonly string[];
}

export interface GlobalRuntimeControl {
  readonly scopeType: "global";
  readonly scopeId: "global";
  readonly effectsPaused: boolean;
  readonly reason: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
  readonly authorizationId?: StableId<"runtimeControlAuthorization">;
}

export interface ProjectRuntimeControl {
  readonly scopeType: "project";
  readonly scopeId: StableId<"project">;
  readonly effectsPaused: boolean;
  readonly reason: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
  readonly authorizationId?: StableId<"runtimeControlAuthorization">;
}

export interface RuntimeControlAssessment {
  readonly allowed: boolean;
  readonly reasons: readonly string[];
}

export interface EvidenceSummary {
  readonly evidenceId: StableId<"evidence">;
  readonly contentHash: string;
  readonly summary: string;
}

export const contextPacketSchemaVersion = "1.1.0";
export const supportedContextPacketSchemaVersions: readonly string[] = ["1.0.0", contextPacketSchemaVersion];
export const workerResultSchemaVersion = "1.0.0";
export const workerResultOutputSchemaId = "acp.worker-result@1.0.0";
export const maximumContextPacketBytes = 262_144;
export const maximumWorkerResultBytes = 262_144;

export const findingSeverities = ["info", "low", "medium", "high", "critical"] as const;
export type FindingSeverity = (typeof findingSeverities)[number];

export interface WorkerFinding {
  readonly code: string;
  readonly severity: FindingSeverity;
  readonly summary: string;
  readonly evidenceIds: readonly StableId<"evidence">[];
}

export interface PreviousWorkerResultReference {
  readonly runId: StableId<"run">;
  readonly status: WorkerResultStatus;
  readonly resultDigest: string;
  readonly conclusion: string;
}

export interface WorkerLimits {
  readonly wallTimeMs: number;
  readonly maximumTurns: number;
  readonly maximumOutputBytes: number;
  readonly maximumModelTokens?: number;
}

export interface ContextPacketContent {
  readonly contextPacketId: StableId<"contextPacket">;
  readonly schemaVersion: string;
  readonly missionId: StableId<"mission">;
  readonly nodeId: StableId<"node">;
  readonly projectId: StableId<"project">;
  readonly nodeType: string;
  readonly workerRole: WorkerRole;
  readonly objective: string;
  readonly nonGoals: readonly string[];
  readonly completionScope: string;
  readonly projectProfile: VersionedReference<StableId<"projectProfile">>;
  readonly workflow: VersionedReference<StableId<"workflow">>;
  readonly policy: VersionedReference<StableId<"policy">>;
  readonly completionContract: VersionedReference<StableId<"completionContract">>;
  readonly lifecycle: LifecycleVector;
  readonly behavioralContract: Readonly<Record<string, JsonValue>>;
  readonly acceptanceCriteria: readonly string[];
  readonly sourceAuthorityRules: Readonly<Record<string, JsonValue>>;
  readonly evidence: readonly EvidenceSummary[];
  readonly activeClaimIds: readonly StableId<"claim">[];
  readonly conflicts: readonly string[];
  readonly unresolvedQuestions: readonly string[];
  readonly previousResultRefs: readonly PreviousWorkerResultReference[];
  readonly approvalIds: readonly StableId<"approval">[];
  readonly capabilityGrantId: StableId<"capabilityGrant">;
  readonly requiredOutputSchema: typeof workerResultOutputSchemaId;
  readonly nextAction: string;
  readonly retryCount: number;
  readonly limits: WorkerLimits;
}

export interface ContextPacket extends ContextPacketContent {
  readonly digest: string;
}

export type WorkerResultStatus =
  | "succeeded"
  | "failed"
  | "needs_input"
  | "cancelled";

export interface WorkerResourceUsage {
  readonly wallMilliseconds: number;
  readonly outputBytes: number;
}

export interface WorkerModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
}

export interface WorkerResultContent {
  readonly schemaVersion: string;
  readonly runId: StableId<"run">;
  readonly missionId: StableId<"mission">;
  readonly nodeId: StableId<"node">;
  readonly projectId: StableId<"project">;
  readonly contextPacketId: StableId<"contextPacket">;
  readonly contextPacketDigest: string;
  readonly attemptNumber: number;
  readonly workerRole: WorkerRole;
  readonly status: WorkerResultStatus;
  readonly conclusion: string;
  readonly evidenceIds: readonly StableId<"evidence">[];
  readonly claimsProduced: readonly Claim[];
  readonly challengedClaimIds: readonly StableId<"claim">[];
  readonly artifactIds: readonly StableId<"artifact">[];
  readonly candidateRevision?: string;
  readonly findings: readonly WorkerFinding[];
  readonly proposedEffects: readonly EffectProposal[];
  readonly risks: readonly string[];
  readonly unresolvedQuestions: readonly string[];
  readonly suggestedNextNodeTypes: readonly string[];
  readonly resourceUsage: WorkerResourceUsage;
  readonly modelUsage: WorkerModelUsage;
}

export interface WorkerResult extends WorkerResultContent {
  readonly digest: string;
}

const contextPacketKeys = [
  "contextPacketId",
  "schemaVersion",
  "missionId",
  "nodeId",
  "projectId",
  "nodeType",
  "workerRole",
  "objective",
  "nonGoals",
  "completionScope",
  "projectProfile",
  "workflow",
  "policy",
  "completionContract",
  "lifecycle",
  "behavioralContract",
  "acceptanceCriteria",
  "sourceAuthorityRules",
  "evidence",
  "activeClaimIds",
  "conflicts",
  "unresolvedQuestions",
  "previousResultRefs",
  "approvalIds",
  "capabilityGrantId",
  "requiredOutputSchema",
  "nextAction",
  "retryCount",
  "limits",
  "digest",
] as const;

const workerResultKeys = [
  "schemaVersion",
  "runId",
  "missionId",
  "nodeId",
  "projectId",
  "contextPacketId",
  "contextPacketDigest",
  "attemptNumber",
  "workerRole",
  "status",
  "conclusion",
  "evidenceIds",
  "claimsProduced",
  "challengedClaimIds",
  "artifactIds",
  "candidateRevision",
  "findings",
  "proposedEffects",
  "risks",
  "unresolvedQuestions",
  "suggestedNextNodeTypes",
  "resourceUsage",
  "modelUsage",
  "digest",
] as const;

export interface RuntimeProvenance {
  readonly provenanceId: StableId<"provenance">;
  readonly workflowBindingId: StableId<"workflowBinding">;
  readonly workflowId: StableId<"workflow">;
  readonly projectProfileId: StableId<"projectProfile">;
  readonly completionContractId: StableId<"completionContract">;
  readonly policyId: StableId<"policy">;
  readonly adapterId: StableId<"adapter">;
  readonly sourceRepositoryCommit: string;
  readonly artifactDigest: string;
  readonly serviceInstance: string;
  readonly serviceVersion: string;
  readonly codexPluginVersion: string;
  readonly workerImplementationVersion: string;
  readonly workflowVersion: string;
  readonly policyVersion: string;
  readonly projectProfileVersion: string;
  readonly completionContractVersion: string;
  readonly adapterVersion: string;
  readonly apiVersion: string;
  readonly databaseSchemaVersion: string;
  readonly modelIdentifier: string;
  readonly modelConfiguration: Readonly<Record<string, JsonValue>>;
  readonly contextPacketSchemaVersion: string;
  readonly contextPacketDigest: string;
  readonly credentialReferenceVersion: string;
  readonly hostIdentifier: string;
  readonly executionEnvironment: string;
}

export function parseContextPacket(value: unknown): ContextPacket {
  const input = expectRecord(value, "contextPacket");
  expectOnlyKeys(input, contextPacketKeys, "contextPacket");
  const packet: ContextPacket = {
    contextPacketId: parseStableId(input.contextPacketId, "contextPacket"),
    schemaVersion: expectString(input.schemaVersion, "contextPacket.schemaVersion"),
    missionId: parseStableId(input.missionId, "mission"),
    nodeId: parseStableId(input.nodeId, "node"),
    projectId: parseStableId(input.projectId, "project"),
    nodeType: expectString(input.nodeType, "contextPacket.nodeType"),
    workerRole: expectEnum(
      input.workerRole,
      workerRoles,
      "contextPacket.workerRole",
    ),
    objective: expectString(input.objective, "contextPacket.objective"),
    nonGoals: expectStringArray(input.nonGoals, "contextPacket.nonGoals"),
    completionScope: expectString(
      input.completionScope,
      "contextPacket.completionScope",
    ),
    projectProfile: parseVersionedReference(
      input.projectProfile,
      "projectProfile",
      "contextPacket.projectProfile",
    ),
    workflow: parseVersionedReference(
      input.workflow,
      "workflow",
      "contextPacket.workflow",
    ),
    policy: parseVersionedReference(
      input.policy,
      "policy",
      "contextPacket.policy",
    ),
    completionContract: parseVersionedReference(
      input.completionContract,
      "completionContract",
      "contextPacket.completionContract",
    ),
    lifecycle: parseLifecycleVector(input.lifecycle),
    behavioralContract: parseJsonObject(
      input.behavioralContract,
      "contextPacket.behavioralContract",
    ),
    acceptanceCriteria: expectStringArray(
      input.acceptanceCriteria,
      "contextPacket.acceptanceCriteria",
    ),
    sourceAuthorityRules: parseJsonObject(
      input.sourceAuthorityRules,
      "contextPacket.sourceAuthorityRules",
    ),
    evidence: expectArray(input.evidence, "contextPacket.evidence").map(
      parseEvidenceSummary,
    ),
    activeClaimIds: expectStringArray(
      input.activeClaimIds,
      "contextPacket.activeClaimIds",
    ).map((id) => parseStableId(id, "claim")),
    conflicts: expectStringArray(input.conflicts, "contextPacket.conflicts"),
    unresolvedQuestions: expectStringArray(
      input.unresolvedQuestions,
      "contextPacket.unresolvedQuestions",
    ),
    previousResultRefs: expectArray(
      input.previousResultRefs,
      "contextPacket.previousResultRefs",
    ).map(parsePreviousWorkerResultReference),
    approvalIds: expectStringArray(
      input.approvalIds,
      "contextPacket.approvalIds",
    ).map((id) => parseStableId(id, "approval")),
    capabilityGrantId: parseStableId(
      input.capabilityGrantId,
      "capabilityGrant",
    ),
    requiredOutputSchema: parseRequiredOutputSchema(input.requiredOutputSchema),
    nextAction: expectString(input.nextAction, "contextPacket.nextAction"),
    retryCount: expectInteger(input.retryCount, "contextPacket.retryCount", {
      minimum: 0,
    }),
    limits: parseWorkerLimits(input.limits),
    digest: expectString(input.digest, "contextPacket.digest"),
  };
  if (!supportedContextPacketSchemaVersions.includes(packet.schemaVersion)) {
    throw new TypeError(
      `contextPacket.schemaVersion must be supported (${supportedContextPacketSchemaVersions.join(", ")})`,
    );
  }
  assertLifecyclePacketVersion(packet.lifecycle, packet.schemaVersion);
  const { digest: _digest, ...content } = packet;
  if (packet.digest !== contextPacketDigest(content)) {
    throw new TypeError("contextPacket.digest does not match its content");
  }
  if (jsonByteLength(packet) > maximumContextPacketBytes) {
    throw new TypeError(
      `contextPacket exceeds ${maximumContextPacketBytes} bytes`,
    );
  }
  return packet;
}

export function createContextPacket(content: ContextPacketContent): ContextPacket {
  if (!supportedContextPacketSchemaVersions.includes(content.schemaVersion)) {
    throw new TypeError(
      `contextPacket.schemaVersion must be supported (${supportedContextPacketSchemaVersions.join(", ")})`,
    );
  }
  return parseContextPacket({
    ...content,
    digest: contextPacketDigest(content),
  });
}

export function contextPacketDigest(content: ContextPacketContent): string {
  return canonicalJsonDigest(content as unknown as JsonValue);
}

export function parseWorkerResult(value: unknown): WorkerResult {
  const input = expectRecord(value, "workerResult");
  expectOnlyKeys(input, workerResultKeys, "workerResult");
  const candidateRevision = expectOptionalString(
    input.candidateRevision,
    "workerResult.candidateRevision",
  );
  if (
    candidateRevision !== undefined &&
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(candidateRevision)
  ) {
    throw new TypeError(
      "workerResult.candidateRevision must be a full lowercase Git object ID",
    );
  }
  const result: WorkerResult = {
    schemaVersion: expectString(
      input.schemaVersion,
      "workerResult.schemaVersion",
    ),
    runId: parseStableId(input.runId, "run"),
    missionId: parseStableId(input.missionId, "mission"),
    nodeId: parseStableId(input.nodeId, "node"),
    projectId: parseStableId(input.projectId, "project"),
    contextPacketId: parseStableId(input.contextPacketId, "contextPacket"),
    contextPacketDigest: expectString(
      input.contextPacketDigest,
      "workerResult.contextPacketDigest",
    ),
    attemptNumber: expectInteger(
      input.attemptNumber,
      "workerResult.attemptNumber",
      { minimum: 1 },
    ),
    workerRole: expectEnum(
      input.workerRole,
      workerRoles,
      "workerResult.workerRole",
    ),
    status: expectEnum(
      input.status,
      ["succeeded", "failed", "needs_input", "cancelled"] as const,
      "workerResult.status",
    ),
    conclusion: expectString(input.conclusion, "workerResult.conclusion"),
    evidenceIds: expectStringArray(
      input.evidenceIds,
      "workerResult.evidenceIds",
    ).map((id) => parseStableId(id, "evidence")),
    claimsProduced: expectArray(
      input.claimsProduced,
      "workerResult.claimsProduced",
    ).map(parseClaim),
    challengedClaimIds: expectStringArray(
      input.challengedClaimIds,
      "workerResult.challengedClaimIds",
    ).map((id) => parseStableId(id, "claim")),
    artifactIds: expectStringArray(
      input.artifactIds,
      "workerResult.artifactIds",
    ).map((id) => parseStableId(id, "artifact")),
    ...(candidateRevision === undefined ? {} : { candidateRevision }),
    findings: expectArray(input.findings, "workerResult.findings").map(
      parseWorkerFinding,
    ),
    proposedEffects: expectArray(
      input.proposedEffects,
      "workerResult.proposedEffects",
    ).map(parseEffectProposal),
    risks: expectStringArray(input.risks, "workerResult.risks"),
    unresolvedQuestions: expectStringArray(
      input.unresolvedQuestions,
      "workerResult.unresolvedQuestions",
    ),
    suggestedNextNodeTypes: expectStringArray(
      input.suggestedNextNodeTypes,
      "workerResult.suggestedNextNodeTypes",
    ),
    resourceUsage: parseWorkerResourceUsage(input.resourceUsage),
    modelUsage: parseWorkerModelUsage(input.modelUsage),
    digest: expectString(input.digest, "workerResult.digest"),
  };
  if (result.schemaVersion !== workerResultSchemaVersion) {
    throw new TypeError(
      `workerResult.schemaVersion must be ${workerResultSchemaVersion}`,
    );
  }
  if (
    result.workerRole === "delivery" &&
    result.status === "succeeded" &&
    result.candidateRevision === undefined
  ) {
    throw new TypeError(
      "successful delivery workerResult requires candidateRevision",
    );
  }
  for (const claim of result.claimsProduced) {
    if (claim.createdByRunId !== result.runId) {
      throw new TypeError("workerResult claim was produced by a different run");
    }
    if (claim.projectId !== undefined && claim.projectId !== result.projectId) {
      throw new TypeError("workerResult claim belongs to a different project");
    }
  }
  for (const effect of result.proposedEffects) {
    if (
      effect.proposedByRunId !== result.runId ||
      effect.missionId !== result.missionId ||
      effect.projectId !== result.projectId
    ) {
      throw new TypeError("workerResult effect belongs to a different run context");
    }
  }
  const { digest: _digest, ...content } = result;
  if (result.digest !== workerResultDigest(content)) {
    throw new TypeError("workerResult.digest does not match its content");
  }
  if (jsonByteLength(result) > maximumWorkerResultBytes) {
    throw new TypeError(`workerResult exceeds ${maximumWorkerResultBytes} bytes`);
  }
  return result;
}

export function createWorkerResult(content: WorkerResultContent): WorkerResult {
  if (content.schemaVersion !== workerResultSchemaVersion) {
    throw new TypeError(
      `workerResult.schemaVersion must be ${workerResultSchemaVersion}`,
    );
  }
  return parseWorkerResult({
    ...content,
    digest: workerResultDigest(content),
  });
}

export function workerResultDigest(content: WorkerResultContent): string {
  return canonicalJsonDigest(content as unknown as JsonValue);
}

export function assertWorkerResultContext(
  result: WorkerResult,
  packet: ContextPacket,
  runId: StableId<"run">,
  attemptNumber: number,
): void {
  if (
    result.runId !== runId ||
    result.missionId !== packet.missionId ||
    result.nodeId !== packet.nodeId ||
    result.projectId !== packet.projectId ||
    result.contextPacketId !== packet.contextPacketId ||
    result.contextPacketDigest !== packet.digest ||
    result.attemptNumber !== attemptNumber ||
    result.workerRole !== packet.workerRole
  ) {
    throw new TypeError("workerResult does not match its dispatched run context");
  }
}

export interface WorkerFailureResultInput {
  readonly runId: StableId<"run">;
  readonly packet: ContextPacket;
  readonly attemptNumber: number;
  readonly status: Extract<WorkerResultStatus, "failed" | "cancelled">;
  readonly code:
    | "timeout"
    | "terminated"
    | "transport_failure"
    | "invalid_output";
  readonly conclusion: string;
  readonly wallMilliseconds: number;
}

export function createWorkerFailureResult(
  input: WorkerFailureResultInput,
): WorkerResult {
  return createWorkerResult({
    schemaVersion: workerResultSchemaVersion,
    runId: input.runId,
    missionId: input.packet.missionId,
    nodeId: input.packet.nodeId,
    projectId: input.packet.projectId,
    contextPacketId: input.packet.contextPacketId,
    contextPacketDigest: input.packet.digest,
    attemptNumber: input.attemptNumber,
    workerRole: input.packet.workerRole,
    status: input.status,
    conclusion: input.conclusion,
    evidenceIds: [],
    claimsProduced: [],
    challengedClaimIds: [],
    artifactIds: [],
    findings: [{
      code: input.code,
      severity: input.code === "timeout" ? "medium" : "high",
      summary: input.conclusion,
      evidenceIds: [],
    }],
    proposedEffects: [],
    risks: [],
    unresolvedQuestions: [],
    suggestedNextNodeTypes: [],
    resourceUsage: {
      wallMilliseconds: input.wallMilliseconds,
      outputBytes: 0,
    },
    modelUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    },
  });
}

function parseWorkerFinding(value: unknown, index: number): WorkerFinding {
  const path = `workerResult.findings[${index}]`;
  const input = expectRecord(value, path);
  return {
    code: expectString(input.code, `${path}.code`),
    severity: expectEnum(input.severity, findingSeverities, `${path}.severity`),
    summary: expectString(input.summary, `${path}.summary`),
    evidenceIds: expectStringArray(input.evidenceIds, `${path}.evidenceIds`).map(
      (id) => parseStableId(id, "evidence"),
    ),
  };
}

export function parseRuntimeProvenance(value: unknown): RuntimeProvenance {
  const input = expectRecord(value, "runtimeProvenance");
  return {
    provenanceId: parseStableId(input.provenanceId, "provenance"),
    workflowBindingId: parseStableId(input.workflowBindingId, "workflowBinding"),
    workflowId: parseStableId(input.workflowId, "workflow"),
    projectProfileId: parseStableId(input.projectProfileId, "projectProfile"),
    completionContractId: parseStableId(
      input.completionContractId,
      "completionContract",
    ),
    policyId: parseStableId(input.policyId, "policy"),
    adapterId: parseStableId(input.adapterId, "adapter"),
    sourceRepositoryCommit: expectString(
      input.sourceRepositoryCommit,
      "runtimeProvenance.sourceRepositoryCommit",
    ),
    artifactDigest: expectString(
      input.artifactDigest,
      "runtimeProvenance.artifactDigest",
    ),
    serviceInstance: expectString(
      input.serviceInstance,
      "runtimeProvenance.serviceInstance",
    ),
    serviceVersion: expectString(
      input.serviceVersion,
      "runtimeProvenance.serviceVersion",
    ),
    codexPluginVersion: expectString(
      input.codexPluginVersion,
      "runtimeProvenance.codexPluginVersion",
    ),
    workerImplementationVersion: expectString(
      input.workerImplementationVersion,
      "runtimeProvenance.workerImplementationVersion",
    ),
    workflowVersion: expectString(
      input.workflowVersion,
      "runtimeProvenance.workflowVersion",
    ),
    policyVersion: expectString(
      input.policyVersion,
      "runtimeProvenance.policyVersion",
    ),
    projectProfileVersion: expectString(
      input.projectProfileVersion,
      "runtimeProvenance.projectProfileVersion",
    ),
    completionContractVersion: expectString(
      input.completionContractVersion,
      "runtimeProvenance.completionContractVersion",
    ),
    adapterVersion: expectString(
      input.adapterVersion,
      "runtimeProvenance.adapterVersion",
    ),
    apiVersion: expectString(input.apiVersion, "runtimeProvenance.apiVersion"),
    databaseSchemaVersion: expectString(
      input.databaseSchemaVersion,
      "runtimeProvenance.databaseSchemaVersion",
    ),
    modelIdentifier: expectString(
      input.modelIdentifier,
      "runtimeProvenance.modelIdentifier",
    ),
    modelConfiguration: parseJsonObject(
      input.modelConfiguration,
      "runtimeProvenance.modelConfiguration",
    ),
    contextPacketSchemaVersion: expectString(
      input.contextPacketSchemaVersion,
      "runtimeProvenance.contextPacketSchemaVersion",
    ),
    contextPacketDigest: expectString(
      input.contextPacketDigest,
      "runtimeProvenance.contextPacketDigest",
    ),
    credentialReferenceVersion: expectString(
      input.credentialReferenceVersion,
      "runtimeProvenance.credentialReferenceVersion",
    ),
    hostIdentifier: expectString(
      input.hostIdentifier,
      "runtimeProvenance.hostIdentifier",
    ),
    executionEnvironment: expectString(
      input.executionEnvironment,
      "runtimeProvenance.executionEnvironment",
    ),
  };
}

function parseJsonObject(
  value: unknown,
  path: string,
): Readonly<Record<string, JsonValue>> {
  const record = expectRecord(value, path);
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [
      key,
      expectJsonValue(item, `${path}.${key}`),
    ]),
  );
}

export function parseCapabilityGrant(value: unknown): CapabilityGrant {
  const input = expectRecord(value, "capabilityGrant");
  const validFrom = expectIsoTimestamp(
    input.validFrom,
    "capabilityGrant.validFrom",
  );
  const expiresAt = expectIsoTimestamp(
    input.expiresAt,
    "capabilityGrant.expiresAt",
  );
  const maximumAttempts = expectInteger(
    input.maximumAttempts,
    "capabilityGrant.maximumAttempts",
    { minimum: 1 },
  );
  const attemptsUsed = expectInteger(
    input.attemptsUsed,
    "capabilityGrant.attemptsUsed",
    { minimum: 0 },
  );

  if (
    timestampMilliseconds(expiresAt, "capabilityGrant.expiresAt") <=
    timestampMilliseconds(validFrom, "capabilityGrant.validFrom")
  ) {
    throw new TypeError(
      "capabilityGrant.expiresAt must be later than capabilityGrant.validFrom",
    );
  }
  if (attemptsUsed > maximumAttempts) {
    throw new TypeError(
      "capabilityGrant.attemptsUsed must not exceed capabilityGrant.maximumAttempts",
    );
  }

  return {
    grantId: parseStableId(input.grantId, "capabilityGrant"),
    evaluationId: parseStableId(
      input.evaluationId,
      "capabilityGrantEvaluation",
    ),
    missionId: parseStableId(input.missionId, "mission"),
    nodeId: parseStableId(input.nodeId, "node"),
    projectId: parseStableId(input.projectId, "project"),
    role: expectEnum(input.role, workerRoles, "capabilityGrant.role"),
    resourceClass: expectEnum(
      input.resourceClass,
      workerResourceClasses,
      "capabilityGrant.resourceClass",
    ),
    allowedOperations: expectStringArray(
      input.allowedOperations,
      "capabilityGrant.allowedOperations",
    ),
    allowedResources: expectStringArray(
      input.allowedResources,
      "capabilityGrant.allowedResources",
    ),
    mode: expectEnum(input.mode, capabilityModes, "capabilityGrant.mode"),
    workspace: expectString(input.workspace, "capabilityGrant.workspace"),
    networkDestinations: expectStringArray(
      input.networkDestinations,
      "capabilityGrant.networkDestinations",
    ),
    validFrom,
    expiresAt,
    maximumAttempts,
    attemptsUsed,
  };
}

export function assessCapabilityGrant(
  grant: CapabilityGrant,
  request: CapabilityRequest,
): CapabilityAssessment {
  expectIsoTimestamp(request.at, "capabilityRequest.at");
  const reasons: string[] = [];
  const assessedAt = timestampMilliseconds(request.at, "capabilityRequest.at");
  const validFrom = timestampMilliseconds(grant.validFrom, "capabilityGrant.validFrom");
  const expiresAt = timestampMilliseconds(grant.expiresAt, "capabilityGrant.expiresAt");

  if (assessedAt < validFrom) reasons.push("grant_not_yet_valid");
  if (assessedAt >= expiresAt) reasons.push("grant_expired");
  if (grant.attemptsUsed >= grant.maximumAttempts) reasons.push("attempt_limit_reached");
  if (request.missionId !== grant.missionId) reasons.push("mission_not_granted");
  if (request.nodeId !== grant.nodeId) reasons.push("node_not_granted");
  if (request.projectId !== grant.projectId) reasons.push("project_not_granted");
  if (request.role !== grant.role) reasons.push("role_not_granted");
  if (request.resourceClass !== grant.resourceClass) {
    reasons.push("resource_class_not_granted");
  }
  if (!grant.allowedOperations.includes(request.operation)) {
    reasons.push("operation_not_granted");
  }
  if (!grant.allowedResources.includes(request.resource)) {
    reasons.push("resource_not_granted");
  }
  if (request.mode !== grant.mode) reasons.push("mode_not_granted");
  if (request.workspace !== grant.workspace) reasons.push("workspace_not_granted");
  if (
    request.networkAccess === "required" &&
    request.networkDestination === undefined
  ) {
    reasons.push("network_destination_required");
  }
  if (
    request.networkAccess === "none" &&
    request.networkDestination !== undefined
  ) {
    reasons.push("unexpected_network_destination");
  }
  if (
    request.networkAccess === "required" &&
    request.networkDestination !== undefined &&
    !grant.networkDestinations.includes(request.networkDestination)
  ) {
    reasons.push("network_destination_not_granted");
  }

  return { allowed: reasons.length === 0, reasons };
}

export function assessRuntimeControls(
  globalControl: GlobalRuntimeControl,
  projectControl: ProjectRuntimeControl | undefined,
  projectId: StableId<"project">,
): RuntimeControlAssessment {
  const reasons: string[] = [];

  if (
    globalControl.scopeType !== "global" ||
    globalControl.scopeId !== "global"
  ) {
    reasons.push("global_control_invalid");
  } else if (globalControl.effectsPaused) {
    reasons.push("global_effects_paused");
  }

  if (projectControl !== undefined) {
    if (
      projectControl.scopeType !== "project" ||
      projectControl.scopeId !== projectId
    ) {
      reasons.push("project_control_scope_mismatch");
    } else if (projectControl.effectsPaused) {
      reasons.push("project_effects_paused");
    }
  }

  return { allowed: reasons.length === 0, reasons };
}

function parseVersionedReference<
  K extends "projectProfile" | "workflow" | "policy" | "completionContract",
>(
  value: unknown,
  kind: K,
  path: string,
): VersionedReference<StableId<K>> {
  const input = expectRecord(value, path);
  return {
    id: parseStableId(input.id, kind),
    version: expectString(input.version, `${path}.version`),
  };
}

function parseEvidenceSummary(value: unknown, index: number): EvidenceSummary {
  const path = `contextPacket.evidence[${index}]`;
  const input = expectRecord(value, path);
  return {
    evidenceId: parseStableId(input.evidenceId, "evidence"),
    contentHash: expectString(input.contentHash, `${path}.contentHash`),
    summary: expectString(input.summary, `${path}.summary`),
  };
}

function parsePreviousWorkerResultReference(
  value: unknown,
  index: number,
): PreviousWorkerResultReference {
  const path = `contextPacket.previousResultRefs[${index}]`;
  const input = expectRecord(value, path);
  return {
    runId: parseStableId(input.runId, "run"),
    status: expectEnum(
      input.status,
      ["succeeded", "failed", "needs_input", "cancelled"] as const,
      `${path}.status`,
    ),
    resultDigest: expectString(input.resultDigest, `${path}.resultDigest`),
    conclusion: expectString(input.conclusion, `${path}.conclusion`),
  };
}

function parseRequiredOutputSchema(
  value: unknown,
): typeof workerResultOutputSchemaId {
  const schema = expectString(value, "contextPacket.requiredOutputSchema");
  if (schema !== workerResultOutputSchemaId) {
    throw new TypeError(
      `contextPacket.requiredOutputSchema must be ${workerResultOutputSchemaId}`,
    );
  }
  return schema;
}

export function parseWorkerLimits(value: unknown): WorkerLimits {
  const input = expectRecord(value, "contextPacket.limits");
  expectOnlyKeys(
    input,
    ["wallTimeMs", "maximumTurns", "maximumOutputBytes", "maximumModelTokens"],
    "contextPacket.limits",
  );
  const maximumModelTokens = input.maximumModelTokens === undefined
    ? undefined
    : expectInteger(
        input.maximumModelTokens,
        "contextPacket.limits.maximumModelTokens",
        { minimum: 1 },
      );
  return {
    wallTimeMs: expectInteger(input.wallTimeMs, "contextPacket.limits.wallTimeMs", {
      minimum: 1,
      maximum: 86_400_000,
    }),
    maximumTurns: expectInteger(
      input.maximumTurns,
      "contextPacket.limits.maximumTurns",
      { minimum: 1, maximum: 100 },
    ),
    maximumOutputBytes: expectInteger(
      input.maximumOutputBytes,
      "contextPacket.limits.maximumOutputBytes",
      { minimum: 1, maximum: maximumWorkerResultBytes },
    ),
    ...(maximumModelTokens === undefined ? {} : { maximumModelTokens }),
  };
}

function parseWorkerResourceUsage(value: unknown): WorkerResourceUsage {
  const input = expectRecord(value, "workerResult.resourceUsage");
  expectOnlyKeys(
    input,
    ["wallMilliseconds", "outputBytes"],
    "workerResult.resourceUsage",
  );
  return {
    wallMilliseconds: expectInteger(
      input.wallMilliseconds,
      "workerResult.resourceUsage.wallMilliseconds",
      { minimum: 0 },
    ),
    outputBytes: expectInteger(
      input.outputBytes,
      "workerResult.resourceUsage.outputBytes",
      { minimum: 0 },
    ),
  };
}

function parseWorkerModelUsage(value: unknown): WorkerModelUsage {
  const input = expectRecord(value, "workerResult.modelUsage");
  expectOnlyKeys(
    input,
    ["inputTokens", "outputTokens", "cachedInputTokens"],
    "workerResult.modelUsage",
  );
  return {
    inputTokens: expectInteger(
      input.inputTokens,
      "workerResult.modelUsage.inputTokens",
      { minimum: 0 },
    ),
    outputTokens: expectInteger(
      input.outputTokens,
      "workerResult.modelUsage.outputTokens",
      { minimum: 0 },
    ),
    cachedInputTokens: expectInteger(
      input.cachedInputTokens,
      "workerResult.modelUsage.cachedInputTokens",
      { minimum: 0 },
    ),
  };
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
