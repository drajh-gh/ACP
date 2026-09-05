SET CONSTRAINTS ALL IMMEDIATE;
SELECT acp.acquire_effect_authority_lock();

CREATE OR REPLACE FUNCTION pg_temp.expect_sqlstate(
  expected_state text,
  statement text
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = expected_state THEN
      RETURN;
    END IF;
    RAISE;
  END;
  RAISE EXCEPTION 'statement succeeded; expected SQLSTATE %: %', expected_state, statement;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.context_packet_content(
  context_packet_id text,
  node_id text,
  capability_grant_id text,
  retry_count integer DEFAULT 0
) RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    'contextPacketId', context_packet_id,
    'schemaVersion', '1.0.0',
    'missionId', 'mis_00000000-0000-4000-8000-000000000001',
    'nodeId', node_id,
    'projectId', 'prj_00000000-0000-4000-8000-000000000001',
    'nodeType', 'effect',
    'workerRole', 'effect_executor',
    'objective', 'Exercise the durable worker boundary.',
    'nonGoals', jsonb_build_array('No external side effects.'),
    'completionScope', 'Return one structured result.',
    'projectProfile', jsonb_build_object(
      'id', 'pro_00000000-0000-4000-8000-000000000001', 'version', '1.0.0'
    ),
    'workflow', jsonb_build_object(
      'id', 'wfl_00000000-0000-4000-8000-000000000001', 'version', '1.0.0'
    ),
    'policy', jsonb_build_object(
      'id', 'pol_00000000-0000-4000-8000-000000000001', 'version', '1.0.0'
    ),
    'completionContract', jsonb_build_object(
      'id', 'cct_00000000-0000-4000-8000-000000000001', 'version', '1.0.0'
    ),
    'lifecycle', jsonb_build_object(
      'mission', jsonb_build_object('state', 'executing'),
      'deployments', '[]'::jsonb,
      'acceptance', jsonb_build_object('state', 'not_required'),
      'effects', '[]'::jsonb,
      'businessCompletion', jsonb_build_object('state', 'not_required')
    ),
    'behavioralContract', '{}'::jsonb,
    'acceptanceCriteria', jsonb_build_array('The result is schema-valid.'),
    'sourceAuthorityRules', '{}'::jsonb,
    'evidence', '[]'::jsonb,
    'activeClaimIds', '[]'::jsonb,
    'conflicts', '[]'::jsonb,
    'unresolvedQuestions', '[]'::jsonb,
    'previousResultRefs', '[]'::jsonb,
    'approvalIds', '[]'::jsonb,
    'capabilityGrantId', capability_grant_id,
    'requiredOutputSchema', 'acp.worker-result@1.0.0',
    'nextAction', 'Return the synthetic result.',
    'retryCount', retry_count,
    'limits', jsonb_build_object(
      'wallTimeMs', 300000,
      'maximumTurns', 3,
      'maximumOutputBytes', 32768
    )
  )
$$;

INSERT INTO acp.projects (project_id, display_name) VALUES
  ('prj_00000000-0000-4000-8000-000000000001', 'Project A'),
  ('prj_00000000-0000-4000-8000-000000000002', 'Project B');

INSERT INTO acp.policy_definitions (
  policy_id, version, definition, published_at
) VALUES (
  'pol_00000000-0000-4000-8000-000000000001', '1.0.0', '{}',
  statement_timestamp()
);

INSERT INTO acp.adapter_definitions (
  adapter_id, adapter_key, version, definition, published_at
) VALUES (
  'adp_00000000-0000-4000-8000-000000000001', 'synthetic', '1.0.0', '{}',
  statement_timestamp()
), (
  'adp_00000000-0000-4000-8000-000000000002', 'other-adapter', '1.0.0', '{}',
  statement_timestamp()
);

INSERT INTO acp.completion_contracts (
  contract_id, version, definition, published_at
) VALUES (
  'cct_00000000-0000-4000-8000-000000000001', '1.0.0', '{}',
  statement_timestamp()
);

INSERT INTO acp.workflow_definitions (
  workflow_id, version, definition, default_completion_contract_id,
  default_completion_contract_version, published_at
) VALUES (
  'wfl_00000000-0000-4000-8000-000000000001', '1.0.0', '{}',
  'cct_00000000-0000-4000-8000-000000000001', '1.0.0',
  statement_timestamp()
);

INSERT INTO acp.project_profiles (
  profile_id, version, project_id, profile, published_at
) VALUES (
  'pro_00000000-0000-4000-8000-000000000001', '1.0.0',
  'prj_00000000-0000-4000-8000-000000000001', '{}', statement_timestamp()
);

INSERT INTO acp.project_workflow_bindings (
  binding_id, project_id, workflow_id, workflow_version, profile_id,
  profile_version, completion_contract_id, completion_contract_version,
  policy_id, policy_version, binding, active_from
) VALUES (
  'wfb_00000000-0000-4000-8000-000000000001',
  'prj_00000000-0000-4000-8000-000000000001',
  'wfl_00000000-0000-4000-8000-000000000001', '1.0.0',
  'pro_00000000-0000-4000-8000-000000000001', '1.0.0',
  'cct_00000000-0000-4000-8000-000000000001', '1.0.0',
  'pol_00000000-0000-4000-8000-000000000001', '1.0.0',
  '{}', statement_timestamp()
);

INSERT INTO acp.runtime_provenance (
  provenance_id, source_repository_commit, artifact_digest, service_instance,
  service_version, codex_plugin_version, worker_implementation_version,
  workflow_version, policy_version, project_profile_version,
  completion_contract_version, adapter_version, api_version,
  database_schema_version, model_identifier, model_configuration,
  context_packet_schema_version, context_packet_digest,
  credential_reference_version, host_identifier, execution_environment,
  workflow_binding_id, workflow_id, project_profile_id, completion_contract_id,
  policy_id, adapter_id
) VALUES (
  'prv_00000000-0000-4000-8000-000000000001', repeat('a', 40),
  'sha256:artifact', 'test', '1.0.0', '1.0.0', '1.0.0', '1.0.0',
  '1.0.0', '1.0.0', '1.0.0', '1.0.0', '1.0.0', '0002', 'synthetic',
  '{}', '1.0.0', acp.jsonb_sha256(pg_temp.context_packet_content(
    'ctx_00000000-0000-4000-8000-000000000001',
    'nod_00000000-0000-4000-8000-000000000001',
    'cgr_00000000-0000-4000-8000-000000000001'
  )), '1.0.0', 'host:test', 'integration-test',
  'wfb_00000000-0000-4000-8000-000000000001',
  'wfl_00000000-0000-4000-8000-000000000001',
  'pro_00000000-0000-4000-8000-000000000001',
  'cct_00000000-0000-4000-8000-000000000001',
  'pol_00000000-0000-4000-8000-000000000001',
  'adp_00000000-0000-4000-8000-000000000001'
), (
  'prv_00000000-0000-4000-8000-000000000002', repeat('b', 40),
  'sha256:other-artifact', 'test', '1.0.0', '1.0.0', '1.0.0', '1.0.0',
  '1.0.0', '1.0.0', '1.0.0', '1.0.0', '1.0.0', '0002', 'synthetic',
  '{}', '1.0.0', acp.jsonb_sha256(pg_temp.context_packet_content(
    'ctx_00000000-0000-4000-8000-000000000002',
    'nod_00000000-0000-4000-8000-000000000002',
    'cgr_00000000-0000-4000-8000-000000000002'
  )), '1.0.0', 'host:test', 'integration-test',
  'wfb_00000000-0000-4000-8000-000000000001',
  'wfl_00000000-0000-4000-8000-000000000001',
  'pro_00000000-0000-4000-8000-000000000001',
  'cct_00000000-0000-4000-8000-000000000001',
  'pol_00000000-0000-4000-8000-000000000001',
  'adp_00000000-0000-4000-8000-000000000002'
);

INSERT INTO acp.runtime_provenance (
  provenance_id, source_repository_commit, artifact_digest, service_instance,
  service_version, codex_plugin_version, worker_implementation_version,
  workflow_version, policy_version, project_profile_version,
  completion_contract_version, adapter_version, api_version,
  database_schema_version, model_identifier, model_configuration,
  context_packet_schema_version, context_packet_digest,
  credential_reference_version, host_identifier, execution_environment,
  workflow_binding_id, workflow_id, project_profile_id, completion_contract_id,
  policy_id, adapter_id
)
SELECT
  target.provenance_id, source_repository_commit,
  artifact_digest, service_instance, service_version, codex_plugin_version,
  worker_implementation_version, workflow_version, policy_version,
  project_profile_version, completion_contract_version, adapter_version,
  api_version, database_schema_version, model_identifier, model_configuration,
  context_packet_schema_version, context_packet_digest,
  credential_reference_version, target.host_identifier, execution_environment,
  workflow_binding_id, workflow_id, project_profile_id, completion_contract_id,
  policy_id, adapter_id
FROM acp.runtime_provenance AS source
CROSS JOIN (VALUES
  ('prv_00000000-0000-4000-8000-000000000003'::acp.stable_id, 'host:other'),
  ('prv_00000000-0000-4000-8000-000000000004'::acp.stable_id, 'host:stale'),
  ('prv_00000000-0000-4000-8000-000000000005'::acp.stable_id, 'host:offline')
) AS target(provenance_id, host_identifier)
WHERE source.provenance_id = 'prv_00000000-0000-4000-8000-000000000002';

WITH content AS (
  SELECT jsonb_set(
    pg_temp.context_packet_content(
      'ctx_00000000-0000-4000-8000-000000000098',
      'nod_00000000-0000-4000-8000-000000000002',
      'cgr_00000000-0000-4000-8000-000000000002'
    ),
    '{workflow,version}',
    '"9.9.9"'::jsonb
  ) AS value
)
INSERT INTO acp.runtime_provenance (
  provenance_id, source_repository_commit, artifact_digest, service_instance,
  service_version, codex_plugin_version, worker_implementation_version,
  workflow_version, policy_version, project_profile_version,
  completion_contract_version, adapter_version, api_version,
  database_schema_version, model_identifier, model_configuration,
  context_packet_schema_version, context_packet_digest,
  credential_reference_version, host_identifier, execution_environment,
  workflow_binding_id, workflow_id, project_profile_id, completion_contract_id,
  policy_id, adapter_id
)
SELECT
  'prv_00000000-0000-4000-8000-000000000006', source_repository_commit,
  artifact_digest, service_instance, service_version, codex_plugin_version,
  worker_implementation_version, workflow_version, policy_version,
  project_profile_version, completion_contract_version, adapter_version,
  api_version, database_schema_version, model_identifier, model_configuration,
  context_packet_schema_version, acp.jsonb_sha256(content.value),
  credential_reference_version, host_identifier, execution_environment,
  workflow_binding_id, workflow_id, project_profile_id, completion_contract_id,
  policy_id, adapter_id
FROM acp.runtime_provenance
CROSS JOIN content
WHERE provenance_id = 'prv_00000000-0000-4000-8000-000000000002';

