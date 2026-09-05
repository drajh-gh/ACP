import assert from "node:assert/strict";
import { it } from "node:test";
import type { Pool } from "pg";
import { createStableId } from "@acp/domain";
import { parseFilesystemWriterReservation, PostgresFilesystemWriterStore } from "../src/index.ts";

const value = { leaseId: createStableId("lease"), runId: createStableId("run"), workerProcessId: createStableId("workerProcess"),
  worktreeBindingId: createStableId("worktreeBinding"), provenanceId: createStableId("provenance") };
it("filesystem writer reservations preserve the complete exact owner tuple", () => {
  assert.deepEqual(parseFilesystemWriterReservation(value),value);
});
it("filesystem writer reservations reject client-selected keys, expiry and missing ownership", () => {
  for (const input of [null,[],{}, { ...value, expiresAt: "2099-01-01" }, { ...value, branchKey: "branch:custom" },
    { ...value, runId: value.leaseId }, { ...value, workerProcessId: undefined }, { ...value, worktreeBindingId: "C:\\workspace" }]) {
    assert.throws(() => parseFilesystemWriterReservation(input),TypeError);
  }
});
it("filesystem writer stores require bounded database access and an explicit runtime", () => {
  const runtime = { hostIdentifier: "host:writer", sessionId: createStableId("workerHostSession"), applicationVersion: "test", bindings: [] };
  assert.throws(() => new PostgresFilesystemWriterStore({ options: {} } as Pool,runtime), /explicitly bounded/u);
  const pool = { options: { connectionTimeoutMillis: 1000, statement_timeout: 1000, lock_timeout: 1000 } } as Pool;
  assert.throws(() => new PostgresFilesystemWriterStore(pool,{ ...runtime,hostIdentifier: " " }), /identity required/u);
  assert.deepEqual(new PostgresFilesystemWriterStore(pool,runtime).authority,
    { hostIdentifier: runtime.hostIdentifier,sessionId: runtime.sessionId,applicationVersion: runtime.applicationVersion });
});
