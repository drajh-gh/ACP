import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createStableId } from "../src/ids.ts";
import {
  contextPacketSchemaVersion,
  createContextPacket,
  createWorkerFailureResult,
  createWorkerResult,
  parseContextPacket,
  parseRuntimeProvenance,
  parseWorkerResult,
  workerResultOutputSchemaId,
  workerResultSchemaVersion,
  type ContextPacketContent,
  type WorkerResultContent,
} from "../src/runtime.ts";

describe("runtime boundary schemas", () => {
  it("validates context packets before worker execution", () => {
    const content = {
      contextPacketId: createStableId("contextPacket"),
      schemaVersion: contextPacketSchemaVersion,
      missionId: createStableId("mission"),
      nodeId: createStableId("node"),
      projectId: createStableId("project"),
      nodeType: "diagnosis",
      workerRole: "diagnosis",
      objective: "Inspect one synthetic issue.",
      nonGoals: ["No external mutations."],
      completionScope: "A disposition is recorded.",
      projectProfile: {
        id: createStableId("projectProfile"),
        version: "1.0.0",
      },
      workflow: { id: createStableId("workflow"), version: "1.0.0" },
      policy: { id: createStableId("policy"), version: "1.0.0" },
      completionContract: {
        id: createStableId("completionContract"),
        version: "1.0.0",
      },
      lifecycle: {
        mission: { state: "executing" },
        deployments: [],
        acceptance: { state: "not_required" },
        effects: [],
        businessCompletion: { state: "not_required" },
      },
      behavioralContract: {},
      acceptanceCriteria: ["Disposition is schema-valid."],
      sourceAuthorityRules: {},
      evidence: [
        {
          evidenceId: createStableId("evidence"),
          contentHash: "sha256:synthetic-issue",
          summary: "Synthetic issue body.",
        },
      ],
      activeClaimIds: [],
      conflicts: [],
      unresolvedQuestions: [],
      previousResultRefs: [],
      approvalIds: [],
      capabilityGrantId: createStableId("capabilityGrant"),
      requiredOutputSchema: workerResultOutputSchemaId,
      nextAction: "Return a disposition.",
      retryCount: 0,
      limits: {
        wallTimeMs: 30_000,
        maximumTurns: 3,
        maximumOutputBytes: 16_384,
      },
    } satisfies ContextPacketContent;
    const packet = createContextPacket(content);

    assert.equal(packet.lifecycle.mission.state, "executing");
    assert.equal(createContextPacket(content).digest, packet.digest);
    assert.throws(
      () => parseContextPacket({ ...packet, retryCount: -1 }),
      /retryCount/,
    );
    assert.throws(
      () => parseContextPacket({ ...packet, objective: "Tampered objective." }),
      /digest does not match/,
    );
    assert.throws(
      () => createContextPacket({ ...content, schemaVersion: "2.0.0" }),
      /schemaVersion/,
    );
    assert.throws(
      () => parseContextPacket({ ...packet, conversationHistory: [] }),
      /unexpected fields/,
    );
    assert.throws(
      () => parseContextPacket({
        ...packet,
        evidence: packet.evidence.map(({ evidenceId, summary }) => ({
          evidenceId,
          summary,
        })),
      }),
      /contentHash/,
    );
  });

  it("schema-validates worker results and nested effect proposals", () => {
    const runId = createStableId("run");
    const content = {
      schemaVersion: workerResultSchemaVersion,
      runId,
      missionId: createStableId("mission"),
      nodeId: createStableId("node"),
      projectId: createStableId("project"),
      contextPacketId: createStableId("contextPacket"),
      contextPacketDigest: "sha256:context",
      attemptNumber: 1,
      workerRole: "diagnosis",
      status: "succeeded",
      conclusion: "No defect reproduced.",
      evidenceIds: [createStableId("evidence")],
      claimsProduced: [],
      challengedClaimIds: [],
      artifactIds: [],
      findings: [],
      proposedEffects: [],
      risks: [],
      unresolvedQuestions: [],
      suggestedNextNodeTypes: [],
      resourceUsage: { wallMilliseconds: 10, outputBytes: 512 },
      modelUsage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 5 },
    } satisfies WorkerResultContent;
    const result = createWorkerResult(content);

    assert.equal(result.status, "succeeded");
    assert.equal(createWorkerResult(content).digest, result.digest);
    assert.throws(
      () => parseWorkerResult({ ...result, proposedEffects: [{}] }),
      /effect/,
    );
    assert.throws(
      () =>
        parseWorkerResult({
          ...result,
          findings: [{ code: "missing-severity", summary: "missing severity", evidenceIds: [] }],
        }),
      /severity/,
    );
    assert.throws(
      () => parseWorkerResult({ ...result, conclusion: "Tampered." }),
      /digest does not match/,
    );
    assert.throws(
      () => parseWorkerResult({ ...result, threadId: "hidden-history" }),
      /unexpected fields/,
    );
  });

  it("creates deterministic structured manager failures bound to the packet", () => {
    const packet = createContextPacket({
      contextPacketId: createStableId("contextPacket"),
      schemaVersion: contextPacketSchemaVersion,
      missionId: createStableId("mission"),
      nodeId: createStableId("node"),
      projectId: createStableId("project"),
      nodeType: "research",
      workerRole: "research",
      objective: "Inspect one bounded source.",
      nonGoals: ["No mutation."],
      completionScope: "Return a structured finding.",
      projectProfile: { id: createStableId("projectProfile"), version: "1.0.0" },
      workflow: { id: createStableId("workflow"), version: "1.0.0" },
      policy: { id: createStableId("policy"), version: "1.0.0" },
      completionContract: {
        id: createStableId("completionContract"),
        version: "1.0.0",
      },
      lifecycle: {
        mission: { state: "executing" },
        deployments: [],
        acceptance: { state: "not_required" },
        effects: [],
        businessCompletion: { state: "not_required" },
      },
      behavioralContract: {},
      acceptanceCriteria: ["Result is schema-valid."],
      sourceAuthorityRules: {},
      evidence: [],
      activeClaimIds: [],
      conflicts: [],
      unresolvedQuestions: [],
      previousResultRefs: [],
      approvalIds: [],
      capabilityGrantId: createStableId("capabilityGrant"),
      requiredOutputSchema: workerResultOutputSchemaId,
      nextAction: "Inspect.",
      retryCount: 0,
      limits: {
        wallTimeMs: 1_000,
        maximumTurns: 1,
        maximumOutputBytes: 8_192,
      },
    });
    const runId = createStableId("run");
    const failure = createWorkerFailureResult({
      runId,
      packet,
      attemptNumber: 1,
      status: "failed",
      code: "transport_failure",
      conclusion: "The worker process exited before returning a result.",
      wallMilliseconds: 15,
    });

    assert.equal(failure.runId, runId);
    assert.equal(failure.contextPacketDigest, packet.digest);
    assert.equal(failure.findings[0]?.code, "transport_failure");
  });

  it("requires identifier and version provenance together", () => {
    const provenance = parseRuntimeProvenance({
      provenanceId: createStableId("provenance"),
      workflowBindingId: createStableId("workflowBinding"),
      workflowId: createStableId("workflow"),
      projectProfileId: createStableId("projectProfile"),
      completionContractId: createStableId("completionContract"),
      policyId: createStableId("policy"),
      adapterId: createStableId("adapter"),
      sourceRepositoryCommit: "a".repeat(40),
      artifactDigest: "sha256:artifact",
      serviceInstance: "worker-1",
      serviceVersion: "1.0.0",
      codexPluginVersion: "1.0.0",
      workerImplementationVersion: "1.0.0",
      workflowVersion: "1.0.0",
      policyVersion: "1.0.0",
      projectProfileVersion: "1.0.0",
      completionContractVersion: "1.0.0",
      adapterVersion: "1.0.0",
      apiVersion: "1.0.0",
      databaseSchemaVersion: "0002",
      modelIdentifier: "synthetic",
      modelConfiguration: {},
      contextPacketSchemaVersion: "1.0.0",
      contextPacketDigest: "sha256:context",
      credentialReferenceVersion: "1.0.0",
      hostIdentifier: "test-host",
      executionEnvironment: "test",
    });

    assert.match(provenance.workflowId, /^wfl_/u);
    assert.throws(
      () => parseRuntimeProvenance({ ...provenance, artifactDigest: "   " }),
      /artifactDigest/,
    );
    assert.throws(
      () => parseRuntimeProvenance({ ...provenance, modelConfiguration: null }),
      /modelConfiguration/,
    );
  });
});
