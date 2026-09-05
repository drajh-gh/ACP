import { parseStableId, type StableId } from "./ids.ts";
import {
  ContractValidationError,
  expectArray,
  expectRecord,
  expectString,
} from "./validation.ts";

export interface RuntimeWorkflowVersion {
  readonly workflowId: StableId<"workflow">;
  readonly version: string;
}

export interface RuntimeCompatibilityRequirements {
  readonly protocolVersion: string;
  readonly apiVersion: string;
  readonly workerImplementationVersion: string;
  readonly databaseSchemaVersion: string;
  readonly workflowVersions: readonly RuntimeWorkflowVersion[];
}

export interface RuntimeHello {
  readonly protocolVersion: string;
  readonly apiVersion: string;
  readonly workerImplementationVersion: string;
  readonly databaseSchemaVersion: string;
  readonly workflowVersions: readonly RuntimeWorkflowVersion[];
}

export type RuntimeCompatibilityReasonCode =
  | "requirements_invalid"
  | "hello_invalid"
  | "protocol_version_mismatch"
  | "api_version_mismatch"
  | "worker_implementation_version_mismatch"
  | "database_schema_version_mismatch"
  | "workflow_version_missing"
  | "workflow_version_mismatch";

export interface RuntimeCompatibilityReason {
  readonly code: RuntimeCompatibilityReasonCode;
  readonly expected?: string;
  readonly observed?: string;
  readonly workflowId?: StableId<"workflow">;
  readonly path?: string;
}

export interface RuntimeCompatibilityAssessment {
  readonly compatible: boolean;
  readonly reasons: readonly RuntimeCompatibilityReason[];
}

const compatibilityFields = [
  "protocolVersion",
  "apiVersion",
  "workerImplementationVersion",
  "databaseSchemaVersion",
  "workflowVersions",
] as const;

const workflowVersionFields = ["workflowId", "version"] as const;

export function parseRuntimeCompatibilityRequirements(
  value: unknown,
): RuntimeCompatibilityRequirements {
  return parseCompatibilityVersionSet(value, "runtimeCompatibilityRequirements");
}

export function parseRuntimeHello(value: unknown): RuntimeHello {
  return parseCompatibilityVersionSet(value, "runtimeHello");
}

export function assessRuntimeCompatibility(
  requirementsValue: unknown,
  helloValue: unknown,
): RuntimeCompatibilityAssessment {
  let requirements: RuntimeCompatibilityRequirements;
  try {
    requirements = parseRuntimeCompatibilityRequirements(requirementsValue);
  } catch (error) {
    return invalidAssessment("requirements_invalid", error);
  }

  let hello: RuntimeHello;
  try {
    hello = parseRuntimeHello(helloValue);
  } catch (error) {
    return invalidAssessment("hello_invalid", error);
  }

  const reasons: RuntimeCompatibilityReason[] = [];
  compareVersion(
    reasons,
    "protocol_version_mismatch",
    requirements.protocolVersion,
    hello.protocolVersion,
  );
  compareVersion(
    reasons,
    "api_version_mismatch",
    requirements.apiVersion,
    hello.apiVersion,
  );
  compareVersion(
    reasons,
    "worker_implementation_version_mismatch",
    requirements.workerImplementationVersion,
    hello.workerImplementationVersion,
  );
  compareVersion(
    reasons,
    "database_schema_version_mismatch",
    requirements.databaseSchemaVersion,
    hello.databaseSchemaVersion,
  );

  const observedWorkflowVersions = new Map(
    hello.workflowVersions.map((workflow) => [workflow.workflowId, workflow.version]),
  );
  for (const requirement of requirements.workflowVersions) {
    const observed = observedWorkflowVersions.get(requirement.workflowId);
    if (observed === undefined) {
      reasons.push({
        code: "workflow_version_missing",
        expected: requirement.version,
        workflowId: requirement.workflowId,
      });
    } else if (observed !== requirement.version) {
      reasons.push({
        code: "workflow_version_mismatch",
        expected: requirement.version,
        observed,
        workflowId: requirement.workflowId,
      });
    }
  }

  return { compatible: reasons.length === 0, reasons };
}

function parseCompatibilityVersionSet(
  value: unknown,
  path: string,
): RuntimeCompatibilityRequirements {
  const input = expectRecord(value, path);
  expectExactFields(input, compatibilityFields, path);
  const workflowVersions = expectArray(
    input.workflowVersions,
    `${path}.workflowVersions`,
  ).map((workflow, index) =>
    parseWorkflowVersion(workflow, `${path}.workflowVersions[${index}]`),
  );
  if (workflowVersions.length === 0) {
    throw new ContractValidationError(
      `${path}.workflowVersions`,
      "must contain at least one workflow version",
    );
  }
  if (
    new Set(workflowVersions.map((workflow) => workflow.workflowId)).size !==
    workflowVersions.length
  ) {
    throw new ContractValidationError(
      `${path}.workflowVersions`,
      "must not contain duplicate workflow identifiers",
    );
  }

  return {
    protocolVersion: expectString(input.protocolVersion, `${path}.protocolVersion`),
    apiVersion: expectString(input.apiVersion, `${path}.apiVersion`),
    workerImplementationVersion: expectString(
      input.workerImplementationVersion,
      `${path}.workerImplementationVersion`,
    ),
    databaseSchemaVersion: expectString(
      input.databaseSchemaVersion,
      `${path}.databaseSchemaVersion`,
    ),
    workflowVersions,
  };
}

function parseWorkflowVersion(value: unknown, path: string): RuntimeWorkflowVersion {
  const input = expectRecord(value, path);
  expectExactFields(input, workflowVersionFields, path);
  return {
    workflowId: parseStableId(input.workflowId, "workflow"),
    version: expectString(input.version, `${path}.version`),
  };
}

function expectExactFields(
  input: Readonly<Record<string, unknown>>,
  expectedFields: readonly string[],
  path: string,
): void {
  const expected = new Set(expectedFields);
  const unknown = Object.keys(input).find((field) => !expected.has(field));
  if (unknown !== undefined) {
    throw new ContractValidationError(`${path}.${unknown}`, "is not a recognized field");
  }
}

function compareVersion(
  reasons: RuntimeCompatibilityReason[],
  code: RuntimeCompatibilityReasonCode,
  expected: string,
  observed: string,
): void {
  if (expected !== observed) reasons.push({ code, expected, observed });
}

function invalidAssessment(
  code: "requirements_invalid" | "hello_invalid",
  error: unknown,
): RuntimeCompatibilityAssessment {
  return {
    compatible: false,
    reasons: [{
      code,
      ...(error instanceof ContractValidationError ? { path: error.path } : {}),
    }],
  };
}
