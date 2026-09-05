import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  contextPacketSchemaVersion,
  createContextPacket,
  createStableId,
  createWorkerResult,
  workerResultOutputSchemaId,
  workerResultSchemaVersion,
  type CapabilityGrant,
  type ContextPacket,
  type StableId,
  type WorkerResult,
} from "@acp/domain";
import type {
  StartedWorkerRun,
  WorkerRunCompletion,
  WorkerRunPersistence,
  WorkerRunStart,
} from "@acp/storage";

import {
  isIsolatedGitWorktree,
  WorkerManager,
  WorkerTerminationUnconfirmedError,
  type WorkerDispatch,
  type WorkerTransport,
  type WorkerTransportRequest,
} from "../src/worker-manager.ts";

const now = new Date("2026-09-04T12:00:00.000Z");
const execFileAsync = promisify(execFile);

class MemoryWorkerRuntime implements WorkerRunPersistence {
  readonly packets = new Map<StableId<"contextPacket">, ContextPacket>();
  readonly starts: WorkerRunStart[] = [];
  readonly completions: WorkerRunCompletion[] = [];
  private grant: CapabilityGrant;

  constructor(grant: CapabilityGrant, packets: readonly ContextPacket[]) {
    this.grant = grant;
    for (const packet of packets) this.packets.set(packet.contextPacketId, packet);
  }

  async loadCapabilityGrant(
    grantId: StableId<"capabilityGrant">,
  ): Promise<CapabilityGrant | undefined> {
    return this.grant.grantId === grantId ? this.grant : undefined;
  }

  async loadContextPacket(
    contextPacketId: StableId<"contextPacket">,
  ): Promise<ContextPacket | undefined> {
    return this.packets.get(contextPacketId);
  }

  async startRun(start: WorkerRunStart): Promise<StartedWorkerRun> {
    this.starts.push(start);
    this.grant = { ...this.grant, attemptsUsed: this.grant.attemptsUsed + 1 };
    return {
      ...(start.launchIntent === undefined ? {} : { launchIntent: structuredClone(start.launchIntent) }),
      runId: start.runId,
      startedAt: now.toISOString(),
      timeoutAt: new Date(now.getTime() + start.wallTimeMs).toISOString(),
    };
  }

  async completeRun(completion: WorkerRunCompletion): Promise<boolean> {
    this.completions.push(completion);
    return true;
  }
}

class FunctionTransport implements WorkerTransport {
  readonly requests: WorkerTransportRequest[] = [];
  private readonly implementation: (
    request: WorkerTransportRequest,
  ) => Promise<unknown>;

  constructor(
    implementation: (request: WorkerTransportRequest) => Promise<unknown>,
  ) {
    this.implementation = implementation;
  }

  async run(request: WorkerTransportRequest): Promise<unknown> {
    this.requests.push(request);
    return this.implementation(request);
  }
}

