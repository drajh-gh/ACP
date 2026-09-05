-- Populate the complete 0001 schema before 0002 is applied. This fixture proves
-- that the additive runtime migration accepts existing provenance rows.

INSERT INTO acp.projects (project_id, display_name)
VALUES ('prj_00000000-0000-4000-8000-000000000900', '0001 upgrade seed');

INSERT INTO acp.policy_definitions (policy_id, version, definition, published_at)
VALUES (
  'pol_00000000-0000-4000-8000-000000000900',
  '1.0.0',
  '{}'::jsonb,
  '2026-09-04T00:00:00Z'
);

INSERT INTO acp.adapter_definitions (
  adapter_id,
  adapter_key,
  version,
  definition,
  published_at
)
VALUES (
  'adp_00000000-0000-4000-8000-000000000900',
  'upgrade-seed',
  '1.0.0',
  '{}'::jsonb,
  '2026-09-04T00:00:00Z'
);

INSERT INTO acp.completion_contracts (
  contract_id,
  version,
  definition,
  published_at
)
VALUES (
  'cct_00000000-0000-4000-8000-000000000900',
  '1.0.0',
  '{}'::jsonb,
  '2026-09-04T00:00:00Z'
);

INSERT INTO acp.workflow_definitions (
  workflow_id,
  version,
  definition,
  default_completion_contract_id,
  default_completion_contract_version,
  published_at
)
VALUES (
  'wfl_00000000-0000-4000-8000-000000000900',
  '1.0.0',
  '{}'::jsonb,
  'cct_00000000-0000-4000-8000-000000000900',
  '1.0.0',
  '2026-09-04T00:00:00Z'
);

INSERT INTO acp.project_profiles (
  profile_id,
  version,
  project_id,
  profile,
  published_at
)
VALUES (
  'pro_00000000-0000-4000-8000-000000000900',
  '1.0.0',
  'prj_00000000-0000-4000-8000-000000000900',
  '{}'::jsonb,
  '2026-09-04T00:00:00Z'
);

INSERT INTO acp.project_workflow_bindings (
  binding_id,
  project_id,
  workflow_id,
  workflow_version,
  profile_id,
  profile_version,
  completion_contract_id,
  completion_contract_version,
  policy_id,
  policy_version,
  binding,
  active_from
)
VALUES (
  'wfb_00000000-0000-4000-8000-000000000900',
  'prj_00000000-0000-4000-8000-000000000900',
  'wfl_00000000-0000-4000-8000-000000000900',
  '1.0.0',
  'pro_00000000-0000-4000-8000-000000000900',
  '1.0.0',
  'cct_00000000-0000-4000-8000-000000000900',
  '1.0.0',
  'pol_00000000-0000-4000-8000-000000000900',
  '1.0.0',
  '{}'::jsonb,
  '2026-09-04T00:00:00Z'
);

INSERT INTO acp.runtime_provenance (
  provenance_id,
  workflow_binding_id,
  workflow_id,
  project_profile_id,
  completion_contract_id,
  policy_id,
  adapter_id,
  source_repository_commit,
  artifact_digest,
  service_instance,
  service_version,
  codex_plugin_version,
  worker_implementation_version,
  workflow_version,
  policy_version,
  project_profile_version,
  completion_contract_version,
  adapter_version,
  api_version,
  database_schema_version,
  model_identifier,
  model_configuration,
  context_packet_schema_version,
  context_packet_digest,
  credential_reference_version,
  host_identifier,
  execution_environment,
  recorded_at
)
VALUES (
  'prv_00000000-0000-4000-8000-000000000900',
  'wfb_00000000-0000-4000-8000-000000000900',
  'wfl_00000000-0000-4000-8000-000000000900',
  'pro_00000000-0000-4000-8000-000000000900',
  'cct_00000000-0000-4000-8000-000000000900',
  'pol_00000000-0000-4000-8000-000000000900',
  'adp_00000000-0000-4000-8000-000000000900',
  '0000000000000000000000000000000000000000',
  'sha256:upgrade-seed-artifact',
  'upgrade-seed-instance',
  '1.0.0',
  '1.0.0',
  'sha256:upgrade-seed-worker',
  '1.0.0',
  '1.0.0',
  '1.0.0',
  '1.0.0',
  '1.0.0',
  '1.0.0',
  '0001',
  'upgrade-seed-model',
  '{}'::jsonb,
  '1.0.0',
  'sha256:upgrade-seed-context',
  '1.0.0',
  'upgrade-seed-host',
  'integration',
  '2026-09-04T00:00:00Z'
);

