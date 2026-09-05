-- Transaction ownership belongs to the migration runner.

CREATE SCHEMA acp;

CREATE TABLE acp.schema_migrations (
  version text PRIMARY KEY,
  name text NOT NULL,
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  down_checksum_sha256 text NOT NULL CHECK (down_checksum_sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE DOMAIN acp.stable_id AS text
  CHECK (
    VALUE ~ '^[a-z][a-z0-9]{2,4}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  );

CREATE DOMAIN acp.semantic_version AS text
  CHECK (VALUE ~ '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$');

CREATE FUNCTION acp.reject_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TABLE acp.projects (
  project_id acp.stable_id PRIMARY KEY,
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (left(project_id::text, 4) = 'prj_')
);

CREATE TABLE acp.policy_definitions (
  policy_id acp.stable_id NOT NULL,
  version acp.semantic_version NOT NULL,
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  published_at timestamptz NOT NULL,
  PRIMARY KEY (policy_id, version),
  CHECK (left(policy_id::text, 4) = 'pol_')
);

CREATE TRIGGER policy_definitions_are_immutable
BEFORE UPDATE OR DELETE ON acp.policy_definitions
FOR EACH ROW EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE TABLE acp.adapter_definitions (
  adapter_id acp.stable_id NOT NULL,
  adapter_key text NOT NULL CHECK (length(btrim(adapter_key)) > 0),
  version acp.semantic_version NOT NULL,
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  published_at timestamptz NOT NULL,
  PRIMARY KEY (adapter_id, version),
  UNIQUE (adapter_key, version),
  CHECK (left(adapter_id::text, 4) = 'adp_')
);

CREATE TRIGGER adapter_definitions_are_immutable
BEFORE UPDATE OR DELETE ON acp.adapter_definitions
FOR EACH ROW EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE TABLE acp.completion_contracts (
  contract_id acp.stable_id NOT NULL,
  version acp.semantic_version NOT NULL,
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  published_at timestamptz NOT NULL,
  PRIMARY KEY (contract_id, version),
  CHECK (left(contract_id::text, 4) = 'cct_')
);

CREATE TABLE acp.workflow_definitions (
  workflow_id acp.stable_id NOT NULL,
  version acp.semantic_version NOT NULL,
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  default_completion_contract_id acp.stable_id NOT NULL,
  default_completion_contract_version acp.semantic_version NOT NULL,
  published_at timestamptz NOT NULL,
  PRIMARY KEY (workflow_id, version),
  FOREIGN KEY (
    default_completion_contract_id,
    default_completion_contract_version
  ) REFERENCES acp.completion_contracts (contract_id, version),
  CHECK (left(workflow_id::text, 4) = 'wfl_')
);

CREATE TRIGGER workflow_definitions_are_immutable
BEFORE UPDATE OR DELETE ON acp.workflow_definitions
FOR EACH ROW EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE TABLE acp.project_profiles (
  profile_id acp.stable_id NOT NULL,
  version acp.semantic_version NOT NULL,
  project_id acp.stable_id NOT NULL REFERENCES acp.projects (project_id),
  profile jsonb NOT NULL CHECK (jsonb_typeof(profile) = 'object'),
  published_at timestamptz NOT NULL,
  PRIMARY KEY (profile_id, version),
  CHECK (left(profile_id::text, 4) = 'pro_')
);

CREATE TABLE acp.project_workflow_bindings (
  binding_id acp.stable_id PRIMARY KEY,
  project_id acp.stable_id NOT NULL REFERENCES acp.projects (project_id),
  workflow_id acp.stable_id NOT NULL,
  workflow_version acp.semantic_version NOT NULL,
  profile_id acp.stable_id NOT NULL,
  profile_version acp.semantic_version NOT NULL,
  completion_contract_id acp.stable_id NOT NULL,
  completion_contract_version acp.semantic_version NOT NULL,
  policy_id acp.stable_id NOT NULL,
  policy_version acp.semantic_version NOT NULL,
  binding jsonb NOT NULL CHECK (jsonb_typeof(binding) = 'object'),
  active_from timestamptz NOT NULL,
  retired_at timestamptz,
  FOREIGN KEY (workflow_id, workflow_version)
    REFERENCES acp.workflow_definitions (workflow_id, version),
  FOREIGN KEY (profile_id, profile_version)
    REFERENCES acp.project_profiles (profile_id, version),
  FOREIGN KEY (completion_contract_id, completion_contract_version)
    REFERENCES acp.completion_contracts (contract_id, version),
  FOREIGN KEY (policy_id, policy_version)
    REFERENCES acp.policy_definitions (policy_id, version),
  CHECK (left(binding_id::text, 4) = 'wfb_'),
  CHECK (retired_at IS NULL OR retired_at > active_from)
);

CREATE TABLE acp.runtime_provenance (
  provenance_id acp.stable_id PRIMARY KEY,
  workflow_binding_id acp.stable_id NOT NULL
    REFERENCES acp.project_workflow_bindings (binding_id),
  workflow_id acp.stable_id NOT NULL,
  project_profile_id acp.stable_id NOT NULL,
  completion_contract_id acp.stable_id NOT NULL,
  policy_id acp.stable_id NOT NULL,
  adapter_id acp.stable_id NOT NULL,
  source_repository_commit text NOT NULL,
  artifact_digest text NOT NULL,
  service_instance text NOT NULL,
  service_version text NOT NULL,
  codex_plugin_version text NOT NULL,
  worker_implementation_version text NOT NULL,
  workflow_version text NOT NULL,
  policy_version text NOT NULL,
  project_profile_version text NOT NULL,
  completion_contract_version text NOT NULL,
  adapter_version text NOT NULL,
  api_version text NOT NULL,
  database_schema_version text NOT NULL,
  model_identifier text NOT NULL,
  model_configuration jsonb NOT NULL,
  context_packet_schema_version text NOT NULL,
  context_packet_digest text NOT NULL,
  credential_reference_version text NOT NULL,
  host_identifier text NOT NULL,
  execution_environment text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT runtime_provenance_workflow_version_fk
    FOREIGN KEY (workflow_id, workflow_version)
    REFERENCES acp.workflow_definitions (workflow_id, version),
  CONSTRAINT runtime_provenance_profile_version_fk
    FOREIGN KEY (project_profile_id, project_profile_version)
    REFERENCES acp.project_profiles (profile_id, version),
  CONSTRAINT runtime_provenance_contract_version_fk
    FOREIGN KEY (completion_contract_id, completion_contract_version)
    REFERENCES acp.completion_contracts (contract_id, version),
  CONSTRAINT runtime_provenance_policy_version_fk
    FOREIGN KEY (policy_id, policy_version)
    REFERENCES acp.policy_definitions (policy_id, version),
  CONSTRAINT runtime_provenance_adapter_version_fk
    FOREIGN KEY (adapter_id, adapter_version)
    REFERENCES acp.adapter_definitions (adapter_id, version),
  CONSTRAINT runtime_provenance_text_identity_nonblank CHECK (
    length(btrim(source_repository_commit)) > 0
    AND length(btrim(artifact_digest)) > 0
    AND length(btrim(service_instance)) > 0
    AND length(btrim(service_version)) > 0
    AND length(btrim(codex_plugin_version)) > 0
    AND length(btrim(worker_implementation_version)) > 0
    AND length(btrim(workflow_version)) > 0
    AND length(btrim(policy_version)) > 0
    AND length(btrim(project_profile_version)) > 0
    AND length(btrim(completion_contract_version)) > 0
    AND length(btrim(adapter_version)) > 0
    AND length(btrim(api_version)) > 0
    AND length(btrim(database_schema_version)) > 0
    AND length(btrim(model_identifier)) > 0
    AND length(btrim(context_packet_schema_version)) > 0
    AND length(btrim(context_packet_digest)) > 0
    AND length(btrim(credential_reference_version)) > 0
    AND length(btrim(host_identifier)) > 0
    AND length(btrim(execution_environment)) > 0
  ),
  CONSTRAINT runtime_provenance_model_configuration_object CHECK (
    jsonb_typeof(model_configuration) IS NOT DISTINCT FROM 'object'
  ),
  CHECK (left(provenance_id::text, 4) = 'prv_'),
  CHECK (left(workflow_binding_id::text, 4) = 'wfb_'),
  CHECK (left(workflow_id::text, 4) = 'wfl_'),
  CHECK (left(project_profile_id::text, 4) = 'pro_'),
  CHECK (left(completion_contract_id::text, 4) = 'cct_'),
  CHECK (left(policy_id::text, 4) = 'pol_'),
  CHECK (left(adapter_id::text, 4) = 'adp_')
);

CREATE TRIGGER runtime_provenance_is_immutable
BEFORE UPDATE OR DELETE ON acp.runtime_provenance
FOR EACH ROW EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE TABLE acp.intake_records (
  intake_id acp.stable_id PRIMARY KEY,
  project_id acp.stable_id REFERENCES acp.projects (project_id),
  origin text NOT NULL CHECK (
    origin IN (
      'codex', 'gmail', 'slack', 'sentry', 'bugsink', 'tracker',
      'meeting', 'drive', 'schedule', 'other'
    )
  ),
  immutable_source_ref text NOT NULL,
  external_event_id text,
  received_at timestamptz NOT NULL,
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (left(intake_id::text, 4) = 'int_'),
  UNIQUE NULLS NOT DISTINCT (origin, immutable_source_ref, external_event_id)
);

CREATE TABLE acp.evidence_records (
  evidence_id acp.stable_id PRIMARY KEY,
  project_id acp.stable_id NOT NULL REFERENCES acp.projects (project_id),
  source_type text NOT NULL,
  source_ref text NOT NULL,
  observed_at timestamptz NOT NULL,
  retrieved_at timestamptz NOT NULL,
  content_hash text,
  source_version text,
  sensitivity text NOT NULL CHECK (
    sensitivity IN ('public', 'project_confidential', 'restricted')
  ),
  retention_policy text NOT NULL,
  redacted_summary text NOT NULL,
  raw_content_ref text,
  freshness text NOT NULL CHECK (freshness IN ('current', 'stale', 'unknown')),
  accessibility text NOT NULL CHECK (
    accessibility IN ('available', 'inaccessible', 'missing', 'malformed', 'unknown')
  ),
  CHECK (left(evidence_id::text, 4) = 'evd_')
);

CREATE TABLE acp.claims (
  claim_id acp.stable_id PRIMARY KEY,
  project_id acp.stable_id REFERENCES acp.projects (project_id),
  claim_type text NOT NULL CHECK (
    claim_type IN (
      'agreed_fact', 'reported_assertion', 'observation', 'hypothesis',
      'inference', 'request', 'decision', 'commitment', 'requirement',
      'acceptance_criterion', 'superseded_claim', 'disputed_claim'
    )
  ),
  statement text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('active', 'unverified', 'conflicted', 'superseded', 'rejected')
  ),
  authority double precision NOT NULL CHECK (authority BETWEEN 0 AND 1),
  freshness double precision NOT NULL CHECK (freshness BETWEEN 0 AND 1),
  corroboration double precision NOT NULL CHECK (corroboration BETWEEN 0 AND 1),
  completeness double precision NOT NULL CHECK (completeness BETWEEN 0 AND 1),
  inference_distance double precision NOT NULL CHECK (inference_distance >= 0),
  confidence double precision NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  source_evidence_ids jsonb NOT NULL CHECK (jsonb_typeof(source_evidence_ids) = 'array'),
  asserted_by text,
  valid_from timestamptz,
  valid_until timestamptz,
  supersedes jsonb CHECK (supersedes IS NULL OR jsonb_typeof(supersedes) = 'array'),
  created_by_run_id acp.stable_id NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (left(claim_id::text, 4) = 'clm_'),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from)
);

CREATE TABLE acp.missions (
  mission_id acp.stable_id PRIMARY KEY,
  project_id acp.stable_id NOT NULL REFERENCES acp.projects (project_id),
  intake_id acp.stable_id REFERENCES acp.intake_records (intake_id),
  workflow_id acp.stable_id NOT NULL,
  workflow_version acp.semantic_version NOT NULL,
  workflow_binding_id acp.stable_id NOT NULL
    REFERENCES acp.project_workflow_bindings (binding_id),
  completion_contract_id acp.stable_id NOT NULL,
  completion_contract_version acp.semantic_version NOT NULL,
  state text NOT NULL CHECK (
    state IN (
      'received', 'triaging', 'needs_input', 'ready', 'planning',
      'awaiting_approval', 'executing', 'verifying', 'awaiting_external',
      'complete_for_scope', 'failed', 'cancelled'
    )
  ),
  requested_scope text NOT NULL,
  completed_by_evaluation_id acp.stable_id,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (workflow_id, workflow_version)
    REFERENCES acp.workflow_definitions (workflow_id, version),
  FOREIGN KEY (completion_contract_id, completion_contract_version)
    REFERENCES acp.completion_contracts (contract_id, version),
  CHECK (left(mission_id::text, 4) = 'mis_'),
  CHECK (
    (state = 'complete_for_scope' AND completed_by_evaluation_id IS NOT NULL)
    OR
    (state <> 'complete_for_scope' AND completed_by_evaluation_id IS NULL)
  )
);

CREATE TABLE acp.completion_evaluations (
  evaluation_id acp.stable_id PRIMARY KEY,
  mission_id acp.stable_id NOT NULL REFERENCES acp.missions (mission_id),
  contract_id acp.stable_id NOT NULL,
  contract_version acp.semantic_version NOT NULL,
  status text NOT NULL CHECK (status IN ('passed', 'failed')),
  reasons jsonb NOT NULL CHECK (jsonb_typeof(reasons) = 'array'),
  disqualifiers jsonb NOT NULL CHECK (jsonb_typeof(disqualifiers) = 'array'),
  evaluated_at timestamptz NOT NULL,
  provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id),
  FOREIGN KEY (contract_id, contract_version)
    REFERENCES acp.completion_contracts (contract_id, version),
  CHECK (left(evaluation_id::text, 4) = 'cev_'),
  CHECK (status = 'failed' OR jsonb_array_length(disqualifiers) = 0)
);

