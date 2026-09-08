import assert from "node:assert/strict";
import { it } from "node:test";
import { runSyntheticRecoveryExercise } from "./support/request-brief-recovery-evaluator.ts";

function withoutLatency<T extends { historyOnly: { harnessLatencyMs: number }; brief: { harnessLatencyMs: number } }>(value: T) {
  const copy = structuredClone(value);
  delete (copy.historyOnly as Partial<typeof copy.historyOnly>).harnessLatencyMs;
  delete (copy.brief as Partial<typeof copy.brief>).harnessLatencyMs;
  return copy;
}

it("structurally compares independently authored facts with instrumented history and brief reads", async () => {
  const result = await runSyntheticRecoveryExercise();
  assert.equal(result.label, "synthetic_offline_exercise_not_fresh_reader_acceptance");
  assert.deepEqual(result.historyOnly.missingFactIds, ["history_reference", "observed_unassessed", "missing_observations",
    "actual_source_change", "decisive_evidence_gap", "overflow", "unavailable_records", "next_action"]);
  assert.deepEqual(result.brief.missingFactIds, []);
  assert.equal(result.historyOnly.sourceReaderCalls, 1);
  assert.equal(result.brief.sourceReaderCalls, 8);
  assert.equal(result.historyOnly.cumulativeSourceReturnedUtf8Bytes, result.historyOnly.resultUtf8Bytes);
  assert.ok(result.brief.cumulativeSourceReturnedUtf8Bytes > 0 && result.brief.resultUtf8Bytes > 0);
  assert.ok(result.historyOnly.harnessLatencyMs >= 0 && result.brief.harnessLatencyMs >= 0);
});

it("reports complete fact failures for wrong-path, authority, pin, coverage, gap and absence decoys", async () => {
  const result = await runSyntheticRecoveryExercise();
  assert.deepEqual(result.negativeControls.map(control => [control.name, control.missingFactIds]), [
    ["wrong_path_decoy", ["original_wording"]], ["contradictory_authority", ["authority_boundaries"]],
    ["altered_source_pin", ["actual_source_change"]], ["altered_coverage", ["coverage"]],
    ["drop_decisive_gap", ["decisive_evidence_gap"]], ["misleading_empty_obligations", ["unavailable_records"]],
  ]);
});

it("is deterministic except for separately measured harness latency", async () => {
  assert.deepEqual(withoutLatency(await runSyntheticRecoveryExercise()), withoutLatency(await runSyntheticRecoveryExercise()));
});