INSERT INTO acp.worker_hosts (
  host_identifier, host_kind, state, maximum_cpu_intensive,
  maximum_moderate_compute, maximum_lightweight_read,
  maximum_network_bound, heartbeat_ttl_seconds, heartbeat_at, provenance_id,
  transition_provenance_id
) VALUES (
  'host:test', 'operator_laptop', 'active', 1, 2, 2, 4, 60,
  statement_timestamp(),
  'prv_00000000-0000-4000-8000-000000000001',
  'prv_00000000-0000-4000-8000-000000000001'
), (
  'host:stale', 'vps', 'active', 1, 2, 4, 4, 5,
  statement_timestamp() - interval '10 seconds',
  'prv_00000000-0000-4000-8000-000000000004',
  'prv_00000000-0000-4000-8000-000000000004'
), (
  'host:offline', 'vps', 'offline', 1, 2, 4, 4, 60,
  statement_timestamp(),
  'prv_00000000-0000-4000-8000-000000000005',
  'prv_00000000-0000-4000-8000-000000000005'
);

SELECT pg_temp.expect_sqlstate(
  '23514',
  $statement$
    INSERT INTO acp.runtime_provenance (
      provenance_id, workflow_binding_id, workflow_id, project_profile_id,
      completion_contract_id, policy_id, adapter_id,
      source_repository_commit, artifact_digest, service_instance,
      service_version, codex_plugin_version, worker_implementation_version,
      workflow_version, policy_version, project_profile_version,
      completion_contract_version, adapter_version, api_version,
      database_schema_version, model_identifier, model_configuration,
      context_packet_schema_version, context_packet_digest,
      credential_reference_version, host_identifier, execution_environment
    )
    SELECT
      'prv_00000000-0000-4000-8000-000000000099', workflow_binding_id,
      workflow_id, project_profile_id, completion_contract_id, policy_id,
      adapter_id, source_repository_commit, '   ', service_instance,
      service_version, codex_plugin_version, worker_implementation_version,
      workflow_version, policy_version, project_profile_version,
      completion_contract_version, adapter_version, api_version,
      database_schema_version, model_identifier, model_configuration,
      context_packet_schema_version, context_packet_digest,
      credential_reference_version, host_identifier, execution_environment
    FROM acp.runtime_provenance
    WHERE provenance_id = 'prv_00000000-0000-4000-8000-000000000001'
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  '23514',
  $statement$
    INSERT INTO acp.runtime_provenance (
      provenance_id, workflow_binding_id, workflow_id, project_profile_id,
      completion_contract_id, policy_id, adapter_id,
      source_repository_commit, artifact_digest, service_instance,
      service_version, codex_plugin_version, worker_implementation_version,
      workflow_version, policy_version, project_profile_version,
      completion_contract_version, adapter_version, api_version,
      database_schema_version, model_identifier, model_configuration,
      context_packet_schema_version, context_packet_digest,
      credential_reference_version, host_identifier, execution_environment
    )
    SELECT
      'prv_00000000-0000-4000-8000-000000000098', workflow_binding_id,
      workflow_id, project_profile_id, completion_contract_id, policy_id,
      adapter_id, source_repository_commit, artifact_digest, service_instance,
      service_version, codex_plugin_version, worker_implementation_version,
      workflow_version, policy_version, project_profile_version,
      completion_contract_version, adapter_version, api_version,
      database_schema_version, model_identifier, 'null'::jsonb,
      context_packet_schema_version, context_packet_digest,
      credential_reference_version, host_identifier, execution_environment
    FROM acp.runtime_provenance
    WHERE provenance_id = 'prv_00000000-0000-4000-8000-000000000001'
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    UPDATE acp.runtime_provenance
    SET artifact_digest = 'sha256:retroactive-rewrite'
    WHERE provenance_id = 'prv_00000000-0000-4000-8000-000000000001'
  $statement$
);

INSERT INTO acp.evidence_records (
  evidence_id, project_id, source_type, source_ref, observed_at, retrieved_at,
  content_hash, sensitivity, retention_policy, redacted_summary, freshness,
  accessibility
) VALUES (
  'evd_00000000-0000-4000-8000-000000000001',
  'prj_00000000-0000-4000-8000-000000000001', 'synthetic', 'record:readback',
  statement_timestamp(), statement_timestamp(), 'sha256:observed-one', 'public',
  'integration-test', 'Synthetic read-back matched.', 'current', 'available'
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    INSERT INTO acp.runtime_control_authorizations (
      authorization_id, scope_type, scope_id, action, authorized_by, reason,
      valid_from, expires_at, provenance_id
    ) VALUES (
      'rca_00000000-0000-4000-8000-000000000099', 'project',
      'prj_00000000-0000-4000-8000-000000000099', 'unpause_effects',
      'operator:test', 'Wrong-project provenance must fail.',
      '2000-01-01T00:00:00Z', '2099-01-01T00:00:00Z',
      'prv_00000000-0000-4000-8000-000000000001'
    )
  $statement$
);

INSERT INTO acp.runtime_control_authorizations (
  authorization_id, scope_type, scope_id, action, authorized_by, reason,
  valid_from, expires_at, provenance_id
) VALUES
  (
    'rca_00000000-0000-4000-8000-000000000001', 'global', 'global',
    'unpause_effects', 'operator:test', 'Consistency checks passed.',
    '2000-01-01T00:00:00Z', '2099-01-01T00:00:00Z',
    'prv_00000000-0000-4000-8000-000000000001'
  ),
  (
    'rca_00000000-0000-4000-8000-000000000002', 'global', 'global',
    'unpause_effects', 'operator:test', 'Expired authorization test.',
    '2000-01-01T00:00:00Z', statement_timestamp() - interval '1 microsecond',
    'prv_00000000-0000-4000-8000-000000000001'
  ),
  (
    'rca_00000000-0000-4000-8000-000000000003', 'global', 'global',
    'unpause_effects', 'operator:test', 'Projection-expiry test.',
    '2000-01-01T00:00:00Z', statement_timestamp() + interval '200 milliseconds',
    'prv_00000000-0000-4000-8000-000000000001'
  );

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    INSERT INTO acp.runtime_control_events (
      control_event_id, scope_type, scope_id, previous_effects_paused,
      effects_paused, reason, updated_by, authorization_id, occurred_at,
      provenance_id
    )
    SELECT
      'rce_00000000-0000-4000-8000-000000000099', 'global', 'global', true,
      false, 'Backdated expired authorization.', 'operator:test',
      'rca_00000000-0000-4000-8000-000000000002',
      updated_at + interval '1 microsecond',
      'prv_00000000-0000-4000-8000-000000000001'
    FROM acp.runtime_controls
    WHERE scope_type = 'global' AND scope_id = 'global'
  $statement$
);

INSERT INTO acp.runtime_control_events (
  control_event_id, scope_type, scope_id, previous_effects_paused,
  effects_paused, reason, updated_by, authorization_id, occurred_at,
  provenance_id
)
VALUES (
  'rce_00000000-0000-4000-8000-000000000098', 'global', 'global', true,
  false, 'Authorization expires before projection.', 'operator:test',
  'rca_00000000-0000-4000-8000-000000000003', statement_timestamp(),
  'prv_00000000-0000-4000-8000-000000000001'
);

SELECT pg_sleep(0.25);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    WITH configured AS (
      SELECT set_config(
        'acp.runtime_control_event_id',
        'rce_00000000-0000-4000-8000-000000000098',
        true
      )
    ), event AS (
      SELECT occurred_at FROM acp.runtime_control_events
      WHERE control_event_id = 'rce_00000000-0000-4000-8000-000000000098'
    )
    UPDATE acp.runtime_controls
    SET effects_paused = false,
        reason = 'Authorization expires before projection.',
        updated_by = 'operator:test',
        authorization_id = 'rca_00000000-0000-4000-8000-000000000003',
        updated_at = event.occurred_at,
        last_control_event_id = 'rce_00000000-0000-4000-8000-000000000098'
    FROM configured, event
    WHERE scope_type = 'global' AND scope_id = 'global'
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    UPDATE acp.runtime_controls
    SET effects_paused = false, reason = 'Unaudited enablement.',
        updated_by = 'test', authorization_id = NULL,
        updated_at = statement_timestamp()
    WHERE scope_type = 'global' AND scope_id = 'global'
  $statement$
);

INSERT INTO acp.missions (
  mission_id, project_id, workflow_id, workflow_version, workflow_binding_id,
  completion_contract_id, completion_contract_version, state, requested_scope,
  transition_provenance_id
) VALUES (
  'mis_00000000-0000-4000-8000-000000000001',
  'prj_00000000-0000-4000-8000-000000000001',
  'wfl_00000000-0000-4000-8000-000000000001', '1.0.0',
  'wfb_00000000-0000-4000-8000-000000000001',
  'cct_00000000-0000-4000-8000-000000000001', '1.0.0',
  'executing', 'Exercise durable invariants.',
  'prv_00000000-0000-4000-8000-000000000001'
);

INSERT INTO acp.counterpart_mission_requests (
  client_request_id, request_digest, mission_id, provenance_id
) VALUES (
  'integration:counterpart:1',
  'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  'mis_00000000-0000-4000-8000-000000000001',
  'prv_00000000-0000-4000-8000-000000000001'
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    UPDATE acp.counterpart_mission_requests
    SET request_digest =
      'sha256:1111111111111111111111111111111111111111111111111111111111111111'
    WHERE client_request_id = 'integration:counterpart:1'
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    UPDATE acp.missions
    SET requested_scope = 'Retroactively changed scope.'
    WHERE mission_id = 'mis_00000000-0000-4000-8000-000000000001'
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    INSERT INTO acp.completion_evaluations (
      evaluation_id, mission_id, contract_id, contract_version, status,
      reasons, disqualifiers, evaluated_at, provenance_id,
      required_receipts_verified, evidence_freshness_verified,
      lifecycle_digest
    ) VALUES (
      'cev_00000000-0000-4000-8000-000000000099',
      'mis_00000000-0000-4000-8000-000000000001',
      'cct_00000000-0000-4000-8000-000000000001', '1.0.0', 'passed',
      '[]', '[]', statement_timestamp() + interval '1 hour',
      'prv_00000000-0000-4000-8000-000000000001', true, true,
      'sha256:future-completion'
    )
  $statement$
);

INSERT INTO acp.missions (
  mission_id, project_id, workflow_id, workflow_version, workflow_binding_id,
  completion_contract_id, completion_contract_version, state, requested_scope,
  transition_provenance_id
) VALUES (
  'mis_00000000-0000-4000-8000-000000000002',
  'prj_00000000-0000-4000-8000-000000000001',
  'wfl_00000000-0000-4000-8000-000000000001', '1.0.0',
  'wfb_00000000-0000-4000-8000-000000000001',
  'cct_00000000-0000-4000-8000-000000000001', '1.0.0',
  'verifying', 'Prove immutable completion attribution.',
  'prv_00000000-0000-4000-8000-000000000001'
);