ALTER TABLE acp.missions
  ADD CONSTRAINT missions_completion_evaluation_fk
  FOREIGN KEY (completed_by_evaluation_id)
  REFERENCES acp.completion_evaluations (evaluation_id);

CREATE TABLE acp.mission_events (
  event_id acp.stable_id PRIMARY KEY,
  mission_id acp.stable_id NOT NULL REFERENCES acp.missions (mission_id),
  event_type text NOT NULL,
  event_version acp.semantic_version NOT NULL,
  idempotency_key text NOT NULL,
  event_digest text NOT NULL CHECK (length(btrim(event_digest)) > 0),
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id),
  CHECK (left(event_id::text, 4) = 'evt_'),
  UNIQUE (mission_id, event_type, idempotency_key)
);

CREATE TRIGGER mission_events_are_append_only
BEFORE UPDATE OR DELETE ON acp.mission_events
FOR EACH ROW EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE TABLE acp.candidate_records (
  record_id acp.stable_id PRIMARY KEY,
  mission_id acp.stable_id NOT NULL REFERENCES acp.missions (mission_id),
  candidate_id acp.stable_id NOT NULL,
  state text NOT NULL CHECK (
    state IN (
      'not_started', 'workspace_ready', 'modified', 'locally_verified',
      'review_pending', 'reviewed', 'pr_open', 'ci_pending', 'merge_ready',
      'merged', 'superseded', 'abandoned'
    )
  ),
  repository_id acp.stable_id NOT NULL,
  worktree_path text NOT NULL,
  branch text NOT NULL,
  head_sha text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}(?:[0-9a-f]{24})?$'),
  evidence_ids jsonb NOT NULL CHECK (jsonb_typeof(evidence_ids) = 'array'),
  observed_at timestamptz NOT NULL,
  provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id)
);

