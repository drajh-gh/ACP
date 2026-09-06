import assert from "node:assert/strict";
import { it } from "node:test";
import { createStableId, requestHistoryMaximumAssociations, requestHistoryMaximumBytes } from "@acp/domain";
import type { QueryExecutor } from "../src/database.ts";
import { getRequestHistory } from "../src/request-history.ts";

function fixture() {
  const query = { projectId: createStableId("project"), requestId: createStableId("request") };
  const snapshot = { schemaVersion: "1.0.0", asOf: "2026-09-06T18:00:00.000002Z", recordedAt: "2026-09-06T18:00:00.000001Z",
    request: { ...query, sourceIntakeId: createStableId("intake"), title: "Original title", summary: "Original report, not a verified diagnosis." },
    missionAssociations: [], coverage: "recorded_associations_only", freshness: "not_assessed", authority: "not_granted" };
  let rows: unknown[] = [{ request_error: null, snapshot }], failure: Error | undefined; const calls: { sql: string; values: unknown[] | undefined }[] = [];
  const executor = { async query(sql: string, values?: unknown[]) { calls.push({ sql, values }); if (failure) throw failure; return { rows }; } } as unknown as QueryExecutor;
  return { query, snapshot, executor, calls, set rows(value: unknown[]) { rows = value; }, set failure(value: Error) { failure = value; } };
}
it("request history uses one bounded SELECT and validates a complete immutable result", async () => {
  const f = fixture(), result = await getRequestHistory(f.executor, f.query); assert.deepEqual(result, f.snapshot); assert.ok(Object.isFrozen(result));
  assert.equal(f.calls.length, 1); assert.match(f.calls[0]!.sql, /^WITH/u); assert.doesNotMatch(f.calls[0]!.sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|pg_advisory|FOR SHARE)\b/u);
  assert.deepEqual(f.calls[0]!.values, [f.query.projectId, f.query.requestId, requestHistoryMaximumAssociations, requestHistoryMaximumBytes]);
});
it("request history missing scope returns undefined without a fallback project or second query", async () => {
  const f = fixture(); f.rows = []; assert.equal(await getRequestHistory(f.executor, f.query), undefined); assert.equal(f.calls.length, 1);
});
it("request history rejects invalid selectors and unsafe accessors before I/O", async () => {
  const f = fixture(); let calls = 0;
  const unsafe = Object.defineProperty({ ...f.query }, "requestId", { enumerable: true, get() { calls++; return f.query.requestId; } });
  for (const q of [{ ...f.query, limit: 1 }, { ...f.query, approve: true }, { projectId: f.query.projectId }, unsafe]) await assert.rejects(getRequestHistory(f.executor, q));
  assert.equal(f.calls.length, 0); assert.equal(calls, 0);
});
it("request history overflow, malformed envelopes and substituted scope deny the whole response", async () => {
  const f = fixture();
  for (const rows of [[{ request_error: "too_many", snapshot: f.snapshot }], [{ request_error: "too_large", snapshot: null }],
    [{ snapshot: f.snapshot }], [{ request_error: null, snapshot: null }], Array(2).fill({ request_error: null, snapshot: f.snapshot }),
    [{ request_error: null, snapshot: { ...f.snapshot, authority: "granted" } }],
    [{ request_error: null, snapshot: { ...f.snapshot, request: { ...f.snapshot.request, requestId: createStableId("request") } } }]]) {
    f.rows = rows; const count = f.calls.length; await assert.rejects(getRequestHistory(f.executor, f.query)); assert.equal(f.calls.length, count + 1);
  }
});
it("request history query failure never returns an empty success or retries", async () => {
  const f = fixture(); f.failure = new Error("synthetic unavailable database"); await assert.rejects(getRequestHistory(f.executor, f.query)); assert.equal(f.calls.length, 1);
});
