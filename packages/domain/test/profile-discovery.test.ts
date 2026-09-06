import assert from "node:assert/strict";
import { it } from "node:test";
import { canonicalJsonDigest } from "../src/effects.ts";
import { createStableId } from "../src/ids.ts";
import { buildProjectProfileProposal, preparePinnedProfileDiscovery, profileFieldIds, reduceProfileDiscoveryObservations } from "../src/profile-proposal.ts";
import { expectJsonValue } from "../src/validation.ts";

const evidence = Array.from({ length: 22 }, () => createStableId("evidence"));
const observation = (value: unknown, evidenceIds: readonly string[] = [evidence[0]!], fieldId = "context.product") => ({ fieldId, value, evidenceIds });
const digest = (value: unknown) => canonicalJsonDigest(expectJsonValue(value, "synthetic discovery"));
const metadata = { proposalId: createStableId("projectProfileProposal"), projectId: createStableId("project"),
  candidateProfile: { profileId: createStableId("projectProfile"), profileVersion: "1.0.0" }, baseProfile: null, supersedesProposalId: null,
  producer: { component: "synthetic", version: "1", artifactDigest: digest({ synthetic: true }) }, proposedAt: "2026-09-06T00:00:00Z" };
const pins = (ids: readonly string[]) => ids.map(evidenceId => ({ evidenceId, projectId: metadata.projectId, identityDigest: digest({ evidenceId }) }));

