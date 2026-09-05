import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createStableId } from "../src/ids.ts";
import {
  parseWorkflowDefinition,
  parseWorkflowNode,
  validateWorkflowGraph,
} from "../src/workflows.ts";

function workflowNode(
  nodeId = createStableId("node"),
  dependencies: readonly string[] = [],
) {
  return {
    nodeId,
    nodeType: "intake.normalize",
    workflowVersion: "wf-issue@1.0.0",
    role: "context_intake",
    dependencies,
    inputSchema: "acp.intake-envelope@1",
    outputSchema: "acp.intake-disposition@1",
    contextPacketId: createStableId("contextPacket"),
    capabilityGrantId: createStableId("capabilityGrant"),
    resourceLeases: [],
    riskClass: "R0",
    retryPolicy: {
      kind: "model_repair",
      maximumAttempts: 3,
      maximumMateriallyIdenticalFailures: 2,
    },
    timeoutPolicy: {
      timeoutMs: 60_000,
      disposition: "fail",
    },
    completionCondition: {
      type: "schema_valid",
      parameters: { schema: "acp.intake-disposition@1" },
    },
    failureDisposition: {
      type: "needs_input",
      parameters: { reason: "project_unresolved" },
    },
  } as const;
}

describe("bounded workflow graph schema", () => {
  it("accepts an acyclic graph with explicit dependencies", () => {
    const first = parseWorkflowNode(workflowNode());
    const second = parseWorkflowNode(
      workflowNode(createStableId("node"), [first.nodeId]),
    );

    assert.deepEqual(validateWorkflowGraph([first, second]), [first, second]);
  });

  it("rejects missing dependencies and cycles", () => {
    const missing = parseWorkflowNode(
      workflowNode(createStableId("node"), [createStableId("node")]),
    );
    assert.throws(() => validateWorkflowGraph([missing]), /missing dependency/);

    const firstId = createStableId("node");
    const secondId = createStableId("node");
    const first = parseWorkflowNode(workflowNode(firstId, [secondId]));
    const second = parseWorkflowNode(workflowNode(secondId, [firstId]));
    assert.throws(() => validateWorkflowGraph([first, second]), /cycle/);
  });

  it("enforces the default model-repair ceiling", () => {
    assert.throws(
      () =>
        parseWorkflowNode({
          ...workflowNode(),
          retryPolicy: {
            kind: "model_repair",
            maximumAttempts: 4,
            maximumMateriallyIdenticalFailures: 2,
          },
        }),
      /maximumAttempts/,
    );
  });

  it("rejects contradictory retry policies", () => {
    assert.throws(
      () =>
        parseWorkflowNode({
          ...workflowNode(),
          retryPolicy: {
            kind: "none",
            maximumAttempts: 2,
            maximumMateriallyIdenticalFailures: 0,
          },
        }),
      /cannot retry or back off/,
    );
    assert.throws(
      () =>
        parseWorkflowNode({
          ...workflowNode(),
          retryPolicy: {
            kind: "deterministic_backoff",
            maximumAttempts: 3,
            maximumMateriallyIdenticalFailures: 0,
          },
        }),
      /requires bounded backoff fields/,
    );
  });

  it("validates a version-pinned definition and its repair limits", () => {
    const node = workflowNode();
    const definition = parseWorkflowDefinition({
      workflowId: createStableId("workflow"),
      version: node.workflowVersion,
      supportedMissionTypes: ["issue_delivery"],
      nodeTemplates: [node],
      requiredWorkerRoles: [node.role],
      inputSchema: "acp.issue@1",
      outputSchema: "acp.delivery-result@1",
      riskClassificationRules: {},
      defaultCompletionContractId: createStableId("completionContract"),
      requiredGates: ["tests"],
      retryLimits: {
        maximumDeterministicAttempts: 5,
        maximumModelRepairAttempts: 3,
        maximumMateriallyIdenticalFailures: 2,
      },
      allowedOptionalBranches: [],
      contextPacketSchemaVersion: "1.0.0",
      compatibleAdapterCapabilities: ["repository.read"],
      migrationPolicy: { strategy: "pinned" },
    });

    assert.equal(definition.nodeTemplates.length, 1);
    assert.equal(definition.retryLimits.maximumModelRepairAttempts, 3);
  });
});
