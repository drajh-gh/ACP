import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalJsonDigest } from "../src/effects.ts";
import { createStableId } from "../src/ids.ts";
import {
  buildProjectProfileProposal, buildProfileConfirmationRequest, parseProjectProfileProposal,
  profileFieldIds, profileSections,
} from "../src/profile-proposal.ts";

const projectId = createStableId("project"), profileId = createStableId("projectProfile"), evidenceId = createStableId("evidence");
const metadata = () => ({ proposalId: createStableId("projectProfileProposal"), projectId,
  candidateProfile: { profileId, profileVersion: "1.0.0" }, baseProfile: null, supersedesProposalId: null,
  producer: { component: "synthetic-discovery", version: "1.0.0", artifactDigest: canonicalJsonDigest({ synthetic: true }) },
  proposedAt: "2026-09-06T00:00:00.000001Z" });
const pin = { evidenceId, projectId, identityDigest: canonicalJsonDigest({ syntheticEvidence: 1 }) };
const observed = (value: unknown) => ({ status: "observed", value, evidenceIds: [evidenceId] });
const proposed = (value: unknown) => ({ status: "proposed", value, rationale: "Synthetic proposed configuration, not permission.", evidenceIds: [] });
const resolvedFields = () => Object.fromEntries(profileFieldIds.map(id => [id, { status: "not_applicable", rationale: "Synthetic applicability proposal for this exact field.", evidenceIds: [] }]));
const current = (proposal: ReturnType<typeof buildProjectProfileProposal>, overrides: object = {}) => ({
  currentProposalId: proposal.proposalId, candidateProfileExists: false, baseProfileMatches: true,
  asOf: "2026-09-06T00:01:00.000001Z", evidence: proposal.evidencePins.map(pin => ({ ...pin,
    sensitivity: "project_confidential", freshness: "current", accessibility: "available", contentHashPresent: true,
    observedAt: "2026-09-05T23:00:00.000001Z", retrievedAt: "2026-09-05T23:00:01.000001Z",
  })), ...overrides });