INSERT INTO acp.completion_evaluations (
  evaluation_id, mission_id, contract_id, contract_version, status,
  reasons, disqualifiers, evaluated_at, provenance_id,
  required_receipts_verified, evidence_freshness_verified, lifecycle_digest
) VALUES
  (
    'cev_00000000-0000-4000-8000-000000000002',
    'mis_00000000-0000-4000-8000-000000000002',
    'cct_00000000-0000-4000-8000-000000000001', '1.0.0', 'passed',
    '[]', '[]', statement_timestamp(),
    'prv_00000000-0000-4000-8000-000000000001', true, true,
    'sha256:completion-two'
  ),
  (
    'cev_00000000-0000-4000-8000-000000000003',
    'mis_00000000-0000-4000-8000-000000000002',
    'cct_00000000-0000-4000-8000-000000000001', '1.0.0', 'passed',
    '[]', '[]', statement_timestamp(),
    'prv_00000000-0000-4000-8000-000000000001', true, true,
    'sha256:completion-three'
  );

UPDATE acp.missions
SET state = 'complete_for_scope',
    completed_by_evaluation_id =
      'cev_00000000-0000-4000-8000-000000000002',
    updated_at = statement_timestamp()
WHERE mission_id = 'mis_00000000-0000-4000-8000-000000000002';

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    UPDATE acp.missions
    SET completed_by_evaluation_id =
      'cev_00000000-0000-4000-8000-000000000003'
    WHERE mission_id = 'mis_00000000-0000-4000-8000-000000000002'
  $statement$
);

INSERT INTO acp.mission_nodes (
  node_id, mission_id, node_type, worker_role, state, dependencies,
  retry_policy, graph_revision, provenance_id, transition_provenance_id
) VALUES
  (
    'nod_00000000-0000-4000-8000-000000000001',
    'mis_00000000-0000-4000-8000-000000000001', 'effect', 'effect_executor',
    'running', '[]', '{"mode":"none"}', 'sha256:graph',
    'prv_00000000-0000-4000-8000-000000000001',
    'prv_00000000-0000-4000-8000-000000000001'
  ),
  (
    'nod_00000000-0000-4000-8000-000000000002',
    'mis_00000000-0000-4000-8000-000000000001', 'effect', 'effect_executor',
    'running', '[]', '{"mode":"none"}', 'sha256:graph',
    'prv_00000000-0000-4000-8000-000000000001',
    'prv_00000000-0000-4000-8000-000000000001'
  );

INSERT INTO acp.capability_grant_evaluations (
  evaluation_id, mission_id, node_id, project_id, role,
  resource_class, allowed_operations, allowed_resources, mode, workspace,
  network_destinations, valid_from, expires_at, maximum_attempts,
  policy_id, policy_version, result, reasons, evaluated_at, provenance_id
) VALUES
  (
    'cge_00000000-0000-4000-8000-000000000001',
    'mis_00000000-0000-4000-8000-000000000001',
    'nod_00000000-0000-4000-8000-000000000001',
    'prj_00000000-0000-4000-8000-000000000001', 'effect_executor',
    'lightweight_read',
    '["synthetic.read"]', '["synthetic:record:1"]', 'read',
    'workspace:synthetic:one', '[]',
    '2000-01-01T00:00:00Z',
    '2099-01-01T00:00:00Z', 2,
    'pol_00000000-0000-4000-8000-000000000001', '1.0.0',
    'passed', '[]', statement_timestamp(),
    'prv_00000000-0000-4000-8000-000000000001'
  ),
  (
    'cge_00000000-0000-4000-8000-000000000002',
    'mis_00000000-0000-4000-8000-000000000001',
    'nod_00000000-0000-4000-8000-000000000002',
    'prj_00000000-0000-4000-8000-000000000001', 'effect_executor',
    'lightweight_read',
    '["synthetic.read"]', '["synthetic:record:2"]', 'read',
    'workspace:synthetic:two', '[]',
    '2000-01-01T00:00:00Z',
    '2099-01-01T00:00:00Z', 1,
    'pol_00000000-0000-4000-8000-000000000001', '1.0.0',
    'passed', '[]', statement_timestamp(),
    'prv_00000000-0000-4000-8000-000000000001'
  ),
  (
    'cge_00000000-0000-4000-8000-000000000003',
    'mis_00000000-0000-4000-8000-000000000001',
    'nod_00000000-0000-4000-8000-000000000002',
    'prj_00000000-0000-4000-8000-000000000001', 'effect_executor',
    'lightweight_read',
    '["synthetic.read"]', '["synthetic:record:2"]', 'read',
    'workspace:synthetic:two', '[]',
    '2000-01-01T00:00:00Z',
    '2099-01-01T00:00:00Z', 1,
    'pol_00000000-0000-4000-8000-000000000001', '1.0.0',
    'denied', '["policy_denied"]', statement_timestamp(),
    'prv_00000000-0000-4000-8000-000000000001'
  );

INSERT INTO acp.capability_grants (
  grant_id, evaluation_id, mission_id, node_id, project_id, role,
  resource_class, allowed_operations, allowed_resources, mode, workspace,
  network_destinations, valid_from,
  expires_at, maximum_attempts, provenance_id
) VALUES
  (
    'cgr_00000000-0000-4000-8000-000000000001',
    'cge_00000000-0000-4000-8000-000000000001',
    'mis_00000000-0000-4000-8000-000000000001',
    'nod_00000000-0000-4000-8000-000000000001',
    'prj_00000000-0000-4000-8000-000000000001', 'effect_executor',
    'lightweight_read',
    '["synthetic.read"]', '["synthetic:record:1"]', 'read',
    'workspace:synthetic:one', '[]',
    '2000-01-01T00:00:00Z',
    '2099-01-01T00:00:00Z', 2,
    'prv_00000000-0000-4000-8000-000000000001'
  ),
  (
    'cgr_00000000-0000-4000-8000-000000000002',
    'cge_00000000-0000-4000-8000-000000000002',
    'mis_00000000-0000-4000-8000-000000000001',
    'nod_00000000-0000-4000-8000-000000000002',
    'prj_00000000-0000-4000-8000-000000000001', 'effect_executor',
    'lightweight_read',
    '["synthetic.read"]', '["synthetic:record:2"]', 'read',
    'workspace:synthetic:two', '[]',
    '2000-01-01T00:00:00Z',
    '2099-01-01T00:00:00Z', 1,
    'prv_00000000-0000-4000-8000-000000000001'
  );

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    INSERT INTO acp.capability_grants (
      grant_id, evaluation_id, mission_id, node_id, project_id, role,
      resource_class, allowed_operations, allowed_resources, mode, workspace,
      network_destinations, valid_from, expires_at, maximum_attempts,
      provenance_id
    ) VALUES (
      'cgr_00000000-0000-4000-8000-000000000099',
      'cge_00000000-0000-4000-8000-000000000003',
      'mis_00000000-0000-4000-8000-000000000001',
      'nod_00000000-0000-4000-8000-000000000002',
      'prj_00000000-0000-4000-8000-000000000001', 'effect_executor',
      'lightweight_read',
      '["synthetic.read"]', '["synthetic:record:2"]', 'read',
      'workspace:synthetic:two', '[]',
      '2000-01-01T00:00:00Z', '2099-01-01T00:00:00Z', 1,
      'prv_00000000-0000-4000-8000-000000000001'
    )
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    WITH content AS (
      SELECT pg_temp.context_packet_content(
        'ctx_00000000-0000-4000-8000-000000000099',
        'nod_00000000-0000-4000-8000-000000000002',
        'cgr_00000000-0000-4000-8000-000000000002'
      ) AS value
    )
    INSERT INTO acp.context_packets (
      context_packet_id, mission_id, node_id, schema_version, digest, packet,
      provenance_id, capability_grant_id
    ) SELECT
      'ctx_00000000-0000-4000-8000-000000000099',
      'mis_00000000-0000-4000-8000-000000000001',
      'nod_00000000-0000-4000-8000-000000000002', '1.0.0',
      acp.jsonb_sha256(content.value),
      content.value || jsonb_build_object(
        'digest', acp.jsonb_sha256(content.value)
      ),
      'prv_00000000-0000-4000-8000-000000000002',
      'cgr_00000000-0000-4000-8000-000000000002'
    FROM content
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    WITH content AS (
      SELECT jsonb_set(
        pg_temp.context_packet_content(
          'ctx_00000000-0000-4000-8000-000000000098',
          'nod_00000000-0000-4000-8000-000000000002',
          'cgr_00000000-0000-4000-8000-000000000002'
        ),
        '{workflow,version}',
        '"9.9.9"'::jsonb
      ) AS value
    )
    INSERT INTO acp.context_packets (
      context_packet_id, mission_id, node_id, schema_version, digest, packet,
      provenance_id, capability_grant_id
    ) SELECT
      'ctx_00000000-0000-4000-8000-000000000098',
      'mis_00000000-0000-4000-8000-000000000001',
      'nod_00000000-0000-4000-8000-000000000002', '1.0.0',
      acp.jsonb_sha256(content.value),
      content.value || jsonb_build_object(
        'digest', acp.jsonb_sha256(content.value)
      ),
      'prv_00000000-0000-4000-8000-000000000006',
      'cgr_00000000-0000-4000-8000-000000000002'
    FROM content
  $statement$
);

WITH packets(context_packet_id, node_id, capability_grant_id, provenance_id) AS (
  VALUES
  (
    'ctx_00000000-0000-4000-8000-000000000001',
    'nod_00000000-0000-4000-8000-000000000001',
    'cgr_00000000-0000-4000-8000-000000000001',
    'prv_00000000-0000-4000-8000-000000000001'
  ),
  (
    'ctx_00000000-0000-4000-8000-000000000002',
    'nod_00000000-0000-4000-8000-000000000002',
    'cgr_00000000-0000-4000-8000-000000000002',
    'prv_00000000-0000-4000-8000-000000000002'
  )
), packet_content AS (
  SELECT packets.*, pg_temp.context_packet_content(
    context_packet_id, node_id, capability_grant_id
  ) AS content
  FROM packets
)
INSERT INTO acp.context_packets (
  context_packet_id, mission_id, node_id, schema_version, digest, packet,
  provenance_id, capability_grant_id
)
SELECT
  context_packet_id,
  'mis_00000000-0000-4000-8000-000000000001',
  node_id,
  '1.0.0',
  acp.jsonb_sha256(content),
  content || jsonb_build_object('digest', acp.jsonb_sha256(content)),
  provenance_id,
  capability_grant_id
FROM packet_content;

INSERT INTO acp.worker_runs (
  run_id, mission_id, node_id, context_packet_id, attempt_number, state,
  started_at, provenance_id, transition_provenance_id, capability_grant_id,
  host_identifier, resource_class, operation, resource, requested_mode, workspace,
  network_destination, timeout_at
) VALUES (
  'run_00000000-0000-4000-8000-000000000001',
  'mis_00000000-0000-4000-8000-000000000001',
  'nod_00000000-0000-4000-8000-000000000001',
  'ctx_00000000-0000-4000-8000-000000000001', 1, 'started',
  statement_timestamp(), 'prv_00000000-0000-4000-8000-000000000001',
  'prv_00000000-0000-4000-8000-000000000001',
  'cgr_00000000-0000-4000-8000-000000000001', 'host:test',
  'lightweight_read',
  'synthetic.read', 'synthetic:record:1', 'read',
  'workspace:synthetic:one', NULL,
  statement_timestamp() + interval '5 minutes'
);

