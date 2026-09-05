import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  contextPacketSchemaVersion,
  createContextPacket,
  createStableId,
  parseWorkerResult,
  workerResultOutputSchemaId,
  workerResultSchemaVersion,
  type ContextPacket,
} from "@acp/domain";
import type {
  RunResult,
  ThreadOptions,
  TurnOptions,
} from "@openai/codex-sdk";

import {
  CodexSdkWorkerTransport,
  minimalCodexEnvironment,
  unsignedWorkerResultJsonSchema,
  type CodexClient,
} from "../src/codex-sdk-transport.ts";
import type { WorkerTransportRequest } from "../src/worker-manager.ts";

class FakeCodexClient implements CodexClient {
  threadOptions: ThreadOptions | undefined;
  prompt: string | undefined;
  turnOptions: TurnOptions | undefined;
  response: RunResult;

  constructor(response: RunResult) {
    this.response = response;
  }

  startThread(options?: ThreadOptions) {
    this.threadOptions = options;
    return {
      run: async (input: string, turnOptions?: TurnOptions) => {
        this.prompt = input;
        this.turnOptions = turnOptions;
        return this.response;
      },
    };
  }
}

describe("CodexSdkWorkerTransport", () => {
  it("starts a fresh read-only SDK thread and supervisor-signs its result", async () => {
    const packet = packetFor("diagnosis");
    const request = requestFor(packet, "read_only");
    const client = new FakeCodexClient({
      items: [],
      finalResponse: JSON.stringify(unsignedResultFor(request)),
      usage: {
        input_tokens: 101,
        cached_input_tokens: 25,
        cache_write_input_tokens: 0,
        output_tokens: 33,
        reasoning_output_tokens: 8,
      },
    });
    const transport = new CodexSdkWorkerTransport({
      client,
      model: "synthetic-model",
      modelReasoningEffort: "medium",
    });

    const result = parseWorkerResult(await transport.run(request));

    assert.deepEqual(client.threadOptions, {
      model: "synthetic-model",
      modelReasoningEffort: "medium",
      threadSource: "acp-worker",
      sandboxMode: "read-only",
      workingDirectory: "C:/workspace/acp",
      skipGitRepoCheck: false,
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      approvalPolicy: "never",
      additionalDirectories: [],
    });
    assert.equal(client.turnOptions?.outputSchema, unsignedWorkerResultJsonSchema);
    assert.equal(client.turnOptions?.signal, request.signal);
    assert.equal(result.contextPacketDigest, packet.digest);
    assert.deepEqual(result.modelUsage, {
      inputTokens: 101,
      outputTokens: 33,
      cachedInputTokens: 25,
    });
    const prompt = JSON.parse(client.prompt ?? "null") as Record<string, unknown>;
    assert.equal(Object.hasOwn(prompt, "threadId"), false);
    assert.equal(Object.hasOwn(prompt, "conversationHistory"), false);
  });

  it("fails closed when only a broad network toggle is available", async () => {
    const packet = packetFor("diagnosis");
    const request = {
      ...requestFor(packet, "read_only"),
      isolation: {
        ...requestFor(packet, "read_only").isolation,
        networkDestinations: ["api.example.invalid"],
      },
    };
    const client = new FakeCodexClient({ items: [], finalResponse: "{}", usage: null });
    const transport = new CodexSdkWorkerTransport({ client });

    await assert.rejects(
      transport.run(request),
      /cannot enforce destination-level network allowlists/,
    );
    assert.equal(client.threadOptions, undefined);
  });

  it("uses workspace-write only for a verified delivery descriptor", async () => {
    const packet = packetFor("delivery");
    const request = requestFor(packet, "delivery");
    const client = new FakeCodexClient({
      items: [],
      finalResponse: JSON.stringify(unsignedResultFor(request)),
      usage: null,
    });
    const transport = new CodexSdkWorkerTransport({ client });

    await transport.run(request);

    assert.equal(client.threadOptions?.sandboxMode, "workspace-write");
    assert.equal(client.threadOptions?.workingDirectory, request.isolation.workspace);
    assert.equal(client.threadOptions?.networkAccessEnabled, false);
    assert.equal(client.threadOptions?.approvalPolicy, "never");
  });

  it("does not forward control-plane credentials into the Codex process", () => {
    assert.deepEqual(minimalCodexEnvironment({
      PATH: "C:/tools",
      TEMP: "C:/temp",
      ACP_DATABASE_URL: "postgres://secret",
      ACP_MCP_BEARER_TOKEN: "secret",
      GITHUB_TOKEN: "secret",
      OPENAI_API_KEY: "secret",
    }), {
      PATH: "C:/tools",
      TEMP: "C:/temp",
    });
  });

  it("fails closed on a model-token limit the SDK cannot enforce", async () => {
    const packet = {
      ...packetFor("diagnosis"),
      limits: {
        ...packetFor("diagnosis").limits,
        maximumModelTokens: 1_000,
      },
    } as ContextPacket;
    const request = requestFor(packet, "read_only");
    const client = new FakeCodexClient({ items: [], finalResponse: "{}", usage: null });

    await assert.rejects(
      new CodexSdkWorkerTransport({ client }).run(request),
      /cannot enforce an exact model-token ceiling/,
    );
    assert.equal(client.threadOptions, undefined);
  });
});

