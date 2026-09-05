import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalJsonDigest } from "../src/effects.ts";
import { createStableId } from "../src/ids.ts";
import { createContextPacket, parseContextPacket, type ContextPacketContent } from "../src/runtime.ts";
import { evaluateCompletionContract, type LifecycleVector } from "../src/lifecycle.ts";
import type { JsonValue } from "../src/validation.ts";

const observation = () => ({ recordId: createStableId("event"), observedAt: "2026-09-05T12:00:00.123456+00:00" });
function vector(): LifecycleVector {
  return { mission: { state: "executing" }, candidate: { candidateId: createStableId("candidate"), observation: observation(), state: "merged",
    revision: { repositoryId: createStableId("repository"), worktreePath: "C:/isolated/test", branch: "test", headSha: "b".repeat(40), evidenceIds: [createStableId("evidence")] } },
    deployments: [{ environment: "staging", state: "verified", observation: observation(), artifactVersion: { status: "known", digest: "sha256:" + "c".repeat(64) } },
      { environment: "production", state: "not_deployed", observation: observation(), artifactVersion: { status: "unknown" } }],
    acceptance: { state: "passed", observation: observation(), candidateRevision: "a".repeat(40), evidenceIds: [createStableId("evidence")] },
    tracker: { observation: observation(), adapterId: "adapter:synthetic", externalId: "issue:1", sourceVersion: "etag-7", nativeState: "Open" },
    effects: [], businessCompletion: { state: "pending", observation: observation() } };
}
function content(lifecycle: LifecycleVector, schemaVersion = "1.1.0"): ContextPacketContent {
  return { schemaVersion, contextPacketId: createStableId("contextPacket"), missionId: createStableId("mission"), nodeId: createStableId("node"),
    projectId: createStableId("project"), nodeType: "diagnosis", workerRole: "diagnosis", objective: "Inspect exact lifecycle references.", nonGoals: [], completionScope: "Report only.",
    projectProfile: { id: createStableId("projectProfile"), version: "1.0.0" }, workflow: { id: createStableId("workflow"), version: "1.0.0" },
    policy: { id: createStableId("policy"), version: "1.0.0" }, completionContract: { id: createStableId("completionContract"), version: "1.0.0" },
    lifecycle, behavioralContract: {}, acceptanceCriteria: [], sourceAuthorityRules: {}, evidence: [], activeClaimIds: [], conflicts: [], unresolvedQuestions: [],
    previousResultRefs: [], approvalIds: [], capabilityGrantId: createStableId("capabilityGrant"), requiredOutputSchema: "acp.worker-result@1.0.0",
    nextAction: "Read records.", retryCount: 0, limits: { wallTimeMs: 1000, maximumTurns: 1, maximumOutputBytes: 4096 } };
}
describe("versioned lifecycle context", () => {
  it("preserves exact identities, source versions, microseconds, and independent states", () => {
    const lifecycle = vector(), packet = createContextPacket(content(lifecycle));
    assert.deepEqual(packet.lifecycle, lifecycle);
    assert.equal(packet.lifecycle.acceptance.candidateRevision, "a".repeat(40));
    assert.equal(packet.lifecycle.candidate?.revision.headSha, "b".repeat(40));
    assert.equal(packet.lifecycle.deployments[1]?.artifactVersion?.status, "unknown");
  });
  it("retains legacy packet shape and digest exactly without inventing identity", () => {
    const lifecycle = vector();
    const legacy: LifecycleVector = { mission: lifecycle.mission, candidate: { state: lifecycle.candidate!.state, revision: lifecycle.candidate!.revision },
      deployments: [{ environment: "staging", state: "verified", artifactDigest: "sha256:legacy" }],
      acceptance: { state: "pending" }, tracker: { adapterId: "adapter:synthetic", externalId: "issue:1", nativeState: "Open" },
      effects: [], businessCompletion: { state: "not_evaluated" } };
    const unsigned = content(legacy, "1.0.0"), stored = { ...unsigned, digest: canonicalJsonDigest(unsigned as unknown as JsonValue) };
    assert.deepEqual(parseContextPacket(stored), stored); assert.deepEqual(createContextPacket(unsigned), stored);
    assert.equal(parseContextPacket(stored).lifecycle.candidate?.candidateId, undefined);
  });
  it("binds identity-only and version-only changes into the packet digest", () => {
    const unsigned = content(vector()), original = createContextPacket(unsigned);
    const changes = [
      { ...unsigned.lifecycle, tracker: { ...unsigned.lifecycle.tracker!, sourceVersion: "etag-8" } },
      { ...unsigned.lifecycle, tracker: { ...unsigned.lifecycle.tracker!, observation: { ...unsigned.lifecycle.tracker!.observation!, recordId: createStableId("event") } } },
      { ...unsigned.lifecycle, candidate: { ...unsigned.lifecycle.candidate!, candidateId: createStableId("candidate") } },
    ];
    for (const lifecycle of changes) {
      const changed = createContextPacket({ ...unsigned, lifecycle });
      assert.notEqual(original.digest, changed.digest);
      assert.throws(() => parseContextPacket({ ...original, lifecycle: changed.lifecycle }), /digest/);
    }
  });
  it("requires candidate, deployment and tracker identity in current packets", () => {
    const lifecycle = vector();
    const cases = [
      { ...lifecycle, candidate: { state: lifecycle.candidate!.state, revision: lifecycle.candidate!.revision } },
      { ...lifecycle, deployments: [{ environment: "staging", state: "verified" as const }] },
      { ...lifecycle, tracker: { adapterId: "adapter:synthetic", externalId: "issue:1", nativeState: "Open", observation: observation() } },
    ];
    for (const item of cases) assert.throws(() => createContextPacket(content(item)), /identity|observation|source version/);
  });
  it("rejects forged observations, unsupported artifact claims, and duplicate environments", () => {
    const packet = createContextPacket(content(vector()));
    for (const value of [null, { recordId: "pid:1", observedAt: observation().observedAt }, { ...observation(), extra: "injected" }]) {
      assert.throws(() => parseContextPacket({ ...packet, lifecycle: { ...packet.lifecycle, candidate: { ...packet.lifecycle.candidate, observation: value } } }));
    }
    const deployment = packet.lifecycle.deployments[0]!;
    for (const artifactVersion of [{ status: "known" }, { status: "unknown", digest: "invented" }, { status: "known", digest: " " }]) {
      assert.throws(() => parseContextPacket({ ...packet, lifecycle: { ...packet.lifecycle, deployments: [{ ...deployment, artifactVersion }] } }));
    }
    assert.throws(() => createContextPacket(content({ ...packet.lifecycle, deployments: [deployment, deployment] })), /unique/);
  });
  it("does not silently backport current identities into a legacy packet", () => {
    assert.throws(() => createContextPacket(content(vector(), "1.0.0")), /legacy/);
  });
  const facts = () => ({ evaluationId: createStableId("completionEvaluation"), missionId: createStableId("mission"), evaluatedAt: "2026-09-05T12:00:00Z",
    requiredReceiptsVerified: true, evidenceFreshnessVerified: true, conflicts: [], unresolvedFindings: [], lifecycleDigest: "sha256:lifecycle", provenanceId: createStableId("provenance") });
  const contract = () => ({ contract: { id: createStableId("completionContract"), version: "1.0.0" }, requireAllEffectsVerified: true });
  it("keeps version-unknown verified deployments diagnosable but not sufficient for completion", () => {
    const lifecycle = { ...vector(), acceptance: { state: "pending" as const }, deployments: [{ environment: "staging", state: "verified" as const,
      observation: observation(), artifactVersion: { status: "unknown" as const } }] };
    assert.equal(createContextPacket(content(lifecycle)).lifecycle.deployments[0]?.artifactVersion?.status, "unknown");
    const requirement = { ...contract(), requiredDeployments: [{ environment: "staging", allowedStates: ["verified" as const] }] };
    const unknown = evaluateCompletionContract(requirement, lifecycle, facts());
    assert.equal(unknown.status, "failed"); assert.ok(unknown.disqualifiers.includes("deployment_artifact_unknown:staging"));
    const known = { ...lifecycle, deployments: lifecycle.deployments.map((item) => ({ ...item, artifactVersion: { status: "known" as const, digest: "sha256:release" } })) };
    assert.equal(evaluateCompletionContract(requirement, known, facts()).status, "passed");
  });
  it("can pin a deployment completion requirement to an exact current or legacy artifact digest", () => {
    const requirement = { ...contract(), requiredDeployments: [{ environment: "staging", allowedStates: ["verified" as const], artifactDigest: "sha256:release" }] };
    const lifecycle = { ...vector(), acceptance: { state: "pending" as const } };
    assert.ok(evaluateCompletionContract(requirement, lifecycle, facts()).disqualifiers.includes("deployment_artifact_mismatch:staging"));
    for (const version of [{ artifactDigest: "sha256:release" }, { artifactVersion: { status: "known" as const, digest: "sha256:release" } }]) {
      assert.equal(evaluateCompletionContract(requirement, { ...lifecycle, deployments: [{ environment: "staging", state: "verified", ...version }] }, facts()).status, "passed");
    }
    assert.ok(evaluateCompletionContract(requirement, { ...lifecycle, deployments: [{ environment: "staging", state: "verified",
      artifactDigest: "sha256:release", artifactVersion: { status: "unknown" } }] }, facts()).disqualifiers.includes("deployment_artifact_mismatch:staging"));
  });
  it("does not turn an unconfigured or out-of-scope deployment into a completion requirement", () => {
    const lifecycle = { ...vector(), acceptance: { state: "pending" as const }, deployments: [{ environment: "staging", state: "not_configured" as const,
      artifactVersion: { status: "unknown" as const } }] };
    assert.equal(evaluateCompletionContract({ ...contract(), requiredDeployments: [{ environment: "staging", allowedStates: ["not_configured"] }] }, lifecycle, facts()).status, "passed");
    assert.equal(evaluateCompletionContract(contract(), { ...lifecycle, deployments: [{ ...lifecycle.deployments[0]!, state: "verified" }] }, facts()).status, "passed");
  });
});
