import assert from "node:assert/strict";
import { it } from "node:test";
import { createStableId, type StableId } from "@acp/domain";
import {
  readRequestBrief,
  requestBriefAttentionPageSize,
  requestBriefMaximumReaderCalls,
  type RequestBriefClock,
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

function clock(...samples: string[]): RequestBriefClock {
  let index = 0;
  return { now() { return samples[Math.min(index++, samples.length - 1)]!; } };
}

function normalClock() { return clock("2026-09-08T11:59:00.000001Z", assembledAt); }

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
  await assert.rejects(readRequestBrief(f.readers, { projectId }, normalClock()));
  await assert.rejects(readRequestBrief(f.readers, { projectId, requestId, missionId }, normalClock()));
  await assert.rejects(readRequestBrief(f.readers, { projectId, requestId }, clock("not-a-time")));
  assert.deepEqual(f.calls, []);
});

it("reads only associated missions sequentially within declared bounds", async () => {
  const f = fixture();
  const brief = await readRequestBrief(f.readers, { projectId, requestId }, normalClock());
  assert.ok(brief);
  assert.deepEqual(f.calls, ["history", `status:${missionId}`, `status:${missionId}`, "attention:20", "attention:20", "history"]);
  assert.ok(f.calls.length <= requestBriefMaximumReaderCalls);
  assert.equal(brief.freshness, "not_assessed");
});

it("retains history while marking supported absent sources unavailable", async () => {
  const f = fixture({ async getMissionStatus() { f.calls.push("status:missing"); return undefined; },
    async getAttentionQueue() { f.calls.push("attention:missing"); return undefined; } });
  const brief = await readRequestBrief(f.readers, { projectId, requestId }, normalClock());
  assert.ok(brief);
  assert.equal(brief.missions[0]?.observation, null);
  assert.deepEqual(brief.missions[0]?.attention, { availability: "unavailable" });
  assert.deepEqual(brief.issues, ["missing_attention", "missing_mission_status"]);
});

it("returns unavailable for absent history without mission fanout", async () => {
  const f = fixture({ async getRequestHistory() { f.calls.push("history:missing"); return undefined; } });
  assert.equal(await readRequestBrief(f.readers, { projectId, requestId }, normalClock()), undefined);
  assert.deepEqual(f.calls, ["history:missing"]);
});

it("distinguishes first-read absence from repeat history and attention disappearance", async () => {
  let historyReads = 0;
  const repeatedHistory = fixture({ async getRequestHistory() {
    repeatedHistory.calls.push("history:repeat"); return ++historyReads === 1 ? history() : undefined;
  } });
  await assert.rejects(readRequestBrief(repeatedHistory.readers, { projectId, requestId }, normalClock()), /history source is unavailable/u);
  assert.equal(historyReads, 2);

  let attentionReads = 0;
  const repeatedAttention = fixture({ async getAttentionQueue() {
    repeatedAttention.calls.push("attention:repeat"); return ++attentionReads === 1 ? queue() : undefined;
  } });
  await assert.rejects(readRequestBrief(repeatedAttention.readers, { projectId, requestId }, normalClock()), /attention source is unavailable/u);
  assert.equal(attentionReads, 2);
});

it("refuses more than fifty associated missions before fanout", async () => {
  const associations = Array.from({ length: 51 }, (_, index) => ({
    missionId: `mis_00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` as StableId<"mission">,
    reason: `Link ${index}`, recordedAt: at,
  }));
  const f = fixture({ async getRequestHistory() { f.calls.push("history:overflow"); return history({ missionAssociations: associations }); } });
  await assert.rejects(readRequestBrief(f.readers, { projectId, requestId }, normalClock()), /bounded mission limit/u);
  assert.deepEqual(f.calls, ["history:overflow"]);
});

it("fails closed on substituted or malformed sources without exposing reader errors", async () => {
  const foreign = fixture({ async getMissionStatus() { return status({ projectId: createStableId("project") }); } });
  await assert.rejects(readRequestBrief(foreign.readers, { projectId, requestId }, normalClock()),
    error => error instanceof Error && error.message === "Request brief mission status source is invalid or outside the requested scope.");

  const broken = fixture({ async getAttentionQueue() { throw new Error("secret database detail"); } });
  await assert.rejects(readRequestBrief(broken.readers, { projectId, requestId }, normalClock()),
    error => error instanceof Error && error.message === "Request brief attention source is unavailable.");
});

it("rejects malformed and cross-project history and attention", async () => {
  for (const value of [history({ request: { ...history().request, projectId: createStableId("project") } }),
    { ...history(), authority: "granted" }]) {
    const f = fixture({ async getRequestHistory() { return value; } });
    await assert.rejects(readRequestBrief(f.readers, { projectId, requestId }, normalClock()),
      /history source is invalid or outside/u);
  }
  for (const value of [queue({ projectId: createStableId("project") }), { ...queue(), authority: "granted" }]) {
    const f = fixture({ async getAttentionQueue() { return value; } });
    await assert.rejects(readRequestBrief(f.readers, { projectId, requestId }, normalClock()),
      /attention source is invalid or outside/u);
  }
});