CREATE TABLE acp.deployment_records (
  record_id acp.stable_id PRIMARY KEY,
  mission_id acp.stable_id NOT NULL REFERENCES acp.missions (mission_id),
  environment text NOT NULL,
  artifact_digest text,
  state text NOT NULL CHECK (
    state IN (
      'not_configured', 'not_deployed', 'deployment_proposed', 'authorized',
      'deploying', 'deployed', 'verifying', 'verified', 'failed',
      'unknown_outcome', 'rolled_back'
    )
  ),
  observed_at timestamptz NOT NULL,
  evidence_ids jsonb NOT NULL CHECK (jsonb_typeof(evidence_ids) = 'array'),
  provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id)
);

CREATE TABLE acp.acceptance_records (
  record_id acp.stable_id PRIMARY KEY,
  mission_id acp.stable_id NOT NULL REFERENCES acp.missions (mission_id),
  state text NOT NULL CHECK (
    state IN ('not_required', 'pending', 'running', 'passed', 'failed', 'waived', 'invalidated')
  ),
  candidate_revision text,
  evidence_ids jsonb NOT NULL CHECK (jsonb_typeof(evidence_ids) = 'array'),
  waiver jsonb CHECK (waiver IS NULL OR jsonb_typeof(waiver) = 'object'),
  observed_at timestamptz NOT NULL,
  provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id)
);