describe("inert whole-profile proposals", () => {
  it("addresses all 62 fields in the 15 specification areas without inventing discovered information", () => {
    assert.equal(Object.keys(profileSections).length, 15); assert.equal(profileFieldIds.length, 62);
    const proposal = buildProjectProfileProposal(metadata(), {}, []);
    assert.equal(proposal.state, "needs_input");
    assert.deepEqual(Object.keys(proposal.fields), profileFieldIds);
    assert.ok(Object.values(proposal.fields).every(field => field.status === "missing"));
    assert.equal(proposal.evidencePins.length, 0);
    assert.deepEqual(proposal.authority, { assessment: "not_evaluated", publication: "not_authorized", activation: "not_authorized" });
    assert.deepEqual(parseProjectProfileProposal(proposal), proposal);
    assert.equal(Object.hasOwn(proposal, "confirmed"), false);
    assert.throws(() => buildProfileConfirmationRequest(proposal, current(proposal)), /unavailable/u);
  });

  it("keeps partial repository discovery separate from protection and ownership gaps", () => {
    const proposal = buildProjectProfileProposal(metadata(), { "repositories.inventory": observed([{ repositoryId: createStableId("repository"), displayName: "Synthetic repository" }]) }, [pin]);
    assert.equal(proposal.fields["repositories.inventory"].status, "observed");
    assert.equal(proposal.fields["repositories.protections"].status, "missing");
    assert.equal(proposal.fields["repositories.owners"].status, "missing");
    assert.equal(proposal.state, "needs_input");
    assert.throws(() => buildProjectProfileProposal(metadata(), { "repositories.inventory": observed([]) }, []));
  });

  it("distinguishes explicit none, proposed values, missing facts and unresolved conflicts", () => {
    const proposal = buildProjectProfileProposal(metadata(), {
      "repositories.inventory": observed([]), "verification.requiredGates": proposed(["synthetic gate"]),
      "tracker.transitionPolicy": { status: "conflicted", question: "Which transition policy is intended?", alternatives: [
        { value: { permitted: false }, evidenceIds: [evidenceId] }, { value: { permitted: true }, evidenceIds: [evidenceId] },
      ] },
    }, [pin]);
    assert.equal(proposal.state, "conflicted");
    assert.deepEqual(proposal.fields["repositories.inventory"], observed([]));
    assert.equal(proposal.fields["verification.requiredGates"].status, "proposed");
    assert.equal(proposal.fields["tracker.transitionPolicy"].status, "conflicted");
    assert.throws(() => buildProfileConfirmationRequest(proposal, current(proposal)), /unavailable/u);
    assert.throws(() => buildProjectProfileProposal(metadata(), { "tracker.transitionPolicy": {
      status: "conflicted", question: "Duplicate alternatives?", alternatives: [{ value: true, evidenceIds: [evidenceId] }, { value: true, evidenceIds: [evidenceId] }],
    } }, [pin]));
  });

  it("requires exact complete stored shape and recomputes state and document digest", () => {
    const proposal = buildProjectProfileProposal(metadata(), {}, []);
    const { "identity.client": _removed, ...incomplete } = proposal.fields;
    for (const invalid of [
      { ...proposal, fields: incomplete }, { ...proposal, fields: { ...proposal.fields, "identity.guessed": proposed("fake") } },
      { ...proposal, state: "reviewable" }, { ...proposal, proposalDigest: canonicalJsonDigest({ different: true }) },
      { ...proposal, authority: { ...proposal.authority, activation: "authorized" } },
      { ...proposal, fields: { ...proposal.fields, "identity.client": { status: "missing", reason: "Undiscovered", question: "Who?", value: "Invented client" } } },
    ]) assert.throws(() => parseProjectProfileProposal(invalid));
    assert.throws(() => buildProjectProfileProposal({ ...metadata(), candidateProfile: { profileId, profileVersion: "latest" } }, {}, []));
    assert.throws(() => buildProjectProfileProposal({ ...metadata(), authority: "operator" }, {}, []));
  });

  it("pins the exact target, baseline, predecessor, producer, evidence and every proposed field", () => {
    const meta = metadata(), fields = { "context.product": observed("Synthetic product") };
    const original = buildProjectProfileProposal(meta, fields, [pin]);
    for (const changed of [
      buildProjectProfileProposal({ ...meta, candidateProfile: { profileId, profileVersion: "1.0.1" } }, fields, [pin]),
      buildProjectProfileProposal({ ...meta, baseProfile: { profileId, profileVersion: "0.9.0", profileDigest: canonicalJsonDigest({ old: true }) } }, fields, [pin]),
      buildProjectProfileProposal({ ...meta, supersedesProposalId: createStableId("projectProfileProposal") }, fields, [pin]),
      buildProjectProfileProposal({ ...meta, producer: { ...meta.producer, version: "1.0.1" } }, fields, [pin]),
      buildProjectProfileProposal(meta, { "context.product": observed("Different product") }, [pin]),
      buildProjectProfileProposal(meta, fields, [{ ...pin, identityDigest: canonicalJsonDigest({ changed: true }) }]),
    ]) assert.notEqual(changed.proposalDigest, original.proposalDigest);
    assert.equal(buildProjectProfileProposal({ ...meta, proposedAt: "2026-09-06T02:00:00.000001+02:00" }, fields, [pin]).proposalDigest, original.proposalDigest);
    assert.throws(() => buildProjectProfileProposal({ ...meta, supersedesProposalId: meta.proposalId }, fields, [pin]));
    assert.throws(() => buildProjectProfileProposal(meta, fields, [{ ...pin, projectId: createStableId("project") }]));
    assert.throws(() => buildProjectProfileProposal(meta, fields, [pin, pin]));
    assert.throws(() => buildProjectProfileProposal(meta, {}, [pin]));
  });

  it("permits only reference-shaped credential records and keeps read/write identities separate", () => {
    const credentialReferenceId = createStableId("credentialReference");
    const refs = [{ credentialReferenceId, version: "revision:1", purpose: "Synthetic reader" }];
    const reads = [{ credentialReferenceId, credentialReferenceVersion: "revision:1", identityRef: "synthetic:reader" }];
    const proposal = buildProjectProfileProposal(metadata(), { "credentials.references": proposed(refs), "credentials.readIdentities": proposed(reads) }, []);
    assert.equal(proposal.fields["credentials.writeIdentities"].status, "missing");
    for (const value of ["synthetic-secret", [{ ...refs[0], secret: "synthetic-secret" }], [{ ...refs[0], credentialReferenceId: createStableId("evidence") }]]) {
      assert.throws(() => buildProjectProfileProposal(metadata(), { "credentials.references": proposed(value) }, []));
    }
    assert.throws(() => buildProjectProfileProposal(metadata(), { "credentials.references": proposed([]), "credentials.readIdentities": proposed(reads) }, []));
    assert.throws(() => buildProjectProfileProposal(metadata(), { "credentials.references": proposed([refs[0], { ...refs[0], purpose: "Conflicting purpose for the same exact reference" }]) }, []));
  });

  it("retains exact native tracker semantics and explicit unmapped categories without a universal workflow", () => {
    const row = { adapterId: createStableId("adapter"), adapterVersion: "1.0.0", instanceRef: "synthetic:tracker", itemType: "Issue", nativeState: "Shipped", semanticCategory: null };
    const proposal = buildProjectProfileProposal(metadata(), { "tracker.semanticMappings": proposed([row, { ...row, nativeState: "shipped", semanticCategory: "released" }]) }, []);
    const field = proposal.fields["tracker.semanticMappings"];
    assert.equal(field.status, "proposed");
    if (field.status === "proposed") assert.deepEqual(field.value, [row, { ...row, nativeState: "shipped", semanticCategory: "released" }]);
    assert.throws(() => buildProjectProfileProposal(metadata(), { "tracker.semanticMappings": proposed([{ ...row, semanticCategory: "complete_for_scope" }]) }, []));
    assert.throws(() => buildProjectProfileProposal(metadata(), { "tracker.semanticMappings": proposed([row, { ...row, semanticCategory: "done" }]) }, []));
  });

  it("bounds JSON depth, arrays, unsafe keys, unsupported values and whole-document UTF-8 size", () => {
    let nested: unknown = true; for (let i = 0; i < 10; i++) nested = { child: nested };
    for (const value of [nested, Array(101).fill(true), new Date(), Number.NaN, JSON.parse('{"__proto__":{"polluted":true}}'), "x".repeat(4097), "\ud800"]) {
      assert.throws(() => buildProjectProfileProposal(metadata(), { "context.product": proposed(value) }, []));
    }
    const oversize = Object.fromEntries(profileFieldIds.map(id => [id, { status: "missing", reason: "ž".repeat(2000), question: "ž".repeat(2000) }]));
    assert.throws(() => buildProjectProfileProposal(metadata(), oversize, []));
    assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  });

  it("rejects sparse or decorated arrays instead of losing evidence or aliasing serialized facts", () => {
    const decorated = Object.assign([true], { hiddenFact: "not serialized" });
    const iteratorEvidence = [evidenceId];
    Object.defineProperty(iteratorEvidence, Symbol.iterator, { value: function* () {} });
    for (const value of [Array(1), [true, , false], decorated, iteratorEvidence]) {
      assert.throws(() => buildProjectProfileProposal(metadata(), { "context.product": proposed(value) }, []));
    }
    assert.throws(() => buildProjectProfileProposal(metadata(), { "context.product": { status: "observed", value: "Synthetic", evidenceIds: Array(1) } }, []));
    assert.throws(() => buildProjectProfileProposal(metadata(), { "context.product": { status: "observed", value: "Synthetic", evidenceIds: iteratorEvidence } }, []));
    assert.throws(() => buildProjectProfileProposal(metadata(), { "context.product": { status: "conflicted", question: "What is intended?", alternatives: Array(2) } }, []));
    assert.throws(() => buildProjectProfileProposal(metadata(), {}, Array(1)));
  });

  it("normalizes negative zero so returned fact identity survives JSON and database round-trips", () => {
    const meta = metadata(), negative = buildProjectProfileProposal(meta, { "context.product": proposed(-0) }, []);
    const positive = buildProjectProfileProposal(meta, { "context.product": proposed(0) }, []);
    assert.deepEqual(negative, positive);
    assert.deepEqual(parseProjectProfileProposal(JSON.parse(JSON.stringify(negative))), negative);
    const field = negative.fields["context.product"];
    assert.equal(field.status, "proposed");
    if (field.status === "proposed") assert.equal(Object.is(field.value, -0), false);
  });
});

