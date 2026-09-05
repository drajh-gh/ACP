-- Transaction ownership belongs to the migration runner.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM acp.effect_approval_evaluations
    GROUP BY effect_id, approval_id, evaluated_at
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      '0002 down preflight requires same-timestamp approval evaluations to be reconciled before downgrade';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS execution_precondition_evaluations_require_authority_lock
  ON acp.execution_precondition_evaluations;
DROP TRIGGER IF EXISTS resource_leases_require_authority_lock ON acp.resource_leases;
DROP TRIGGER IF EXISTS effect_approval_evaluations_require_authority_lock
  ON acp.effect_approval_evaluations;
DROP TRIGGER IF EXISTS approval_envelopes_require_authority_lock
  ON acp.approval_envelopes;
DROP TRIGGER IF EXISTS runtime_controls_require_authority_lock ON acp.runtime_controls;
DROP TRIGGER IF EXISTS runtime_control_events_require_authority_lock
  ON acp.runtime_control_events;
DROP TRIGGER IF EXISTS runtime_control_authorizations_require_authority_lock
  ON acp.runtime_control_authorizations;
DROP FUNCTION IF EXISTS acp.require_effect_authority_lock();
DROP FUNCTION IF EXISTS acp.acquire_effect_authority_lock();

DROP TRIGGER IF EXISTS durable_subscriptions_validate_provenance ON acp.durable_subscriptions;
DROP TRIGGER IF EXISTS mission_workflow_runs_validate_provenance ON acp.mission_workflow_runs;
DROP TRIGGER IF EXISTS worker_runs_validate_context_provenance ON acp.worker_runs;
DROP FUNCTION IF EXISTS acp.validate_worker_run_context_provenance();
DROP TRIGGER IF EXISTS worker_runs_validate_provenance ON acp.worker_runs;
DROP TRIGGER IF EXISTS mission_nodes_validate_provenance ON acp.mission_nodes;
DROP FUNCTION IF EXISTS acp.validate_runtime_projection_provenance();
DROP TRIGGER IF EXISTS effect_reconciliations_validate_provenance ON acp.effect_reconciliations;
DROP TRIGGER IF EXISTS execution_precondition_evaluations_validate_provenance
  ON acp.execution_precondition_evaluations;
DROP TRIGGER IF EXISTS effect_approval_evaluations_validate_provenance
  ON acp.effect_approval_evaluations;
DROP TRIGGER IF EXISTS precondition_snapshots_validate_provenance
  ON acp.precondition_snapshots;
DROP TRIGGER IF EXISTS effect_receipts_validate_verification_plan ON acp.effect_receipts;
DROP FUNCTION IF EXISTS acp.validate_verified_receipt_plan();
DROP TRIGGER IF EXISTS effect_receipts_validate_provenance ON acp.effect_receipts;
DROP FUNCTION IF EXISTS acp.validate_effect_record_provenance();

DROP TRIGGER IF EXISTS durable_subscriptions_record_state_transition ON acp.durable_subscriptions;
DROP TRIGGER IF EXISTS mission_workflow_runs_record_state_transition ON acp.mission_workflow_runs;
DROP TRIGGER IF EXISTS worker_runs_record_state_transition ON acp.worker_runs;
DROP TRIGGER IF EXISTS mission_nodes_record_state_transition ON acp.mission_nodes;
DROP TRIGGER IF EXISTS missions_record_state_transition ON acp.missions;
DROP TRIGGER IF EXISTS effect_proposals_record_state_transition ON acp.effect_proposals;
DROP FUNCTION IF EXISTS acp.record_state_transition();
DROP TRIGGER IF EXISTS state_transition_events_are_immutable ON acp.state_transition_events;
DROP TABLE IF EXISTS acp.state_transition_events;
DROP TRIGGER IF EXISTS effect_receipts_require_reconciliation ON acp.effect_receipts;
DROP FUNCTION IF EXISTS acp.require_unknown_outcome_reconciliation();
DROP TRIGGER IF EXISTS effect_receipts_sync_effect_state ON acp.effect_receipts;
DROP FUNCTION IF EXISTS acp.sync_effect_state_from_receipt();
DROP TRIGGER IF EXISTS effect_proposals_enforce_state_transition ON acp.effect_proposals;
DROP FUNCTION IF EXISTS acp.enforce_effect_transition();
DROP TRIGGER IF EXISTS effect_proposals_protect_content ON acp.effect_proposals;
DROP FUNCTION IF EXISTS acp.protect_effect_proposal();
DROP TRIGGER IF EXISTS effect_proposals_validate_initial_state ON acp.effect_proposals;
DROP FUNCTION IF EXISTS acp.validate_initial_effect_state();
DROP TRIGGER IF EXISTS execution_precondition_evaluations_are_immutable
  ON acp.execution_precondition_evaluations;
