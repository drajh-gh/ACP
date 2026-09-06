import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { buildProjectProfileProposal, canonicalJsonDigest, createStableId, reduceProfileDiscoveryObservations } from "@acp/domain";
import type { PinnedProfileDiscoveryWrite } from "@acp/storage";
import { discoverNpmPackageManifest } from "../src/npm-package-manifest-discovery.ts";
import { recordNpmManifestDiscovery, recordNpmManifestDiscoveries } from "../src/npm-manifest-discovery-coordinator.ts";

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

function batchSource(value: Uint8Array = bytes) {
  const evidenceId = createStableId("evidence");
  return { supplied: { evidenceId, bytes: value }, descriptor: { evidenceId, projectId: identity.projectId, contentHash: hash(value),
    expectedPin: { evidenceId, projectId: identity.projectId, identityDigest: canonicalJsonDigest({ evidenceId }) } } };
}
function batchStore(sources: ReturnType<typeof batchSource>[]) {
  const calls = { reads: 0, writes: 0 };
  return { calls, async getCurrentDiscoveryEvidenceBatch(query: unknown) {
    calls.reads++; assert.deepEqual(query, { projectId: identity.projectId, evidenceIds: sources.map(item => item.supplied.evidenceId).sort() });
    return sources.map(item => item.descriptor).reverse();
  }, async recordPinnedDiscovery(value: PinnedProfileDiscoveryWrite) {
    calls.writes++;
    const { observations, expectedEvidencePins, ...terms } = value;
    return { proposal: buildProjectProfileProposal({ ...terms, producer, proposedAt: "2026-09-06T00:00:00Z" }, reduceProfileDiscoveryObservations(observations), expectedEvidencePins), replayed: false };
  } };
}
it("multi-source manifest composition merges equal reports independently of input or descriptor order in one write", async () => {
  const sources = [batchSource(), batchSource()], store = batchStore(sources);
  const first = await recordNpmManifestDiscoveries(store, { ...identity, sources: sources.map(item => item.supplied) });
  const second = await recordNpmManifestDiscoveries(store, { ...identity, sources: sources.map(item => item.supplied).reverse() });
  assert.deepEqual(first, second); assert.equal(first.state, "recorded");
  if (first.state === "recorded") {
    assert.deepEqual(first.proposal.evidencePins.map(item => item.evidenceId), sources.map(item => item.supplied.evidenceId).sort());
    assert.equal(first.proposal.fields["verification.tests"].status, "observed");
    assert.equal(first.proposal.fields["verification.linting"].status, "missing");
  }
  assert.deepEqual(store.calls, { reads: 2, writes: 2 });
});
it("multi-source manifest composition preserves conflicting reports and independent categories without source precedence", async () => {
  const sources = [batchSource(), batchSource(Buffer.from('{"scripts":{"test":"different","lint":"lint only"}}'))], store = batchStore(sources);
  const result = await recordNpmManifestDiscoveries(store, { ...identity, sources: sources.map(item => item.supplied) });
  assert.equal(result.state, "recorded"); if (result.state !== "recorded") throw new Error("fixture");
  assert.equal(result.proposal.state, "conflicted"); assert.equal(result.proposal.fields["verification.tests"].status, "conflicted");
  assert.equal(result.proposal.fields["verification.linting"].status, "observed"); assert.equal(store.calls.writes, 1);
});
it("empty contributors create no retained negative evidence, and all-empty batches do not call the writer", async () => {
  const nonempty = batchSource(), empty = batchSource(Buffer.from('{}')), store = batchStore([nonempty, empty]);
  const result = await recordNpmManifestDiscoveries(store, { ...identity, sources: [empty.supplied, nonempty.supplied] });
  assert.equal(result.state, "recorded"); if (result.state === "recorded") assert.deepEqual(result.proposal.evidencePins, [nonempty.descriptor.expectedPin]);
  const emptyStore = batchStore([empty]);
  assert.deepEqual(await recordNpmManifestDiscoveries(emptyStore, { ...identity, sources: [empty.supplied] }), { state: "not_recorded", reason: "no_relevant_declarations" });
  assert.equal(emptyStore.calls.writes, 0);
});
it("one unconfirmed manifest prevents every partial write even beside usable or empty sources", async () => {
  const bad = batchSource(Buffer.from('{"scripts":{"test":"a","test":"b"}}'));
  for (const other of [batchSource(), batchSource(Buffer.from('{}'))]) {
    const store = batchStore([other, bad]);
    assert.deepEqual(await recordNpmManifestDiscoveries(store, { ...identity, sources: [other.supplied, bad.supplied] }), { state: "not_recorded", reason: "manifest_unconfirmed" });
    assert.equal(store.calls.writes, 0);
  }
});
it("batch count, density, exact source shape and distinct evidence identity are checked before any source I/O", async () => {
  const item = batchSource(), store = batchStore([item]);
  for (const sources of [[], new Array(1), [item.supplied, item.supplied], Array.from({ length: 6 }, () => batchSource().supplied),
    Object.assign([item.supplied], { extra: true }), [{ ...item.supplied, contentHash: item.descriptor.contentHash }],
    Object.assign([item.supplied], { [Symbol.iterator]: function* () { yield item.supplied; } })]) {
    await assert.rejects(recordNpmManifestDiscoveries(store, { ...identity, sources }), /not confirmed/u);
  }
  assert.deepEqual(store.calls, { reads: 0, writes: 0 });
});
it("batch byte bounds reject per-source and aggregate overflow before I/O while allowing the exact one-MiB boundary", async () => {
  const padded = Buffer.concat([bytes, Buffer.alloc(262144 - bytes.byteLength, 0x20)]);
  const sources = Array.from({ length: 5 }, () => batchSource(padded)), store = batchStore(sources);
  await assert.rejects(recordNpmManifestDiscoveries(store, { ...identity, sources: sources.map(item => item.supplied) }), /not confirmed/u);
  await assert.rejects(recordNpmManifestDiscoveries(store, { ...identity, sources: [{ ...sources[0]!.supplied, bytes: Buffer.alloc(262145) }] }), /not confirmed/u);
  assert.equal(store.calls.reads, 0);
  const bounded = batchStore(sources.slice(0, 4));
  assert.equal((await recordNpmManifestDiscoveries(bounded, { ...identity, sources: sources.slice(0, 4).map(item => item.supplied) })).state, "recorded");
});
it("every batch byte view is owned before the first await and substituted descriptor sets deny the whole write", async () => {
  const sources = [batchSource(Buffer.from(bytes)), batchSource(Buffer.from(bytes))], store = batchStore(sources);
  const originalRead = store.getCurrentDiscoveryEvidenceBatch.bind(store);
  store.getCurrentDiscoveryEvidenceBatch = async query => { sources.forEach(item => item.supplied.bytes.fill(0xff)); return originalRead(query); };
  assert.equal((await recordNpmManifestDiscoveries(store, { ...identity, sources: sources.map(item => item.supplied) })).state, "recorded");
  const fresh = [batchSource(), batchSource()];
  for (const descriptors of [[], [fresh[0]!.descriptor], [fresh[0]!.descriptor, fresh[0]!.descriptor]]) {
    const store = { async getCurrentDiscoveryEvidenceBatch() { return descriptors; }, async recordPinnedDiscovery() { throw new Error("unexpected writer"); } };
    await assert.rejects(recordNpmManifestDiscoveries(store, { ...identity, sources: fresh.map(item => item.supplied) }), /not confirmed/u);
  }
});