CREATE TABLE acp.tracker_records (
  record_id acp.stable_id PRIMARY KEY,
  mission_id acp.stable_id NOT NULL REFERENCES acp.missions (mission_id),
  adapter_id text NOT NULL,
  external_id text NOT NULL,
  native_state text NOT NULL,
  semantic_category text CHECK (
    semantic_category IS NULL OR semantic_category IN (
      'intake', 'selected', 'in_progress', 'on_development',
      'ready_for_release', 'released', 'done', 'rejected'
    )
  ),
  observed_at timestamptz NOT NULL,
  source_version text NOT NULL,
  provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id)
);

CREATE TABLE acp.business_completion_records (
  record_id acp.stable_id PRIMARY KEY,
  mission_id acp.stable_id NOT NULL REFERENCES acp.missions (mission_id),
  state text NOT NULL CHECK (
    state IN ('not_evaluated', 'pending', 'complete', 'not_required')
  ),
  evidence_ids jsonb NOT NULL CHECK (jsonb_typeof(evidence_ids) = 'array'),
  observed_at timestamptz NOT NULL,
  provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id)
);

CREATE TABLE acp.effect_proposals (
  effect_id acp.stable_id PRIMARY KEY,
  mission_id acp.stable_id NOT NULL REFERENCES acp.missions (mission_id),
  project_id acp.stable_id NOT NULL REFERENCES acp.projects (project_id),
  effect_type text NOT NULL,
  adapter_id text NOT NULL,
  adapter_version acp.semantic_version NOT NULL,
  adapter_account_id text NOT NULL CHECK (length(btrim(adapter_account_id)) > 0),
  target jsonb NOT NULL CHECK (
    jsonb_typeof(target) = 'object'
    AND target ? 'type'
    AND target ? 'externalId'
    AND target ? 'displayName'
    AND jsonb_typeof(target -> 'type') = 'string'
    AND length(btrim(target ->> 'type')) > 0
    AND jsonb_typeof(target -> 'externalId') = 'string'
    AND length(btrim(target ->> 'externalId')) > 0
    AND jsonb_typeof(target -> 'displayName') = 'string'
    AND length(btrim(target ->> 'displayName')) > 0
  ),
  payload jsonb NOT NULL,
  preview text NOT NULL,
  risk_class text NOT NULL CHECK (risk_class IN ('R0', 'R1', 'R2', 'R3', 'R4')),
  rationale text NOT NULL,
  evidence_ids jsonb NOT NULL CHECK (jsonb_typeof(evidence_ids) = 'array'),
  candidate_revision text,
  idempotency_key text NOT NULL,
  proposal_digest text NOT NULL CHECK (length(btrim(proposal_digest)) > 0),
  payload_digest text NOT NULL CHECK (length(btrim(payload_digest)) > 0),
  required_preconditions jsonb NOT NULL CHECK (jsonb_typeof(required_preconditions) = 'array'),
  verification_plan jsonb NOT NULL CHECK (
    jsonb_typeof(verification_plan) = 'array'
    AND jsonb_array_length(verification_plan) > 0
  ),
  rollback_plan jsonb CHECK (rollback_plan IS NULL OR jsonb_typeof(rollback_plan) = 'array'),
  proposed_by_run_id acp.stable_id NOT NULL,
  state text NOT NULL CHECK (
    state IN (
      'proposed', 'previewed', 'authorized', 'revalidating', 'executing',
      'applied', 'verifying', 'verified', 'failed', 'unknown_outcome',
      'rolled_back', 'invalidated'
    )
  ),
  execution_fencing_token bigint,
  provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (left(effect_id::text, 4) = 'eff_'),
  FOREIGN KEY (adapter_id, adapter_version)
    REFERENCES acp.adapter_definitions (adapter_key, version),
  UNIQUE (adapter_id, adapter_account_id, idempotency_key)
);