DROP TRIGGER IF EXISTS execution_precondition_evaluations_validate
  ON acp.execution_precondition_evaluations;
DROP FUNCTION IF EXISTS acp.validate_execution_precondition_evaluation();
ALTER TABLE acp.effect_proposals
  DROP CONSTRAINT IF EXISTS effect_proposals_execution_precondition_fk;
DROP TABLE IF EXISTS acp.execution_precondition_evaluations;
ALTER TABLE acp.effect_approval_evaluations
  DROP CONSTRAINT IF EXISTS effect_approval_evaluations_pkey,
  DROP CONSTRAINT IF EXISTS effect_approval_evaluations_identity_scope_unique,
  DROP CONSTRAINT IF EXISTS effect_approval_evaluations_recorded_order_unique,
  DROP CONSTRAINT IF EXISTS effect_approval_evaluations_id_prefix,
  DROP COLUMN IF EXISTS approval_evaluation_id,
  DROP COLUMN IF EXISTS recorded_order,
  ADD CONSTRAINT effect_approval_evaluations_pkey
    PRIMARY KEY (effect_id, approval_id, evaluated_at);
ALTER TABLE acp.resource_leases
  DROP CONSTRAINT IF EXISTS resource_leases_id_token_unique;
DROP TRIGGER IF EXISTS effect_reconciliations_validate_receipt ON acp.effect_reconciliations;
DROP FUNCTION IF EXISTS acp.validate_effect_reconciliation();
DROP TRIGGER IF EXISTS durable_subscriptions_protect_identity ON acp.durable_subscriptions;
DROP TRIGGER IF EXISTS mission_workflow_runs_protect_identity ON acp.mission_workflow_runs;
DROP TRIGGER IF EXISTS worker_runs_protect_identity ON acp.worker_runs;
DROP TRIGGER IF EXISTS mission_nodes_protect_identity ON acp.mission_nodes;
DROP FUNCTION IF EXISTS acp.protect_runtime_projection_identity();
ALTER TABLE acp.resource_leases
  DROP CONSTRAINT IF EXISTS resource_leases_owner_run_fk,
  DROP CONSTRAINT IF EXISTS resource_leases_mission_node_fk;
DROP TABLE IF EXISTS acp.effect_reconciliations;
DROP TABLE IF EXISTS acp.durable_subscriptions;
DROP TABLE IF EXISTS acp.mission_workflow_runs;
DROP TABLE IF EXISTS acp.worker_runs;
DROP TRIGGER IF EXISTS context_packets_validate_provenance ON acp.context_packets;
DROP FUNCTION IF EXISTS acp.validate_context_packet_provenance();
DROP TABLE IF EXISTS acp.context_packets;
DROP TABLE IF EXISTS acp.mission_nodes;
DROP TABLE IF EXISTS acp.intake_dispositions;
DROP TRIGGER IF EXISTS runtime_controls_require_audit_event ON acp.runtime_controls;
DROP FUNCTION IF EXISTS acp.authorize_runtime_control_mutation();
ALTER TABLE acp.runtime_controls
  DROP CONSTRAINT IF EXISTS runtime_controls_last_event_fk,
  DROP CONSTRAINT IF EXISTS runtime_controls_authorization_fk;
DROP TRIGGER IF EXISTS runtime_control_events_validate_authorization
  ON acp.runtime_control_events;
DROP TRIGGER IF EXISTS runtime_control_events_validate_scope_provenance
  ON acp.runtime_control_events;
DROP FUNCTION IF EXISTS acp.validate_runtime_control_event();
DROP TRIGGER IF EXISTS runtime_control_events_are_immutable ON acp.runtime_control_events;
DROP TABLE IF EXISTS acp.runtime_control_events;

ALTER TABLE acp.runtime_controls
  DROP CONSTRAINT IF EXISTS runtime_controls_unpause_requires_authorization,
  DROP COLUMN IF EXISTS last_control_event_id,
  DROP COLUMN IF EXISTS authorization_id;

DROP TRIGGER IF EXISTS runtime_control_authorizations_are_immutable
  ON acp.runtime_control_authorizations;
DROP TRIGGER IF EXISTS runtime_control_authorizations_validate_scope_provenance
  ON acp.runtime_control_authorizations;
DROP FUNCTION IF EXISTS acp.validate_runtime_control_scope_provenance();
DROP TABLE IF EXISTS acp.runtime_control_authorizations;

ALTER TABLE acp.completion_evaluations
  DROP CONSTRAINT IF EXISTS completion_evaluations_lifecycle_digest_nonblank,
  DROP COLUMN IF EXISTS lifecycle_digest,
  DROP COLUMN IF EXISTS evidence_freshness_verified,
  DROP COLUMN IF EXISTS required_receipts_verified;

