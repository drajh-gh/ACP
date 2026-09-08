import assert from "node:assert/strict";
import { it } from "node:test";
import { runSyntheticRecoveryExercise } from "./support/request-brief-recovery-evaluator.ts";

it("compares independent retained facts with history-only and assembled-brief inputs", async () => {
  const result = await runSyntheticRecoveryExercise();
  assert.equal(result.label, "synthetic_offline_exercise_not_fresh_reader_acceptance");
  assert.deepEqual(result.historyOnly.missingFactIds, ["decisive_detail", "missing_observation", "stale_observation", "source_change",
    "unavailable_records", "next_action", "overflow"]);
  assert.deepEqual(result.brief.missingFactIds, []);
  assert.equal(result.brief.readerCalls, 8);
  assert.ok(result.brief.returnedUtf8Bytes > result.historyOnly.returnedUtf8Bytes);
  assert.ok(result.historyOnly.harnessLatencyMs >= 0 && result.brief.harnessLatencyMs >= 0);
  assert.deepEqual(result.unavailableMeasurements, ["model_usage", "coordinator_usage", "worker_usage", "retry_usage",
    "escalation_usage", "human_recovery_time", "fresh_worker_performance", "accepted_product_outcomes"]);
});

it("negative controls fail when decisive retained content is altered or dropped", async () => {
  const result = await runSyntheticRecoveryExercise();
  assert.deepEqual(result.negativeControls.map(control => [control.name, control.detectedMissingFactIds]), [
    ["alter_original_wording", ["original_wording"]],
    ["drop_decisive_attention", ["decisive_detail"]],
    ["drop_source_change", ["source_change"]],
  ]);
});
