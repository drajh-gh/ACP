import assert from "node:assert/strict";
import { it } from "node:test";
import { createStableId } from "../src/ids.ts";
import { attentionTypes, attentionItemDigest, parseAttentionItem, parseAttentionQueue, parseAttentionQueueQuery } from "../src/attention.ts";

function fixture() {
  return { itemId: createStableId("attentionItem"), projectId: createStableId("project"), missionIds: [createStableId("mission")],
    type: "material_ambiguity", urgency: "normal", title: "Confirm the intended audience", explanation: "Two recorded descriptions disagree.",
    whyHumanIsNeeded: "The sources do not select an audience.", recommendation: "Confirm one audience.", alternatives: ["Internal", "External"],
    consequenceOfNoAction: "This branch remains blocked; independent work can continue.", evidenceIds: [createStableId("evidence")],
    effectPreviewIds: [], allowedResponses: ["Confirm internal", "Confirm external"], expiresAt: "2026-09-06T15:00:00.123456Z",
    deduplicationKey: "audience:version:1", quietHoursDisposition: "Recorded request; notification policy not evaluated." };
}
function queue(item = fixture()) {
  const query = parseAttentionQueueQuery({ projectId: item.projectId, missionId: item.missionIds[0] });
  return { query, value: { schemaVersion: "1.0.0", projectId: item.projectId, missionId: item.missionIds[0], afterItemId: null, limit: 20,
    asOf: "2026-09-06T14:00:00.000000Z", coverage: "recorded_items_only", freshness: "not_assessed", authority: "not_granted",
    items: [{ item, recordedAt: "2026-09-06T13:00:00.000001Z", expiry: "not_expired" }], nextCursor: null } };
}
it("attention preserves all twelve spec types as decision descriptions without granting response or notification authority", () => {
  assert.equal(attentionTypes.length, 12);
  for (const type of attentionTypes) { const source = { ...fixture(), type }; assert.deepEqual(parseAttentionItem(source), source); }
  const source = fixture(), result = parseAttentionItem(source);
  source.allowedResponses[0] = "Mutated"; assert.notEqual(result.allowedResponses[0], "Mutated");
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.allowedResponses));
});
it("attention rejects extra authority fields, malformed identities and unsupported type or urgency", () => {
  for (const change of [{ approved: true }, { type: "automatic_remediation" }, { urgency: "urgent" }, { itemId: createStableId("mission") },
    { projectId: "a project name" }, { missionIds: ["arbitrary"] }, { effectPreviewIds: [createStableId("approval")] },
    { evidenceIds: [createStableId("project")] }, { expiresAt: "2026-02-30T00:00:00Z" }]) assert.throws(() => parseAttentionItem({ ...fixture(), ...change }));
});
it("attention canonicalizes reference sets and exact expiry instants but preserves response and alternative ordering", () => {
  const source = fixture(), a = createStableId("mission"), b = createStableId("mission"), effect = createStableId("effect");
  const parsed = parseAttentionItem({ ...source, missionIds: [b, a], effectPreviewIds: [effect], expiresAt: "2026-09-06T17:00:00.123456+02:00" });
  assert.deepEqual(parsed.missionIds, [a, b].sort()); assert.deepEqual(parsed.effectPreviewIds, [effect]);
  assert.equal(parsed.expiresAt, source.expiresAt); assert.deepEqual(parsed.alternatives, source.alternatives);
  assert.deepEqual(parsed.allowedResponses, source.allowedResponses);
});
it("attention permits project-wide items and absent optional details without inventing evidence or expiry", () => {
  const { recommendation: _r, alternatives: _a, consequenceOfNoAction: _c, expiresAt: _e, effectPreviewIds: _p, ...source } = fixture();
  const result = parseAttentionItem({ ...source, missionIds: [], evidenceIds: [] });
  assert.equal("expiresAt" in result, false); assert.equal("effectPreviewIds" in result, false);
  assert.deepEqual(result.missionIds, []); assert.deepEqual(result.evidenceIds, []);
});
it("attention bounds strings, encoded bytes, dense reference sets and allowed responses without truncating", () => {
  const item = fixture();
  for (const change of [{ title: "x".repeat(241) }, { explanation: "x".repeat(4001) }, { title: " padded " }, { title: "bad\u0000" },
    { allowedResponses: [] }, { allowedResponses: ["same", "same"] }, { missionIds: [item.missionIds[0], item.missionIds[0]] },
    { evidenceIds: Array.from({ length: 51 }, () => createStableId("evidence")) }, { alternatives: Array(2) },
    { explanation: "🚀".repeat(2000), whyHumanIsNeeded: "🚀".repeat(2000), recommendation: "🚀".repeat(2000), consequenceOfNoAction: "🚀".repeat(2000),
      alternatives: Array.from({ length: 10 }, (_, n) => `${n}` + "🚀".repeat(499)) }]) assert.throws(() => parseAttentionItem({ ...item, ...change }));
});
it("attention refuses accessors, hooks, cycles, hidden or symbol fields without invoking caller code", () => {
  let calls = 0;
  const getter = Object.defineProperty(fixture(), "title", { enumerable: true, get() { calls++; return "Private"; } });
  const hook = { ...fixture(), toJSON() { calls++; return {}; } };
  const hidden = Object.defineProperty(fixture(), "private", { value: "secret" });
  const symbolic = { ...fixture(), [Symbol("private")]: true };
  for (const value of [getter, hook, hidden, symbolic]) assert.throws(() => parseAttentionItem(value));
  assert.equal(calls, 0);
});
it("attention semantic digest excludes only item identity and is invariant to reference ordering", () => {
  const source = fixture(), second = createStableId("mission"); source.missionIds.push(second);
  const digest = attentionItemDigest(source);
  assert.equal(attentionItemDigest({ ...source, itemId: createStableId("attentionItem"), missionIds: [...source.missionIds].reverse() }), digest);
  for (const change of [{ title: "Different decision" }, { deduplicationKey: "different" }, { expiresAt: "2026-09-06T15:00:00.123457Z" },
    { allowedResponses: [...source.allowedResponses].reverse() }, { projectId: createStableId("project") }])
    assert.notEqual(attentionItemDigest({ ...source, ...change }), digest);
});
it("attention semantic digest distinguishes optional presence and ordered alternatives", () => {
  const source = fixture(), { effectPreviewIds: _previews, ...absent } = source;
  assert.notEqual(attentionItemDigest(source), attentionItemDigest(absent));
  assert.notEqual(attentionItemDigest(source), attentionItemDigest({ ...source, alternatives: [...source.alternatives].reverse() }));
  const { alternatives: _alternatives, ...none } = source;
  assert.notEqual(attentionItemDigest(none), attentionItemDigest({ ...none, alternatives: [] }));
});
it("attention queue queries bind an exact project and optional mission/cursor with bounded defaults", () => {
  const projectId = createStableId("project"), afterItemId = createStableId("attentionItem");
  assert.deepEqual(parseAttentionQueueQuery({ projectId }), { projectId, limit: 20 });
  assert.deepEqual(parseAttentionQueueQuery({ projectId, afterItemId, limit: 50 }), { projectId, afterItemId, limit: 50 });
  for (const change of [{ limit: 0 }, { limit: 51 }, { limit: 2.5 }, { missionId: null }, { afterItemId: "cursor" }, { acknowledge: true }])
    assert.throws(() => parseAttentionQueueQuery({ projectId, ...change }));
});
it("attention queue expiry is exact at the microsecond boundary and never implies resolution", () => {
  const { query, value } = queue();
  assert.deepEqual(parseAttentionQueue(query, value), value);
  const expired = { ...value, asOf: value.items[0]!.item.expiresAt, items: [{ ...value.items[0]!, expiry: "expired" }] };
  const result = parseAttentionQueue(query, expired); assert.equal(result.items[0]?.expiry, "expired");
  assert.equal("resolved" in result.items[0]!, false);
  assert.throws(() => parseAttentionQueue(query, { ...expired, items: value.items }));
  const { expiresAt: _expires, ...noExpiry } = value.items[0]!.item;
  assert.equal(parseAttentionQueue(query, { ...value, items: [{ ...value.items[0]!, item: noExpiry, expiry: "not_expiring" }] }).items[0]?.expiry, "not_expiring");
});
it("attention queue rejects query substitution, partial disclosure, duplicate items and invented favorable states", () => {
  const { query, value } = queue();
  for (const changed of [{ ...value, projectId: createStableId("project") }, { ...value, missionId: null }, { ...value, limit: 19 },
    { ...value, afterItemId: createStableId("attentionItem") }, { ...value, authority: "approved" }, { ...value, complete: true },
    { ...value, items: [...value.items, ...value.items] }, { ...value, nextCursor: createStableId("attentionItem") },
    { ...value, items: [{ ...value.items[0], recordedAt: "2026-09-06T14:00:00.000001Z" }] },
    { ...value, items: [{ ...value.items[0], item: { ...value.items[0]!.item, missionIds: [] } }] }]) assert.throws(() => parseAttentionQueue(query, changed));
  assert.deepEqual(parseAttentionQueue(query, { ...value, items: [] }).items, []);
});
it("attention pages require priority then immutable time and ID ordering, with an exact last-item continuation", () => {
  const { query, value } = queue(), first = value.items[0]!, second = { ...first, item: { ...first.item, itemId: createStableId("attentionItem"), urgency: "critical" } };
  assert.throws(() => parseAttentionQueue(query, { ...value, items: [first, second] }));
  const shortQuery = { ...query, limit: 2 }, page = { ...value, limit: 2, items: [second, first], nextCursor: first.item.itemId };
  assert.equal(parseAttentionQueue(shortQuery, page).nextCursor, first.item.itemId);
  assert.throws(() => parseAttentionQueue(shortQuery, { ...page, nextCursor: second.item.itemId }));
});
it("attention same-priority pages preserve microsecond chronology and stable-ID tie ordering", () => {
  const { query, value } = queue(), first = value.items[0]!;
  const ids = [createStableId("attentionItem"), createStableId("attentionItem")].sort();
  const early = { ...first, item: { ...first.item, itemId: ids[1] }, recordedAt: "2026-09-06T13:00:00.000001Z" };
  const late = { ...first, item: { ...first.item, itemId: ids[0] }, recordedAt: "2026-09-06T13:00:00.000002Z" };
  assert.equal(parseAttentionQueue(query, { ...value, items: [early, late] }).items.length, 2);
  assert.throws(() => parseAttentionQueue(query, { ...value, items: [late, early] }));
  const tie = { ...late, recordedAt: early.recordedAt };
  assert.equal(parseAttentionQueue(query, { ...value, items: [tie, early] }).items.length, 2);
  assert.throws(() => parseAttentionQueue(query, { ...value, items: [early, tie] }));
});