CREATE TABLE acp.approval_envelopes (
  approval_id acp.stable_id PRIMARY KEY,
  approver_id text NOT NULL,
  project_id acp.stable_id NOT NULL REFERENCES acp.projects (project_id),
  mission_id acp.stable_id REFERENCES acp.missions (mission_id),
  allowed_effect_types jsonb NOT NULL CHECK (jsonb_typeof(allowed_effect_types) = 'array'),
  allowed_adapter_account_ids jsonb NOT NULL CHECK (
    jsonb_typeof(allowed_adapter_account_ids) = 'array'
  ),
  allowed_target_ids jsonb NOT NULL CHECK (jsonb_typeof(allowed_target_ids) = 'array'),
  payload_digests jsonb CHECK (payload_digests IS NULL OR jsonb_typeof(payload_digests) = 'array'),
  candidate_revisions jsonb CHECK (
    candidate_revisions IS NULL OR jsonb_typeof(candidate_revisions) = 'array'
  ),
  behavioral_contract_id text,
  maximum_risk_class text NOT NULL CHECK (
    maximum_risk_class IN ('R0', 'R1', 'R2', 'R3', 'R4')
  ),
  maximum_change_size jsonb CHECK (
    maximum_change_size IS NULL OR jsonb_typeof(maximum_change_size) = 'object'
  ),
  allowed_environments jsonb NOT NULL CHECK (jsonb_typeof(allowed_environments) = 'array'),
  required_gates jsonb NOT NULL CHECK (jsonb_typeof(required_gates) = 'array'),
  allowed_repair_classes jsonb NOT NULL CHECK (
    jsonb_typeof(allowed_repair_classes) = 'array'
  ),
  non_material_drift_policy jsonb CHECK (
    non_material_drift_policy IS NULL
    OR jsonb_typeof(non_material_drift_policy) = 'object'
  ),
  precondition_snapshot_ids jsonb NOT NULL CHECK (
    jsonb_typeof(precondition_snapshot_ids) = 'array'
  ),
  rollback_authorization jsonb CHECK (
    rollback_authorization IS NULL OR jsonb_typeof(rollback_authorization) = 'array'
  ),
  valid_from timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  quiet_hours_behavior text NOT NULL CHECK (
    quiet_hours_behavior IN ('defer', 'continue_if_preapproved')
  ),
  revoked_at timestamptz,
  provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id),
  CHECK (left(approval_id::text, 4) = 'apr_'),
  CHECK (expires_at > valid_from)
);

