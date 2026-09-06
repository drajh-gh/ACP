import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { buildProjectProfileProposal, canonicalJsonDigest, createStableId, reduceProfileDiscoveryObservations } from "@acp/domain";
import { discoverNpmPackageManifest } from "../src/npm-package-manifest-discovery.ts";
import { recordNpmManifestDiscovery } from "../src/npm-manifest-discovery-coordinator.ts";

const identity = { proposalId: createStableId("projectProfileProposal"), projectId: createStableId("project"),
  candidateProfile: { profileId: createStableId("projectProfile"), profileVersion: "1.0.0" }, baseProfile: null, supersedesProposalId: null };
const evidenceId = createStableId("evidence"), bytes = Buffer.from('{"scripts":{"test":"synthetic private command"}}');
const hash = (value: Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const expectedPin = { evidenceId, projectId: identity.projectId, identityDigest: canonicalJsonDigest({ source: "synthetic" }) };
const descriptor = { evidenceId, projectId: identity.projectId, contentHash: hash(bytes), expectedPin };
const producer = { component: "synthetic", version: "1", artifactDigest: canonicalJsonDigest({ fixture: true }) };
const input = { ...identity, evidenceId, bytes };
const parse = (value = bytes) => { const result = discoverNpmPackageManifest({ evidenceId, expectedContentHash: hash(value), bytes: value });
  assert.equal(result.state, "observed"); if (result.state !== "observed") throw new Error("fixture"); return result; };
const saved = buildProjectProfileProposal({ ...identity, producer, proposedAt: "2026-09-06T00:00:00Z" }, reduceProfileDiscoveryObservations(parse().observations), [expectedPin]);

it("manifest coordinator uses only the database hash and pin, preserves exact extraction and returns the retained result", async () => {
  for (const replayed of [false, true]) {
    let reads = 0, writes = 0;
    const store = { async getCurrentDiscoveryEvidence(query: unknown) { reads++; assert.deepEqual(query, { projectId: identity.projectId, evidenceId }); return descriptor; },
      async recordPinnedDiscovery(value: unknown) { writes++; assert.deepEqual(value, { ...identity, observations: parse().observations, expectedEvidencePins: [expectedPin] }); return { proposal: saved, replayed }; } };
    assert.deepEqual(await recordNpmManifestDiscovery(store, input), { state: "recorded", proposal: saved, replayed });
    assert.equal(reads, 1); assert.equal(writes, 1);
  }
});
it("manifest coordinator rejects malformed identity, caller hash, observations and authority before source I/O", async () => {
  let reads = 0;
  const store = { async getCurrentDiscoveryEvidence() { reads++; return descriptor; }, async recordPinnedDiscovery() { throw new Error("unexpected writer"); } };
  for (const key of ["expectedContentHash", "expectedEvidencePins", "observations", "producer", "authority", "proposedAt"]) {
    await assert.rejects(recordNpmManifestDiscovery(store, { ...input, [key]: "injected" }), /not confirmed/u);
  }
  await assert.rejects(recordNpmManifestDiscovery(store, { ...input, evidenceId: createStableId("mission") }), /not confirmed/u);
  assert.equal(reads, 0);
});
it("hash mismatch or malformed manifests never call the writer or return partial observations", async () => {
  for (const value of [Buffer.from("wrong"), Buffer.from('{"scripts":{"test":"a","test":"b"}}'), Buffer.from([0xff])]) {
    const store = { async getCurrentDiscoveryEvidence() { return { ...descriptor, contentHash: value.toString() === "wrong" ? descriptor.contentHash : hash(value) }; },
      async recordPinnedDiscovery() { throw new Error("unexpected writer"); } };
    assert.deepEqual(await recordNpmManifestDiscovery(store, { ...input, bytes: value }), { state: "not_recorded", reason: "manifest_unconfirmed" });
  }
});
it("no relevant declarations mean this invocation writes nothing, not a retained empty-source scan", async () => {
  for (const value of [Buffer.from('{}'), Buffer.from('{"scripts":{"pretest":"synthetic hook","start":"synthetic start"}}')]) {
    const store = { async getCurrentDiscoveryEvidence() { return { ...descriptor, contentHash: hash(value) }; }, async recordPinnedDiscovery() { throw new Error("unexpected writer"); } };
    assert.deepEqual(await recordNpmManifestDiscovery(store, { ...input, bytes: value }), { state: "not_recorded", reason: "no_relevant_declarations" });
  }
});
it("source and persistence failures stay whole errors, never no-observation or unpinned fallback results", async () => {
  for (const failed of ["source", "write"]) {
    const store = { async getCurrentDiscoveryEvidence() { if (failed === "source") throw new Error("synthetic private source"); return descriptor; },
      async recordPinnedDiscovery() { throw new Error("synthetic private lost commit"); } };
    await assert.rejects(recordNpmManifestDiscovery(store, input), { message: "Manifest discovery was not confirmed; persistence may require exact retry." });
  }
});
it("source metadata and returned proposal substitutions cannot escape as a successful bound invocation", async () => {
  for (const bad of [{ ...descriptor, evidenceId: createStableId("evidence") }, { ...descriptor, projectId: createStableId("project") },
    { ...descriptor, contentHash: "sha256:invalid" }, { ...descriptor, expectedPin: { ...expectedPin, evidenceId: createStableId("evidence") } }]) {
    const store = { async getCurrentDiscoveryEvidence() { return bad; }, async recordPinnedDiscovery() { throw new Error("unexpected writer"); } };
    await assert.rejects(recordNpmManifestDiscovery(store, input), /not confirmed/u);
  }
  const store = { async getCurrentDiscoveryEvidence() { return descriptor; }, async recordPinnedDiscovery() {
    return { proposal: { ...saved, proposalDigest: canonicalJsonDigest({ wrong: true }) }, replayed: false };
  } };
  await assert.rejects(recordNpmManifestDiscovery(store, input), /not confirmed/u);
});
it("caller byte mutation during source I/O cannot replace the invocation's owned bytes or extracted observations", async () => {
  const mutable = Buffer.from(bytes);
  const store = { async getCurrentDiscoveryEvidence() { mutable.fill(0xff); return descriptor; }, async recordPinnedDiscovery(value: unknown) {
    assert.deepEqual(value, { ...identity, observations: parse().observations, expectedEvidencePins: [expectedPin] }); return { proposal: saved, replayed: false };
  } };
  assert.equal((await recordNpmManifestDiscovery(store, { ...input, bytes: mutable })).state, "recorded");
});
