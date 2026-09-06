import assert from "node:assert/strict";
import { it } from "node:test";
import { createStableId } from "../src/ids.ts";
import { parseRequestHistory, parseRequestHistoryQuery, requestHistoryMaximumAssociations } from "../src/request-history.ts";

const query = () => ({ projectId: createStableId("project"), requestId: createStableId("request") });
const first = "mis_00000000-0000-4000-8000-000000000001", second = "mis_00000000-0000-4000-8000-000000000002";
function fixture() {
  const q = query(); return { q, value: { schemaVersion: "1.0.0", asOf: "2026-09-06T18:00:00.000003Z",
    request: { ...q, sourceIntakeId: createStableId("intake"), title: "Original matter", summary: "The reported blockage remains an original statement." },
    recordedAt: "2026-09-06T18:00:00.000001Z", missionAssociations: [
      { missionId: first, reason: "Investigate", recordedAt: "2026-09-06T18:00:00.000002Z" },
      { missionId: second, reason: "Verify", recordedAt: "2026-09-06T18:00:00.000003Z" }],
    coverage: "recorded_associations_only", freshness: "not_assessed", authority: "not_granted" } };
}
it("request history selectors are exact immutable project/request identity, not a search or action", () => {
  const q = query(), parsed = parseRequestHistoryQuery(q); assert.deepEqual(parsed, q); assert.ok(Object.isFrozen(parsed));
  for (const value of [{ ...q, limit: 1 }, { ...q, approve: true }, { requestId: q.requestId }, { ...q, requestId: createStableId("mission") }])
    assert.throws(() => parseRequestHistoryQuery(value));
});
it("recorded request history is a detached immutable snapshot with no lifecycle inference", () => {
  const { q, value } = fixture(), parsed = parseRequestHistory(q, value); assert.deepEqual(parsed, value);
  assert.ok(Object.isFrozen(parsed)); assert.ok(Object.isFrozen(parsed.request)); assert.ok(Object.isFrozen(parsed.missionAssociations));
  assert.ok(Object.isFrozen(parsed.missionAssociations[0])); value.missionAssociations[0]!.reason = "Changed";
  assert.equal(parsed.missionAssociations[0]?.reason, "Investigate"); assert.equal(parsed.freshness, "not_assessed");
});
it("no recorded associations is valid without implying complete intake coverage or a closed request", () => {
  const { q, value } = fixture(); assert.deepEqual(parseRequestHistory(q, { ...value, missionAssociations: [] }).missionAssociations, []);
  for (const change of [{ coverage: "complete" }, { freshness: "current" }, { authority: "approved" }, { closed: true }, { schemaVersion: "2.0.0" }])
    assert.throws(() => parseRequestHistory(q, { ...value, ...change }));
});
it("history rejects project/request substitution and private or partial metadata", () => {
  const { q, value } = fixture();
  for (const request of [{ ...value.request, projectId: createStableId("project") }, { ...value.request, requestId: createStableId("request") }])
    assert.throws(() => parseRequestHistory(q, { ...value, request }));
  for (const key of Object.keys(value)) { const partial = { ...value } as Record<string, unknown>; delete partial[key]; assert.throws(() => parseRequestHistory(q, partial)); }
  assert.throws(() => parseRequestHistory(q, { ...value, provenanceId: createStableId("provenance") }));
  assert.throws(() => parseRequestHistory(q, { ...value, missionAssociations: [{ ...value.missionAssociations[0], state: "completed" }] }));
});
it("association order and uniqueness are canonical, with no dropped or reordered rows", () => {
  const { q, value } = fixture();
  for (const missionAssociations of [[...value.missionAssociations].reverse(), [value.missionAssociations[0], value.missionAssociations[0]],
    Array.from({ length: requestHistoryMaximumAssociations + 1 }, () => value.missionAssociations[0])])
    assert.throws(() => parseRequestHistory(q, { ...value, missionAssociations }));
  assert.throws(() => parseRequestHistory(q, { ...value, missionAssociations: [{ ...value.missionAssociations[0], reason: " " }] }));
});
it("history chronology retains exact microseconds and rejects future or pre-request associations", () => {
  const { q, value } = fixture();
  assert.equal(parseRequestHistory(q, value).missionAssociations[1]?.recordedAt, value.asOf);
  for (const recordedAt of ["2026-09-06T18:00:00.000000Z", "2026-09-06T18:00:00.000004Z", "invalid"])
    assert.throws(() => parseRequestHistory(q, { ...value, missionAssociations: [{ ...value.missionAssociations[0], recordedAt }] }));
  assert.throws(() => parseRequestHistory(q, { ...value, asOf: "2026-09-06T18:00:00.000000Z" }));
});
it("oversized history and unsafe object behavior are denied as whole responses", () => {
  const { q, value } = fixture(); let calls = 0;
  const unsafe = Object.defineProperty({ ...value }, "request", { enumerable: true, get() { calls++; return value.request; } });
  assert.throws(() => parseRequestHistory(q, unsafe)); assert.equal(calls, 0);
  const missionAssociations = Array.from({ length: 100 }, (_, i) => ({ missionId: `mis_00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    reason: "x".repeat(1000), recordedAt: value.recordedAt }));
  assert.throws(() => parseRequestHistory(q, { ...value, missionAssociations }));
});
