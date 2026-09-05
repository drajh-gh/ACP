import { riskClasses, type RiskClass } from "./effects.ts";
import { parseStableId, type StableId } from "./ids.ts";
import {
  expectArray,
  expectEnum,
  expectFiniteNumber,
  expectInteger,
  expectJsonValue,
  expectRecord,
  expectString,
  expectStringArray,
  type JsonValue,
} from "./validation.ts";

export const workerRoles = [
  "counterpart",
  "context_intake",
  "research",
  "diagnosis",
  "decision",
  "delivery",
  "assurance",
  "acceptance",
  "coordination",
  "learning",
  "effect_executor",
  "reconciler",
] as const;

export type WorkerRole = (typeof workerRoles)[number];

export type RetryPolicy =
  | {
      readonly kind: "none";
      readonly maximumAttempts: 1;
      readonly maximumMateriallyIdenticalFailures: 0;
    }
  | {
      readonly kind: "deterministic_backoff";
      readonly maximumAttempts: number;
      readonly maximumMateriallyIdenticalFailures: 0;
      readonly initialDelayMs: number;
      readonly backoffMultiplier: number;
    }
  | {
      readonly kind: "model_repair";
      readonly maximumAttempts: number;
      readonly maximumMateriallyIdenticalFailures: number;
    };

export interface WorkflowRetryLimits {
  readonly maximumDeterministicAttempts: number;
  readonly maximumModelRepairAttempts: number;
  readonly maximumMateriallyIdenticalFailures: number;
}

export interface TimeoutPolicy {
  readonly timeoutMs: number;
  readonly disposition: "fail" | "await_reconciliation" | "create_attention";
}

export interface NodeCondition {
  readonly type: string;
  readonly parameters: JsonValue;
}

export interface WorkflowNode {
  readonly nodeId: StableId<"node">;
  readonly nodeType: string;
  readonly workflowVersion: string;
  readonly role: WorkerRole;
  readonly dependencies: readonly StableId<"node">[];
  readonly inputSchema: string;
  readonly outputSchema: string;
  readonly contextPacketId: StableId<"contextPacket">;
  readonly capabilityGrantId: StableId<"capabilityGrant">;
  readonly resourceLeases: readonly string[];
  readonly riskClass: RiskClass;
  readonly retryPolicy: RetryPolicy;
  readonly timeoutPolicy: TimeoutPolicy;
  readonly completionCondition: NodeCondition;
  readonly failureDisposition: NodeCondition;
}

export interface WorkflowDefinition {
  readonly workflowId: StableId<"workflow">;
  readonly version: string;
  readonly supportedMissionTypes: readonly string[];
  readonly nodeTemplates: readonly WorkflowNode[];
  readonly requiredWorkerRoles: readonly WorkerRole[];
  readonly inputSchema: string;
  readonly outputSchema: string;
  readonly riskClassificationRules: JsonValue;
  readonly defaultCompletionContractId: StableId<"completionContract">;
  readonly requiredGates: readonly string[];
  readonly retryLimits: WorkflowRetryLimits;
  readonly allowedOptionalBranches: readonly string[];
  readonly contextPacketSchemaVersion: string;
  readonly compatibleAdapterCapabilities: readonly string[];
  readonly migrationPolicy: JsonValue;
}