DO $$
BEGIN
  IF (
    SELECT count(*) FROM acp.capability_grant_uses
    WHERE run_id = 'run_00000000-0000-4000-8000-000000000001'
      AND grant_id = 'cgr_00000000-0000-4000-8000-000000000001'
  ) <> 1 THEN
    RAISE EXCEPTION 'worker run did not consume exactly one capability grant use';
  END IF;
END;
$$;

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    INSERT INTO acp.worker_runs (
      run_id, mission_id, node_id, context_packet_id, attempt_number, state,
      started_at, provenance_id, transition_provenance_id, capability_grant_id,
      host_identifier, resource_class, operation, resource, requested_mode,
      workspace, network_destination, timeout_at
    ) VALUES (
      'run_00000000-0000-4000-8000-000000000098',
      'mis_00000000-0000-4000-8000-000000000001',
      'nod_00000000-0000-4000-8000-000000000001',
      'ctx_00000000-0000-4000-8000-000000000001', 2, 'started',
      statement_timestamp(), 'prv_00000000-0000-4000-8000-000000000001',
      'prv_00000000-0000-4000-8000-000000000001',
      'cgr_00000000-0000-4000-8000-000000000001', 'host:test',
      'lightweight_read', 'repository.write', 'synthetic:record:1', 'read',
      'workspace:synthetic:one', NULL,
      statement_timestamp() + interval '5 minutes'
    )
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  '23505',
  $statement$
    INSERT INTO acp.worker_runs (
      run_id, mission_id, node_id, context_packet_id, attempt_number, state,
      started_at, provenance_id, transition_provenance_id, capability_grant_id,
      host_identifier, resource_class, operation, resource, requested_mode,
      workspace, network_destination, timeout_at
    ) VALUES (
      'run_00000000-0000-4000-8000-000000000097',
      'mis_00000000-0000-4000-8000-000000000001',
      'nod_00000000-0000-4000-8000-000000000001',
      'ctx_00000000-0000-4000-8000-000000000001', 2, 'started',
      statement_timestamp(), 'prv_00000000-0000-4000-8000-000000000001',
      'prv_00000000-0000-4000-8000-000000000001',
      'cgr_00000000-0000-4000-8000-000000000001', 'host:test',
      'lightweight_read', 'synthetic.read', 'synthetic:record:1', 'read',
      'workspace:synthetic:one', NULL,
      statement_timestamp() + interval '5 minutes'
    )
  $statement$
);

INSERT INTO acp.worker_processes (
  worker_process_id, run_id, mission_id, node_id, process_id,
  process_start_token, purpose, host_identifier, resource_class, state,
  started_at, deadline_at, heartbeat_at, provenance_id,
  transition_provenance_id
)
SELECT
  'wpr_00000000-0000-4000-8000-000000000001', run_id, mission_id, node_id,
  4242, '2026-09-04T12:00:00.000Z', 'synthetic worker process',
  host_identifier, resource_class, 'running', started_at,
  timeout_at, started_at, provenance_id, transition_provenance_id
FROM acp.worker_runs
WHERE run_id = 'run_00000000-0000-4000-8000-000000000001';

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    UPDATE acp.missions
    SET state = 'cancelled', updated_at = statement_timestamp()
    WHERE mission_id = 'mis_00000000-0000-4000-8000-000000000001'
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    UPDATE acp.mission_nodes
    SET state = 'failed', completed_at = statement_timestamp()
    WHERE node_id = 'nod_00000000-0000-4000-8000-000000000001'
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    UPDATE acp.worker_processes
    SET heartbeat_at = started_at - interval '1 microsecond'
    WHERE worker_process_id = 'wpr_00000000-0000-4000-8000-000000000001'
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    UPDATE acp.worker_processes
    SET state = 'terminated', heartbeat_at = statement_timestamp(),
        completed_at = statement_timestamp(),
        termination_reason = 'claimed by another host',
        transition_provenance_id =
          'prv_00000000-0000-4000-8000-000000000003'
    WHERE worker_process_id = 'wpr_00000000-0000-4000-8000-000000000001'
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    UPDATE acp.worker_processes
    SET reconciliation_id = 'rcn_00000000-0000-4000-8000-000000000001',
        reconciliation_owner = 'supervisor:other',
        reconciliation_claimed_at = statement_timestamp(),
        reconciliation_claim_expires_at =
          statement_timestamp() + interval '1 minute',
        reconciliation_provenance_id =
          'prv_00000000-0000-4000-8000-000000000003'
    WHERE worker_process_id = 'wpr_00000000-0000-4000-8000-000000000001'
  $statement$
);

UPDATE acp.worker_processes
SET reconciliation_id = 'rcn_00000000-0000-4000-8000-000000000001',
    reconciliation_owner = 'supervisor:test',
    reconciliation_claimed_at = statement_timestamp(),
    reconciliation_claim_expires_at = statement_timestamp() + interval '1 minute',
    reconciliation_provenance_id =
      'prv_00000000-0000-4000-8000-000000000001'
WHERE worker_process_id = 'wpr_00000000-0000-4000-8000-000000000001';

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    UPDATE acp.worker_processes
    SET reconciliation_owner = 'supervisor:test:alias'
    WHERE worker_process_id = 'wpr_00000000-0000-4000-8000-000000000001'
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    UPDATE acp.worker_processes
    SET reconciliation_id = 'rcn_00000000-0000-4000-8000-000000000002',
        reconciliation_owner = 'supervisor:test:second',
        reconciliation_claimed_at = statement_timestamp(),
        reconciliation_claim_expires_at =
          statement_timestamp() + interval '1 minute',
        reconciliation_provenance_id =
          'prv_00000000-0000-4000-8000-000000000001'
    WHERE worker_process_id = 'wpr_00000000-0000-4000-8000-000000000001'
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  '23514',
  $statement$
    UPDATE acp.worker_processes
    SET state = 'exited', heartbeat_at = statement_timestamp(),
        completed_at = statement_timestamp(),
        termination_reason = 'missing exit code'
    WHERE worker_process_id = 'wpr_00000000-0000-4000-8000-000000000001'
  $statement$
);

UPDATE acp.worker_processes
SET state = 'exited', heartbeat_at = statement_timestamp(),
    completed_at = statement_timestamp(), exit_code = 0,
    termination_reason = 'process exited normally'
WHERE worker_process_id = 'wpr_00000000-0000-4000-8000-000000000001';

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    UPDATE acp.worker_processes
    SET termination_reason = 'rewritten terminal reason'
    WHERE worker_process_id = 'wpr_00000000-0000-4000-8000-000000000001'
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    INSERT INTO acp.worker_runs (
      run_id, mission_id, node_id, context_packet_id, attempt_number, state,
      started_at, provenance_id, transition_provenance_id, capability_grant_id,
      host_identifier, resource_class, operation, resource, requested_mode, workspace,
      network_destination, timeout_at
    ) VALUES (
      'run_00000000-0000-4000-8000-000000000099',
      'mis_00000000-0000-4000-8000-000000000001',
      'nod_00000000-0000-4000-8000-000000000002',
      'ctx_00000000-0000-4000-8000-000000000002', 1, 'started',
      statement_timestamp(), 'prv_00000000-0000-4000-8000-000000000001',
      'prv_00000000-0000-4000-8000-000000000001',
      'cgr_00000000-0000-4000-8000-000000000002', 'host:test',
      'lightweight_read',
      'synthetic.read', 'synthetic:record:2', 'read',
      'workspace:synthetic:two', NULL,
      statement_timestamp() + interval '5 minutes'
    )
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    INSERT INTO acp.worker_runs (
      run_id, mission_id, node_id, context_packet_id, attempt_number, state,
      started_at, provenance_id, transition_provenance_id, capability_grant_id,
      host_identifier, resource_class, operation, resource, requested_mode,
      workspace, network_destination, timeout_at
    ) VALUES (
      'run_00000000-0000-4000-8000-000000000095',
      'mis_00000000-0000-4000-8000-000000000001',
      'nod_00000000-0000-4000-8000-000000000002',
      'ctx_00000000-0000-4000-8000-000000000002', 1, 'started',
      statement_timestamp(), 'prv_00000000-0000-4000-8000-000000000002',
      'prv_00000000-0000-4000-8000-000000000002',
      'cgr_00000000-0000-4000-8000-000000000002', 'host:test',
      'cpu_intensive', 'synthetic.read', 'synthetic:record:2', 'read',
      'workspace:synthetic:two', NULL,
      statement_timestamp() + interval '5 minutes'
    )
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    INSERT INTO acp.worker_runs (
      run_id, mission_id, node_id, context_packet_id, attempt_number, state,
      started_at, provenance_id, transition_provenance_id, capability_grant_id,
      host_identifier, resource_class, operation, resource, requested_mode,
      workspace, network_destination, timeout_at
    ) VALUES (
      'run_00000000-0000-4000-8000-000000000094',
      'mis_00000000-0000-4000-8000-000000000001',
      'nod_00000000-0000-4000-8000-000000000002',
      'ctx_00000000-0000-4000-8000-000000000002', 1, 'started',
      statement_timestamp(), 'prv_00000000-0000-4000-8000-000000000003',
      'prv_00000000-0000-4000-8000-000000000003',
      'cgr_00000000-0000-4000-8000-000000000002', 'host:test',
      'lightweight_read', 'synthetic.read', 'synthetic:record:2', 'read',
      'workspace:synthetic:two', NULL,
      statement_timestamp() + interval '5 minutes'
    )
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    INSERT INTO acp.worker_runs (
      run_id, mission_id, node_id, context_packet_id, attempt_number, state,
      started_at, provenance_id, transition_provenance_id, capability_grant_id,
      host_identifier, resource_class, operation, resource, requested_mode,
      workspace, network_destination, timeout_at
    ) VALUES (
      'run_00000000-0000-4000-8000-000000000093',
      'mis_00000000-0000-4000-8000-000000000001',
      'nod_00000000-0000-4000-8000-000000000002',
      'ctx_00000000-0000-4000-8000-000000000002', 1, 'started',
      statement_timestamp(), 'prv_00000000-0000-4000-8000-000000000004',
      'prv_00000000-0000-4000-8000-000000000004',
      'cgr_00000000-0000-4000-8000-000000000002', 'host:stale',
      'lightweight_read', 'synthetic.read', 'synthetic:record:2', 'read',
      'workspace:synthetic:two', NULL,
      statement_timestamp() + interval '5 minutes'
    )
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    INSERT INTO acp.worker_runs (
      run_id, mission_id, node_id, context_packet_id, attempt_number, state,
      started_at, provenance_id, transition_provenance_id, capability_grant_id,
      host_identifier, resource_class, operation, resource, requested_mode,
      workspace, network_destination, timeout_at
    ) VALUES (
      'run_00000000-0000-4000-8000-000000000092',
      'mis_00000000-0000-4000-8000-000000000001',
      'nod_00000000-0000-4000-8000-000000000002',
      'ctx_00000000-0000-4000-8000-000000000002', 1, 'started',
      statement_timestamp(), 'prv_00000000-0000-4000-8000-000000000005',
      'prv_00000000-0000-4000-8000-000000000005',
      'cgr_00000000-0000-4000-8000-000000000002', 'host:offline',
      'lightweight_read', 'synthetic.read', 'synthetic:record:2', 'read',
      'workspace:synthetic:two', NULL,
      statement_timestamp() + interval '5 minutes'
    )
  $statement$
);

