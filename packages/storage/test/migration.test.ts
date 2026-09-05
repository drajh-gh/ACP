import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const migrationUrl = new URL(
  "../migrations/0001_control_plane.sql",
  import.meta.url,
);
const runtimeMigrationUrl = new URL(
  "../migrations/0002_durable_runtime.sql",
  import.meta.url,
);
const workerRuntimeMigrationUrl = new URL(
  "../migrations/0003_worker_runtime.sql",
  import.meta.url,
);
const runtimeDownMigrationUrl = new URL(
  "../migrations/0002_durable_runtime.down.sql",
  import.meta.url,
);
const workerRuntimeDownMigrationUrl = new URL(
  "../migrations/0003_worker_runtime.down.sql",
  import.meta.url,
);
const counterpartMigrationUrl = new URL(
  "../migrations/0004_counterpart_interface.sql",
  import.meta.url,
);
const counterpartDownMigrationUrl = new URL(
  "../migrations/0004_counterpart_interface.down.sql",
  import.meta.url,
);
const upgradeSeedUrl = new URL(
  "./integration/postgres-0001-upgrade-seed.sql",
  import.meta.url,
);
const authorityLockNegativeUrl = new URL(
  "./integration/postgres-authority-lock-negative.sql",
  import.meta.url,
);
const migrationRunnerUrl = new URL("../src/migrations.ts", import.meta.url);

async function migrationSql() {
  return readFile(migrationUrl, "utf8");
}

async function runtimeMigrationSql() {
  return readFile(runtimeMigrationUrl, "utf8");
}

async function workerRuntimeMigrationSql() {
  return readFile(workerRuntimeMigrationUrl, "utf8");
}

