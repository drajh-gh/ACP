-- Transaction ownership belongs to the migration runner.
-- Legacy packets remain readable audit history, but cannot admit new runs.
CREATE TABLE acp.node_context_revisions (
  context_revision_id acp.stable_id PRIMARY KEY CHECK (left(context_revision_id, 4) = 'ncr_'),
  mission_id acp.stable_id NOT NULL,
  node_id acp.stable_id NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  graph_revision text NOT NULL,
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  digest text NOT NULL CHECK (digest = acp.jsonb_sha256(content)),
  provenance_id acp.stable_id NOT NULL REFERENCES acp.runtime_provenance (provenance_id),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (mission_id, node_id) REFERENCES acp.mission_nodes (mission_id, node_id),
  UNIQUE (node_id, revision),
  UNIQUE (context_revision_id, mission_id, node_id)
);

CREATE FUNCTION acp.validate_node_context_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  field text;
  prefix text;
  node_record acp.mission_nodes;
BEGIN
  PERFORM 1 FROM acp.missions WHERE mission_id = NEW.mission_id FOR UPDATE;
  SELECT * INTO STRICT node_record FROM acp.mission_nodes
  WHERE node_id = NEW.node_id AND mission_id = NEW.mission_id FOR UPDATE;
  IF node_record.state IN ('succeeded', 'failed', 'cancelled')
     OR node_record.graph_revision <> NEW.graph_revision
     OR EXISTS (SELECT 1 FROM acp.missions WHERE mission_id = NEW.mission_id
       AND state IN ('complete_for_scope', 'failed', 'cancelled'))
     OR NEW.revision <> (SELECT coalesce(max(revision), 0) + 1
       FROM acp.node_context_revisions WHERE node_id = NEW.node_id)
     OR NOT acp.runtime_provenance_matches_context(NEW.provenance_id, NEW.mission_id) THEN
    RAISE EXCEPTION 'node context revision requires current graph, next revision, and matching provenance';
  END IF;
  IF NOT (NEW.content ?& ARRAY['objective', 'nonGoals', 'behavioralContract',
    'acceptanceCriteria', 'conflicts', 'unresolvedQuestions', 'nextAction', 'limits',
    'evidenceIds', 'activeClaimIds', 'previousRunIds', 'approvalIds'])
    OR NEW.content - ARRAY['objective', 'nonGoals', 'behavioralContract',
    'acceptanceCriteria', 'conflicts', 'unresolvedQuestions', 'nextAction', 'limits',
    'evidenceIds', 'activeClaimIds', 'previousRunIds', 'approvalIds'] <> '{}'::jsonb
    OR octet_length(NEW.content::text) > 262144 THEN
    RAISE EXCEPTION 'node context content must match the bounded schema';
  END IF;
  FOREACH field IN ARRAY ARRAY['objective', 'nextAction'] LOOP
    IF jsonb_typeof(NEW.content -> field) IS DISTINCT FROM 'string'
       OR length(btrim(NEW.content ->> field)) = 0 THEN
      RAISE EXCEPTION 'node context requires nonblank %', field;
    END IF;
  END LOOP;
  IF jsonb_typeof(NEW.content -> 'behavioralContract') IS DISTINCT FROM 'object'
     OR jsonb_typeof(NEW.content -> 'limits') IS DISTINCT FROM 'object'
     OR NOT ((NEW.content -> 'limits') ?& ARRAY['wallTimeMs', 'maximumTurns', 'maximumOutputBytes'])
     OR (NEW.content -> 'limits') - ARRAY['wallTimeMs', 'maximumTurns', 'maximumOutputBytes', 'maximumModelTokens'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'node context requires a behavioral contract and bounded limits';
  END IF;
  FOREACH field IN ARRAY ARRAY['wallTimeMs', 'maximumTurns', 'maximumOutputBytes', 'maximumModelTokens'] LOOP
    IF (NEW.content -> 'limits') ? field THEN
      IF jsonb_typeof(NEW.content #> ARRAY['limits', field]) IS DISTINCT FROM 'number'
         OR (NEW.content #>> ARRAY['limits', field]) !~ '^[1-9][0-9]*$'
         OR (NEW.content #>> ARRAY['limits', field])::numeric >
           (CASE field WHEN 'wallTimeMs' THEN 86400000 WHEN 'maximumTurns' THEN 100
             WHEN 'maximumOutputBytes' THEN 262144 ELSE 9007199254740991 END) THEN
        RAISE EXCEPTION 'node context has invalid %', field;
      END IF;
    END IF;
  END LOOP;
  FOREACH field IN ARRAY ARRAY['nonGoals', 'acceptanceCriteria', 'conflicts',
    'unresolvedQuestions', 'evidenceIds', 'activeClaimIds', 'previousRunIds', 'approvalIds'] LOOP
    IF jsonb_typeof(NEW.content -> field) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'node context % must be an array', field;
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.content -> field) x
      WHERE jsonb_typeof(x) <> 'string' OR length(btrim(x #>> '{}')) = 0) THEN
      RAISE EXCEPTION 'node context % must contain nonblank strings', field;
    END IF;
    prefix := CASE field WHEN 'evidenceIds' THEN 'evd' WHEN 'activeClaimIds' THEN 'clm'
      WHEN 'previousRunIds' THEN 'run' WHEN 'approvalIds' THEN 'apr' END;
    IF prefix IS NOT NULL THEN
      IF jsonb_array_length(NEW.content -> field) > 100
         OR (SELECT count(DISTINCT x) FROM jsonb_array_elements(NEW.content -> field) x)
           <> jsonb_array_length(NEW.content -> field)
         OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(NEW.content -> field) x
           WHERE x !~ ('^' || prefix || '_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')) THEN
        RAISE EXCEPTION 'node context % must contain bounded unique stable identifiers', field;
      END IF;
    END IF;
  END LOOP;
  NEW.created_at := statement_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER node_context_revisions_validate BEFORE INSERT ON acp.node_context_revisions
FOR EACH ROW EXECUTE FUNCTION acp.validate_node_context_revision();
CREATE TRIGGER node_context_revisions_are_immutable BEFORE UPDATE OR DELETE ON acp.node_context_revisions
FOR EACH ROW EXECUTE FUNCTION acp.reject_immutable_mutation();

ALTER TABLE acp.context_packets
  ADD COLUMN context_revision_id acp.stable_id,
  ADD COLUMN build_request_digest text CHECK (build_request_digest ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN runtime_template_provenance_id acp.stable_id REFERENCES acp.runtime_provenance (provenance_id),
  ADD CONSTRAINT context_packets_revision_fk FOREIGN KEY (context_revision_id, mission_id, node_id)
    REFERENCES acp.node_context_revisions (context_revision_id, mission_id, node_id);

-- STABLE: every source read in one assembly uses one database statement snapshot.
-- Selection is durable node intent; summaries, results, pins and lifecycle are not caller inputs.
CREATE FUNCTION acp.build_context_packet_content(
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

CREATE FUNCTION acp.validate_authoritative_context_packet() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.context_revision_id IS NULL OR NEW.runtime_template_provenance_id IS NULL
     OR NEW.build_request_digest IS NULL THEN
    RAISE EXCEPTION 'new context packets require an authoritative revision and build identity';
  END IF;
  IF NEW.packet - 'digest' IS DISTINCT FROM acp.build_context_packet_content(
    NEW.context_packet_id, NEW.mission_id, NEW.node_id, NEW.context_revision_id, NEW.capability_grant_id) THEN
    RAISE EXCEPTION 'context packet differs from authoritative assembly';
  END IF;
  IF NOT acp.runtime_provenance_matches_context(NEW.runtime_template_provenance_id, NEW.mission_id)
     OR NEW.build_request_digest <> acp.jsonb_sha256(jsonb_build_object(
       'contextPacketId', NEW.context_packet_id, 'missionId', NEW.mission_id, 'nodeId', NEW.node_id,
       'capabilityGrantId', NEW.capability_grant_id, 'provenanceId', NEW.provenance_id,
       'runtimeTemplateProvenanceId', NEW.runtime_template_provenance_id)) THEN
    RAISE EXCEPTION 'context packet build identity does not match its request';
  END IF;
  IF (SELECT to_jsonb(p) - ARRAY['provenance_id', 'context_packet_schema_version', 'context_packet_digest', 'recorded_at']
      FROM acp.runtime_provenance p WHERE p.provenance_id = NEW.provenance_id)
     IS DISTINCT FROM
     (SELECT to_jsonb(p) - ARRAY['provenance_id', 'context_packet_schema_version', 'context_packet_digest', 'recorded_at']
      FROM acp.runtime_provenance p WHERE p.provenance_id = NEW.runtime_template_provenance_id) THEN
    RAISE EXCEPTION 'packet provenance must retain the runtime template identity';
  END IF;
  NEW.created_at := statement_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER context_packets_validate_authoritative BEFORE INSERT ON acp.context_packets
FOR EACH ROW EXECUTE FUNCTION acp.validate_authoritative_context_packet();

CREATE FUNCTION acp.require_authoritative_worker_context() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  packet acp.context_packets;
BEGIN
  PERFORM 1 FROM acp.missions WHERE mission_id = NEW.mission_id FOR UPDATE;
  PERFORM 1 FROM acp.mission_nodes WHERE node_id = NEW.node_id AND mission_id = NEW.mission_id FOR UPDATE;
  SELECT * INTO STRICT packet FROM acp.context_packets WHERE context_packet_id = NEW.context_packet_id;
  IF packet.context_revision_id IS NULL THEN
    RAISE EXCEPTION 'legacy context packets cannot admit new worker runs';
  END IF;
  IF EXISTS (SELECT 1 FROM acp.worker_runs r WHERE r.node_id = NEW.node_id AND r.state = 'started')
     OR EXISTS (SELECT 1 FROM acp.worker_processes p WHERE p.node_id = NEW.node_id AND p.state = 'running') THEN
    RAISE EXCEPTION 'worker admission cannot overlap a live predecessor run or process';
  END IF;
  IF NEW.timeout_at - NEW.started_at >
       (packet.packet #>> '{limits,wallTimeMs}')::double precision * interval '1 millisecond' THEN
    RAISE EXCEPTION 'worker deadline exceeds authoritative packet limits';
  END IF;
  -- Revalidate current references and node revision at admission; prior retry count
  -- is the durable next-attempt fence, not a caller-supplied suggestion.
  IF packet.packet - 'digest' IS DISTINCT FROM acp.build_context_packet_content(
    packet.context_packet_id, packet.mission_id, packet.node_id,
    packet.context_revision_id, packet.capability_grant_id) THEN
    RAISE EXCEPTION 'worker admission requires a fresh authoritative context snapshot';
  END IF;
  IF (packet.packet ->> 'retryCount')::integer <> NEW.attempt_number - 1
     OR EXISTS (SELECT 1 FROM acp.worker_runs WHERE context_packet_id = NEW.context_packet_id) THEN
    RAISE EXCEPTION 'worker run requires a fresh context packet for its attempt';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER worker_runs_aa_require_authoritative_context BEFORE INSERT ON acp.worker_runs
FOR EACH ROW EXECUTE FUNCTION acp.require_authoritative_worker_context();