export function parseWorkflowDefinition(value: unknown): WorkflowDefinition {
  const input = expectRecord(value, "workflowDefinition");
  const version = expectString(input.version, "workflowDefinition.version");
  const nodeTemplates = validateWorkflowGraph(
    expectArray(input.nodeTemplates, "workflowDefinition.nodeTemplates").map(
      parseWorkflowNode,
    ),
  );
  const requiredWorkerRoles = expectArray(
    input.requiredWorkerRoles,
    "workflowDefinition.requiredWorkerRoles",
  ).map((role, index) =>
    expectEnum(
      role,
      workerRoles,
      `workflowDefinition.requiredWorkerRoles[${index}]`,
    ),
  );
  const retryLimits = parseWorkflowRetryLimits(input.retryLimits);

  for (const node of nodeTemplates) {
    if (node.workflowVersion !== version) {
      throw new TypeError(
        `workflow node ${node.nodeId} is pinned to a different workflow version`,
      );
    }
    if (!requiredWorkerRoles.includes(node.role)) {
      throw new TypeError(
        `workflow node ${node.nodeId} uses an undeclared worker role`,
      );
    }
    if (
      node.retryPolicy.kind === "deterministic_backoff" &&
      node.retryPolicy.maximumAttempts > retryLimits.maximumDeterministicAttempts
    ) {
      throw new TypeError(`workflow node ${node.nodeId} exceeds retry limits`);
    }
    if (
      node.retryPolicy.kind === "model_repair" &&
      (node.retryPolicy.maximumAttempts > retryLimits.maximumModelRepairAttempts ||
        node.retryPolicy.maximumMateriallyIdenticalFailures >
          retryLimits.maximumMateriallyIdenticalFailures)
    ) {
      throw new TypeError(`workflow node ${node.nodeId} exceeds repair limits`);
    }
  }

  return {
    workflowId: parseStableId(input.workflowId, "workflow"),
    version,
    supportedMissionTypes: expectStringArray(
      input.supportedMissionTypes,
      "workflowDefinition.supportedMissionTypes",
    ),
    nodeTemplates,
    requiredWorkerRoles,
    inputSchema: expectString(input.inputSchema, "workflowDefinition.inputSchema"),
    outputSchema: expectString(input.outputSchema, "workflowDefinition.outputSchema"),
    riskClassificationRules: expectJsonValue(
      input.riskClassificationRules,
      "workflowDefinition.riskClassificationRules",
    ),
    defaultCompletionContractId: parseStableId(
      input.defaultCompletionContractId,
      "completionContract",
    ),
    requiredGates: expectStringArray(
      input.requiredGates,
      "workflowDefinition.requiredGates",
    ),
    retryLimits,
    allowedOptionalBranches: expectStringArray(
      input.allowedOptionalBranches,
      "workflowDefinition.allowedOptionalBranches",
    ),
    contextPacketSchemaVersion: expectString(
      input.contextPacketSchemaVersion,
      "workflowDefinition.contextPacketSchemaVersion",
    ),
    compatibleAdapterCapabilities: expectStringArray(
      input.compatibleAdapterCapabilities,
      "workflowDefinition.compatibleAdapterCapabilities",
    ),
    migrationPolicy: expectJsonValue(
      input.migrationPolicy,
      "workflowDefinition.migrationPolicy",
    ),
  };
}

export function parseWorkflowNode(value: unknown): WorkflowNode {
  const input = expectRecord(value, "workflowNode");
  return {
    nodeId: parseStableId(input.nodeId, "node"),
    nodeType: expectString(input.nodeType, "workflowNode.nodeType"),
    workflowVersion: expectString(
      input.workflowVersion,
      "workflowNode.workflowVersion",
    ),
    role: expectEnum(input.role, workerRoles, "workflowNode.role"),
    dependencies: expectStringArray(
      input.dependencies,
      "workflowNode.dependencies",
    ).map((id) => parseStableId(id, "node")),
    inputSchema: expectString(input.inputSchema, "workflowNode.inputSchema"),
    outputSchema: expectString(input.outputSchema, "workflowNode.outputSchema"),
    contextPacketId: parseStableId(input.contextPacketId, "contextPacket"),
    capabilityGrantId: parseStableId(
      input.capabilityGrantId,
      "capabilityGrant",
    ),
    resourceLeases: expectStringArray(
      input.resourceLeases,
      "workflowNode.resourceLeases",
    ),
    riskClass: expectEnum(
      input.riskClass,
      riskClasses,
      "workflowNode.riskClass",
    ),
    retryPolicy: parseRetryPolicy(input.retryPolicy),
    timeoutPolicy: parseTimeoutPolicy(input.timeoutPolicy),
    completionCondition: parseNodeCondition(
      input.completionCondition,
      "workflowNode.completionCondition",
    ),
    failureDisposition: parseNodeCondition(
      input.failureDisposition,
      "workflowNode.failureDisposition",
    ),
  };
}

export function validateWorkflowGraph(
  nodes: readonly WorkflowNode[],
): readonly WorkflowNode[] {
  if (nodes.length === 0) {
    throw new TypeError("workflow graph must contain at least one node");
  }

  const byId = new Map<StableId<"node">, WorkflowNode>();
  for (const node of nodes) {
    if (byId.has(node.nodeId)) {
      throw new TypeError(`workflow graph contains duplicate node ${node.nodeId}`);
    }
    byId.set(node.nodeId, node);
  }

  for (const node of nodes) {
    for (const dependency of node.dependencies) {
      if (!byId.has(dependency)) {
        throw new TypeError(
          `workflow node ${node.nodeId} has missing dependency ${dependency}`,
        );
      }
    }
  }

  const visitState = new Map<StableId<"node">, "visiting" | "visited">();
  const visit = (node: WorkflowNode): void => {
    const state = visitState.get(node.nodeId);
    if (state === "visiting") {
      throw new TypeError(`workflow graph contains a cycle at ${node.nodeId}`);
    }
    if (state === "visited") {
      return;
    }

    visitState.set(node.nodeId, "visiting");
    for (const dependency of node.dependencies) {
      visit(byId.get(dependency)!);
    }
    visitState.set(node.nodeId, "visited");
  };

  for (const node of nodes) {
    visit(node);
  }

  return nodes;
}