it("contains synchronous throws and rejected promises from every first and repeat reader call", async () => {
  const failure = (mode: "throw" | "reject", message: string): Promise<never> => {
    if (mode === "throw") throw new Error(message);
    return Promise.reject(new Error(message));
  };
  for (const mode of ["throw", "reject"] as const) {
    for (const repeat of [false, true]) {
      let calls = 0;
      const historyFailure = fixture({ getRequestHistory() {
        if (!repeat || ++calls === 2) return failure(mode, "private history detail");
        return Promise.resolve(history());
      } });
      await assert.rejects(readRequestBrief(historyFailure.readers, { projectId, requestId }, normalClock()),
        error => error instanceof Error && error.message === "Request brief history source is unavailable.");

      calls = 0;
      const statusFailure = fixture({ getMissionStatus() {
        if (!repeat || ++calls === 2) return failure(mode, "private status detail");
        return Promise.resolve(status());
      } });
      await assert.rejects(readRequestBrief(statusFailure.readers, { projectId, requestId }, normalClock()),
        error => error instanceof Error && error.message === "Request brief mission status source is unavailable.");

      calls = 0;
      const attentionFailure = fixture({ getAttentionQueue() {
        if (!repeat || ++calls === 2) return failure(mode, "private attention detail");
        return Promise.resolve(queue());
      } });
      await assert.rejects(readRequestBrief(attentionFailure.readers, { projectId, requestId }, normalClock()),
        error => error instanceof Error && error.message === "Request brief attention source is unavailable.");
    }
  }
});

it("preserves reader method receivers", async () => {
  const f = fixture();
  const readers = {
    marker: "expected",
    async getRequestHistory(this: { marker: string }) { assert.equal(this.marker, "expected"); return history(); },
    async getMissionStatus(this: { marker: string }) { assert.equal(this.marker, "expected"); return status(); },
    async getAttentionQueue(this: { marker: string }) { assert.equal(this.marker, "expected"); return queue(); },
  };
  assert.ok(await readRequestBrief(readers, { projectId, requestId }, normalClock()));
  assert.deepEqual(f.calls, []);
});

it("returns immutable detached snapshots and preserves the attention envelope", async () => {
  const sourceStatus = status();
  const source = queue();
  const f = fixture({
    async getMissionStatus() { return sourceStatus; },
    async getAttentionQueue(query) { f.calls.push(`attention:${query.limit}`); return source; },
  });
  const brief = await readRequestBrief(f.readers, { projectId, requestId }, normalClock());
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
  const changedBrief = await readRequestBrief(changed.readers, { projectId, requestId }, normalClock());
  assert.ok(changedBrief?.sourceChanges.some(change => change.source === "mission_status"));

  let reads = 0;
  const timestampOnly = fixture({ async getMissionStatus() {
    reads += 1; return status({ asOf: reads === 1 ? at : "2026-09-08T12:00:30.000001Z" });
  } });
  const stableBrief = await readRequestBrief(timestampOnly.readers, { projectId, requestId }, normalClock());
  assert.equal(stableBrief?.sourceChanges.length, 0);
});

it("samples completion time after advancing live-reader observations and validates both reads", async () => {
  let statusReads = 0;
  const f = fixture({ async getMissionStatus() {
    return status({ asOf: ++statusReads === 1 ? "2026-09-08T12:00:10.000001Z" : "2026-09-08T12:00:20.000001Z" });
  } });
  const brief = await readRequestBrief(f.readers, { projectId, requestId },
    clock("2026-09-08T11:59:59.000001Z", "2026-09-08T12:00:30.000001Z"));
  assert.equal(brief?.assembledAt, "2026-09-08T12:00:30.000001Z");

  statusReads = 0;
  const future = fixture({ async getMissionStatus() {
    return status({ asOf: ++statusReads === 1 ? at : "2026-09-08T12:00:31.000001Z" });
  } });
  await assert.rejects(readRequestBrief(future.readers, { projectId, requestId },
    clock("2026-09-08T11:59:59.000001Z", "2026-09-08T12:00:30.000001Z")), /later than the completion clock/u);
});

it("rejects future timestamps independently on first and repeat private reads", async () => {
  const completion = "2026-09-08T12:00:30.000001Z";
  for (const futureRead of [1, 2]) {
    let historyReads = 0;
    const historyFuture = fixture({ async getRequestHistory() {
      return history({ asOf: ++historyReads === futureRead ? "2026-09-08T12:00:31.000001Z" : at });
    } });
    await assert.rejects(readRequestBrief(historyFuture.readers, { projectId, requestId }, clock(at, completion)),
      /history source observation is later/u);
    let attentionReads = 0;
    const attentionFuture = fixture({ async getAttentionQueue() {
      return queue({ asOf: ++attentionReads === futureRead ? "2026-09-08T12:00:31.000001Z" : at });
    } });
    await assert.rejects(readRequestBrief(attentionFuture.readers, { projectId, requestId }, clock(at, completion)),
      /attention source observation is later/u);
  }
});

it("fails safely when the injected clock throws, is invalid, or moves backwards", async () => {
  const f = fixture();
  await assert.rejects(readRequestBrief(f.readers, { projectId, requestId }, { now() { throw new Error("private clock detail"); } }),
    /Request brief clock is unavailable or invalid/u);
  await assert.rejects(readRequestBrief(f.readers, { projectId, requestId }, clock("invalid")), /clock is unavailable or invalid/u);
  await assert.rejects(readRequestBrief(f.readers, { projectId, requestId }, clock(assembledAt, at)), /clock moved backwards/u);
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
  const brief = await readRequestBrief(f.readers, { projectId, requestId }, normalClock());
  const attention = brief?.missions[0]?.attention;
  assert.equal(attention?.availability === "observed" ? attention.nextCursor : null, cursor);
});
