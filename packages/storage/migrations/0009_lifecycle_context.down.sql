-- Restore prior assembly without rewriting 1.1.0 historical packets.
-- Retain lifecycle immutability and insert-time guards: old packets still name
-- these observations. Rollback restores the producer, not destructive mutation
-- authority. 0009 up is safe to reapply with these guards present.
CREATE OR REPLACE FUNCTION acp.build_context_packet_content(
  packet_id acp.stable_id, mission_id_arg acp.stable_id, node_id_arg acp.stable_id,
  revision_id acp.stable_id, grant_id_arg acp.stable_id
) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
  mission acp.missions;
  node acp.mission_nodes;
  revision acp.node_context_revisions;
  binding acp.project_workflow_bindings;
  source_rules jsonb;
  evidence jsonb;
  previous_results jsonb;
  lifecycle jsonb;
  observation jsonb;
  packet jsonb;
BEGIN
  SELECT * INTO STRICT mission FROM acp.missions WHERE mission_id = mission_id_arg;
  SELECT * INTO STRICT node FROM acp.mission_nodes WHERE node_id = node_id_arg AND mission_id = mission_id_arg;
  SELECT * INTO STRICT revision FROM acp.node_context_revisions
    WHERE context_revision_id = revision_id AND mission_id = mission_id_arg AND node_id = node_id_arg;
  IF mission.state IN ('complete_for_scope', 'failed', 'cancelled')
     OR node.state IN ('succeeded', 'failed', 'cancelled')
     OR revision.graph_revision <> node.graph_revision
     OR EXISTS (SELECT 1 FROM acp.node_context_revisions r WHERE r.node_id = node_id_arg AND r.revision > revision.revision) THEN
    RAISE EXCEPTION 'context assembly requires current node context and a nonterminal mission';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM acp.capability_grants g
    WHERE g.grant_id = grant_id_arg AND g.mission_id = mission_id_arg AND g.node_id = node_id_arg
      AND g.project_id = mission.project_id AND g.role = node.worker_role
      AND g.valid_from <= statement_timestamp() AND g.expires_at > statement_timestamp()) THEN
    RAISE EXCEPTION 'context assembly requires a current matching capability grant';
  END IF;
  SELECT * INTO STRICT binding FROM acp.project_workflow_bindings WHERE binding_id = mission.workflow_binding_id;
  SELECT profile -> 'sourceAuthorityRules' INTO source_rules FROM acp.project_profiles
    WHERE profile_id = binding.profile_id AND version = binding.profile_version;
  IF jsonb_typeof(source_rules) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'pinned project profile must declare sourceAuthorityRules';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(revision.content -> 'evidenceIds') selected(id)
    LEFT JOIN acp.evidence_records e ON e.evidence_id::text = selected.id
    WHERE e.evidence_id IS NULL OR e.project_id <> mission.project_id OR e.content_hash IS NULL
      OR e.freshness <> 'current' OR e.accessibility <> 'available' OR e.sensitivity = 'restricted'
      OR e.observed_at > statement_timestamp() OR e.retrieved_at > statement_timestamp()) THEN
    RAISE EXCEPTION 'selected evidence must be current, available, hashed and project-bound';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(revision.content -> 'activeClaimIds') selected(id)
    LEFT JOIN acp.claims c ON c.claim_id::text = selected.id
    WHERE c.claim_id IS NULL OR c.project_id IS DISTINCT FROM mission.project_id OR c.status <> 'active'
      OR c.valid_from > statement_timestamp() OR c.valid_until <= statement_timestamp()) THEN
    RAISE EXCEPTION 'selected claims must be active, current and project-bound';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(revision.content -> 'previousRunIds') selected(id)
    LEFT JOIN acp.worker_runs r ON r.run_id::text = selected.id
    WHERE r.run_id IS NULL OR r.mission_id <> mission_id_arg OR r.state = 'started'
      OR r.result IS NULL OR r.result ->> 'digest' IS NULL OR r.result ->> 'conclusion' IS NULL) THEN
    RAISE EXCEPTION 'selected previous results must be terminal and mission-bound';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(revision.content -> 'approvalIds') selected(id)
    LEFT JOIN acp.approval_envelopes a ON a.approval_id::text = selected.id
    WHERE a.approval_id IS NULL OR a.project_id <> mission.project_id
      OR a.mission_id IS DISTINCT FROM mission_id_arg OR a.revoked_at IS NOT NULL
      OR a.valid_from > statement_timestamp() OR a.expires_at <= statement_timestamp()) THEN
    RAISE EXCEPTION 'selected approvals must be current and mission-bound';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('evidenceId', e.evidence_id,
    'contentHash', e.content_hash, 'summary', e.redacted_summary) ORDER BY selected.ordinality), '[]') INTO evidence
    FROM jsonb_array_elements_text(revision.content -> 'evidenceIds') WITH ORDINALITY selected(id, ordinality)
    JOIN acp.evidence_records e ON e.evidence_id::text = selected.id;
  SELECT coalesce(jsonb_agg(jsonb_build_object('runId', r.run_id, 'status', r.state,
    'resultDigest', r.result ->> 'digest', 'conclusion', r.result ->> 'conclusion') ORDER BY selected.ordinality), '[]') INTO previous_results
    FROM jsonb_array_elements_text(revision.content -> 'previousRunIds') WITH ORDINALITY selected(id, ordinality)
    JOIN acp.worker_runs r ON r.run_id::text = selected.id;

  lifecycle := jsonb_build_object('mission', jsonb_build_object('state', mission.state),
    'deployments', '[]'::jsonb, 'acceptance', jsonb_build_object('state', 'pending'),
    'effects', '[]'::jsonb, 'businessCompletion', jsonb_build_object('state', 'not_evaluated'));
  SELECT jsonb_build_object('state', c.state, 'revision', jsonb_build_object(
    'repositoryId', c.repository_id, 'worktreePath', c.worktree_path, 'branch', c.branch,
    'headSha', c.head_sha, 'evidenceIds', c.evidence_ids)) INTO observation
    FROM acp.candidate_records c WHERE c.mission_id = mission_id_arg
    ORDER BY c.observed_at DESC, c.record_id DESC LIMIT 1;
  IF observation IS NOT NULL THEN lifecycle := lifecycle || jsonb_build_object('candidate', observation); END IF;
  SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('environment', d.environment,
    'artifactDigest', d.artifact_digest, 'state', d.state)) ORDER BY d.environment), '[]') INTO observation
    FROM (SELECT DISTINCT ON (environment) * FROM acp.deployment_records WHERE mission_id = mission_id_arg
      ORDER BY environment, observed_at DESC, record_id DESC) d;
  lifecycle := lifecycle || jsonb_build_object('deployments', observation);
  SELECT jsonb_strip_nulls(jsonb_build_object('state', a.state, 'candidateRevision', a.candidate_revision,
    'evidenceIds', a.evidence_ids, 'waiver', a.waiver)) INTO observation
    FROM acp.acceptance_records a WHERE a.mission_id = mission_id_arg
    ORDER BY a.observed_at DESC, a.record_id DESC LIMIT 1;
  IF observation IS NOT NULL THEN lifecycle := lifecycle || jsonb_build_object('acceptance', observation); END IF;
  SELECT jsonb_strip_nulls(jsonb_build_object('adapterId', t.adapter_id, 'externalId', t.external_id,
    'nativeState', t.native_state, 'semanticCategory', t.semantic_category)) INTO observation
    FROM acp.tracker_records t WHERE t.mission_id = mission_id_arg
    ORDER BY t.observed_at DESC, t.record_id DESC LIMIT 1;
  IF observation IS NOT NULL THEN lifecycle := lifecycle || jsonb_build_object('tracker', observation); END IF;
  SELECT jsonb_build_object('state', b.state, 'evidenceIds', b.evidence_ids) INTO observation
    FROM acp.business_completion_records b WHERE b.mission_id = mission_id_arg
    ORDER BY b.observed_at DESC, b.record_id DESC LIMIT 1;
  IF observation IS NOT NULL THEN lifecycle := lifecycle || jsonb_build_object('businessCompletion', observation); END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('effectId', e.effect_id, 'state', e.state) ORDER BY e.effect_id), '[]') INTO observation
    FROM acp.effect_proposals e WHERE e.mission_id = mission_id_arg;
  lifecycle := lifecycle || jsonb_build_object('effects', observation);

  -- Historical lifecycle observations retain their original candidate binding.
  -- Their references may be old, but must not smuggle another project's data.
  IF EXISTS (
    WITH referenced(id) AS (
      SELECT jsonb_array_elements_text(coalesce(lifecycle #> '{candidate,revision,evidenceIds}', '[]'))
      UNION ALL SELECT jsonb_array_elements_text(coalesce(lifecycle #> '{acceptance,evidenceIds}', '[]'))
      UNION ALL SELECT jsonb_array_elements_text(coalesce(lifecycle #> '{businessCompletion,evidenceIds}', '[]'))
      UNION ALL SELECT jsonb_array_elements_text(c.source_evidence_ids)
        FROM acp.claims c WHERE revision.content -> 'activeClaimIds' ? c.claim_id::text
    ) SELECT 1 FROM referenced r LEFT JOIN acp.evidence_records e ON e.evidence_id::text = r.id
      WHERE e.evidence_id IS NULL OR e.project_id IS DISTINCT FROM mission.project_id
        OR e.sensitivity = 'restricted'
  ) THEN
    RAISE EXCEPTION 'transitive context evidence must be accessible to the mission project';
  END IF;

  packet := (revision.content - ARRAY['evidenceIds', 'previousRunIds']) || jsonb_build_object(
    'contextPacketId', packet_id, 'schemaVersion', '1.0.0', 'missionId', mission_id_arg,
    'nodeId', node_id_arg, 'projectId', mission.project_id, 'nodeType', node.node_type,
    'workerRole', node.worker_role, 'completionScope', mission.requested_scope,
    'projectProfile', jsonb_build_object('id', binding.profile_id, 'version', binding.profile_version),
    'workflow', jsonb_build_object('id', mission.workflow_id, 'version', mission.workflow_version),
    'policy', jsonb_build_object('id', binding.policy_id, 'version', binding.policy_version),
    'completionContract', jsonb_build_object('id', mission.completion_contract_id, 'version', mission.completion_contract_version),
    'lifecycle', lifecycle, 'sourceAuthorityRules', source_rules, 'evidence', evidence,
    'previousResultRefs', previous_results, 'capabilityGrantId', grant_id_arg,
    'requiredOutputSchema', 'acp.worker-result@1.0.0',
    'retryCount', (SELECT coalesce(max(attempt_number), 0) FROM acp.worker_runs WHERE node_id = node_id_arg));
  IF octet_length(acp.canonical_jsonb_text(packet)) + 100 > 262144 THEN
    RAISE EXCEPTION 'assembled context exceeds the context packet byte limit';
  END IF;
  RETURN packet;
END;
$$;