function parseRetryPolicy(value: unknown): RetryPolicy {
  const input = expectRecord(value, "workflowNode.retryPolicy");
  const kind = expectEnum(
    input.kind,
    ["none", "deterministic_backoff", "model_repair"] as const,
    "workflowNode.retryPolicy.kind",
  );
  const maximumAttempts = expectInteger(
    input.maximumAttempts,
    "workflowNode.retryPolicy.maximumAttempts",
    { minimum: 1 },
  );
  const maximumMateriallyIdenticalFailures = expectInteger(
    input.maximumMateriallyIdenticalFailures,
    "workflowNode.retryPolicy.maximumMateriallyIdenticalFailures",
    { minimum: 0 },
  );
  const initialDelayMs = parseOptionalInteger(
    input.initialDelayMs,
    "workflowNode.retryPolicy.initialDelayMs",
    1,
  );
  const backoffMultiplier =
    input.backoffMultiplier === undefined
      ? undefined
      : expectFiniteNumber(
          input.backoffMultiplier,
          "workflowNode.retryPolicy.backoffMultiplier",
          { minimum: 1 },
        );

  if (
    kind === "none" &&
    (maximumAttempts !== 1 ||
      maximumMateriallyIdenticalFailures !== 0 ||
      initialDelayMs !== undefined ||
      backoffMultiplier !== undefined)
  ) {
    throw new TypeError("workflowNode.retryPolicy.none cannot retry or back off");
  }
  if (
    kind === "deterministic_backoff" &&
    (maximumAttempts < 2 ||
      maximumMateriallyIdenticalFailures !== 0 ||
      initialDelayMs === undefined ||
      backoffMultiplier === undefined)
  ) {
    throw new TypeError(
      "workflowNode.retryPolicy.deterministic_backoff requires bounded backoff fields",
    );
  }

  if (kind === "model_repair" && maximumAttempts > 3) {
    throw new TypeError(
      "workflowNode.retryPolicy.maximumAttempts must not exceed 3 for model repair",
    );
  }
  if (kind === "model_repair" && maximumMateriallyIdenticalFailures > 2) {
    throw new TypeError(
      "workflowNode.retryPolicy.maximumMateriallyIdenticalFailures must not exceed 2 for model repair",
    );
  }

  if (kind === "none") {
    return {
      kind,
      maximumAttempts: 1,
      maximumMateriallyIdenticalFailures: 0,
    };
  }
  if (kind === "deterministic_backoff") {
    return {
      kind,
      maximumAttempts,
      maximumMateriallyIdenticalFailures: 0,
      initialDelayMs: initialDelayMs!,
      backoffMultiplier: backoffMultiplier!,
    };
  }
  return { kind, maximumAttempts, maximumMateriallyIdenticalFailures };
}

function parseWorkflowRetryLimits(value: unknown): WorkflowRetryLimits {
  const input = expectRecord(value, "workflowDefinition.retryLimits");
  const maximumModelRepairAttempts = expectInteger(
    input.maximumModelRepairAttempts,
    "workflowDefinition.retryLimits.maximumModelRepairAttempts",
    { minimum: 1, maximum: 3 },
  );
  const maximumMateriallyIdenticalFailures = expectInteger(
    input.maximumMateriallyIdenticalFailures,
    "workflowDefinition.retryLimits.maximumMateriallyIdenticalFailures",
    { minimum: 0, maximum: 2 },
  );
  return {
    maximumDeterministicAttempts: expectInteger(
      input.maximumDeterministicAttempts,
      "workflowDefinition.retryLimits.maximumDeterministicAttempts",
      { minimum: 1, maximum: 100 },
    ),
    maximumModelRepairAttempts,
    maximumMateriallyIdenticalFailures,
  };
}

function parseTimeoutPolicy(value: unknown): TimeoutPolicy {
  const input = expectRecord(value, "workflowNode.timeoutPolicy");
  return {
    timeoutMs: expectInteger(
      input.timeoutMs,
      "workflowNode.timeoutPolicy.timeoutMs",
      { minimum: 1 },
    ),
    disposition: expectEnum(
      input.disposition,
      ["fail", "await_reconciliation", "create_attention"] as const,
      "workflowNode.timeoutPolicy.disposition",
    ),
  };
}

function parseNodeCondition(value: unknown, path: string): NodeCondition {
  const input = expectRecord(value, path);
  return {
    type: expectString(input.type, `${path}.type`),
    parameters: expectJsonValue(input.parameters, `${path}.parameters`),
  };
}

function parseOptionalInteger(
  value: unknown,
  path: string,
  minimum: number,
): number | undefined {
  return value === undefined
    ? undefined
    : expectInteger(value, path, { minimum });
}
