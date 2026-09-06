import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createStableId } from "../src/ids.ts";
import {
  buildProjectReadiness,
  parseProjectReadiness,
  parseProjectReadinessQuery,
  parseReadinessAssessment,
  parseReadinessTimestamp,
  readinessTimestampMicroseconds,
} from "../src/readiness.ts";

const projectId = createStableId("project");
const profileId = createStableId("projectProfile");
const provenanceId = createStableId("provenance");
const evidenceId = createStableId("evidence");
const key = { capability: "run_required_tests", resourceKey: "repository:fixture", resourceVersion: "binding-1" };
const asOf = "2026-09-06T00:00:00.000001Z";
const query = { projectId, profileId, profileVersion: "1.0.0", keys: [key] };

function assessment(overrides: Record<string, unknown> = {}) {
  return {
    assessmentId: createStableId("capabilityReadinessAssessment"), projectId, profileId, profileVersion: "1.0.0",
    ...key, recordedState: "available", recordedReason: "The bounded synthetic test probe passed.",
    assessedAt: "2026-09-06T00:00:00.000000Z", validUntil: "2026-09-06T01:00:00.000000Z",
    evidenceIds: [evidenceId], evaluatorVersion: "fixture-evaluator:1", provenanceId, supersedesAssessmentId: null,
    ...overrides,
  };
}

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    evidenceId, projectId, observedAt: "2026-09-05T23:59:59.999999Z", retrievedAt: "2026-09-06T00:00:00.000000Z",
    contentHash: "sha256:fixture", sensitivity: "project_confidential", freshness: "current", accessibility: "available",
    ...overrides,
  };
}

function snapshot(rows: readonly unknown[] = [assessment()], refs: readonly unknown[] = [evidence()], clock = asOf) {
  return buildProjectReadiness(query, clock, rows, refs, identities(rows));
}

function identities(rows: readonly unknown[]) {
  return rows.map(row => ({ assessmentId: (row as { assessmentId: string }).assessmentId, matches: true }));
}

describe("exact readiness contracts", () => {
  it("bounds exact query keys without inferring resource or profile aliases", () => {
    assert.deepEqual(parseProjectReadinessQuery(query), query);
    for (const input of [
      { ...query, keys: [] }, { ...query, keys: [key, key] },
      { ...query, keys: Array.from({ length: 51 }, (_, i) => ({ ...key, capability: `test-${i}` })) },
      { ...query, keys: [{ ...key, resourceKey: " repository:fixture" }] },
      { ...query, keys: [{ ...key, resourceVersion: "binding-1\n" }] },
      { ...query, keys: [{ ...key, capability: "x".repeat(201) }] },
      { ...query, keys: [{ ...key, resourceKey: "x".repeat(513) }] },
      { ...query, profileVersion: "latest" }, { ...query, grant: true },
      { ...query, keys: [{ ...key, authority: "write" }] },
    ]) assert.throws(() => parseProjectReadinessQuery(input));
    assert.equal(parseProjectReadinessQuery({ ...query, keys: [{ ...key, resourceKey: "Repository:fixture" }] }).keys[0]?.resourceKey, "Repository:fixture");
    assert.equal(parseProjectReadinessQuery({ ...query, profileVersion: "1.0.0-rc.1+build.2" }).profileVersion, "1.0.0-rc.1+build.2");
  });

  it("canonicalizes equivalent instants without losing PostgreSQL microseconds", () => {
    assert.equal(parseReadinessTimestamp("2026-09-06T02:00:00.000001+02:00"), asOf);
    assert.equal(parseReadinessTimestamp("2026-09-06T00:00:00Z"), "2026-09-06T00:00:00.000000Z");
    assert.equal(readinessTimestampMicroseconds(asOf) - readinessTimestampMicroseconds("2026-09-06T00:00:00.000000Z"), 1n);
    assert.equal(parseReadinessTimestamp("2024-02-29T23:59:59.999999Z"), "2024-02-29T23:59:59.999999Z");
    assert.equal(readinessTimestampMicroseconds("1969-12-31T23:59:59.999999Z"), -1n);
    assert.equal(parseReadinessTimestamp("1970-01-01T00:59:59.999999+01:00"), "1969-12-31T23:59:59.999999Z");
    assert.equal(parseReadinessTimestamp("0001-01-01T00:00:00.000001Z"), "0001-01-01T00:00:00.000001Z");
    assert.equal(parseReadinessTimestamp("9999-12-31T23:59:59.999999Z"), "9999-12-31T23:59:59.999999Z");
    for (const bad of ["2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-09-06T24:00:00Z", "2026-09-06T00:00:00.0000001Z", "0000-01-01T00:00:00Z", "2026-09-06", "infinity"]) {
      assert.throws(() => parseReadinessTimestamp(bad), Error, bad);
    }
  });

  it("retains exact recorded assessment terms and canonical evidence-set identity", () => {
    const other = createStableId("evidence");
    const input = assessment({ evidenceIds: [other, evidenceId], assessedAt: "2026-09-06T02:00:00+02:00" });
    const parsed = parseReadinessAssessment(input);
    assert.deepEqual(parsed.evidenceIds, [other, evidenceId].sort());
    assert.equal(parsed.assessedAt, "2026-09-06T00:00:00.000000Z");
    assert.equal(parsed.supersedesAssessmentId, null);
    assert.match(parsed.assessmentId, /^cra_/u);
    const predecessor = createStableId("capabilityReadinessAssessment");
    assert.equal(parseReadinessAssessment({ ...input, supersedesAssessmentId: predecessor }).supersedesAssessmentId, predecessor);
    for (const invalid of [
      { evidenceIds: [evidenceId, evidenceId] }, { evidenceIds: [] },
      { evidenceIds: Array.from({ length: 21 }, () => createStableId("evidence")) },
      { recordedReason: "x".repeat(2001) }, { recordedState: "ready" }, { evaluatorVersion: " " },
      { validUntil: input.assessedAt }, { validUntil: "2026-09-07T00:00:00.000001Z" },
      { supersedesAssessmentId: input.assessmentId }, { supersedesAssessmentId: createStableId("approval") },
      { assessmentId: createStableId("capabilityGrant") }, { authority: "execute" },
    ]) assert.throws(() => parseReadinessAssessment({ ...input, ...invalid }));
    assert.doesNotThrow(() => parseReadinessAssessment(assessment({ recordedState: "unconfigured", evidenceIds: [] })));
    assert.throws(() => parseReadinessAssessment(assessment({ recordedState: "degraded", evidenceIds: [] })));
  });
});

