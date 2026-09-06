import assert from "node:assert/strict";
import { it } from "node:test";
import "./model.js";
const model = globalThis.ACPPrototype;
const request = (state, id = "EX-001") => state.requests.find(row => row.id === id);
it("Operations starts with three decisions in a five-request synthetic set", () => {
  const state = model.createState();
  assert.equal(state.filter, "decisions"); assert.equal(state.coverage, "sample");
  assert.equal(model.visibleRequests(state).length, 3);
  assert.deepEqual(model.counts(state), { decisions: 3, active: 4, waiting: 1, completed: 1 });
  assert.ok(state.requests.every(row => row.id.startsWith("EX-")));
});
it("editing scope retains the earlier proposal and invalidates its simulated approval", () => {
  const original = model.createState();
  let state = model.transition(original, { type: "approve_scope", id: "EX-001", revision: 1 });
  state = model.transition(state, { type: "edit_scope", id: "EX-001", text: "Inspect permissions before preparing a development repair." });
  assert.equal(request(state).proposal.revision, 2); assert.equal(request(state).proposal.approvedRevision, null);
  assert.equal(request(state).proposal.history[0].revision, 1);
  assert.equal(request(original).proposal.history.length, 0);
  assert.equal(request(state).outcomeStatus, "Proposed"); assert.equal(request(state).needsDecision, true);
});
it("approval covers the exact sample scope only and leaves implementation and final outcome outstanding", () => {
  const state = model.transition(model.createState(), { type: "approve_scope", id: "EX-001", revision: 1 });
  assert.equal(request(state).proposal.approvedRevision, 1); assert.equal(request(state).closed, false);
  assert.equal(request(state).checkpoint, "Implementation"); assert.equal(request(state).execution, "Not started");
  assert.equal(request(state).communications[1].state, "Not due"); assert.ok(request(state).obligations.length > 0);
  assert.equal(model.counts(state).decisions, 2);
  assert.ok(model.visibleRequests(state).some(row => row.id === "EX-001"));
  assert.match(state.notice, /No worker started/u);
  assert.throws(() => model.transition(state, { type: "approve_scope", id: "EX-001", revision: 1 }));
});
it("new evidence blocks stale scope approval and loading the revision grants no approval", () => {
  let state = model.transition(model.createState(), { type: "simulate_drift", id: "EX-001" });
  assert.equal(request(state).proposal.stale, true); assert.equal(request(state).proposal.revision, 2);
  assert.throws(() => model.transition(state, { type: "approve_scope", id: "EX-001", revision: 1 }));
  assert.throws(() => model.transition(state, { type: "approve_scope", id: "EX-001", revision: 2 }));
  state = model.transition(state, { type: "load_revision", id: "EX-001" });
  assert.equal(request(state).proposal.approvedRevision, null);
  assert.equal(model.transition(state, { type: "approve_scope", id: "EX-001", revision: 2 }).requests[0].proposal.approvedRevision, 2);
});
it("rejecting a solution preserves the problem, destination and obligations", () => {
  const before = model.createState(), state = model.transition(before, { type: "reject_solution", id: "EX-001", text: "Investigate the existing flow first." });
  assert.equal(request(state).closed, false); assert.equal(request(state).subject, request(before).subject);
  assert.equal(request(state).outcome, request(before).outcome); assert.deepEqual(request(state).obligations, request(before).obligations);
  assert.equal(request(state).checkpoint, "Alternative review"); assert.equal(request(state).decisions.at(-1).kind, "Solution rejected");
});
it("operator evidence reports never turn an incomplete check into passed", () => {
  const state = model.transition(model.createState(), { type: "report_evidence", id: "EX-002", text: "Sample operator report: test account is available." });
  assert.equal(request(state, "EX-002").status, "Verification incomplete");
  assert.equal(request(state, "EX-002").closed, false);
  assert.equal(request(state, "EX-002").checks.find(check => check.name === "Role regression").state, "Incomplete");
  assert.match(state.notice, /independent verification/u);
});
it("a returning linked-ticket signal retains the same deferred request without restoring permission", () => {
  const state = model.transition(model.createState(), { type: "simulate_return", id: "EX-004" });
  assert.equal(state.requests.length, 5); assert.equal(request(state, "EX-004").needsDecision, true);
  assert.equal(request(state, "EX-004").outcomeStatus, "Approved"); assert.equal(request(state, "EX-004").closed, false);
  assert.match(request(state, "EX-004").reason, /Linked ticket selected/u);
  assert.equal(request(state, "EX-004").execution, "Not started");
});
it("unknown simulated send stays unconfirmed and suppresses a duplicate send", () => {
  const before = model.createState(); assert.equal(request(before, "EX-003").status, "Communication due");
  const state = model.transition(before, { type: "simulate_unknown_send", id: "EX-003" });
  assert.equal(request(state, "EX-003").communications[0].state, "Unknown outcome");
  assert.equal(request(state, "EX-003").closed, false); assert.equal(request(state, "EX-003").needsDecision, true);
  assert.throws(() => model.transition(state, { type: "simulate_unknown_send", id: "EX-003" }));
});
it("filters, search and coverage gaps cannot invent completed requests or healthy live sources", () => {
  let state = model.transition(model.createState(), { type: "filter", value: "waiting" });
  assert.deepEqual(model.visibleRequests(state).map(row => row.id), ["EX-004"]);
  state = model.transition(state, { type: "search", value: "no-match" }); assert.equal(model.visibleRequests(state).length, 0);
  state = model.transition(state, { type: "toggle_coverage" }); assert.equal(state.coverage, "unavailable");
  assert.deepEqual(model.counts(state), { decisions: 3, active: 4, waiting: 1, completed: 1 });
});
it("invalid actions, wrong request types and blank or overlong input do not mutate the source state", () => {
  const state = model.createState(), serialized = JSON.stringify(state);
  for (const event of [{ type: "execute_production", id: "EX-001" }, { type: "approve_scope", id: "EX-005", revision: 1 },
    { type: "approve_scope", id: "EX-001", revision: 3 }, { type: "edit_scope", id: "EX-001", text: " " },
    { type: "edit_scope", id: "EX-001", text: "x".repeat(5001) }, { type: "select", id: "missing" }]) assert.throws(() => model.transition(state, event));
  assert.equal(JSON.stringify(state), serialized);
});
it("each simulated transition keeps its board checkpoint represented by the current journey stage", () => {
  for (const event of [{ type: "approve_scope", id: "EX-001", revision: 1 },
    { type: "reject_solution", id: "EX-001", text: "Prepare an alternative." },
    { type: "simulate_return", id: "EX-004" }, { type: "simulate_unknown_send", id: "EX-003" }]) {
    const row = request(model.transition(model.createState(), event), event.id);
    const current = row.journey.find(item => item.name === row.checkpoint);
    assert.ok(current, `${row.checkpoint} must appear in the same request's journey`);
    assert.notEqual(current.state, "Passed"); assert.equal(row.execution, "Not started");
    if (event.type === "simulate_unknown_send") {
      assert.equal(current.state, "Unknown outcome");
      assert.notEqual(row.journey.find(item => item.name === "Reply review").state, "Your decision");
    }
  }
});
it("revising a rejected proposal restores the named scope stage with its exact revision", () => {
  let state = model.transition(model.createState(), { type: "reject_solution", id: "EX-001", text: "Prepare an alternative." });
  state = model.transition(state, { type: "edit_scope", id: "EX-001", text: "Prepare a bounded role investigation first." });
  const row = request(state), current = row.journey.find(item => item.name === row.checkpoint);
  assert.equal(row.checkpoint, "Scope review"); assert.equal(current.state, "Your decision");
  assert.match(current.detail, /revision 2/u); assert.equal(row.proposal.approvedRevision, null);
});