it("empty discovery addresses all 62 fields as unanswered, not an empty inventory or non-applicability", () => {
  const fields = reduceProfileDiscoveryObservations([]);
  assert.deepEqual(Object.keys(fields), profileFieldIds);
  for (const id of profileFieldIds) {
    const field = fields[id]; assert.equal(field.status, "missing");
    if (field.status === "missing") { assert.equal(field.reason, "No attributed observation was supplied for this field."); assert.match(field.question, new RegExp(id, "u")); assert.equal("value" in field, false); }
  }
  assert.equal(buildProjectProfileProposal(metadata, fields, []).state, "needs_input");
});
it("explicit empty and false observations remain attributed values without guessing neighboring facts", () => {
  const fields = reduceProfileDiscoveryObservations([observation([], undefined, "repositories.inventory"), observation(false, undefined, "deployment.stagingAvailability")]);
  assert.deepEqual(fields["repositories.inventory"], { status: "observed", value: [], evidenceIds: [evidence[0]] });
  assert.deepEqual(fields["deployment.stagingAvailability"], { status: "observed", value: false, evidenceIds: [evidence[0]] });
  assert.equal(fields["repositories.defaultBranches"].status, "missing");
  assert.equal(fields["deployment.productionAuthority"].status, "missing");
});
it("equal canonical observations coalesce evidence deterministically without mutating the input", () => {
  const input = [observation({ z: [0.1, 1e-7], a: -0 }, [evidence[1]!]), observation({ a: 0, z: [0.1, 1e-7] }, [evidence[0]!, evidence[1]!])];
  const snapshot = structuredClone(input), fields = reduceProfileDiscoveryObservations(input);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(fields["context.product"], { status: "observed", value: { a: 0, z: [0.1, 1e-7] }, evidenceIds: evidence.slice(0, 2).sort() });
  assert.equal(digest(fields), digest(reduceProfileDiscoveryObservations(input.slice().reverse())));
  assert.deepEqual(fields, reduceProfileDiscoveryObservations([...input, input[0]]));
});
it("distinct values and array order remain unresolved conflicts with no precedence winner", () => {
  const input = [observation(["a", "b"]), observation(["b", "a"], [evidence[1]!]), observation(["a", "b"], [evidence[2]!])];
  const fields = reduceProfileDiscoveryObservations(input), field = fields["context.product"];
  assert.equal(field.status, "conflicted");
  if (field.status === "conflicted") {
    assert.equal(field.alternatives.length, 2);
    assert.deepEqual(field.alternatives.map(item => digest(item.value)), field.alternatives.map(item => digest(item.value)).slice().sort());
    assert.match(field.question, /context.product/u);
  }
  assert.deepEqual(fields, reduceProfileDiscoveryObservations(input.slice().reverse()));
  const proposal = buildProjectProfileProposal(metadata, fields, pins(evidence.slice(0, 3)));
  assert.equal(proposal.state, "conflicted"); assert.equal(proposal.authority.activation, "not_authorized");
});
it("discovery rejects unattributed, aliased, decorated or authority-bearing input as a whole", () => {
  const sparse = new Array(1), iterator = Object.assign([observation("synthetic")], { [Symbol.iterator]: function* () { yield observation("replacement"); } });
  for (const invalid of [null, {}, sparse, iterator, [observation("synthetic", [], "context.product")],
    [observation("synthetic", [evidence[0]!, evidence[0]!])], [observation("synthetic", [createStableId("mission")])],
    [observation("synthetic", undefined, "context.Product")], [observation("synthetic", undefined, "latest")],
    [{ ...observation("synthetic"), status: "observed" }], [{ ...observation("synthetic"), authority: "approved" }],
    [{ ...observation("synthetic"), operatorId: "synthetic-user" }], [{ ...observation("synthetic"), sourceRank: 1 }],
    [{ ...observation("synthetic"), fieldId: " context.product" }], [observation(undefined)], [observation(NaN)],
    [observation("x".repeat(4097))], [observation(Array.from({ length: 101 }, () => null))],
    [observation({ nested: { secret: new Date() } })], [observation([[[[[[[[[null]]]]]]]]])]]) assert.throws(() => reduceProfileDiscoveryObservations(invalid));
});
it("discovery rejects excess alternatives, merged evidence and aggregate input without truncation", () => {
  assert.throws(() => reduceProfileDiscoveryObservations(Array.from({ length: 6 }, (_, index) => observation(index))));
  assert.throws(() => reduceProfileDiscoveryObservations([observation("same", evidence.slice(0, 20)), observation("same", evidence.slice(20))]));
  assert.throws(() => reduceProfileDiscoveryObservations(Array.from({ length: 311 }, () => observation("same"))));
  const many = profileFieldIds.flatMap(fieldId => Array.from({ length: 5 }, (_, index) => observation("x".repeat(4000) + index, undefined, fieldId)));
  assert.throws(() => reduceProfileDiscoveryObservations(many));
});
it("discovery uses the same credential catalog and exact tracker mapping boundaries as direct proposals", () => {
  const credentialReferenceId = createStableId("credentialReference"), adapterId = createStableId("adapter");
  const catalog = observation([{ credentialReferenceId, version: "1", purpose: "Synthetic read reference" }], undefined, "credentials.references");
  const identity = observation([{ credentialReferenceId, credentialReferenceVersion: "1", identityRef: "synthetic-read-identity" }], undefined, "credentials.readIdentities");
  const mapping = { adapterId, adapterVersion: "1.0.0", instanceRef: "synthetic", itemType: "Task", nativeState: "Todo", semanticCategory: null };
  const fields = reduceProfileDiscoveryObservations([catalog, identity, observation([mapping], undefined, "tracker.semanticMappings")]);
  assert.equal(fields["credentials.readIdentities"].status, "observed"); assert.equal(fields["tracker.semanticMappings"].status, "observed");
  assert.throws(() => reduceProfileDiscoveryObservations([{ ...catalog, value: [] }, identity]));
  assert.throws(() => reduceProfileDiscoveryObservations([observation([{ ...mapping, semanticCategory: "universally_done" }], undefined, "tracker.semanticMappings")]));
  assert.throws(() => reduceProfileDiscoveryObservations([observation([{ token: "synthetic-secret" }], undefined, "credentials.references")]));
});

it("pinned discovery requires exactly the complete evidence union and canonicalizes expected pins", () => {
  const observations = [observation("same", evidence.slice(0, 2))], expected = pins(evidence.slice(0, 2));
  const prepared = preparePinnedProfileDiscovery(metadata.projectId, observations, expected.slice().reverse());
  assert.deepEqual(prepared.fields, reduceProfileDiscoveryObservations(observations));
  assert.deepEqual(prepared.expectedEvidencePins, expected.sort((a, b) => a.evidenceId < b.evidenceId ? -1 : 1));
  assert.deepEqual(preparePinnedProfileDiscovery(metadata.projectId, [], []).expectedEvidencePins, []);
});
it("pinned discovery rejects malformed, missing, extra, duplicate and wrong-project expectations", () => {
  const observations = [observation("synthetic")], expected = pins(evidence.slice(0, 1));
  for (const invalid of [[], [...expected, ...expected], pins(evidence.slice(0, 2)),
    [{ ...expected[0], projectId: createStableId("project") }], [{ ...expected[0], evidenceId: createStableId("mission") }],
    [{ ...expected[0], identityDigest: "sha256:invented" }], [{ ...expected[0], contentHash: digest("not part of a pin") }],
    [{ ...expected[0], authority: "approved" }], new Array(1)]) assert.throws(() => preparePinnedProfileDiscovery(metadata.projectId, observations, invalid));
});