describe("exact profile confirmation requests, never operator receipts", () => {
  it("builds only a read-only request tied to the complete reviewable proposal and current evidence snapshot", () => {
    const fields = { ...resolvedFields(), "context.product": observed("Synthetic product") };
    const proposal = buildProjectProfileProposal(metadata(), fields, [pin]);
    assert.equal(proposal.state, "reviewable");
    const request = buildProfileConfirmationRequest(proposal, current(proposal));
    assert.equal(request.proposalId, proposal.proposalId); assert.equal(request.proposalDigest, proposal.proposalDigest);
    assert.equal(request.kind, "confirmation_request_only");
    assert.equal(request.authorityAssessment, "not_evaluated"); assert.equal(request.activation, "not_authorized");
    assert.equal(Object.hasOwn(request, "operatorId"), false); assert.equal(Object.hasOwn(request, "confirmedAt"), false);
    assert.match(request.confirmationDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.notEqual(buildProfileConfirmationRequest(proposal, current(proposal, { asOf: "2026-09-06T00:01:00.000002Z" })).confirmationDigest, request.confirmationDigest);
    const publicRequest = buildProfileConfirmationRequest(proposal, current(proposal, { evidence: current(proposal).evidence.map(item => ({ ...item, sensitivity: "public" })) }));
    assert.notEqual(publicRequest.evidenceSnapshotDigest, request.evidenceSnapshotDigest);
    assert.notEqual(publicRequest.confirmationDigest, request.confirmationDigest);
  });

  it("denies supersession, occupied targets, baseline drift, future clocks and all unusable evidence without partial confirmation", () => {
    const proposal = buildProjectProfileProposal(metadata(), { ...resolvedFields(), "context.product": observed("Synthetic product") }, [pin]);
    const snapshot = current(proposal);
    for (const changed of [
      { currentProposalId: createStableId("projectProfileProposal") }, { candidateProfileExists: true }, { baseProfileMatches: false },
      { asOf: "2026-09-06T00:00:00.000000Z" }, { evidence: [] }, { evidence: [...snapshot.evidence, ...snapshot.evidence] },
      ...[{ identityDigest: canonicalJsonDigest({ changed: true }) }, { projectId: createStableId("project") }, { sensitivity: "restricted" },
        { sensitivity: ["public"] }, { sensitivity: ["project_confidential"] }, { sensitivity: {} },
        { freshness: "stale" }, { freshness: "unknown" }, { accessibility: "inaccessible" }, { contentHashPresent: false },
        { retrievedAt: "2026-09-07T00:00:00Z" }, { rawSource: "synthetic-private-sentinel" }].map(override => ({ evidence: [{ ...snapshot.evidence[0], ...override }] })),
    ]) assert.throws(() => buildProfileConfirmationRequest(proposal, { ...snapshot, ...changed }), { message: "Profile confirmation request is unavailable; no partial request returned." });
  });
});