describe("WorkerManager", () => {
  const launchFence = { directory: "C:\\ACP-test\\seals", directoryIdentity: "win32-dir:12345678:0000000000000002",
    scope: { machineFingerprint: "b".repeat(64), bootedAt: "2026-09-01T00:00:00.000Z", sessionId: 1 } };
  it("reserves one process identity at admission and forwards only the persisted intent", async () => {
    const packet = packetFor(), persistence = new MemoryWorkerRuntime(grantFor(packet), [packet]);
    const calls = new FunctionTransport(async (request) => successResult(request));
    const transport = { launchFence, run: (request: WorkerTransportRequest) => calls.run(request) };
    await managerFor(persistence, transport).dispatch({ ...dispatchFor(packet), dispatchGeneration: 1 });
    assert.ok(persistence.starts[0]?.launchIntent);
    assert.deepEqual(calls.requests[0]?.execution.launchIntent, persistence.starts[0]?.launchIntent);
    assert.equal(persistence.starts.length, 1);
  });
  it("cannot launch or project after ambiguous intent admission or prelaunch cancellation", async () => {
    for (const mode of ["missing", "different", "lost_ack", "cancel"] as const) {
      const packet = packetFor(), persistence = new MemoryWorkerRuntime(grantFor(packet), [packet]), controller = new AbortController();
      const calls = new FunctionTransport(async (request) => successResult(request));
      const start = persistence.startRun.bind(persistence);
      persistence.startRun = async (input) => {
        const admitted = await start(input);
        if (mode === "lost_ack") throw new Error("admission acknowledgement lost");
        if (mode === "cancel") controller.abort();
        if (mode === "missing") { const { launchIntent: _intent, ...rest } = admitted; return rest; }
        if (mode === "different") return { ...admitted, launchIntent: { ...admitted.launchIntent!, workerProcessId: createStableId("workerProcess") } };
        return admitted;
      };
      const pending = managerFor(persistence, { launchFence, run: (request) => calls.run(request) })
        .dispatch({ ...dispatchFor(packet), dispatchGeneration: 1, signal: controller.signal });
      if (mode === "lost_ack") await assert.rejects(pending, /acknowledgement lost/u);
      else await assert.rejects(pending, WorkerTerminationUnconfirmedError);
      assert.equal(persistence.starts.length, 1); assert.equal(calls.requests.length, 0); assert.equal(persistence.completions.length, 0);
    }
  });
  it("dispatches one exact packet through a read-only capability boundary", async () => {
    const packet = packetFor();
    const persistence = new MemoryWorkerRuntime(grantFor(packet), [packet]);
    const transport = new FunctionTransport(async (request) =>
      successResult(request),
    );
    const manager = managerFor(persistence, transport);

    const result = await manager.dispatch(dispatchFor(packet));

    assert.equal(result.status, "succeeded");
    assert.equal(persistence.starts.length, 1);
    assert.equal(persistence.starts[0]?.hostIdentifier, "host:test");
    assert.equal(persistence.completions[0]?.result.digest, result.digest);
    assert.deepEqual(transport.requests[0]?.toolManifest, {
      operations: ["repository.inspect"],
      resources: ["repository:acp"],
      effectExecutorAccess: false,
    });
    assert.equal(transport.requests[0]?.isolation.filesystem, "read_only");
    assert.equal(transport.requests[0]?.isolation.credentials, "none");
  });

  it("replaces a failed worker from a fresh packet without hidden history", async () => {
    const firstPacket = packetFor();
    const persistence = new MemoryWorkerRuntime(grantFor(firstPacket), [firstPacket]);
    const crashing = new FunctionTransport(async () => {
      throw new Error("synthetic process death");
    });
    const firstManager = managerFor(persistence, crashing);
    const first = await firstManager.dispatch(dispatchFor(firstPacket));
    assert.equal(first.status, "failed");
    assert.equal(first.findings[0]?.code, "transport_failure");

    const replacementPacket = packetFor({
      capabilityGrantId: firstPacket.capabilityGrantId,
      missionId: firstPacket.missionId,
      nodeId: firstPacket.nodeId,
      projectId: firstPacket.projectId,
      retryCount: 1,
      previousResultRefs: [{
        runId: first.runId,
        status: first.status,
        resultDigest: first.digest,
        conclusion: first.conclusion,
      }],
    });
    persistence.packets.set(replacementPacket.contextPacketId, replacementPacket);
    const replacement = new FunctionTransport(async (request) =>
      successResult(request),
    );
    const secondManager = managerFor(persistence, replacement);
    const second = await secondManager.dispatch(
      dispatchFor(replacementPacket, 2),
    );

    assert.equal(second.status, "succeeded");
    assert.notEqual(second.contextPacketId, first.contextPacketId);
    assert.deepEqual(
      Object.keys(replacement.requests[0] ?? {}).sort(),
      ["attemptNumber", "execution", "isolation", "packet", "runId", "signal", "toolManifest"],
    );
    assert.equal(
      Object.hasOwn(replacement.requests[0]?.packet ?? {}, "conversationHistory"),
      false,
    );
  });

  it("fails closed before persistence when the requested operation is not granted", async () => {
    const packet = packetFor();
    const persistence = new MemoryWorkerRuntime(grantFor(packet), [packet]);
    const transport = new FunctionTransport(async (request) =>
      successResult(request),
    );
    const manager = managerFor(persistence, transport);

    await assert.rejects(
      manager.dispatch({ ...dispatchFor(packet), operation: "repository.write" }),
      /operation_not_granted/,
    );
    assert.equal(persistence.starts.length, 0);
    assert.equal(transport.requests.length, 0);
  });

  it("records timeout as a structured terminal result", async () => {
    const packet = packetFor({ wallTimeMs: 10 });
    const persistence = new MemoryWorkerRuntime(grantFor(packet), [packet]);
    const transport = new FunctionTransport(
      (request) => new Promise((_, reject) => {
        request.signal.addEventListener(
          "abort",
          () => reject(request.signal.reason),
          { once: true },
        );
      }),
    );
    const manager = managerFor(persistence, transport);

    const result = await manager.dispatch(dispatchFor(packet));

    assert.equal(result.status, "failed");
    assert.equal(result.findings[0]?.code, "timeout");
    assert.equal(persistence.completions.length, 1);
  });

  it("does not admit a dispatch that was already cancelled", async () => {
    const packet = packetFor();
    const persistence = new MemoryWorkerRuntime(grantFor(packet), [packet]);
    const transport = new FunctionTransport(async (request) =>
      successResult(request),
    );
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await assert.rejects(
      managerFor(persistence, transport).dispatch({
        ...dispatchFor(packet),
        signal: controller.signal,
      }),
      /cancelled before admission/,
    );
    assert.equal(persistence.starts.length, 0);
    assert.equal(transport.requests.length, 0);
  });

  it("does not accept late success returned by a transport during cancellation", async () => {
    const packet = packetFor();
    const persistence = new MemoryWorkerRuntime(grantFor(packet), [packet]);
    const controller = new AbortController();
    const transport = new FunctionTransport((request) => new Promise((resolve) => {
      request.signal.addEventListener("abort", () => resolve(successResult(request)), { once: true });
      controller.abort(new Error("cancelled while transport was active"));
    }));
    const result = await managerFor(persistence, transport).dispatch({ ...dispatchFor(packet), signal: controller.signal });
    assert.equal(result.status, "cancelled");
    assert.equal(result.findings[0]?.code, "terminated");
    assert.equal(persistence.completions.length, 1);
  });

  it("uses the persisted deadline and skips transport when it already elapsed", async () => {
    const packet = packetFor();
    const persistence = new MemoryWorkerRuntime(grantFor(packet), [packet]);
    const transport = new FunctionTransport(async (request) =>
      successResult(request),
    );
    persistence.startRun = async (start) => {
      persistence.starts.push(start);
      return {
        runId: start.runId,
        startedAt: new Date(now.getTime() - 1_000).toISOString(),
        timeoutAt: new Date(now.getTime() - 1).toISOString(),
      };
    };

    const result = await managerFor(persistence, transport).dispatch(
      dispatchFor(packet),
    );

    assert.equal(result.findings[0]?.code, "timeout");
    assert.equal(transport.requests.length, 0);
  });

  it("does not terminalize a run when worker termination is unconfirmed", async () => {
    const packet = packetFor({ wallTimeMs: 1 });
    const persistence = new MemoryWorkerRuntime(grantFor(packet), [packet]);
    const transport = new FunctionTransport(
      async () => new Promise<never>(() => undefined),
    );
    const manager = new WorkerManager(persistence, transport, {
      localHostIdentifier: "host:test",
      now: () => now,
      terminationConfirmationMs: 5,
    });

    await assert.rejects(
      manager.dispatch(dispatchFor(packet)),
      /termination could not be confirmed/,
    );
    assert.equal(persistence.completions.length, 0);
  });

  it("irrevocably aborts late transport authority before returning an unconfirmed failure", async () => {
    const packet = packetFor(), persistence = new MemoryWorkerRuntime(grantFor(packet), [packet]);
    let signal: AbortSignal | undefined;
    const transport = new FunctionTransport(async (request) => { signal = request.signal; throw new WorkerTerminationUnconfirmedError(); });
    await assert.rejects(managerFor(persistence, transport).dispatch(dispatchFor(packet)), WorkerTerminationUnconfirmedError);
    assert.equal(signal?.aborted, true); assert.equal(persistence.completions.length, 0);
  });

  it("fails closed when a delivery workspace is not a linked Git worktree", async () => {
    const packet = packetFor({ workerRole: "delivery" });
    const persistence = new MemoryWorkerRuntime(grantFor(packet), [packet]);
    const transport = new FunctionTransport(async (request) =>
      successResult(request),
    );
    const manager = new WorkerManager(persistence, transport, {
      localHostIdentifier: "host:test",
      now: () => now,
      verifyDeliveryWorkspace: async () => false,
    });

    await assert.rejects(
      manager.dispatch(dispatchFor(packet)),
      /requires a verified linked Git worktree/,
    );
    assert.equal(persistence.starts.length, 0);
    assert.equal(transport.requests.length, 0);
  });

  it("rejects a successful delivery result whose revision differs from HEAD", async () => {
    const packet = packetFor({ workerRole: "delivery" });
    const persistence = new MemoryWorkerRuntime(grantFor(packet), [packet]);
    const transport = new FunctionTransport(async (request) =>
      successResult(request),
    );
    const manager = new WorkerManager(persistence, transport, {
      localHostIdentifier: "host:test",
      now: () => now,
      verifyDeliveryWorkspace: async () => true,
      readDeliveryRevision: async () => "b".repeat(40),
    });

    const result = await manager.dispatch(dispatchFor(packet));

    assert.equal(result.status, "failed");
    assert.equal(result.findings[0]?.code, "invalid_output");
  });

  it("recognizes a real linked worktree and rejects fabricated metadata", async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "acp-worktree-"));
    try {
      const repository = path.join(fixtureRoot, "repository");
      const workspace = path.join(fixtureRoot, "candidate");
      await execFileAsync("git", ["init", repository], { windowsHide: true });
      await writeFile(path.join(repository, "README.md"), "fixture\n", "utf8");
      await execFileAsync("git", ["-C", repository, "add", "README.md"], {
        windowsHide: true,
      });
      await execFileAsync(
        "git",
        [
          "-C",
          repository,
          "-c",
          "user.name=ACP Test",
          "-c",
          "user.email=acp@example.invalid",
          "commit",
          "-m",
          "fixture",
        ],
        { windowsHide: true },
      );
      await execFileAsync(
        "git",
        ["-C", repository, "worktree", "add", "-b", "acp-test", workspace],
        { windowsHide: true },
      );

      assert.equal(await isIsolatedGitWorktree(workspace), true);
      assert.equal(await isIsolatedGitWorktree(repository), false);

      const forgedWorkspace = path.join(fixtureRoot, "forged");
      const metadata = path.join(
        fixtureRoot,
        "forged-repository",
        ".git",
        "worktrees",
        "forged",
      );
      await mkdir(forgedWorkspace, { recursive: true });
      await mkdir(metadata, { recursive: true });
      await writeFile(
        path.join(forgedWorkspace, ".git"),
        `gitdir: ${metadata}\n`,
        "utf8",
      );
      await writeFile(
        path.join(metadata, "gitdir"),
        `${path.join(forgedWorkspace, ".git")}\n`,
        "utf8",
      );

      assert.equal(await isIsolatedGitWorktree(forgedWorkspace), false);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});

