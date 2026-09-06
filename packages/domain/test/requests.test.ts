import assert from "node:assert/strict";
import { it } from "node:test";
import { createStableId, isStableId, parseStableId } from "../src/ids.ts";
import { parseRequestRegistration, parseRequestMissionLink, requestRegistrationDigest, requestMissionLinkDigest } from "../src/requests.ts";

const registration = () => ({ requestId: "req_00000000-0000-4000-8000-000000000001", projectId: createStableId("project"),
  sourceIntakeId: createStableId("intake"), title: "Membership amendment cannot be submitted", summary: "Retain the reported blockage independently of any proposed repair." });
const link = () => ({ requestId: registration().requestId, projectId: createStableId("project"), missionId: createStableId("mission"), reason: "Investigate the reported blockage." });

it("request identity has its own stable prefix rather than reusing mission or intake identity", () => {
  const id = createStableId("request");
  assert.equal(isStableId(id, "request"), true); assert.match(id, /^req_/u);
  assert.equal(isStableId(id, "mission"), false); assert.equal(isStableId(id, "intake"), false);
  assert.throws(() => parseStableId(createStableId("mission"), "request"));
});
it("request registration retains a detached immutable statement without lifecycle or authority", () => {
  const source = registration(), parsed = parseRequestRegistration(source);
  assert.deepEqual(parsed, source); assert.notEqual(parsed, source); assert.ok(Object.isFrozen(parsed));
  source.title = "Changed after parsing"; assert.notEqual(parsed.title, source.title);
  assert.deepEqual(Object.keys(parsed).sort(), ["projectId", "requestId", "sourceIntakeId", "summary", "title"]);
});
it("one retained intake may support independently identified subrequests, never semantic auto-merging", () => {
  const first = registration(), second = { ...first, requestId: "req_00000000-0000-4000-8000-000000000002" };
  assert.equal(parseRequestRegistration(second).sourceIntakeId, first.sourceIntakeId);
  assert.notEqual(requestRegistrationDigest(first), requestRegistrationDigest(second));
});
it("request digests ignore object key order but bind every registration term", () => {
  const source = registration();
  assert.equal(requestRegistrationDigest(source), requestRegistrationDigest(Object.fromEntries(Object.entries(source).reverse())));
  for (const change of [{ title: "A distinct title" }, { summary: "A distinct matter" }, { projectId: createStableId("project") },
    { sourceIntakeId: createStableId("intake") }, { requestId: "req_00000000-0000-4000-8000-000000000002" }]) {
    assert.notEqual(requestRegistrationDigest(source), requestRegistrationDigest({ ...source, ...change }));
  }
});
it("mission associations bind exact request/project/mission/reason without granting execution", () => {
  const source = link(), parsed = parseRequestMissionLink(source);
  assert.deepEqual(parsed, source); assert.ok(Object.isFrozen(parsed));
  for (const change of [{ missionId: createStableId("mission") }, { projectId: createStableId("project") },
    { requestId: "req_00000000-0000-4000-8000-000000000002" }, { reason: "A distinct reason" }]) {
    assert.notEqual(requestMissionLinkDigest(source), requestMissionLinkDigest({ ...source, ...change }));
  }
});
it("request and association inputs reject injected authority and caller-owned recording metadata", () => {
  for (const [parse, source] of [[parseRequestRegistration, registration()], [parseRequestMissionLink, link()]] as const) {
    for (const field of ["approved", "outcome", "state", "closed", "provenanceId", "recordedAt", "replayed", "execute"]) {
      assert.throws(() => parse({ ...source, [field]: true }));
    }
    for (const field of Object.keys(source)) { const missing = { ...source } as Record<string, unknown>; delete missing[field]; assert.throws(() => parse(missing)); }
  }
});
it("canonical request descriptions preserve exact wording and reject ambiguous or oversized representations", () => {
  const source = registration();
  assert.equal(parseRequestRegistration({ ...source, summary: "Line one\nLine two\t(detail)" }).summary, "Line one\nLine two\t(detail)");
  for (const title of ["", " ", " Leading", "Trailing ", "Line\nbreak", "\u00a0Wrapped\u00a0", "x".repeat(241), "bad\u0000text", "bad\ud800"]) {
    assert.throws(() => parseRequestRegistration({ ...source, title }));
  }
  assert.throws(() => parseRequestRegistration({ ...source, summary: "x".repeat(4001) }));
  assert.throws(() => parseRequestMissionLink({ ...link(), reason: "x".repeat(1001) }));
});
it("unsafe request data is rejected without invoking accessors or serialization hooks", () => {
  let calls = 0;
  const getter = Object.defineProperty(registration(), "title", { enumerable: true, get() { calls++; return "private"; } });
  const serializer = { ...registration(), toJSON() { calls++; return {}; } };
  for (const source of [getter, serializer, new Date(), null, [], Object.assign(registration(), { [Symbol("hidden")]: true })]) assert.throws(() => parseRequestRegistration(source));
  assert.equal(calls, 0);
});