ALTER TABLE acp.acceptance_records
  DROP CONSTRAINT IF EXISTS acceptance_records_passed_evidence_required,
  DROP CONSTRAINT IF EXISTS acceptance_records_audit_contract;
ALTER TABLE acp.candidate_records
  DROP CONSTRAINT IF EXISTS candidate_records_evidence_required;
ALTER TABLE acp.resource_leases
  DROP CONSTRAINT IF EXISTS resource_leases_canonical_key;
ALTER TABLE acp.effect_receipts
  DROP CONSTRAINT IF EXISTS effect_receipts_verified_timing,
  DROP CONSTRAINT IF EXISTS effect_receipts_verified_readback_required;

DROP TRIGGER IF EXISTS effect_receipts_are_immutable ON acp.effect_receipts;
DROP TRIGGER IF EXISTS effect_approval_evaluations_are_immutable ON acp.effect_approval_evaluations;
DROP TRIGGER IF EXISTS effect_approval_evaluations_validate_coverage ON acp.effect_approval_evaluations;
DROP FUNCTION IF EXISTS acp.validate_covered_approval_evaluation();
DROP TRIGGER IF EXISTS precondition_snapshots_are_immutable ON acp.precondition_snapshots;
DROP TRIGGER IF EXISTS completion_evaluations_are_immutable ON acp.completion_evaluations;
DROP TRIGGER IF EXISTS completion_evaluations_validate ON acp.completion_evaluations;
DROP FUNCTION IF EXISTS acp.validate_completion_evaluation();
DROP TRIGGER IF EXISTS project_profiles_are_immutable ON acp.project_profiles;
DROP TRIGGER IF EXISTS completion_contracts_are_immutable ON acp.completion_contracts;
DROP TRIGGER IF EXISTS project_workflow_bindings_protect_content ON acp.project_workflow_bindings;
DROP FUNCTION IF EXISTS acp.protect_workflow_binding();
DROP TRIGGER IF EXISTS approval_envelopes_protect_content ON acp.approval_envelopes;
DROP FUNCTION IF EXISTS acp.protect_approval_envelope();
DROP TRIGGER IF EXISTS missions_enforce_state_transition ON acp.missions;
DROP FUNCTION IF EXISTS acp.enforce_mission_transition();
DROP TRIGGER IF EXISTS missions_protect_identity ON acp.missions;
DROP FUNCTION IF EXISTS acp.protect_mission_identity();
DROP TRIGGER IF EXISTS missions_validate_initial_provenance ON acp.missions;
DROP FUNCTION IF EXISTS acp.validate_initial_mission_provenance();
DROP TRIGGER IF EXISTS missions_require_matching_completion ON acp.missions;
DROP FUNCTION IF EXISTS acp.validate_completed_mission();

DROP FUNCTION IF EXISTS acp.runtime_provenance_matches_context(
  acp.stable_id,
  acp.stable_id,
  text,
  text
);

ALTER TABLE acp.runtime_provenance
  DROP CONSTRAINT IF EXISTS runtime_provenance_binding_tuple_fk;

ALTER TABLE acp.approval_envelopes
  DROP CONSTRAINT IF EXISTS approval_envelopes_mission_project_fk;
ALTER TABLE acp.effect_proposals
  DROP CONSTRAINT IF EXISTS effect_proposals_verification_receipt_fk,
  DROP CONSTRAINT IF EXISTS effect_proposals_transition_provenance_fk,
  DROP CONSTRAINT IF EXISTS effect_proposals_mission_project_fk,
  DROP COLUMN IF EXISTS verification_receipt_id,
  DROP COLUMN IF EXISTS execution_precondition_evaluation_id,
  DROP COLUMN IF EXISTS transition_provenance_id;
ALTER TABLE acp.missions
  DROP CONSTRAINT IF EXISTS missions_binding_scope_fk,
  DROP CONSTRAINT IF EXISTS missions_workflow_execution_scope_unique,
  DROP CONSTRAINT IF EXISTS missions_mission_project_unique,
  DROP CONSTRAINT IF EXISTS missions_transition_provenance_fk,
  DROP COLUMN IF EXISTS transition_provenance_id;
ALTER TABLE acp.project_workflow_bindings
  DROP CONSTRAINT IF EXISTS project_workflow_bindings_runtime_tuple_unique,
  DROP CONSTRAINT IF EXISTS project_workflow_bindings_scope_unique,
  DROP CONSTRAINT IF EXISTS project_workflow_bindings_profile_project_fk;
ALTER TABLE acp.project_profiles
  DROP CONSTRAINT IF EXISTS project_profiles_project_identity_unique;