UPDATE acp.worker_hosts
SET maximum_lightweight_read = 1,
    transition_provenance_id =
      'prv_00000000-0000-4000-8000-000000000001',
    updated_at = statement_timestamp()
WHERE host_identifier = 'host:test';

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    INSERT INTO acp.worker_runs (
      run_id, mission_id, node_id, context_packet_id, attempt_number, state,
      started_at, provenance_id, transition_provenance_id, capability_grant_id,
      host_identifier, resource_class, operation, resource, requested_mode,
      workspace, network_destination, timeout_at
    ) VALUES (
      'run_00000000-0000-4000-8000-000000000091',
      'mis_00000000-0000-4000-8000-000000000001',
      'nod_00000000-0000-4000-8000-000000000002',
      'ctx_00000000-0000-4000-8000-000000000002', 1, 'started',
      statement_timestamp(), 'prv_00000000-0000-4000-8000-000000000002',
      'prv_00000000-0000-4000-8000-000000000002',
      'cgr_00000000-0000-4000-8000-000000000002', 'host:test',
      'lightweight_read', 'synthetic.read', 'synthetic:record:2', 'read',
      'workspace:synthetic:two', NULL,
      statement_timestamp() + interval '5 minutes'
    )
  $statement$
);

UPDATE acp.worker_hosts
SET maximum_lightweight_read = 2,
    transition_provenance_id =
      'prv_00000000-0000-4000-8000-000000000001',
    updated_at = statement_timestamp()
WHERE host_identifier = 'host:test';

INSERT INTO acp.worker_runs (
  run_id, mission_id, node_id, context_packet_id, attempt_number, state,
  started_at, provenance_id, transition_provenance_id, capability_grant_id,
  host_identifier, resource_class, operation, resource, requested_mode,
  workspace, network_destination, timeout_at
) VALUES (
  'run_00000000-0000-4000-8000-000000000002',
  'mis_00000000-0000-4000-8000-000000000001',
  'nod_00000000-0000-4000-8000-000000000002',
  'ctx_00000000-0000-4000-8000-000000000002', 1, 'started',
  statement_timestamp(), 'prv_00000000-0000-4000-8000-000000000002',
  'prv_00000000-0000-4000-8000-000000000002',
  'cgr_00000000-0000-4000-8000-000000000002', 'host:test',
  'lightweight_read', 'synthetic.read', 'synthetic:record:2', 'read',
  'workspace:synthetic:two', NULL,
  statement_timestamp() + interval '5 minutes'
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    INSERT INTO acp.worker_runs (
      run_id, mission_id, node_id, context_packet_id, attempt_number, state,
      started_at, provenance_id, transition_provenance_id, capability_grant_id,
      host_identifier, resource_class, operation, resource, requested_mode,
      workspace, network_destination, timeout_at
    ) VALUES (
      'run_00000000-0000-4000-8000-000000000096',
      'mis_00000000-0000-4000-8000-000000000001',
      'nod_00000000-0000-4000-8000-000000000002',
      'ctx_00000000-0000-4000-8000-000000000002', 2, 'started',
      statement_timestamp(), 'prv_00000000-0000-4000-8000-000000000002',
      'prv_00000000-0000-4000-8000-000000000002',
      'cgr_00000000-0000-4000-8000-000000000002', 'host:test',
      'lightweight_read', 'synthetic.read', 'synthetic:record:2', 'read',
      'workspace:synthetic:two', NULL,
      statement_timestamp() + interval '5 minutes'
    )
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  '23503',
  $statement$
    INSERT INTO acp.resource_leases (
      lease_id, lease_key, mission_id, node_id, owner_run_id, state,
      acquired_at, expires_at, heartbeat_at, recovery_state
    ) VALUES (
      'lea_00000000-0000-4000-8000-000000000099', 'effect:owner-scope-test',
      'mis_00000000-0000-4000-8000-000000000001',
      'nod_00000000-0000-4000-8000-000000000002',
      'run_00000000-0000-4000-8000-000000000001', 'active',
      statement_timestamp(), statement_timestamp() + interval '5 minutes',
      statement_timestamp(), '{}'
    )
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  '23514',
  $statement$
    INSERT INTO acp.effect_proposals (
      effect_id, mission_id, project_id, effect_type, adapter_id, adapter_version,
      adapter_account_id, target, payload, preview, risk_class, rationale,
      evidence_ids, idempotency_key, proposal_digest, payload_digest,
      required_preconditions, verification_plan, proposed_by_run_id, state,
      provenance_id, transition_provenance_id
    ) VALUES (
      'eff_00000000-0000-4000-8000-000000000099',
      'mis_00000000-0000-4000-8000-000000000001',
      'prj_00000000-0000-4000-8000-000000000001',
      'synthetic.write', 'synthetic', '1.0.0', 'test-account', '{"type":"record"}',
      '{}', 'Invalid target.', 'R1', 'Must fail.', '["evd_test"]',
      'synthetic:invalid-target', 'sha256:invalid-target', 'sha256:payload', '[]',
      '[{"type":"read","expected":{"value":1}}]', 'run_00000000-0000-4000-8000-000000000001',
      'proposed', 'prv_00000000-0000-4000-8000-000000000001',
      'prv_00000000-0000-4000-8000-000000000001'
    )
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    INSERT INTO acp.effect_proposals (
      effect_id, mission_id, project_id, effect_type, adapter_id, adapter_version,
      adapter_account_id, target, payload, preview, risk_class, rationale,
      evidence_ids, idempotency_key, proposal_digest, payload_digest,
      required_preconditions, verification_plan, proposed_by_run_id, state,
      provenance_id, transition_provenance_id
    ) VALUES (
      'eff_00000000-0000-4000-8000-000000000098',
      'mis_00000000-0000-4000-8000-000000000001',
      'prj_00000000-0000-4000-8000-000000000001',
      'synthetic.write', 'synthetic', '1.0.0', 'test-account',
      '{"type":"record","externalId":"98","displayName":"Record 98"}', '{}', 'Invalid initial state.',
      'R1', 'Must fail.', '["evd_test"]', 'synthetic:invalid-state',
      'sha256:invalid-state', 'sha256:payload', '[]', '[{"type":"read","expected":{"value":1}}]',
      'run_00000000-0000-4000-8000-000000000001', 'executing',
      'prv_00000000-0000-4000-8000-000000000001',
      'prv_00000000-0000-4000-8000-000000000001'
    )
  $statement$
);

INSERT INTO acp.effect_proposals (
  effect_id, mission_id, project_id, effect_type, adapter_id, adapter_version,
  adapter_account_id, target, payload, preview, risk_class, rationale,
  evidence_ids, idempotency_key, proposal_digest, payload_digest,
  required_preconditions, verification_plan, proposed_by_run_id, state,
  provenance_id, transition_provenance_id
) VALUES (
  'eff_00000000-0000-4000-8000-000000000001',
  'mis_00000000-0000-4000-8000-000000000001',
  'prj_00000000-0000-4000-8000-000000000001',
  'synthetic.write', 'synthetic', '1.0.0', 'test-account',
  '{"type":"record","externalId":"1","displayName":"Record 1"}', '{"value":1}', 'Write one record.',
  'R1', 'Exercise verification.', '["evd_test"]', 'synthetic:one',
  'sha256:proposal-one', 'sha256:payload-one',
  '[{"type":"version","sourceRef":"record:1","expected":"revision-1"}]',
  '[{"type":"read","expected":{"value":1}}]',
  'run_00000000-0000-4000-8000-000000000001', 'proposed',
  'prv_00000000-0000-4000-8000-000000000001',
  'prv_00000000-0000-4000-8000-000000000001'
);

UPDATE acp.effect_proposals
SET state = 'previewed', updated_at = statement_timestamp()
WHERE effect_id = 'eff_00000000-0000-4000-8000-000000000001';

SELECT pg_temp.expect_sqlstate(
  '23514',
  $statement$
    INSERT INTO acp.precondition_snapshots (
      snapshot_id, effect_id, source_ref, snapshot, digest, captured_at,
      provenance_id
    ) VALUES (
      'pcs_00000000-0000-4000-8000-000000000099',
      'eff_00000000-0000-4000-8000-000000000001', 'record:1',
      '"revision-1"', '   ', statement_timestamp(),
      'prv_00000000-0000-4000-8000-000000000001'
    )
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    INSERT INTO acp.precondition_snapshots (
      snapshot_id, effect_id, source_ref, snapshot, digest, captured_at,
      provenance_id
    ) VALUES (
      'pcs_00000000-0000-4000-8000-000000000098',
      'eff_00000000-0000-4000-8000-000000000001', 'record:1',
      '"revision-1"', 'sha256:snapshot-one', statement_timestamp(),
      'prv_00000000-0000-4000-8000-000000000002'
    )
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    INSERT INTO acp.precondition_snapshots (
      snapshot_id, effect_id, source_ref, snapshot, digest, captured_at,
      provenance_id
    ) VALUES (
      'pcs_00000000-0000-4000-8000-000000000097',
      'eff_00000000-0000-4000-8000-000000000001', 'record:1',
      '"revision-1"', 'sha256:snapshot-one',
      statement_timestamp() + interval '1 hour',
      'prv_00000000-0000-4000-8000-000000000001'
    )
  $statement$
);

INSERT INTO acp.precondition_snapshots (
  snapshot_id, effect_id, source_ref, snapshot, digest, captured_at,
  provenance_id
) VALUES (
  'pcs_00000000-0000-4000-8000-000000000001',
  'eff_00000000-0000-4000-8000-000000000001', 'record:1',
  '"revision-1"', 'sha256:snapshot-one', statement_timestamp(),
  'prv_00000000-0000-4000-8000-000000000001'
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    UPDATE acp.effect_proposals SET state = 'authorized'
    WHERE effect_id = 'eff_00000000-0000-4000-8000-000000000001'
  $statement$
);

INSERT INTO acp.approval_envelopes (
  approval_id, approver_id, project_id, mission_id, allowed_effect_types,
  allowed_adapter_account_ids, allowed_target_ids, maximum_risk_class,
  allowed_environments, required_gates, allowed_repair_classes,
  precondition_snapshot_ids, valid_from, expires_at, quiet_hours_behavior,
  provenance_id
) VALUES (
  'apr_00000000-0000-4000-8000-000000000001', 'operator:test',
  'prj_00000000-0000-4000-8000-000000000001',
  'mis_00000000-0000-4000-8000-000000000001', '["synthetic.write"]',
  '["test-account"]', '["1"]', 'R1', '[]', '[]', '[]',
  '["pcs_00000000-0000-4000-8000-000000000001"]',
  statement_timestamp() - interval '1 minute',
  statement_timestamp() + interval '10 minutes', 'defer',
  'prv_00000000-0000-4000-8000-000000000001'
);