interface PacketOverrides {
  readonly capabilityGrantId?: StableId<"capabilityGrant">;
  readonly missionId?: StableId<"mission">;
  readonly nodeId?: StableId<"node">;
  readonly projectId?: StableId<"project">;
  readonly retryCount?: number;
  readonly previousResultRefs?: ContextPacket["previousResultRefs"];
  readonly wallTimeMs?: number;
  readonly workerRole?: "diagnosis" | "delivery";
}

function packetFor(overrides: PacketOverrides = {}): ContextPacket {
  return createContextPacket({
    contextPacketId: createStableId("contextPacket"),
    schemaVersion: contextPacketSchemaVersion,
    missionId: overrides.missionId ?? createStableId("mission"),
    nodeId: overrides.nodeId ?? createStableId("node"),
    projectId: overrides.projectId ?? createStableId("project"),
    nodeType: overrides.workerRole ?? "diagnosis",
    workerRole: overrides.workerRole ?? "diagnosis",
    objective: "Inspect the repository state.",
    nonGoals: ["Do not mutate the repository."],
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
    acceptanceCriteria: ["The result is schema-valid."],
    sourceAuthorityRules: {},
    evidence: [],
    activeClaimIds: [],
    conflicts: [],
    unresolvedQuestions: [],
    previousResultRefs: overrides.previousResultRefs ?? [],
    approvalIds: [],
    capabilityGrantId:
      overrides.capabilityGrantId ?? createStableId("capabilityGrant"),
    requiredOutputSchema: workerResultOutputSchemaId,
    nextAction: "Inspect.",
    retryCount: overrides.retryCount ?? 0,
    limits: {
      wallTimeMs: overrides.wallTimeMs ?? 30_000,
      maximumTurns: 3,
      maximumOutputBytes: 32_768,
    },
  });
}

