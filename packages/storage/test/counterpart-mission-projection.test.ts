import assert from "node:assert/strict";
import { it } from "node:test";
import { createStableId, missionStates, workerRoles } from "@acp/domain";
import { counterpartMissionNodeStates, parseCounterpartMissionCreation, parseCounterpartMissionProjection,
  parseCounterpartActiveMissions } from "../src/counterpart-mission-projection.ts";
import { statusFixture } from "./fixtures/counterpart-status.ts";

function fixture() {
  const { statusSchemaVersion: _schema, asOf: _asOf, lifecycle: _lifecycle, completion: _completion,
    assessment: _assessment, evidence: _evidence, ...projection } = statusFixture();
  return { ...projection, nodes: [{ nodeId: createStableId("node"), nodeType: "delivery", workerRole: "delivery", state: "running", graphRevision: "1" }] };
}
it("mission projections preserve all persisted node/role/state vocabulary and historical spellings", () => {
  const base = fixture();
  for (const state of missionStates) assert.equal(parseCounterpartMissionProjection({ ...base, state }).state, state);
  for (const state of counterpartMissionNodeStates) assert.equal(parseCounterpartMissionProjection({ ...base, nodes: [{ ...base.nodes[0], state }] }).nodes[0]?.state, state);
  for (const workerRole of workerRoles) assert.equal(parseCounterpartMissionProjection({ ...base, nodes: [{ ...base.nodes[0], workerRole }] }).nodes[0]?.workerRole, workerRole);
  for (const version of ["01.02.003", "1.2.3-preview.1+build.2", "1.0.0"]) {
    const input = { ...base, workflowVersion: version, createdAt: "2026-09-06T00:00:00.123456+00:00" };
    assert.deepEqual(parseCounterpartMissionProjection(input), input);
  }
  const created = { mission: base, replayed: true };
  assert.deepEqual(parseCounterpartMissionCreation(created), created);
  assert.notEqual(parseCounterpartMissionCreation(created).mission.nodes[0], base.nodes[0]);
});

it("mission projections reject whole invalid documents without silently stripping or normalizing", () => {
  const base = fixture();
  for (const changed of [{ privateField: 1 }, { missionId: "mis_123" }, { missionId: base.missionId + "\n" }, { projectId: base.projectId.toUpperCase() },
    { state: "invented_state" }, { workflowVersion: "latest" }, { completionContractVersion: "1.2" },
    { workflowVersion: "1.0.0\n" }, { createdAt: "2026-01-01T00:00:00Z\n" },
    { createdAt: "2026-02-30T00:00:00Z" }, { updatedAt: "2026-01-01T00:00:00.1234567Z" },
    { nodes: [base.nodes[0], base.nodes[0]] }, { nodes: [{ ...base.nodes[0], workerRole: "admin" }] },
    { nodes: [{ ...base.nodes[0], state: "blocked" }] }, { nodes: [{ ...base.nodes[0], privateField: 1 }] }]) {
    assert.throws(() => parseCounterpartMissionProjection({ ...base, ...changed }));
  }
  for (const value of [{ mission: base }, { mission: base, replayed: "false" }, { mission: base, replayed: false, privateField: 1 }]) {
    assert.throws(() => parseCounterpartMissionCreation(value));
  }
});

it("active mission lists enforce uniqueness, exact query and total UTF-8 bounds independently", () => {
  const { nodes: _nodes, ...summary } = fixture();
  assert.deepEqual(parseCounterpartActiveMissions([summary], summary.projectId, 1), [summary]);
  assert.deepEqual(parseCounterpartActiveMissions([], undefined, 200), []);
  assert.throws(() => parseCounterpartActiveMissions([summary, summary], undefined, 2));
  assert.throws(() => parseCounterpartActiveMissions([summary], createStableId("project"), 1));
  assert.throws(() => parseCounterpartActiveMissions([summary, { ...summary, missionId: createStableId("mission") }], undefined, 1));
  for (const state of ["complete_for_scope", "failed", "cancelled"]) assert.throws(() => parseCounterpartActiveMissions([{ ...summary, state }], undefined, 1));
  for (const limit of [0, 201, NaN, 1.5]) assert.throws(() => parseCounterpartActiveMissions([], undefined, limit));
  const oversized = Array.from({ length: 20 }, () => ({ ...summary, missionId: createStableId("mission"), requestedScope: "😀".repeat(2000) }));
  assert.throws(() => parseCounterpartActiveMissions(oversized, undefined, 20), /bounded snapshot/u);
});