CREATE TABLE acp.precondition_snapshots (
  snapshot_id acp.stable_id PRIMARY KEY,
  effect_id acp.stable_id NOT NULL REFERENCES acp.effect_proposals (effect_id),
  source_ref text NOT NULL CHECK (length(btrim(source_ref)) > 0),
  snapshot jsonb NOT NULL,
  digest text NOT NULL CHECK (length(btrim(digest)) > 0),
  captured_at timestamptz NOT NULL,
  provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id),
  CHECK (left(snapshot_id::text, 4) = 'pcs_')
);

CREATE TABLE acp.effect_approval_evaluations (
  effect_id acp.stable_id NOT NULL REFERENCES acp.effect_proposals (effect_id),
  approval_id acp.stable_id NOT NULL REFERENCES acp.approval_envelopes (approval_id),
  evaluated_at timestamptz NOT NULL,
  result text NOT NULL CHECK (result IN ('covered', 'not_covered', 'invalidated')),
  reasons jsonb NOT NULL CHECK (jsonb_typeof(reasons) = 'array'),
  assessment_context jsonb NOT NULL CHECK (jsonb_typeof(assessment_context) = 'object'),
  provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id),
  PRIMARY KEY (effect_id, approval_id, evaluated_at)
);

CREATE TABLE acp.effect_receipts (
  receipt_id acp.stable_id PRIMARY KEY,
  effect_id acp.stable_id NOT NULL REFERENCES acp.effect_proposals (effect_id),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  state text NOT NULL CHECK (
    state IN ('applied', 'verified', 'failed', 'unknown_outcome', 'rolled_back')
  ),
  execution_record jsonb NOT NULL CHECK (jsonb_typeof(execution_record) = 'object'),
  verification_record jsonb CHECK (
    verification_record IS NULL OR jsonb_typeof(verification_record) = 'object'
  ),
  external_id text,
  attempted_at timestamptz NOT NULL,
  verified_at timestamptz,
  provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id),
  CHECK (left(receipt_id::text, 4) = 'rcp_'),
  CHECK (state <> 'verified' OR verified_at IS NOT NULL),
  UNIQUE (effect_id, attempt_number),
  UNIQUE (receipt_id, effect_id)
);