INSERT INTO acp.effect_approval_evaluations (
  approval_evaluation_id, effect_id, approval_id, evaluated_at, result,
  reasons, assessment_context, provenance_id
) VALUES (
  'ape_00000000-0000-4000-8000-000000000001',
  'eff_00000000-0000-4000-8000-000000000001',
  'apr_00000000-0000-4000-8000-000000000001', statement_timestamp(),
  'covered', '[]', '{}', 'prv_00000000-0000-4000-8000-000000000001'
);

UPDATE acp.effect_proposals SET state = 'authorized', updated_at = statement_timestamp()
WHERE effect_id = 'eff_00000000-0000-4000-8000-000000000001';
UPDATE acp.effect_proposals SET state = 'revalidating', updated_at = statement_timestamp()
WHERE effect_id = 'eff_00000000-0000-4000-8000-000000000001';

INSERT INTO acp.resource_leases (
  lease_id, lease_key, mission_id, node_id, owner_run_id, state,
  acquired_at, expires_at, heartbeat_at, recovery_state
) VALUES (
  'lea_00000000-0000-4000-8000-000000000001',
  'effect:eff_00000000-0000-4000-8000-000000000001',
  'mis_00000000-0000-4000-8000-000000000001',
  'nod_00000000-0000-4000-8000-000000000001',
  'run_00000000-0000-4000-8000-000000000001', 'active',
  statement_timestamp(), statement_timestamp() + interval '10 minutes',
  statement_timestamp(), '{}'
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    INSERT INTO acp.execution_precondition_evaluations (
      execution_precondition_evaluation_id, effect_id, approval_id,
      approval_evaluation_id, lease_id, fencing_token, proposal_digest,
      payload_digest, observed_target_digest, precondition_results, result,
      evaluated_at, valid_until, provenance_id
    ) SELECT
      'epe_00000000-0000-4000-8000-000000000099',
      'eff_00000000-0000-4000-8000-000000000001',
      'apr_00000000-0000-4000-8000-000000000001',
      'ape_00000000-0000-4000-8000-000000000001', lease_id, fencing_token,
      'sha256:proposal-one', 'sha256:payload-one', 'sha256:observed-target',
      '[{"approvedSnapshotId":"pcs_00000000-0000-4000-8000-000000000001","approvedDigest":"sha256:snapshot-one","observedDigest":"sha256:different","matched":false}]',
      'passed', statement_timestamp(), statement_timestamp() + interval '5 minutes',
      'prv_00000000-0000-4000-8000-000000000001'
    FROM acp.resource_leases
    WHERE lease_id = 'lea_00000000-0000-4000-8000-000000000001'
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    INSERT INTO acp.execution_precondition_evaluations (
      execution_precondition_evaluation_id, effect_id, approval_id,
      approval_evaluation_id, lease_id, fencing_token, proposal_digest,
      payload_digest, observed_target_digest, precondition_results, result,
      evaluated_at, valid_until, provenance_id
    ) SELECT
      'epe_00000000-0000-4000-8000-000000000098',
      'eff_00000000-0000-4000-8000-000000000001',
      'apr_00000000-0000-4000-8000-000000000001',
      'ape_00000000-0000-4000-8000-000000000001', lease_id, fencing_token,
      'sha256:proposal-one', 'sha256:payload-one', 'sha256:observed-target',
      '[{"approvedSnapshotId":"pcs_00000000-0000-4000-8000-000000000001","approvedDigest":"sha256:snapshot-one","observedDigest":"sha256:snapshot-one","matched":"true"}]',
      'passed', statement_timestamp(), statement_timestamp() + interval '5 minutes',
      'prv_00000000-0000-4000-8000-000000000001'
    FROM acp.resource_leases
    WHERE lease_id = 'lea_00000000-0000-4000-8000-000000000001'
  $statement$
);

INSERT INTO acp.execution_precondition_evaluations (
  execution_precondition_evaluation_id, effect_id, approval_id,
  approval_evaluation_id, lease_id, fencing_token, proposal_digest,
  payload_digest, observed_target_digest, precondition_results, result,
  evaluated_at, valid_until, provenance_id
) SELECT
  'epe_00000000-0000-4000-8000-000000000001',
  'eff_00000000-0000-4000-8000-000000000001',
  'apr_00000000-0000-4000-8000-000000000001',
  'ape_00000000-0000-4000-8000-000000000001', lease_id, fencing_token,
  'sha256:proposal-one', 'sha256:payload-one', 'sha256:observed-target',
  '[{"approvedSnapshotId":"pcs_00000000-0000-4000-8000-000000000001","approvedDigest":"sha256:snapshot-one","observedDigest":"sha256:snapshot-one","matched":true}]',
  'passed', statement_timestamp(), statement_timestamp() + interval '5 minutes',
  'prv_00000000-0000-4000-8000-000000000001'
FROM acp.resource_leases
WHERE lease_id = 'lea_00000000-0000-4000-8000-000000000001';

INSERT INTO acp.effect_approval_evaluations (
  approval_evaluation_id, effect_id, approval_id, evaluated_at, result,
  reasons, assessment_context, provenance_id
) VALUES (
  'ape_00000000-0000-4000-8000-000000000002',
  'eff_00000000-0000-4000-8000-000000000001',
  'apr_00000000-0000-4000-8000-000000000001', statement_timestamp(),
  'not_covered', '["approval invalidated after precondition read"]', '{}',
  'prv_00000000-0000-4000-8000-000000000001'
);

INSERT INTO acp.effect_approval_evaluations (
  approval_evaluation_id, effect_id, approval_id, evaluated_at, result,
  reasons, assessment_context, provenance_id
) VALUES (
  'ape_00000000-0000-4000-8000-000000000003',
  'eff_00000000-0000-4000-8000-000000000001',
  'apr_00000000-0000-4000-8000-000000000001', statement_timestamp(),
  'covered', '["approval restored; requires a fresh precondition read"]', '{}',
  'prv_00000000-0000-4000-8000-000000000001'
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    UPDATE acp.effect_proposals
    SET state = 'executing',
        execution_fencing_token = (SELECT fencing_token FROM acp.resource_leases
          WHERE lease_id = 'lea_00000000-0000-4000-8000-000000000001'),
        execution_precondition_evaluation_id =
          'epe_00000000-0000-4000-8000-000000000001'
    WHERE effect_id = 'eff_00000000-0000-4000-8000-000000000001'
  $statement$
);

DO $$
DECLARE
  control_time timestamptz;
BEGIN
  SELECT updated_at + interval '1 microsecond'
  INTO control_time
  FROM acp.runtime_controls
  WHERE scope_type = 'global' AND scope_id = 'global';

  INSERT INTO acp.runtime_control_events (
    control_event_id, scope_type, scope_id, previous_effects_paused,
    effects_paused, reason, updated_by, authorization_id, occurred_at, provenance_id
  ) VALUES (
    'rce_00000000-0000-4000-8000-000000000001', 'global', 'global', true,
    false, 'Authorized integration gate.', 'operator:test',
    'rca_00000000-0000-4000-8000-000000000001',
    control_time, 'prv_00000000-0000-4000-8000-000000000001'
  );
  PERFORM set_config('acp.runtime_control_event_id',
    'rce_00000000-0000-4000-8000-000000000001', true);
  UPDATE acp.runtime_controls
  SET effects_paused = false, reason = 'Authorized integration gate.',
      updated_by = 'operator:test',
      authorization_id = 'rca_00000000-0000-4000-8000-000000000001',
      updated_at = control_time,
      last_control_event_id = 'rce_00000000-0000-4000-8000-000000000001'
  WHERE scope_type = 'global' AND scope_id = 'global';
END;
$$;

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    UPDATE acp.effect_proposals
    SET state = 'executing',
        execution_fencing_token = lease.fencing_token,
        execution_precondition_evaluation_id =
          'epe_00000000-0000-4000-8000-000000000001',
        updated_at = statement_timestamp()
    FROM acp.resource_leases AS lease
    WHERE effect_proposals.effect_id =
            'eff_00000000-0000-4000-8000-000000000001'
      AND lease.lease_id = 'lea_00000000-0000-4000-8000-000000000001'
  $statement$
);

INSERT INTO acp.execution_precondition_evaluations (
  execution_precondition_evaluation_id, effect_id, approval_id,
  approval_evaluation_id, lease_id, fencing_token, proposal_digest,
  payload_digest, observed_target_digest, precondition_results, result,
  evaluated_at, valid_until, provenance_id
) SELECT
  'epe_00000000-0000-4000-8000-000000000003',
  'eff_00000000-0000-4000-8000-000000000001',
  'apr_00000000-0000-4000-8000-000000000001',
  'ape_00000000-0000-4000-8000-000000000003', lease_id, fencing_token,
  'sha256:proposal-one', 'sha256:payload-one', 'sha256:observed-target',
  '[{"approvedSnapshotId":"pcs_00000000-0000-4000-8000-000000000001","approvedDigest":"sha256:snapshot-one","observedDigest":"sha256:snapshot-one","matched":true}]',
  'passed', statement_timestamp(), statement_timestamp() + interval '5 minutes',
  'prv_00000000-0000-4000-8000-000000000001'
FROM acp.resource_leases
WHERE lease_id = 'lea_00000000-0000-4000-8000-000000000001';

UPDATE acp.effect_proposals
SET state = 'executing',
    execution_fencing_token = lease.fencing_token,
    execution_precondition_evaluation_id =
      'epe_00000000-0000-4000-8000-000000000003',
    updated_at = statement_timestamp()
FROM acp.resource_leases AS lease
WHERE effect_proposals.effect_id = 'eff_00000000-0000-4000-8000-000000000001'
  AND lease.lease_id = 'lea_00000000-0000-4000-8000-000000000001';

INSERT INTO acp.effect_receipts (
  receipt_id, effect_id, attempt_number, state, execution_record,
  attempted_at, provenance_id
) VALUES (
  'rcp_00000000-0000-4000-8000-000000000001',
  'eff_00000000-0000-4000-8000-000000000001', 1, 'applied', '{}',
  statement_timestamp(), 'prv_00000000-0000-4000-8000-000000000001'
);

UPDATE acp.effect_proposals SET state = 'verifying', updated_at = statement_timestamp()
WHERE effect_id = 'eff_00000000-0000-4000-8000-000000000001';

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    UPDATE acp.effect_proposals SET state = 'verified'
    WHERE effect_id = 'eff_00000000-0000-4000-8000-000000000001'
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    INSERT INTO acp.effect_receipts (
      receipt_id, effect_id, attempt_number, state, execution_record,
      attempted_at, verified_at, provenance_id
    ) VALUES (
      'rcp_00000000-0000-4000-8000-000000000002',
      'eff_00000000-0000-4000-8000-000000000001', 2, 'verified', '{}',
      statement_timestamp(), statement_timestamp(),
      'prv_00000000-0000-4000-8000-000000000001'
    )
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    INSERT INTO acp.effect_receipts (
      receipt_id, effect_id, attempt_number, state, execution_record,
      verification_record, attempted_at, verified_at, provenance_id
    ) VALUES (
      'rcp_00000000-0000-4000-8000-000000000002',
      'eff_00000000-0000-4000-8000-000000000001', 2, 'verified', '{}',
      '{}', statement_timestamp(), statement_timestamp(),
      'prv_00000000-0000-4000-8000-000000000001'
    )
  $statement$
);