function grantFor(packet: ContextPacket): CapabilityGrant {
  const delivery = packet.workerRole === "delivery";
  return {
    grantId: packet.capabilityGrantId,
    evaluationId: createStableId("capabilityGrantEvaluation"),
    missionId: packet.missionId,
    nodeId: packet.nodeId,
    projectId: packet.projectId,
    role: packet.workerRole,
    resourceClass: "lightweight_read",
    allowedOperations: [
      delivery ? "repository.edit" : "repository.inspect",
    ],
    allowedResources: ["repository:acp"],
    mode: delivery ? "write" : "read",
    workspace: "C:/workspace/acp",
    networkDestinations: [],
    validFrom: "2026-09-04T11:00:00.000Z",
    expiresAt: "2026-09-04T13:00:00.000Z",
    maximumAttempts: 2,
    attemptsUsed: 0,
  };
}

function dispatchFor(packet: ContextPacket, attemptNumber = 1): WorkerDispatch {
  const delivery = packet.workerRole === "delivery";
  return {
    runId: createStableId("run"),
    contextPacketId: packet.contextPacketId,
    attemptNumber,
    operation: delivery ? "repository.edit" : "repository.inspect",
    resource: "repository:acp",
    mode: delivery ? "write" : "read",
    workspace: "C:/workspace/acp",
    provenanceId: createStableId("provenance"),
    transitionProvenanceId: createStableId("provenance"),
  };
}

function managerFor(
  persistence: WorkerRunPersistence,
  transport: WorkerTransport,
): WorkerManager {
  return new WorkerManager(persistence, transport, {
    localHostIdentifier: "host:test",
    now: () => now,
  });
}

function successResult(request: WorkerTransportRequest): WorkerResult {
  return createWorkerResult({
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
    conclusion: "Inspection completed.",
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
    resourceUsage: { wallMilliseconds: 5, outputBytes: 256 },
    modelUsage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
  });
}