describe("initial PostgreSQL migration contract", () => {
  it("is transactional and preserves orthogonal lifecycle facts", async () => {
    const sql = await migrationSql();

    const runner = await readFile(migrationRunnerUrl, "utf8");
    assert.match(sql, /Transaction ownership belongs to the migration runner/u);
    assert.match(runner, /await client\.query\("BEGIN"\)/u);
    assert.match(runner, /await client\.query\("COMMIT"\)/u);
    assert.match(runner, /await client\.query\("ROLLBACK"\)/u);
    assert.match(sql, /CREATE TABLE acp\.missions/u);
    assert.match(sql, /CREATE TABLE acp\.candidate_records/u);
    assert.match(sql, /CREATE TABLE acp\.deployment_records/u);
    assert.match(sql, /CREATE TABLE acp\.acceptance_records/u);
    assert.match(sql, /CREATE TABLE acp\.tracker_records/u);
    assert.match(sql, /CREATE TABLE acp\.business_completion_records/u);
  });

  it("hardens cross-project identity and completion evaluation integrity", async () => {
    const sql = await runtimeMigrationSql();

    assert.match(sql, /project_workflow_bindings_profile_project_fk/u);
    assert.match(sql, /missions_binding_scope_fk/u);
    assert.match(sql, /effect_proposals_mission_project_fk/u);
    assert.match(sql, /approval_envelopes_mission_project_fk/u);
    assert.match(sql, /evaluation\.mission_id = NEW\.mission_id/u);
    assert.match(sql, /evaluation\.contract_id = NEW\.completion_contract_id/u);
    assert.match(sql, /evaluation\.status = 'passed'/u);
  });

  it("persists DBOS recovery projections and unknown-outcome reconciliation", async () => {
    const sql = await runtimeMigrationSql();

    for (const table of [
      "mission_nodes",
      "context_packets",
      "worker_runs",
      "mission_workflow_runs",
      "durable_subscriptions",
      "effect_reconciliations",
      "execution_precondition_evaluations",
    ]) {
      assert.match(sql, new RegExp(`CREATE TABLE acp\\.${table}\\b`, "u"));
    }
    assert.match(sql, /effect_receipts_verified_readback_required/u);
    assert.match(sql, /must reconcile unknown outcome before retry/u);
  });

  it("persists bounded worker grants, packets, runs, hosts, and processes", async () => {
    const sql = await workerRuntimeMigrationSql();
    const down = await readFile(workerRuntimeDownMigrationUrl, "utf8");

    for (const table of [
      "capability_grants",
      "capability_grant_evaluations",
      "capability_grant_uses",
      "worker_hosts",
      "worker_processes",
    ]) {
      assert.match(sql, new RegExp(`CREATE TABLE acp\\.${table}\\b`, "u"));
    }
    assert.match(sql, /context packet does not match the canonical schema/u);
    assert.match(sql, /NEW\.digest <> acp\.jsonb_sha256/u);
    assert.match(sql, /worker run request exceeds its capability grant/u);
    assert.match(sql, /worker run host capacity is exhausted/u);
    assert.match(sql, /host_record\.heartbeat_ttl_seconds/u);
    assert.match(sql, /worker run cannot finish while its process is running/u);
    assert.match(sql, /mission cannot finish while a worker process is running/u);
    assert.match(sql, /worker_processes_reconciliation_queue/u);
    assert.match(sql, /active worker process reconciliation claim cannot be replaced/u);
    assert.match(sql, /transition provenance does not match mission and host/u);
    assert.match(sql, /FOREIGN KEY \(run_id, grant_id\)/u);
    assert.match(down, /DROP TABLE IF EXISTS acp\.worker_hosts/u);
    assert.match(down, /DROP FUNCTION IF EXISTS acp\.canonical_jsonb_text/u);
  });

  it("persists idempotent counterpart mission creation authority", async () => {
    const sql = await readFile(counterpartMigrationUrl, "utf8");
    const down = await readFile(counterpartDownMigrationUrl, "utf8");

    assert.match(sql, /CREATE TABLE acp\.counterpart_mission_requests/u);
    assert.match(sql, /request_digest ~ '\^sha256:/u);
    assert.match(sql, /runtime_provenance_matches_context/u);
    assert.match(sql, /counterpart_mission_requests_are_immutable/u);
    assert.match(down, /DROP TABLE IF EXISTS acp\.counterpart_mission_requests/u);
  });

  it("fails downgrade explicitly when legacy approval identity is lossy", async () => {
    const down = await readFile(runtimeDownMigrationUrl, "utf8");

    assert.match(
      down,
      /0002 down preflight requires same-timestamp approval evaluations/u,
    );
  });

  it("protects approval, effect, provenance, and receipt audit records", async () => {
    const sql = await runtimeMigrationSql();
    const initial = await migrationSql();

    assert.match(sql, /effect_proposals_protect_content/u);
    assert.match(sql, /approval_envelopes_protect_content/u);
    assert.match(sql, /effect_receipts_are_immutable/u);
    assert.match(initial, /runtime_provenance_is_immutable/u);
    assert.match(initial, /runtime_provenance_text_identity_nonblank/u);
    assert.match(initial, /runtime_provenance_model_configuration_object/u);
  });

  it("persists audit, effect, approval, receipt, and provenance state", async () => {
    const sql = await migrationSql();

    for (const table of [
      "mission_events",
      "effect_proposals",
      "approval_envelopes",
      "effect_receipts",
      "runtime_provenance",
      "runtime_controls",
    ]) {
      assert.match(sql, new RegExp(`CREATE TABLE acp\\.${table}\\b`, "u"));
    }
  });

  it("prevents concurrent active writers for one canonical lease key", async () => {
    const sql = await migrationSql();

    assert.match(
      sql,
      /CREATE UNIQUE INDEX resource_leases_one_active_writer[\s\S]*WHERE state IN \('active', 'recovering'\)/u,
    );
  });

  it("binds effect idempotency to one adapter account scope", async () => {
    const sql = await migrationSql();

    assert.match(
      sql,
      /UNIQUE \(adapter_id, adapter_account_id, idempotency_key\)/u,
    );
  });

  it("gates execution on approval, runtime controls, and a fenced lease", async () => {
    const sql = await runtimeMigrationSql();
    assert.match(sql, /requires a current fenced writer lease/u);
    assert.match(sql, /is paused by runtime control/u);
    assert.match(sql, /requires its exact passing execution precondition evaluation/u);
    assert.match(sql, /effect_receipts_sync_effect_state/u);
    assert.match(sql, /FOREIGN KEY \(unknown_receipt_id, effect_id\)/u);
  });

  it("requires proposal-first, approved, revalidated, receipt-backed effects", async () => {
    const sql = await runtimeMigrationSql();

    assert.match(sql, /effect proposals must begin in proposed state/u);
    assert.match(sql, /requires a current covered approval before authorization/u);
    assert.match(sql, /execution_precondition_evaluation_id/u);
    assert.match(sql, /snapshot\.snapshot = requirement -> 'expected'/u);
    assert.match(sql, /can be verified only by a verified receipt/u);
    assert.match(sql, /effect_proposals_verification_receipt_fk/u);
    assert.match(sql, /effect_receipts_validate_verification_plan/u);
    assert.match(sql, /one evidenced passing result for every verification-plan step/u);
    assert.match(sql, /evidence\.accessibility = 'available'/u);
    assert.match(sql, /evidence\.freshness = 'current'/u);
    assert.match(sql, /evidence\.content_hash =/u);
    assert.match(sql, /evidence\.observed_at =/u);
  });

  it("pins policy and adapter definitions and closes effect targets", async () => {
    const initial = await migrationSql();
    const sql = await runtimeMigrationSql();

    assert.match(initial, /CREATE TABLE acp\.policy_definitions/u);
    assert.match(initial, /CREATE TABLE acp\.adapter_definitions/u);
    assert.match(initial, /FOREIGN KEY \(adapter_id, adapter_version\)/u);
    assert.match(initial, /target -> 'displayName'/u);
    assert.match(initial, /runtime_provenance_policy_version_fk/u);
    assert.match(initial, /runtime_provenance_adapter_version_fk/u);
    assert.match(sql, /runtime_provenance_binding_tuple_fk/u);
    assert.match(sql, /runtime_provenance_matches_context/u);
    assert.doesNotMatch(sql, /ADD COLUMN workflow_id/u);
    assert.doesNotMatch(initial, /snapshot jsonb NOT NULL CHECK/u);
  });

  it("upgrades populated provenance and binds observations to exact context", async () => {
    const initial = await migrationSql();
    const sql = await runtimeMigrationSql();
    const upgradeSeed = await readFile(upgradeSeedUrl, "utf8");

    assert.match(initial, /workflow_binding_id acp\.stable_id NOT NULL/u);
    assert.match(upgradeSeed, /INSERT INTO acp\.runtime_provenance/u);
    assert.match(upgradeSeed, /INSERT INTO acp\.completion_evaluations/u);
    assert.match(upgradeSeed, /INSERT INTO acp\.candidate_records/u);
    assert.match(upgradeSeed, /INSERT INTO acp\.acceptance_records/u);
    assert.match(upgradeSeed, /INSERT INTO acp\.effect_proposals/u);
    assert.match(sql, /legacy-unverified:/u);
    assert.match(sql, /required_receipts_verified = false/u);
    assert.match(sql, /0002 preflight requires complete missions/u);
    assert.match(sql, /0002 preflight requires active legacy missions/u);
    assert.match(sql, /0002 preflight requires context-matching mission provenance/u);
    assert.match(sql, /0002 preflight requires legacy effect authority and receipts/u);
    assert.match(sql, /precondition_snapshots_validate_provenance/u);
    assert.match(sql, /precondition snapshot cannot be future-dated/u);
    assert.match(sql, /snapshot\.captured_at <= NEW\.evaluated_at/u);
    assert.match(sql, /observed -> 'matched' = 'true'::jsonb/u);
    assert.match(sql, /effect receipt cannot be future-dated/u);
    assert.match(sql, /context_packets_validate_provenance/u);
    assert.match(sql, /context packet provenance does not match mission, schema, and digest/u);
    assert.match(sql, /worker_runs_validate_context_provenance/u);
    assert.match(sql, /worker creation provenance does not match context packet/u);
    assert.match(sql, /reconciliation requires outcome-specific observed state/u);
    assert.match(sql, /reconciliation evidence must exist and be available in the effect project/u);
    assert.match(sql, /reconciliation evidence must match the observation source, digest, and time/u);
  });

  it("makes runtime controls audited, nondeletable, and fail closed", async () => {
    const sql = await runtimeMigrationSql();

    assert.match(sql, /runtime_controls_require_audit_event/u);
    assert.match(sql, /current_setting\('acp\.runtime_control_event_id', true\)/u);
    assert.match(sql, /last_control_event_id/u);
    assert.match(sql, /runtime_controls cannot be deleted/u);
    assert.match(sql, /runtime control events must advance monotonically/u);
    assert.match(sql, /CREATE TABLE acp\.runtime_control_authorizations/u);
    assert.match(sql, /runtime_control_events_one_authorization_use/u);
    assert.match(sql, /current exact-scope authorization/u);
    assert.match(sql, /auth\.expires_at > statement_timestamp\(\)/u);
    assert.match(sql, /runtime control projection requires a currently valid unpause authorization/u);
    assert.match(sql, /project runtime control provenance must belong to the scoped project/u);
    assert.match(sql, /IF NOT EXISTS \([\s\S]*scope_type = 'global'/u);
  });

  it("binds leases, terminal results, replay digests, and transition provenance", async () => {
    const sql = await runtimeMigrationSql();
    const authorityLockNegative = await readFile(authorityLockNegativeUrl, "utf8");

    assert.match(sql, /FOREIGN KEY \(owner_run_id, mission_id, node_id\)/u);
    assert.match(sql, /terminal worker result is immutable/u);
    assert.match(sql, /semantic_digest text NOT NULL/u);
    assert.match(sql, /transition_provenance_id/u);
    assert.match(sql, /NEW\.transition_provenance_id/u);
    assert.match(sql, /missions_transition_provenance_fk/u);
    assert.match(sql, /mission identity and requested scope are immutable/u);
    assert.match(sql, /WHEN 'missions' THEN 'mission'/u);
    assert.match(sql, /CREATE FUNCTION acp\.acquire_effect_authority_lock/u);
    assert.match(sql, /effect execution requires the transaction authority lock/u);
    assert.match(sql, /effect authorization requires the transaction authority lock/u);
    assert.match(sql, /FROM pg_catalog\.pg_locks/u);
    assert.match(sql, /approval_evaluation_id acp\.stable_id NOT NULL/u);
    assert.match(sql, /recorded_order bigint GENERATED ALWAYS AS IDENTITY/u);
    assert.match(
      sql,
      /newer_evaluation\.recorded_order > evaluation\.recorded_order/u,
    );
    assert.match(
      sql,
      /precondition_evaluation\.approval_evaluation_id/u,
    );
    assert.match(sql, /runtime_controls_require_authority_lock/u);
    assert.match(sql, /approval_envelopes_require_authority_lock/u);
    assert.match(sql, /resource_leases_require_authority_lock/u);
    assert.match(
      authorityLockNegative,
      /authority mutation succeeded without the transaction lock/u,
    );
    assert.match(authorityLockNegative, /CREATE TEMPORARY TABLE pg_locks/u);
    assert.match(
      authorityLockNegative,
      /effect authorization succeeded without the transaction lock/u,
    );
  });

  it("binds completion evaluations to mission context and time", async () => {
    const sql = await runtimeMigrationSql();

    assert.match(sql, /completion_evaluations_validate/u);
    assert.match(sql, /completion evaluation must use the mission pinned contract/u);
    assert.match(sql, /completion evaluation time must be within the mission lifecycle/u);
    assert.match(sql, /completion evaluation provenance does not match mission context/u);
    assert.match(
      sql,
      /mission completion evaluation can be attached only on scoped completion/u,
    );
  });

  it("makes audit history append-only and starts with effects paused", async () => {
    const sql = await migrationSql();

    assert.match(
      sql,
      /CREATE TRIGGER mission_events_are_append_only[\s\S]*acp\.reject_immutable_mutation\(\)/u,
    );
    assert.match(
      sql,
      /INSERT INTO acp\.runtime_controls[\s\S]*'global',[\s\S]*'global',[\s\S]*true,/u,
    );
  });

  it("requires a completion evaluation reference only for scoped completion", async () => {
    const sql = await migrationSql();

    assert.match(
      sql,
      /state = 'complete_for_scope' AND completed_by_evaluation_id IS NOT NULL/u,
    );
    assert.match(
      sql,
      /state <> 'complete_for_scope' AND completed_by_evaluation_id IS NULL/u,
    );
  });
});