INSERT INTO acp.effect_receipts (
  receipt_id, effect_id, attempt_number, state, execution_record,
  verification_record, attempted_at, verified_at, provenance_id
) VALUES (
  'rcp_00000000-0000-4000-8000-000000000002',
  'eff_00000000-0000-4000-8000-000000000001', 2, 'verified', '{}',
  jsonb_build_object(
    'result', 'passed',
    'steps', jsonb_build_array(jsonb_build_object(
      'stepIndex', 0, 'type', 'read', 'expected', jsonb_build_object('value', 1),
      'observed', jsonb_build_object('value', 1),
      'observedDigest', 'sha256:observed-one', 'matched', true,
      'observedAt', (
        SELECT observed_at::text FROM acp.evidence_records
        WHERE evidence_id = 'evd_00000000-0000-4000-8000-000000000001'
      ),
      'evidenceIds', jsonb_build_array('evd_00000000-0000-4000-8000-000000000001')
    ))
  ), (
    SELECT observed_at FROM acp.evidence_records
    WHERE evidence_id = 'evd_00000000-0000-4000-8000-000000000001'
  ), statement_timestamp(),
  'prv_00000000-0000-4000-8000-000000000001'
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    INSERT INTO acp.effect_receipts (
      receipt_id, effect_id, attempt_number, state, execution_record,
      attempted_at, provenance_id
    ) VALUES (
      'rcp_00000000-0000-4000-8000-000000000099',
      'eff_00000000-0000-4000-8000-000000000001', 3, 'failed', '{}',
      statement_timestamp() + interval '1 hour',
      'prv_00000000-0000-4000-8000-000000000001'
    )
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    INSERT INTO acp.effect_approval_evaluations (
      approval_evaluation_id, effect_id, approval_id, evaluated_at, result,
      reasons, assessment_context, provenance_id
    ) VALUES (
      'ape_00000000-0000-4000-8000-000000000004',
      'eff_00000000-0000-4000-8000-000000000001',
      'apr_00000000-0000-4000-8000-000000000001',
      statement_timestamp() + interval '1 microsecond',
      'not_covered', '["wrong_adapter_provenance"]', '{}',
      'prv_00000000-0000-4000-8000-000000000002'
    )
  $statement$
);

INSERT INTO acp.effect_proposals (
  effect_id, mission_id, project_id, effect_type, adapter_id, adapter_version,
  adapter_account_id, target, payload, preview, risk_class, rationale,
  evidence_ids, idempotency_key, proposal_digest, payload_digest,
  required_preconditions, verification_plan, proposed_by_run_id, state,
  provenance_id, transition_provenance_id
) VALUES (
  'eff_00000000-0000-4000-8000-000000000002',
  'mis_00000000-0000-4000-8000-000000000001',
  'prj_00000000-0000-4000-8000-000000000001',
  'synthetic.write', 'synthetic', '1.0.0', 'test-account',
  '{"type":"record","externalId":"1","displayName":"Record 1"}',
  '{"value":2}', 'Write a second record.', 'R1', 'Exercise reconciliation.',
  '["evd_test"]', 'synthetic:two', 'sha256:proposal-two',
  'sha256:payload-two', '[]', '[{"type":"read","expected":{"value":2}}]',
  'run_00000000-0000-4000-8000-000000000001', 'proposed',
  'prv_00000000-0000-4000-8000-000000000001',
  'prv_00000000-0000-4000-8000-000000000001'
);

UPDATE acp.effect_proposals SET state = 'previewed', updated_at = statement_timestamp()
WHERE effect_id = 'eff_00000000-0000-4000-8000-000000000002';

INSERT INTO acp.effect_approval_evaluations (
  approval_evaluation_id, effect_id, approval_id, evaluated_at, result,
  reasons, assessment_context, provenance_id
) VALUES (
  'ape_00000000-0000-4000-8000-000000000005',
  'eff_00000000-0000-4000-8000-000000000002',
  'apr_00000000-0000-4000-8000-000000000001', statement_timestamp(),
  'covered', '[]', '{}', 'prv_00000000-0000-4000-8000-000000000001'
);

UPDATE acp.effect_proposals SET state = 'authorized', updated_at = statement_timestamp()
WHERE effect_id = 'eff_00000000-0000-4000-8000-000000000002';
UPDATE acp.effect_proposals SET state = 'revalidating', updated_at = statement_timestamp()
WHERE effect_id = 'eff_00000000-0000-4000-8000-000000000002';

INSERT INTO acp.resource_leases (
  lease_id, lease_key, mission_id, node_id, owner_run_id, state,
  acquired_at, expires_at, heartbeat_at, recovery_state
) VALUES (
  'lea_00000000-0000-4000-8000-000000000002',
  'effect:eff_00000000-0000-4000-8000-000000000002',
  'mis_00000000-0000-4000-8000-000000000001',
  'nod_00000000-0000-4000-8000-000000000001',
  'run_00000000-0000-4000-8000-000000000001', 'active',
  statement_timestamp(), statement_timestamp() + interval '10 minutes',
  statement_timestamp(), '{}'
);

INSERT INTO acp.execution_precondition_evaluations (
  execution_precondition_evaluation_id, effect_id, approval_id,
  approval_evaluation_id, lease_id, fencing_token, proposal_digest,
  payload_digest, observed_target_digest, precondition_results, result,
  evaluated_at, valid_until, provenance_id
) SELECT
  'epe_00000000-0000-4000-8000-000000000002',
  'eff_00000000-0000-4000-8000-000000000002',
  'apr_00000000-0000-4000-8000-000000000001',
  'ape_00000000-0000-4000-8000-000000000005', lease_id, fencing_token,
  'sha256:proposal-two', 'sha256:payload-two', 'sha256:observed-target-two',
  '[]', 'passed', statement_timestamp(), statement_timestamp() + interval '5 minutes',
  'prv_00000000-0000-4000-8000-000000000001'
FROM acp.resource_leases
WHERE lease_id = 'lea_00000000-0000-4000-8000-000000000002';

UPDATE acp.effect_proposals
SET state = 'executing', execution_fencing_token = lease.fencing_token,
    execution_precondition_evaluation_id =
      'epe_00000000-0000-4000-8000-000000000002',
    updated_at = statement_timestamp()
FROM acp.resource_leases AS lease
WHERE effect_proposals.effect_id = 'eff_00000000-0000-4000-8000-000000000002'
  AND lease.lease_id = 'lea_00000000-0000-4000-8000-000000000002';

INSERT INTO acp.effect_receipts (
  receipt_id, effect_id, attempt_number, state, execution_record,
  attempted_at, provenance_id
) VALUES (
  'rcp_00000000-0000-4000-8000-000000000003',
  'eff_00000000-0000-4000-8000-000000000002', 1, 'unknown_outcome', '{}',
  statement_timestamp(), 'prv_00000000-0000-4000-8000-000000000001'
);

INSERT INTO acp.evidence_records (
  evidence_id, project_id, source_type, source_ref, observed_at, retrieved_at,
  content_hash, sensitivity, retention_policy, redacted_summary, freshness,
  accessibility
) VALUES (
  'evd_00000000-0000-4000-8000-000000000002',
  'prj_00000000-0000-4000-8000-000000000001', 'synthetic',
  'record:reconciliation-readback', statement_timestamp(), statement_timestamp(),
  'sha256:reconciliation-evidence', 'public', 'integration-test',
  'Synthetic reconciliation read-back matched.', 'current', 'available'
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    INSERT INTO acp.effect_receipts (
      receipt_id, effect_id, attempt_number, state, execution_record,
      attempted_at, provenance_id
    ) VALUES (
      'rcp_00000000-0000-4000-8000-000000000004',
      'eff_00000000-0000-4000-8000-000000000002', 2, 'applied', '{}',
      statement_timestamp(), 'prv_00000000-0000-4000-8000-000000000001'
    )
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    INSERT INTO acp.effect_reconciliations (
      reconciliation_id, effect_id, unknown_receipt_id, outcome,
      observed_state, evidence_ids, reconciled_at, provenance_id
    ) VALUES (
      'rcn_00000000-0000-4000-8000-000000000001',
      'eff_00000000-0000-4000-8000-000000000001',
      'rcp_00000000-0000-4000-8000-000000000003', 'applied', '{}',
      '["evd_test"]', statement_timestamp(),
      'prv_00000000-0000-4000-8000-000000000001'
    )
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    INSERT INTO acp.effect_reconciliations (
      reconciliation_id, effect_id, unknown_receipt_id, outcome,
      observed_state, evidence_ids, reconciled_at, provenance_id
    ) VALUES (
      'rcn_00000000-0000-4000-8000-000000000099',
      'eff_00000000-0000-4000-8000-000000000002',
      'rcp_00000000-0000-4000-8000-000000000003', 'applied', '{}',
      '["evd_test"]', statement_timestamp(),
      'prv_00000000-0000-4000-8000-000000000001'
    )
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    INSERT INTO acp.effect_reconciliations (
      reconciliation_id, effect_id, unknown_receipt_id, outcome,
      observed_state, evidence_ids, reconciled_at, provenance_id
    ) VALUES (
      'rcn_00000000-0000-4000-8000-000000000097',
      'eff_00000000-0000-4000-8000-000000000002',
      'rcp_00000000-0000-4000-8000-000000000003', 'applied',
      jsonb_build_object(
        'outcome', 'applied',
        'sourceRef', 'record:unrelated',
        'observedDigest', 'sha256:unrelated',
        'observedAt', (
          SELECT observed_at::text FROM acp.evidence_records
          WHERE evidence_id = 'evd_00000000-0000-4000-8000-000000000002'
        )
      ),
      '["evd_00000000-0000-4000-8000-000000000002"]', statement_timestamp(),
      'prv_00000000-0000-4000-8000-000000000001'
    )
  $statement$
);

INSERT INTO acp.effect_reconciliations (
  reconciliation_id, effect_id, unknown_receipt_id, outcome,
  observed_state, evidence_ids, reconciled_at, provenance_id
) VALUES (
  'rcn_00000000-0000-4000-8000-000000000002',
  'eff_00000000-0000-4000-8000-000000000002',
  'rcp_00000000-0000-4000-8000-000000000003', 'applied',
  jsonb_build_object(
    'outcome', 'applied',
    'sourceRef', 'record:reconciliation-readback',
    'observedDigest', 'sha256:reconciliation-evidence',
    'observedAt', (
      SELECT observed_at::text FROM acp.evidence_records
      WHERE evidence_id = 'evd_00000000-0000-4000-8000-000000000002'
    )
  ),
  '["evd_00000000-0000-4000-8000-000000000002"]', statement_timestamp(),
  'prv_00000000-0000-4000-8000-000000000001'
);