function packetFor(role: "diagnosis" | "delivery"): ContextPacket {
  return createContextPacket({
    contextPacketId: createStableId("contextPacket"),
    schemaVersion: contextPacketSchemaVersion,
    missionId: createStableId("mission"),
    nodeId: createStableId("node"),
    projectId: createStableId("project"),
    nodeType: role,
    workerRole: role,
    objective: "Exercise the SDK boundary.",
    nonGoals: ["No external effects."],
    completionScope: "Return structured output.",
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
      wallTimeMs: 30_000,
      maximumTurns: 3,
      maximumOutputBytes: 32_768,
    },
  });
}

function requestFor(
  packet: ContextPacket,
  profile: "read_only" | "delivery",
): WorkerTransportRequest {
  return {
    runId: createStableId("run"),
    execution: { startedAt: "2026-09-04T12:00:00.000Z", timeoutAt: "2026-09-04T12:05:00.000Z",
      hostIdentifier: "host:test", provenanceId: createStableId("provenance"), transitionProvenanceId: createStableId("provenance") },
    attemptNumber: 1,
    packet,
    toolManifest: {
      operations: ["repository.inspect"],
      resources: ["repository:acp"],
      effectExecutorAccess: false,
    },
    isolation: {
      profile,
      workspace: "C:/workspace/acp",
      filesystem: profile === "read_only" ? "read_only" : "isolated_worktree",
      networkDestinations: [],
      credentials: "none",
    },
    signal: new AbortController().signal,
  };
}

function unsignedResultFor(request: WorkerTransportRequest) {
  return {
    schemaVersion: workerResultSchemaVersion,
    runId: request.runId,
    missionId: request.packet.missionId,
    nodeId: request.packet.nodeId,
    projectId: request.packet.projectId,
    contextPacketId: request.packet.contextPacketId,
    contextPacketDigest: request.packet.digest,
    attemptNumber: request.attemptNumber,
    workerRole: request.packet.workerRole,
    status: "succeeded",
    conclusion: "Synthetic inspection completed.",
    evidenceIds: [],
    claimsProduced: [],
    challengedClaimIds: [],
    artifactIds: [],
    ...(request.packet.workerRole === "delivery"
      ? { candidateRevision: "a".repeat(40) }
      : {}),
    findings: [],
    proposedEffects: [],
    risks: [],
    unresolvedQuestions: [],
    suggestedNextNodeTypes: [],
    resourceUsage: { wallMilliseconds: 0, outputBytes: 0 },
    modelUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
  };
}