INSERT INTO acp.missions (
  mission_id,
  project_id,
  workflow_id,
  workflow_version,
  workflow_binding_id,
  completion_contract_id,
  completion_contract_version,
  state,
  requested_scope,
  created_at,
  updated_at
)
VALUES (
  'mis_00000000-0000-4000-8000-000000000900',
  'prj_00000000-0000-4000-8000-000000000900',
  'wfl_00000000-0000-4000-8000-000000000900',
  '1.0.0',
  'wfb_00000000-0000-4000-8000-000000000900',
  'cct_00000000-0000-4000-8000-000000000900',
  '1.0.0',
  'ready',
  'Exercise a populated migration upgrade.',
  '2026-09-04T00:00:00Z',
  '2026-09-04T00:00:00Z'
);

INSERT INTO acp.completion_evaluations (
  evaluation_id,
  mission_id,
  contract_id,
  contract_version,
  status,
  reasons,
  disqualifiers,
  evaluated_at,
  provenance_id
)
VALUES (
  'cev_00000000-0000-4000-8000-000000000900',
  'mis_00000000-0000-4000-8000-000000000900',
  'cct_00000000-0000-4000-8000-000000000900',
  '1.0.0',
  'failed',
  '["legacy evaluation requires revalidation"]'::jsonb,
  '["receipt and freshness assertions were not recorded"]'::jsonb,
  '2026-09-04T00:00:00Z',
  'prv_00000000-0000-4000-8000-000000000900'
);

INSERT INTO acp.candidate_records (
  record_id,
  mission_id,
  candidate_id,
  state,
  repository_id,
  worktree_path,
  branch,
  head_sha,
  evidence_ids,
  observed_at,
  provenance_id
)
VALUES (
  'rec_00000000-0000-4000-8000-000000000900',
  'mis_00000000-0000-4000-8000-000000000900',
  'can_00000000-0000-4000-8000-000000000900',
  'not_started',
  'rep_00000000-0000-4000-8000-000000000900',
  'C:/upgrade-seed',
  'codex/upgrade-seed',
  '0000000000000000000000000000000000000000',
  '["legacy-evidence-ref"]'::jsonb,
  '2026-09-04T00:00:00Z',
  'prv_00000000-0000-4000-8000-000000000900'
);

INSERT INTO acp.acceptance_records (
  record_id,
  mission_id,
  state,
  evidence_ids,
  observed_at,
  provenance_id
)
VALUES (
  'rec_00000000-0000-4000-8000-000000000901',
  'mis_00000000-0000-4000-8000-000000000900',
  'not_required',
  '[]'::jsonb,
  '2026-09-04T00:00:00Z',
  'prv_00000000-0000-4000-8000-000000000900'
);

INSERT INTO acp.effect_proposals (
  effect_id,
  mission_id,
  project_id,
  effect_type,
  adapter_id,
  adapter_version,
  adapter_account_id,
  target,
  payload,
  preview,
  risk_class,
  rationale,
  evidence_ids,
  idempotency_key,
  proposal_digest,
  payload_digest,
  required_preconditions,
  verification_plan,
  proposed_by_run_id,
  state,
  provenance_id,
  created_at,
  updated_at
)
VALUES (
  'eff_00000000-0000-4000-8000-000000000900',
  'mis_00000000-0000-4000-8000-000000000900',
  'prj_00000000-0000-4000-8000-000000000900',
  'upgrade-seed.write',
  'upgrade-seed',
  '1.0.0',
  'upgrade-seed-account',
  '{"type":"record","externalId":"900","displayName":"Upgrade seed"}'::jsonb,
  '{}'::jsonb,
  'Legacy proposal remains only a proposal.',
  'R1',
  'Exercise safe lifecycle migration.',
  '[]'::jsonb,
  'upgrade-seed:proposal',
  'sha256:upgrade-seed-proposal',
  'sha256:upgrade-seed-payload',
  '[]'::jsonb,
  '[{"type":"read","expected":{"state":"proposed"}}]'::jsonb,
  'run_00000000-0000-4000-8000-000000000900',
  'proposed',
  'prv_00000000-0000-4000-8000-000000000900',
  '2026-09-04T00:00:00Z',
  '2026-09-04T00:00:00Z'
);