INSERT INTO acp.evidence_records (
  evidence_id, project_id, source_type, source_ref, observed_at, retrieved_at,
  content_hash, sensitivity, retention_policy, redacted_summary, freshness,
  accessibility
) VALUES (
  'evd_00000000-0000-4000-8000-000000000003',
  'prj_00000000-0000-4000-8000-000000000001', 'synthetic',
  'record:second-readback', statement_timestamp(), statement_timestamp(),
  'sha256:observed-two', 'public', 'integration-test',
  'Synthetic second read-back matched.', 'current', 'available'
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    INSERT INTO acp.effect_receipts (
      receipt_id, effect_id, attempt_number, state, execution_record,
      verification_record, attempted_at, verified_at, provenance_id
    ) VALUES (
      'rcp_00000000-0000-4000-8000-000000000004',
      'eff_00000000-0000-4000-8000-000000000002', 2, 'verified', '{}',
      jsonb_build_object(
        'result', 'passed',
        'steps', jsonb_build_array(jsonb_build_object(
          'stepIndex', 0, 'type', 'read', 'expected', jsonb_build_object('value', 2),
          'observed', jsonb_build_object('value', 2),
          'observedDigest', 'sha256:observed-two', 'matched', true,
          'observedAt', statement_timestamp()::text,
          'evidenceIds', jsonb_build_array('evd_00000000-0000-4000-8000-000000000001')
        ))
      ), statement_timestamp(), statement_timestamp(),
      'prv_00000000-0000-4000-8000-000000000001'
    )
  $statement$
);

UPDATE acp.effect_proposals SET state = 'verifying', updated_at = statement_timestamp()
WHERE effect_id = 'eff_00000000-0000-4000-8000-000000000002';

INSERT INTO acp.effect_receipts (
  receipt_id, effect_id, attempt_number, state, execution_record,
  verification_record, attempted_at, verified_at, provenance_id
) VALUES (
  'rcp_00000000-0000-4000-8000-000000000004',
  'eff_00000000-0000-4000-8000-000000000002', 2, 'verified', '{}',
  jsonb_build_object(
    'result', 'passed',
    'steps', jsonb_build_array(jsonb_build_object(
      'stepIndex', 0, 'type', 'read', 'expected', jsonb_build_object('value', 2),
      'observed', jsonb_build_object('value', 2),
      'observedDigest', 'sha256:observed-two', 'matched', true,
      'observedAt', (
        SELECT observed_at::text FROM acp.evidence_records
        WHERE evidence_id = 'evd_00000000-0000-4000-8000-000000000003'
      ),
      'evidenceIds', jsonb_build_array('evd_00000000-0000-4000-8000-000000000003')
    ))
  ), (
    SELECT observed_at FROM acp.evidence_records
    WHERE evidence_id = 'evd_00000000-0000-4000-8000-000000000003'
  ), statement_timestamp(),
  'prv_00000000-0000-4000-8000-000000000001'
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    WITH configured AS (
      SELECT set_config(
        'acp.runtime_control_event_id',
        'rce_00000000-0000-4000-8000-000000000001',
        true
      )
    )
    UPDATE acp.runtime_controls
    SET reason = 'Replay old event.'
    FROM configured
    WHERE scope_type = 'global' AND scope_id = 'global'
  $statement$
);

DO $$
DECLARE
  control_time timestamptz;
BEGIN
  SELECT updated_at + interval '1 microsecond'
  INTO control_time
  FROM acp.runtime_controls
  WHERE scope_type = 'global' AND scope_id = 'global';

  INSERT INTO acp.runtime_control_events (
    control_event_id, scope_type, scope_id, previous_effects_paused,
    effects_paused, reason, updated_by, authorization_id, occurred_at, provenance_id
  ) VALUES (
    'rce_00000000-0000-4000-8000-000000000002', 'global', 'global', false,
    true, 'Restore fail-closed state.', 'integration:test', NULL,
    control_time, 'prv_00000000-0000-4000-8000-000000000001'
  );
  PERFORM set_config('acp.runtime_control_event_id',
    'rce_00000000-0000-4000-8000-000000000002', true);
  UPDATE acp.runtime_controls
  SET effects_paused = true, reason = 'Restore fail-closed state.',
      updated_by = 'integration:test', authorization_id = NULL,
      updated_at = control_time,
      last_control_event_id = 'rce_00000000-0000-4000-8000-000000000002'
  WHERE scope_type = 'global' AND scope_id = 'global';
END;
$$;

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    WITH old_event AS (
      SELECT occurred_at
      FROM acp.runtime_control_events
      WHERE control_event_id = 'rce_00000000-0000-4000-8000-000000000001'
    ), configured AS (
      SELECT set_config(
        'acp.runtime_control_event_id',
        'rce_00000000-0000-4000-8000-000000000001',
        true
      )
    )
    UPDATE acp.runtime_controls
    SET effects_paused = false, reason = 'Authorized integration gate.',
        updated_by = 'operator:test',
        authorization_id = 'rca_00000000-0000-4000-8000-000000000001',
        updated_at = old_event.occurred_at,
        last_control_event_id = 'rce_00000000-0000-4000-8000-000000000001'
    FROM old_event, configured
    WHERE scope_type = 'global' AND scope_id = 'global'
  $statement$
);

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$DELETE FROM acp.runtime_controls
    WHERE scope_type = 'global' AND scope_id = 'global'$statement$
);

INSERT INTO acp.durable_subscriptions (
  subscription_id, mission_id, node_id, dbos_workflow_id, topic, semantic_digest,
  state, provenance_id, transition_provenance_id
) VALUES (
  'sub_00000000-0000-4000-8000-000000000001',
  'mis_00000000-0000-4000-8000-000000000001',
  'nod_00000000-0000-4000-8000-000000000001', 'workflow:test', 'approval',
  'sha256:subscription', 'waiting',
  'prv_00000000-0000-4000-8000-000000000001',
  'prv_00000000-0000-4000-8000-000000000001'
);

UPDATE acp.durable_subscriptions
SET state = 'cancelled', resolved_at = statement_timestamp()
WHERE subscription_id = 'sub_00000000-0000-4000-8000-000000000001';

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    UPDATE acp.worker_runs
    SET state = 'succeeded',
        result = '{"runId":"run_00000000-0000-4000-8000-000000000001","status":"succeeded"}',
        completed_at = statement_timestamp()
    WHERE run_id = 'run_00000000-0000-4000-8000-000000000001'
  $statement$
);

WITH result_content AS (
  SELECT jsonb_build_object(
    'schemaVersion', '1.0.0',
    'runId', run.run_id,
    'missionId', run.mission_id,
    'nodeId', run.node_id,
    'projectId', 'prj_00000000-0000-4000-8000-000000000001',
    'contextPacketId', run.context_packet_id,
    'contextPacketDigest', packet.digest,
    'attemptNumber', run.attempt_number,
    'workerRole', 'effect_executor',
    'status', 'succeeded',
    'conclusion', 'Synthetic worker completed.',
    'evidenceIds', '[]'::jsonb,
    'claimsProduced', '[]'::jsonb,
    'challengedClaimIds', '[]'::jsonb,
    'artifactIds', '[]'::jsonb,
    'findings', '[]'::jsonb,
    'proposedEffects', '[]'::jsonb,
    'risks', '[]'::jsonb,
    'unresolvedQuestions', '[]'::jsonb,
    'suggestedNextNodeTypes', '[]'::jsonb,
    'resourceUsage', jsonb_build_object(
      'wallMilliseconds', 1, 'outputBytes', 256
    ),
    'modelUsage', jsonb_build_object(
      'inputTokens', 0, 'outputTokens', 0, 'cachedInputTokens', 0
    )
  ) AS value
  FROM acp.worker_runs AS run
  JOIN acp.context_packets AS packet
    ON packet.context_packet_id = run.context_packet_id
  WHERE run.run_id = 'run_00000000-0000-4000-8000-000000000001'
)
UPDATE acp.worker_runs
SET state = 'succeeded',
    result = result_content.value || jsonb_build_object(
      'digest', acp.jsonb_sha256(result_content.value)
    ),
    completed_at = statement_timestamp()
FROM result_content
WHERE run_id = 'run_00000000-0000-4000-8000-000000000001';

SELECT pg_temp.expect_sqlstate(
  'P0001',
  $statement$
    UPDATE acp.worker_runs
    SET result = jsonb_set(result, '{conclusion}', '"rewritten"'::jsonb)
    WHERE run_id = 'run_00000000-0000-4000-8000-000000000001'
  $statement$
);

SAVEPOINT approval_order_collision;

INSERT INTO acp.effect_approval_evaluations (
  approval_evaluation_id, effect_id, approval_id, evaluated_at, result,
  reasons, assessment_context, provenance_id
) VALUES (
  'ape_00000000-0000-4000-8000-000000000006',
  'eff_00000000-0000-4000-8000-000000000001',
  'apr_00000000-0000-4000-8000-000000000001',
  (SELECT evaluated_at FROM acp.effect_approval_evaluations
   WHERE approval_evaluation_id = 'ape_00000000-0000-4000-8000-000000000001'),
  'not_covered', '["same_timestamp_first"]', '{}',
  'prv_00000000-0000-4000-8000-000000000001'
), (
  'ape_00000000-0000-4000-8000-000000000007',
  'eff_00000000-0000-4000-8000-000000000001',
  'apr_00000000-0000-4000-8000-000000000001',
  (SELECT evaluated_at FROM acp.effect_approval_evaluations
   WHERE approval_evaluation_id = 'ape_00000000-0000-4000-8000-000000000001'),
  'not_covered', '["same_timestamp_second"]', '{}',
  'prv_00000000-0000-4000-8000-000000000001'
);

DO $$
BEGIN
  IF (
    SELECT approval_evaluation_id
    FROM acp.effect_approval_evaluations
    WHERE approval_evaluation_id IN (
      'ape_00000000-0000-4000-8000-000000000006',
      'ape_00000000-0000-4000-8000-000000000007'
    )
    ORDER BY evaluated_at DESC, recorded_order DESC
    LIMIT 1
  ) <> 'ape_00000000-0000-4000-8000-000000000007' THEN
    RAISE EXCEPTION 'same-timestamp approval evaluations lack deterministic order';
  END IF;
END;
$$;

ROLLBACK TO SAVEPOINT approval_order_collision;
RELEASE SAVEPOINT approval_order_collision;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM acp.effect_proposals
    WHERE effect_id = 'eff_00000000-0000-4000-8000-000000000001'
      AND state = 'verified'
      AND verification_receipt_id = 'rcp_00000000-0000-4000-8000-000000000002'
  ) THEN
    RAISE EXCEPTION 'verified effect must point at its exact verified receipt';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM acp.effect_proposals
    WHERE effect_id = 'eff_00000000-0000-4000-8000-000000000002'
      AND state = 'verified'
      AND verification_receipt_id = 'rcp_00000000-0000-4000-8000-000000000004'
  ) THEN
    RAISE EXCEPTION 'reconciled applied effect must verify by a later receipt';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM acp.runtime_controls
    WHERE scope_type = 'global' AND scope_id = 'global' AND effects_paused
  ) THEN
    RAISE EXCEPTION 'global effects must finish paused';
  END IF;
END;
$$;