CREATE TABLE acp.resource_leases (
  lease_id acp.stable_id PRIMARY KEY,
  lease_key text NOT NULL,
  mission_id acp.stable_id NOT NULL REFERENCES acp.missions (mission_id),
  node_id acp.stable_id NOT NULL,
  owner_run_id acp.stable_id NOT NULL,
  fencing_token bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  state text NOT NULL CHECK (state IN ('active', 'recovering', 'released', 'expired')),
  acquired_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  recovery_state jsonb NOT NULL CHECK (jsonb_typeof(recovery_state) = 'object'),
  released_at timestamptz,
  CHECK (left(lease_id::text, 4) = 'lea_'),
  CHECK (expires_at > acquired_at),
  CHECK (released_at IS NULL OR state IN ('released', 'expired'))
);

CREATE UNIQUE INDEX resource_leases_one_active_writer
ON acp.resource_leases (lease_key)
WHERE state IN ('active', 'recovering');

CREATE TABLE acp.runtime_controls (
  scope_type text NOT NULL CHECK (scope_type IN ('global', 'project')),
  scope_id text NOT NULL,
  effects_paused boolean NOT NULL,
  reason text NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (scope_type, scope_id),
  CHECK (
    (scope_type = 'global' AND scope_id = 'global')
    OR
    (scope_type = 'project' AND left(scope_id, 4) = 'prj_')
  )
);

INSERT INTO acp.runtime_controls (
  scope_type,
  scope_id,
  effects_paused,
  reason,
  updated_by,
  updated_at
) VALUES (
  'global',
  'global',
  true,
  'Initial migration defaults all external effects to paused.',
  'migration:0001',
  statement_timestamp()
);