describe("read-only readiness projection", () => {
  it("reports all seven independent states, never an aggregate ready or execution grant", () => {
    const states = ["available", "degraded", "blocked", "unconfigured", "stale", "revoked", "unknown"];
    const keys = states.map(capability => ({ ...key, capability }));
    const rows = states.map(recordedState => assessment({ capability: recordedState, recordedState }));
    const matrix = buildProjectReadiness({ ...query, keys }, asOf, rows, [evidence()], identities(rows));
    assert.equal(matrix.schemaVersion, "2.0.0");
    assert.deepEqual(matrix.entries.map(entry => entry.currentState), states);
    assert.deepEqual(matrix.assessment, { kind: "recorded_only", freshness: "recorded_deadline_and_evidence_metadata", authority: "none", liveProbes: "not_performed" });
    assert.equal(Object.hasOwn(matrix, "ready"), false);
    assert.deepEqual(parseProjectReadiness(matrix, { ...query, keys }), matrix);
  });

  it("distinguishes absent observations from confirmed missing configuration", () => {
    const missing = snapshot([], []);
    assert.equal(missing.entries[0]?.currentState, "unknown");
    assert.equal(missing.entries[0]?.currentReasonCode, "not_assessed");
    assert.equal(missing.entries[0]?.recorded, null);
    const unconfigured = snapshot([assessment({ recordedState: "unconfigured", evidenceIds: [] })], []);
    assert.equal(unconfigured.entries[0]?.currentState, "unconfigured");
    assert.equal(unconfigured.entries[0]?.recorded?.recordedState, "unconfigured");
  });

  it("expires at the exact microsecond, retains revocation and unknown without renewal", () => {
    const validUntil = "2026-09-06T00:00:00.000002Z";
    const row = assessment({ validUntil });
    assert.equal(snapshot([row]).entries[0]?.currentState, "available");
    const expired = snapshot([row], [evidence()], validUntil).entries[0];
    assert.equal(expired?.currentState, "stale");
    assert.equal(expired?.currentReasonCode, "assessment_expired");
    assert.equal(expired?.recorded?.recordedState, "available");
    assert.equal(snapshot([assessment({ recordedState: "revoked", validUntil })], [evidence()], validUntil).entries[0]?.currentState, "revoked");
    assert.equal(snapshot([assessment({ recordedState: "unknown", validUntil })], [evidence()], validUntil).entries[0]?.currentState, "unknown");
    assert.equal(snapshot([assessment({ recordedState: "blocked", validUntil })], [evidence()], validUntil).entries[0]?.currentState, "stale");
  });

  it("downgrades latest positive assessments when recorded evidence metadata is unusable", () => {
    for (const override of [{ freshness: "stale" }, { freshness: "unknown" }, { accessibility: "inaccessible" },
      { accessibility: "missing" }, { accessibility: "malformed" }, { accessibility: "unknown" }, { contentHash: null }]) {
      const entry = snapshot([assessment()], [evidence(override)]).entries[0];
      assert.equal(entry?.currentState, "stale");
      assert.equal(entry?.currentReasonCode, "supporting_evidence_unusable");
      assert.equal(entry?.recorded?.recordedState, "available");
    }
    assert.equal(snapshot([assessment({ recordedState: "blocked" })], [evidence({ freshness: "unknown" })]).entries[0]?.currentState, "blocked");
  });

  it("denies an entire snapshot generically before disclosing bad references", () => {
    for (const refs of [[], [evidence({ sensitivity: "restricted" })], [evidence({ projectId: createStableId("project") })]]) {
      assert.throws(() => snapshot([assessment()], refs), /^Error: readiness snapshot contains invalid or undisclosable references$/);
    }
    assert.throws(() => snapshot([assessment()], [evidence({ sourceRef: "credential-bearing-private-source" })]));
    const matrix = snapshot();
    const json = JSON.stringify(matrix);
    for (const prohibited of ['"sourceRef":', '"rawContentRef":', '"redactedSummary":', '"contentHash":', "sha256:fixture"]) assert.equal(json.includes(prohibited), false);
  });

  it("requires exact profile, resource, time and already-selected latest identity", () => {
    for (const override of [{ projectId: createStableId("project") }, { profileId: createStableId("projectProfile") },
      { profileVersion: "1.0.1" }, { resourceVersion: "binding-2" }, { resourceKey: "repository:other" },
      { assessedAt: "2026-09-06T00:00:00.000002Z" }]) assert.throws(() => snapshot([assessment(override)]));
    assert.throws(() => snapshot([assessment(), assessment({ recordedState: "blocked" })]));
    assert.throws(() => snapshot([assessment()], [evidence(), evidence()]));
    assert.throws(() => snapshot([assessment()], [evidence({ observedAt: "2026-09-06T00:00:00.000002Z" })]));
    assert.throws(() => snapshot([assessment()], [evidence({ retrievedAt: "2026-09-05T23:59:59.999998Z" })]));
    assert.throws(() => snapshot([assessment()], [evidence({ retrievedAt: "2026-09-06T00:00:00.000002Z" })]));
    assert.throws(() => snapshot([assessment()], [evidence({ contentHash: " " })]));
    assert.throws(() => snapshot([assessment()], [evidence(), evidence({ evidenceId: createStableId("evidence") })]));
    const otherVersion = buildProjectReadiness({ ...query, profileVersion: "1.0.1" }, asOf, [], [], []);
    assert.equal(otherVersion.entries[0]?.currentState, "unknown");
  });

  it("revalidates the derived response and rejects favorable or identity-shaped substitutions", () => {
    const matrix = snapshot([assessment({ validUntil: asOf })], [evidence()], "2026-09-06T00:00:00.000002Z");
    const entry = matrix.entries[0]!;
    for (const altered of [
      { ...matrix, ready: true }, { ...matrix, projectId: createStableId("project") },
      { ...matrix, schemaVersion: "1.0.0" },
      { ...matrix, entries: [] }, { ...matrix, entries: [entry, entry] },
      { ...matrix, entries: [{ ...entry, currentState: "available" }] },
      { ...matrix, entries: [{ ...entry, currentReasonCode: "recorded_assessment" }] },
      { ...matrix, assessment: { ...matrix.assessment, authority: "execute" } },
    ]) assert.throws(() => parseProjectReadiness(altered, query));
  });

  it("bounds total UTF-8 output instead of returning a favorable partial matrix", () => {
    const keys = Array.from({ length: 40 }, (_, i) => ({ ...key, capability: `capability-${i}` }));
    const rows = keys.map(item => assessment({ ...item, recordedReason: "界".repeat(1000) }));
    assert.throws(() => buildProjectReadiness({ ...query, keys }, asOf, rows, [evidence()], identities(rows)), /bounded snapshot/);
  });

  it("requires an explicit identity comparison for each assessment and distinguishes identity drift from current metadata", () => {
    const row = assessment();
    const changed = buildProjectReadiness(query, asOf, [row], [evidence()], [{ assessmentId: row.assessmentId, matches: false }]);
    assert.equal(changed.entries[0]?.currentState, "stale");
    assert.equal(changed.entries[0]?.currentReasonCode, "supporting_evidence_identity_changed");
    assert.equal(changed.entries[0]?.evidenceIdentityMatches, false);
    assert.equal(changed.evidence[0]?.contentHashPresent, true);
    assert.equal(changed.evidence[0]?.freshness, "current");
    assert.deepEqual(parseProjectReadiness(changed, query), changed);
    for (const matches of [[], [{ assessmentId: row.assessmentId, matches: "true" }],
      [{ assessmentId: row.assessmentId, matches: true }, { assessmentId: row.assessmentId, matches: false }],
      [{ assessmentId: createStableId("capabilityReadinessAssessment"), matches: true }]]) {
      assert.throws(() => buildProjectReadiness(query, asOf, [row], [evidence()], matches));
    }
    const revoked = assessment({ recordedState: "revoked" });
    assert.equal(buildProjectReadiness(query, asOf, [revoked], [evidence()], [{ assessmentId: revoked.assessmentId, matches: false }]).entries[0]?.currentState, "revoked");
  });
});
