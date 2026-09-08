import assert from "node:assert/strict";
import { it } from "node:test";
import { createStableId, type StableId } from "@acp/domain";
import {
  readRequestBrief,
  requestBriefAttentionPageSize,
  requestBriefMaximumReaderCalls,
  type RequestBriefReaders,
} from "../src/request-brief-reader.ts";
import { statusFixture } from "./fixtures/counterpart-status.ts";

const projectId = createStableId("project");
const requestId = createStableId("request");
const missionId = createStableId("mission");
const intakeId = createStableId("intake");
const at = "2026-09-08T12:00:00.000001Z";
const assembledAt = "2026-09-08T12:01:00.000001Z";
const baseStatus = { ...statusFixture(), projectId, missionId, asOf: at };

function history(change: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1.0.0", asOf: at,
    request: { projectId, requestId, sourceIntakeId: intakeId, title: "Exact title", summary: "Original wording." },
    recordedAt: "2026-09-08T11:00:00.000001Z",
    missionAssociations: [{ missionId, reason: "Recorded link", recordedAt: at }],
    coverage: "recorded_associations_only", freshness: "not_assessed", authority: "not_granted", ...change,
  };
}

function status(change: Record<string, unknown> = {}) {
  return { ...baseStatus, ...change };
}

function queue(change: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1.0.0", projectId, missionId, afterItemId: null, limit: requestBriefAttentionPageSize,
    asOf: at, coverage: "recorded_items_only", freshness: "not_assessed", authority: "not_granted",
    items: [], nextCursor: null, ...change,
  };
}

function fixture(change: Partial<RequestBriefReaders> = {}) {
  const calls: string[] = [];
  const readers: RequestBriefReaders = {
    async getRequestHistory() { calls.push("history"); return history(); },
    async getMissionStatus(id) { calls.push(`status:${id}`); return status(); },
    async getAttentionQueue(query) { calls.push(`attention:${query.limit}`); return queue(); },
    ...change,
  };
  return { readers, calls };
}

it("validates exact selectors and assembly time before I/O", async () => {
  const f = fixture();
  await assert.rejects(readRequestBrief(f.readers, { projectId }, assembledAt));
  await assert.rejects(readRequestBrief(f.readers, { projectId, requestId, missionId }, assembledAt));
  await assert.rejects(readRequestBrief(f.readers, { projectId, requestId }, "not-a-time"));
  assert.deepEqual(f.calls, []);
});

it("reads only associated missions sequentially within declared bounds", async () => {
  const f = fixture();
  const brief = await readRequestBrief(f.readers, { projectId, requestId }, assembledAt);
  assert.ok(brief);
  assert.deepEqual(f.calls, ["history", `status:${missionId}`, `status:${missionId}`, "attention:20", "attention:20", "history"]);
  assert.ok(f.calls.length <= requestBriefMaximumReaderCalls);
  assert.equal(brief.freshness, "not_assessed");
});

it("retains history while marking supported absent sources unavailable", async () => {
  const f = fixture({ async getMissionStatus() { f.calls.push("status:missing"); return undefined; },
    async getAttentionQueue() { f.calls.push("attention:missing"); return undefined; } });
  const brief = await readRequestBrief(f.readers, { projectId, requestId }, assembledAt);
  assert.ok(brief);
  assert.equal(brief.missions[0]?.observation, null);
  assert.deepEqual(brief.missions[0]?.attention, { availability: "unavailable" });
  assert.deepEqual(brief.issues, ["missing_attention", "missing_mission_status"]);
});

it("fails closed on substituted or malformed sources without exposing reader errors", async () => {
  const foreign = fixture({ async getMissionStatus() { return status({ projectId: createStableId("project") }); } });
  await assert.rejects(readRequestBrief(foreign.readers, { projectId, requestId }, assembledAt),
    error => error instanceof Error && error.message === "Request brief mission status source is invalid or outside the requested scope.");

  const broken = fixture({ async getAttentionQueue() { throw new Error("secret database detail"); } });
  await assert.rejects(readRequestBrief(broken.readers, { projectId, requestId }, assembledAt),
    error => error instanceof Error && error.message === "Request brief attention source is unavailable.");
});

it("returns immutable detached snapshots and preserves the attention envelope", async () => {
  const sourceStatus = status();
  const source = queue();
  const f = fixture({
    async getMissionStatus() { return sourceStatus; },
    async getAttentionQueue(query) { f.calls.push(`attention:${query.limit}`); return source; },
  });
  const brief = await readRequestBrief(f.readers, { projectId, requestId }, assembledAt);
  Object.assign(sourceStatus, { state: "verifying" });
  Object.assign(source, { coverage: "mutated-after-read" });
  assert.ok(brief && Object.isFrozen(brief));
  assert.equal(brief.missions[0]?.observation?.state, "executing");
  const attention = brief.missions[0]?.attention;
  assert.equal(attention?.availability, "observed");
  if (attention?.availability === "observed") {
    assert.equal(attention.query.limit, requestBriefAttentionPageSize);
    assert.equal(attention.nextCursor, null);
    assert.equal(attention.coverage, "recorded_items_only");
  }
});

it("detects semantic source changes but ignores asOf-only changes", async () => {
  let statusReads = 0;
  const changed = fixture({ async getMissionStatus() { return status({ state: ++statusReads === 1 ? "executing" : "verifying" }); } });
  const changedBrief = await readRequestBrief(changed.readers, { projectId, requestId }, assembledAt);
  assert.ok(changedBrief?.sourceChanges.some(change => change.source === "mission_status"));

  let reads = 0;
  const timestampOnly = fixture({ async getMissionStatus() {
    reads += 1; return status({ asOf: reads === 1 ? at : "2026-09-08T12:00:30.000001Z" });
  } });
  const stableBrief = await readRequestBrief(timestampOnly.readers, { projectId, requestId }, assembledAt);
  assert.equal(stableBrief?.sourceChanges.length, 0);
});

it("preserves a real pagination cursor from the bounded page", async () => {
  const cursor = "ati_00000000-0000-4000-8000-000000000020" as StableId<"attentionItem">;
  const items = Array.from({ length: requestBriefAttentionPageSize }, (_, index) => {
    const itemId = `ati_00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` as StableId<"attentionItem">;
    return { item: { itemId, projectId, missionIds: [missionId], type: "material_ambiguity", urgency: "normal", title: `Review ${index}`,
      explanation: "Recorded conflict.", whyHumanIsNeeded: "A person must decide.", evidenceIds: [], allowedResponses: ["Review"],
      deduplicationKey: `review:${index}`, quietHoursDisposition: "Not assessed." }, recordedAt: at, expiry: "not_expiring" };
  });
  items[items.length - 1]!.item.itemId = cursor;
  const f = fixture({ async getAttentionQueue() { return queue({ items, nextCursor: cursor }); } });
  const brief = await readRequestBrief(f.readers, { projectId, requestId }, assembledAt);
  const attention = brief?.missions[0]?.attention;
  assert.equal(attention?.availability === "observed" ? attention.nextCursor : null, cursor);
});
