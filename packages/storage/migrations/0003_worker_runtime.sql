-- Transaction ownership belongs to the migration runner.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM acp.worker_runs)
     OR EXISTS (SELECT 1 FROM acp.context_packets) THEN
    RAISE EXCEPTION
      '0003 preflight requires context packets and worker runs to be drained';
  END IF;
END;
$$;

CREATE TABLE acp.capability_grant_evaluations (
  evaluation_id acp.stable_id PRIMARY KEY,
  mission_id acp.stable_id NOT NULL,
  node_id acp.stable_id NOT NULL,
  project_id acp.stable_id NOT NULL REFERENCES acp.projects (project_id),
  role text NOT NULL CHECK (
    role IN (
      'counterpart', 'context_intake', 'research', 'diagnosis', 'decision',
      'delivery', 'assurance', 'acceptance', 'coordination', 'learning',
      'effect_executor', 'reconciler'
    )
  ),
  resource_class text NOT NULL CHECK (
    resource_class IN (
      'cpu_intensive', 'moderate_compute', 'lightweight_read', 'network_bound'
    )
  ),
  allowed_operations jsonb NOT NULL CHECK (jsonb_typeof(allowed_operations) = 'array'),
  allowed_resources jsonb NOT NULL CHECK (jsonb_typeof(allowed_resources) = 'array'),
  mode text NOT NULL CHECK (mode IN ('read', 'write')),
  workspace text NOT NULL CHECK (length(btrim(workspace)) > 0),
  network_destinations jsonb NOT NULL CHECK (jsonb_typeof(network_destinations) = 'array'),
  valid_from timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  maximum_attempts integer NOT NULL CHECK (maximum_attempts > 0),
  policy_id acp.stable_id NOT NULL,
  policy_version acp.semantic_version NOT NULL,
  result text NOT NULL CHECK (result IN ('passed', 'denied')),
  reasons jsonb NOT NULL CHECK (jsonb_typeof(reasons) = 'array'),
  evaluated_at timestamptz NOT NULL,
  provenance_id acp.stable_id NOT NULL REFERENCES acp.runtime_provenance (provenance_id),
  FOREIGN KEY (mission_id, node_id) REFERENCES acp.mission_nodes (mission_id, node_id),
  FOREIGN KEY (policy_id, policy_version)
    REFERENCES acp.policy_definitions (policy_id, version),
  UNIQUE (evaluation_id, mission_id, node_id, project_id, role),
  CHECK (left(evaluation_id::text, 4) = 'cge_'),
  CHECK (expires_at > valid_from)
);

CREATE FUNCTION acp.validate_capability_grant_evaluation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM acp.mission_nodes AS node
    JOIN acp.missions AS mission ON mission.mission_id = node.mission_id
    JOIN acp.runtime_provenance AS provenance
      ON provenance.provenance_id = NEW.provenance_id
    WHERE node.mission_id = NEW.mission_id
      AND node.node_id = NEW.node_id
      AND node.worker_role = NEW.role
      AND mission.project_id = NEW.project_id
      AND provenance.policy_id = NEW.policy_id
      AND provenance.policy_version = NEW.policy_version
      AND acp.runtime_provenance_matches_context(
        provenance.provenance_id,
        NEW.mission_id
      )
  ) THEN
    RAISE EXCEPTION 'capability evaluation does not match policy and mission context';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER capability_grant_evaluations_validate
BEFORE INSERT ON acp.capability_grant_evaluations
FOR EACH ROW EXECUTE FUNCTION acp.validate_capability_grant_evaluation();

CREATE TRIGGER capability_grant_evaluations_are_immutable
BEFORE UPDATE OR DELETE ON acp.capability_grant_evaluations
FOR EACH ROW EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE TABLE acp.capability_grants (
  grant_id acp.stable_id PRIMARY KEY,
  evaluation_id acp.stable_id NOT NULL,
  mission_id acp.stable_id NOT NULL,
  node_id acp.stable_id NOT NULL,
  project_id acp.stable_id NOT NULL REFERENCES acp.projects (project_id),
  role text NOT NULL CHECK (
    role IN (
      'counterpart', 'context_intake', 'research', 'diagnosis', 'decision',
      'delivery', 'assurance', 'acceptance', 'coordination', 'learning',
      'effect_executor', 'reconciler'
    )
  ),
  resource_class text NOT NULL CHECK (
    resource_class IN (
      'cpu_intensive', 'moderate_compute', 'lightweight_read', 'network_bound'
    )
  ),
  allowed_operations jsonb NOT NULL CHECK (
    jsonb_typeof(allowed_operations) = 'array'
  ),
  allowed_resources jsonb NOT NULL CHECK (
    jsonb_typeof(allowed_resources) = 'array'
  ),
  mode text NOT NULL CHECK (mode IN ('read', 'write')),
  workspace text NOT NULL CHECK (length(btrim(workspace)) > 0),
  network_destinations jsonb NOT NULL CHECK (
    jsonb_typeof(network_destinations) = 'array'
  ),
  valid_from timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  maximum_attempts integer NOT NULL CHECK (maximum_attempts > 0),
  provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (mission_id, node_id)
    REFERENCES acp.mission_nodes (mission_id, node_id),
  FOREIGN KEY (evaluation_id, mission_id, node_id, project_id, role)
    REFERENCES acp.capability_grant_evaluations (
      evaluation_id, mission_id, node_id, project_id, role
    ),
  UNIQUE (grant_id, mission_id, node_id),
  CHECK (left(grant_id::text, 4) = 'cgr_'),
  CHECK (expires_at > valid_from)
);

CREATE FUNCTION acp.validate_capability_grant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.allowed_operations) AS item(value)
    WHERE jsonb_typeof(item.value) <> 'string'
       OR length(btrim(item.value #>> '{}')) = 0
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.allowed_resources) AS item(value)
    WHERE jsonb_typeof(item.value) <> 'string'
       OR length(btrim(item.value #>> '{}')) = 0
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.network_destinations) AS item(value)
    WHERE jsonb_typeof(item.value) <> 'string'
       OR length(btrim(item.value #>> '{}')) = 0
  ) THEN
    RAISE EXCEPTION 'capability grant scopes must contain nonblank strings';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM acp.mission_nodes AS node
    JOIN acp.missions AS mission ON mission.mission_id = node.mission_id
    WHERE node.mission_id = NEW.mission_id
      AND node.node_id = NEW.node_id
      AND node.worker_role = NEW.role
      AND mission.project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'capability grant scope does not match mission node';
  END IF;
  IF NOT acp.runtime_provenance_matches_context(
    NEW.provenance_id,
    NEW.mission_id
  ) THEN
    RAISE EXCEPTION 'capability grant provenance does not match mission context';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM acp.capability_grant_evaluations AS evaluation
    WHERE evaluation.evaluation_id = NEW.evaluation_id
      AND evaluation.result = 'passed'
      AND evaluation.resource_class = NEW.resource_class
      AND evaluation.allowed_operations = NEW.allowed_operations
      AND evaluation.allowed_resources = NEW.allowed_resources
      AND evaluation.mode = NEW.mode
      AND evaluation.workspace = NEW.workspace
      AND evaluation.network_destinations = NEW.network_destinations
      AND evaluation.valid_from = NEW.valid_from
      AND evaluation.expires_at = NEW.expires_at
      AND evaluation.maximum_attempts = NEW.maximum_attempts
  ) THEN
    RAISE EXCEPTION 'capability grant requires its exact passing policy evaluation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER capability_grants_validate
BEFORE INSERT ON acp.capability_grants
FOR EACH ROW EXECUTE FUNCTION acp.validate_capability_grant();

CREATE TRIGGER capability_grants_are_immutable
BEFORE UPDATE OR DELETE ON acp.capability_grants
FOR EACH ROW EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE FUNCTION acp.canonical_jsonb_text(input jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
  item record;
  rendered text := '';
  separator text := '';
BEGIN
  CASE jsonb_typeof(input)
    WHEN 'object' THEN
      FOR item IN SELECT key, value FROM jsonb_each(input) ORDER BY key LOOP
        rendered := rendered || separator || to_jsonb(item.key)::text || ':' ||
          acp.canonical_jsonb_text(item.value);
        separator := ',';
      END LOOP;
      RETURN '{' || rendered || '}';
    WHEN 'array' THEN
      FOR item IN
        SELECT value FROM jsonb_array_elements(input) WITH ORDINALITY
        ORDER BY ordinality
      LOOP
        rendered := rendered || separator || acp.canonical_jsonb_text(item.value);
        separator := ',';
      END LOOP;
      RETURN '[' || rendered || ']';
    ELSE
      RETURN input::text;
  END CASE;
END;
$$;

CREATE FUNCTION acp.jsonb_sha256(input jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT 'sha256:' || encode(
    sha256(convert_to(acp.canonical_jsonb_text(input), 'UTF8')),
    'hex'
  )
$$;

ALTER TABLE acp.context_packets
  ADD COLUMN capability_grant_id acp.stable_id NOT NULL,
  ADD CONSTRAINT context_packets_capability_grant_fk
    FOREIGN KEY (capability_grant_id, mission_id, node_id)
    REFERENCES acp.capability_grants (grant_id, mission_id, node_id),
  ADD CONSTRAINT context_packets_capability_identity_unique
    UNIQUE (context_packet_id, mission_id, node_id, capability_grant_id);

CREATE FUNCTION acp.validate_context_packet_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT (
    NEW.packet ?& ARRAY[
      'contextPacketId', 'schemaVersion', 'missionId', 'nodeId', 'projectId',
      'nodeType', 'workerRole', 'objective', 'nonGoals', 'completionScope',
      'projectProfile', 'workflow', 'policy', 'completionContract', 'lifecycle',
      'behavioralContract', 'acceptanceCriteria', 'sourceAuthorityRules',
      'evidence', 'activeClaimIds', 'conflicts', 'unresolvedQuestions',
      'previousResultRefs', 'approvalIds', 'capabilityGrantId',
      'requiredOutputSchema', 'nextAction', 'retryCount', 'limits', 'digest'
    ]
  ) OR (
    NEW.packet - ARRAY[
      'contextPacketId', 'schemaVersion', 'missionId', 'nodeId', 'projectId',
      'nodeType', 'workerRole', 'objective', 'nonGoals', 'completionScope',
      'projectProfile', 'workflow', 'policy', 'completionContract', 'lifecycle',
      'behavioralContract', 'acceptanceCriteria', 'sourceAuthorityRules',
      'evidence', 'activeClaimIds', 'conflicts', 'unresolvedQuestions',
      'previousResultRefs', 'approvalIds', 'capabilityGrantId',
      'requiredOutputSchema', 'nextAction', 'retryCount', 'limits', 'digest'
    ]
  ) <> '{}'::jsonb THEN
    RAISE EXCEPTION 'context packet does not match the canonical schema';
  END IF;
  IF NEW.packet ->> 'contextPacketId' IS DISTINCT FROM NEW.context_packet_id::text
     OR NEW.packet ->> 'missionId' IS DISTINCT FROM NEW.mission_id::text
     OR NEW.packet ->> 'nodeId' IS DISTINCT FROM NEW.node_id::text
     OR NEW.packet ->> 'schemaVersion' IS DISTINCT FROM NEW.schema_version::text
     OR NEW.packet ->> 'capabilityGrantId' IS DISTINCT FROM
          NEW.capability_grant_id::text
     OR NEW.packet ->> 'projectId' IS DISTINCT FROM (
       SELECT mission.project_id::text FROM acp.missions AS mission
       WHERE mission.mission_id = NEW.mission_id
     )
     OR NEW.packet ->> 'nodeType' IS DISTINCT FROM (
       SELECT node.node_type FROM acp.mission_nodes AS node
       WHERE node.mission_id = NEW.mission_id AND node.node_id = NEW.node_id
     )
     OR NEW.packet ->> 'workerRole' IS DISTINCT FROM (
       SELECT node.worker_role FROM acp.mission_nodes AS node
       WHERE node.mission_id = NEW.mission_id AND node.node_id = NEW.node_id
     )
     OR NEW.packet ->> 'digest' IS DISTINCT FROM NEW.digest
     OR NEW.packet ->> 'requiredOutputSchema' <> 'acp.worker-result@1.0.0'
     OR NEW.digest <> acp.jsonb_sha256(NEW.packet - 'digest') THEN
    RAISE EXCEPTION 'context packet JSON identity does not match relational identity';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM acp.missions AS mission
    JOIN acp.project_workflow_bindings AS binding
      ON binding.binding_id = mission.workflow_binding_id
    WHERE mission.mission_id = NEW.mission_id
      AND mission.project_id::text = NEW.packet ->> 'projectId'
      AND mission.workflow_id::text = NEW.packet #>> '{workflow,id}'
      AND mission.workflow_version::text = NEW.packet #>> '{workflow,version}'
      AND binding.profile_id::text = NEW.packet #>> '{projectProfile,id}'
      AND binding.profile_version::text =
            NEW.packet #>> '{projectProfile,version}'
      AND binding.policy_id::text = NEW.packet #>> '{policy,id}'
      AND binding.policy_version::text = NEW.packet #>> '{policy,version}'
      AND mission.completion_contract_id::text =
            NEW.packet #>> '{completionContract,id}'
      AND mission.completion_contract_version::text =
            NEW.packet #>> '{completionContract,version}'
      AND mission.state = NEW.packet #>> '{lifecycle,mission,state}'
  ) THEN
    RAISE EXCEPTION
      'context packet versioned references or mission state are not authoritative';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW.packet -> 'evidence') AS item(value)
    LEFT JOIN acp.evidence_records AS evidence
      ON evidence.evidence_id::text = item.value ->> 'evidenceId'
    WHERE evidence.evidence_id IS NULL
       OR evidence.project_id::text <> NEW.packet ->> 'projectId'
       OR evidence.content_hash IS DISTINCT FROM item.value ->> 'contentHash'
       OR evidence.redacted_summary IS DISTINCT FROM item.value ->> 'summary'
  ) THEN
    RAISE EXCEPTION 'context packet evidence is not authoritative';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(NEW.packet -> 'activeClaimIds') AS item(value)
    LEFT JOIN acp.claims AS claim ON claim.claim_id::text = item.value
    WHERE claim.claim_id IS NULL
       OR claim.project_id::text IS DISTINCT FROM NEW.packet ->> 'projectId'
       OR claim.status <> 'active'
  ) THEN
    RAISE EXCEPTION 'context packet active claims are not authoritative';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(NEW.packet -> 'approvalIds') AS item(value)
    LEFT JOIN acp.approval_envelopes AS approval
      ON approval.approval_id::text = item.value
    WHERE approval.approval_id IS NULL
       OR approval.project_id::text <> NEW.packet ->> 'projectId'
       OR approval.mission_id <> NEW.mission_id
       OR approval.revoked_at IS NOT NULL
       OR approval.valid_from > NEW.created_at
       OR approval.expires_at <= NEW.created_at
  ) THEN
    RAISE EXCEPTION 'context packet approvals are not current and authoritative';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW.packet -> 'previousResultRefs') AS item(value)
    LEFT JOIN acp.worker_runs AS run ON run.run_id::text = item.value ->> 'runId'
    WHERE run.run_id IS NULL
       OR run.mission_id <> NEW.mission_id
       OR run.state = 'started'
       OR run.state IS DISTINCT FROM item.value ->> 'status'
       OR run.result ->> 'digest' IS DISTINCT FROM item.value ->> 'resultDigest'
       OR run.result ->> 'conclusion' IS DISTINCT FROM item.value ->> 'conclusion'
  ) THEN
    RAISE EXCEPTION 'context packet previous results are not authoritative';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER context_packets_validate_identity
BEFORE INSERT ON acp.context_packets
FOR EACH ROW EXECUTE FUNCTION acp.validate_context_packet_identity();

CREATE TABLE acp.worker_hosts (
  host_identifier text PRIMARY KEY CHECK (length(btrim(host_identifier)) > 0),
  host_kind text NOT NULL CHECK (
    host_kind IN ('operator_laptop', 'vps', 'other')
  ),
  state text NOT NULL CHECK (state IN ('active', 'draining', 'offline')),
  maximum_cpu_intensive integer NOT NULL CHECK (maximum_cpu_intensive > 0),
  maximum_moderate_compute integer NOT NULL CHECK (maximum_moderate_compute > 0),
  maximum_lightweight_read integer NOT NULL CHECK (maximum_lightweight_read > 0),
  maximum_network_bound integer NOT NULL CHECK (maximum_network_bound > 0),
  heartbeat_ttl_seconds integer NOT NULL CHECK (
    heartbeat_ttl_seconds BETWEEN 5 AND 300
  ),
  heartbeat_at timestamptz NOT NULL,
  provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id),
  transition_provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

ALTER TABLE acp.worker_runs
  ADD COLUMN capability_grant_id acp.stable_id NOT NULL,
  ADD COLUMN host_identifier text NOT NULL
    REFERENCES acp.worker_hosts (host_identifier),
  ADD COLUMN resource_class text NOT NULL CHECK (
    resource_class IN (
      'cpu_intensive', 'moderate_compute', 'lightweight_read', 'network_bound'
    )
  ),
  ADD COLUMN operation text NOT NULL CHECK (length(btrim(operation)) > 0),
  ADD COLUMN resource text NOT NULL CHECK (length(btrim(resource)) > 0),
  ADD COLUMN requested_mode text NOT NULL CHECK (
    requested_mode IN ('read', 'write')
  ),
  ADD COLUMN workspace text NOT NULL CHECK (length(btrim(workspace)) > 0),
  ADD COLUMN network_destination text,
  ADD COLUMN timeout_at timestamptz NOT NULL,
  ADD CONSTRAINT worker_runs_context_capability_fk
    FOREIGN KEY (
      context_packet_id,
      mission_id,
      node_id,
      capability_grant_id
    ) REFERENCES acp.context_packets (
      context_packet_id,
      mission_id,
      node_id,
      capability_grant_id
    ),
  ADD CONSTRAINT worker_runs_timeout_after_start
    CHECK (timeout_at > started_at),
  ADD CONSTRAINT worker_runs_run_grant_unique
    UNIQUE (run_id, capability_grant_id);

CREATE UNIQUE INDEX worker_runs_one_active_node
ON acp.worker_runs (node_id)
WHERE state = 'started';

CREATE TABLE acp.capability_grant_uses (
  run_id acp.stable_id PRIMARY KEY,
  grant_id acp.stable_id NOT NULL REFERENCES acp.capability_grants (grant_id),
  used_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  host_identifier text NOT NULL CHECK (length(btrim(host_identifier)) > 0),
  provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id),
  FOREIGN KEY (run_id, grant_id)
    REFERENCES acp.worker_runs (run_id, capability_grant_id),
  UNIQUE (grant_id, run_id),
  CHECK (left(run_id::text, 4) = 'run_')
);

CREATE FUNCTION acp.authorize_worker_run()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  grant_record acp.capability_grants%ROWTYPE;
  host_record acp.worker_hosts%ROWTYPE;
  packet_grant_id acp.stable_id;
  used_attempts integer;
  active_host_runs integer;
  host_capacity integer;
BEGIN
  IF NEW.state <> 'started' OR NEW.result IS NOT NULL
     OR NEW.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'worker runs must begin in started state';
  END IF;
  SELECT * INTO grant_record
  FROM acp.capability_grants
  WHERE grant_id = NEW.capability_grant_id
  FOR UPDATE;
  SELECT capability_grant_id INTO packet_grant_id
  FROM acp.context_packets
  WHERE context_packet_id = NEW.context_packet_id
    AND mission_id = NEW.mission_id
    AND node_id = NEW.node_id;
  SELECT count(*) INTO used_attempts
  FROM acp.capability_grant_uses
  WHERE grant_id = NEW.capability_grant_id;
  SELECT * INTO host_record
  FROM acp.worker_hosts
  WHERE host_identifier = NEW.host_identifier
  FOR UPDATE;

  IF grant_record.grant_id IS NULL
     OR packet_grant_id IS DISTINCT FROM NEW.capability_grant_id
     OR grant_record.mission_id <> NEW.mission_id
     OR grant_record.node_id <> NEW.node_id THEN
    RAISE EXCEPTION 'worker run lacks its exact capability grant';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM acp.mission_nodes AS node
    JOIN acp.missions AS mission ON mission.mission_id = node.mission_id
    WHERE node.mission_id = NEW.mission_id
      AND node.node_id = NEW.node_id
      AND node.state = 'running'
      AND mission.state NOT IN ('complete_for_scope', 'failed', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'worker run requires an active mission node';
  END IF;
  IF grant_record.valid_from > NEW.started_at
     OR grant_record.expires_at <= NEW.started_at
     OR grant_record.valid_from > statement_timestamp()
     OR grant_record.expires_at <= statement_timestamp()
     OR NEW.timeout_at > grant_record.expires_at THEN
    RAISE EXCEPTION 'worker run capability grant is not current for its deadline';
  END IF;
  IF NOT (grant_record.allowed_operations ? NEW.operation)
     OR NOT (grant_record.allowed_resources ? NEW.resource)
     OR grant_record.resource_class <> NEW.resource_class
     OR grant_record.mode <> NEW.requested_mode
     OR grant_record.workspace <> NEW.workspace
     OR (
       NEW.network_destination IS NOT NULL
       AND NOT (grant_record.network_destinations ? NEW.network_destination)
     ) THEN
    RAISE EXCEPTION 'worker run request exceeds its capability grant';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM acp.runtime_provenance AS provenance
    WHERE provenance.provenance_id = NEW.provenance_id
      AND provenance.host_identifier = NEW.host_identifier
  ) THEN
    RAISE EXCEPTION 'worker run provenance does not match its execution host';
  END IF;
  IF used_attempts >= grant_record.maximum_attempts THEN
    RAISE EXCEPTION 'worker run capability grant attempt limit is exhausted';
  END IF;
  IF host_record.host_identifier IS NULL
     OR host_record.state <> 'active'
     OR host_record.heartbeat_at +
          make_interval(secs => host_record.heartbeat_ttl_seconds) <=
          statement_timestamp() THEN
    RAISE EXCEPTION 'worker run host is not available';
  END IF;
  host_capacity := CASE NEW.resource_class
    WHEN 'cpu_intensive' THEN host_record.maximum_cpu_intensive
    WHEN 'moderate_compute' THEN host_record.maximum_moderate_compute
    WHEN 'lightweight_read' THEN host_record.maximum_lightweight_read
    WHEN 'network_bound' THEN host_record.maximum_network_bound
  END;
  SELECT count(*) INTO active_host_runs
  FROM acp.worker_runs
  WHERE host_identifier = NEW.host_identifier
    AND resource_class = NEW.resource_class
    AND state = 'started';
  IF active_host_runs >= host_capacity THEN
    RAISE EXCEPTION 'worker run host capacity is exhausted';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER worker_runs_authorize
BEFORE INSERT ON acp.worker_runs
FOR EACH ROW EXECUTE FUNCTION acp.authorize_worker_run();

CREATE FUNCTION acp.record_capability_grant_use()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO acp.capability_grant_uses (
    run_id, grant_id, used_at, host_identifier, provenance_id
  ) VALUES (
    NEW.run_id,
    NEW.capability_grant_id,
    statement_timestamp(),
    NEW.host_identifier,
    NEW.provenance_id
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER worker_runs_record_capability_use
AFTER INSERT ON acp.worker_runs
FOR EACH ROW EXECUTE FUNCTION acp.record_capability_grant_use();

CREATE FUNCTION acp.validate_worker_run_result()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state <> 'started' AND NOT EXISTS (
    SELECT 1 FROM acp.runtime_provenance AS provenance
    WHERE provenance.provenance_id = NEW.transition_provenance_id
      AND provenance.host_identifier = NEW.host_identifier
  ) THEN
    RAISE EXCEPTION 'worker result provenance does not match its execution host';
  END IF;
  IF NEW.state <> 'started' AND NOT (
    NEW.result ?& ARRAY[
      'schemaVersion', 'runId', 'missionId', 'nodeId', 'projectId',
      'contextPacketId', 'contextPacketDigest', 'attemptNumber', 'workerRole',
      'status', 'conclusion', 'evidenceIds', 'claimsProduced',
      'challengedClaimIds', 'artifactIds', 'findings', 'proposedEffects',
      'risks', 'unresolvedQuestions', 'suggestedNextNodeTypes',
      'resourceUsage', 'modelUsage', 'digest'
    ]
  ) THEN
    RAISE EXCEPTION 'worker result does not match the canonical schema';
  END IF;
  IF NEW.state <> 'started' AND (
    NEW.result - ARRAY[
      'schemaVersion', 'runId', 'missionId', 'nodeId', 'projectId',
      'contextPacketId', 'contextPacketDigest', 'attemptNumber', 'workerRole',
      'status', 'conclusion', 'evidenceIds', 'claimsProduced',
      'challengedClaimIds', 'artifactIds', 'candidateRevision', 'findings',
      'proposedEffects', 'risks', 'unresolvedQuestions',
      'suggestedNextNodeTypes', 'resourceUsage', 'modelUsage', 'digest'
    ]
  ) <> '{}'::jsonb THEN
    RAISE EXCEPTION 'worker result contains undeclared fields';
  END IF;
  IF OLD.state <> 'started' AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'terminal worker run cannot transition';
  END IF;
  IF NEW.state <> 'started' AND (
    NEW.result ->> 'runId' IS DISTINCT FROM NEW.run_id::text
    OR NEW.result ->> 'missionId' IS DISTINCT FROM NEW.mission_id::text
    OR NEW.result ->> 'nodeId' IS DISTINCT FROM NEW.node_id::text
    OR NEW.result ->> 'contextPacketId' IS DISTINCT FROM
         NEW.context_packet_id::text
    OR NEW.result ->> 'schemaVersion' <> '1.0.0'
    OR NEW.result ->> 'attemptNumber' IS DISTINCT FROM
         NEW.attempt_number::text
    OR NEW.result ->> 'projectId' IS DISTINCT FROM (
      SELECT mission.project_id::text FROM acp.missions AS mission
      WHERE mission.mission_id = NEW.mission_id
    )
    OR NEW.result ->> 'workerRole' IS DISTINCT FROM (
      SELECT node.worker_role FROM acp.mission_nodes AS node
      WHERE node.mission_id = NEW.mission_id AND node.node_id = NEW.node_id
    )
    OR NEW.result ->> 'status' IS DISTINCT FROM NEW.state
    OR NEW.result ->> 'contextPacketDigest' IS DISTINCT FROM (
      SELECT packet.digest FROM acp.context_packets AS packet
      WHERE packet.context_packet_id = NEW.context_packet_id
    )
    OR NEW.result ->> 'digest' IS DISTINCT FROM
         acp.jsonb_sha256(NEW.result - 'digest')
  ) THEN
    RAISE EXCEPTION 'worker result identity or status does not match run projection';
  END IF;
  IF OLD.state = 'started' AND NEW.state <> 'started' AND EXISTS (
    SELECT 1 FROM acp.worker_processes AS process
    WHERE process.run_id = NEW.run_id AND process.state = 'running'
  ) THEN
    RAISE EXCEPTION 'worker run cannot finish while its process is running';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER worker_runs_validate_result
BEFORE UPDATE ON acp.worker_runs
FOR EACH ROW EXECUTE FUNCTION acp.validate_worker_run_result();

CREATE TABLE acp.worker_processes (
  worker_process_id acp.stable_id PRIMARY KEY,
  run_id acp.stable_id NOT NULL,
  mission_id acp.stable_id NOT NULL,
  node_id acp.stable_id NOT NULL,
  process_id bigint NOT NULL CHECK (process_id > 0),
  process_start_token text NOT NULL CHECK (
    length(btrim(process_start_token)) > 0
  ),
  purpose text NOT NULL CHECK (length(btrim(purpose)) > 0),
  host_identifier text NOT NULL CHECK (length(btrim(host_identifier)) > 0),
  resource_class text NOT NULL CHECK (
    resource_class IN (
      'cpu_intensive', 'moderate_compute', 'lightweight_read', 'network_bound'
    )
  ),
  state text NOT NULL CHECK (
    state IN ('running', 'exited', 'terminated', 'lost')
  ),
  started_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  deadline_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  completed_at timestamptz,
  exit_code integer,
  termination_reason text,
  provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id),
  transition_provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id),
  reconciliation_id acp.stable_id,
  reconciliation_owner text,
  reconciliation_claimed_at timestamptz,
  reconciliation_claim_expires_at timestamptz,
  reconciliation_provenance_id acp.stable_id
    REFERENCES acp.runtime_provenance (provenance_id),
  FOREIGN KEY (run_id, mission_id, node_id)
    REFERENCES acp.worker_runs (run_id, mission_id, node_id),
  UNIQUE (host_identifier, process_id, process_start_token),
  CHECK (left(worker_process_id::text, 4) = 'wpr_'),
  CHECK (deadline_at > started_at),
  CHECK (recorded_at >= started_at),
  CHECK (heartbeat_at >= started_at),
  CHECK ((state = 'running') = (completed_at IS NULL)),
  CHECK (completed_at IS NULL OR completed_at >= heartbeat_at),
  CHECK (
    state <> 'running' OR (exit_code IS NULL AND termination_reason IS NULL)
  ),
  CHECK (
    state = 'running' OR length(btrim(termination_reason)) > 0
  ),
  CHECK (state <> 'exited' OR exit_code IS NOT NULL),
  CHECK (state <> 'lost' OR exit_code IS NULL),
  CHECK (
    (reconciliation_id IS NULL
      AND reconciliation_owner IS NULL
      AND reconciliation_claimed_at IS NULL
      AND reconciliation_claim_expires_at IS NULL
      AND reconciliation_provenance_id IS NULL)
    OR
    (left(reconciliation_id::text, 4) = 'rcn_'
      AND length(btrim(reconciliation_owner)) > 0
      AND reconciliation_claimed_at IS NOT NULL
      AND reconciliation_claim_expires_at > reconciliation_claimed_at
      AND reconciliation_provenance_id IS NOT NULL)
  )
);

CREATE INDEX worker_processes_reconciliation_queue
ON acp.worker_processes (
  host_identifier, state, reconciliation_claim_expires_at, deadline_at,
  heartbeat_at
);

CREATE FUNCTION acp.protect_worker_process_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'worker processes are append-only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'running' THEN
      RAISE EXCEPTION 'worker processes must begin in running state';
    END IF;
    IF NOT acp.runtime_provenance_matches_context(
      NEW.provenance_id,
      NEW.mission_id
    ) OR NOT acp.runtime_provenance_matches_context(
      NEW.transition_provenance_id,
      NEW.mission_id
    ) OR NOT EXISTS (
      SELECT 1 FROM acp.runtime_provenance AS provenance
      WHERE provenance.provenance_id = NEW.transition_provenance_id
        AND provenance.host_identifier = NEW.host_identifier
    ) THEN
      RAISE EXCEPTION 'worker process provenance does not match mission and host';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM acp.worker_runs AS run
      JOIN acp.context_packets AS packet
        ON packet.context_packet_id = run.context_packet_id
      JOIN acp.runtime_provenance AS provenance
        ON provenance.provenance_id = NEW.provenance_id
      WHERE run.run_id = NEW.run_id
        AND run.mission_id = NEW.mission_id
        AND run.node_id = NEW.node_id
        AND run.state = 'started'
        AND run.host_identifier = NEW.host_identifier
        AND run.resource_class = NEW.resource_class
        AND run.provenance_id = NEW.provenance_id
        AND provenance.host_identifier = NEW.host_identifier
        AND provenance.context_packet_digest = packet.digest
        AND NEW.started_at >= run.started_at
        AND NEW.deadline_at <= run.timeout_at
    ) THEN
      RAISE EXCEPTION 'worker process does not match its active run boundary';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state <> 'running' THEN
    RAISE EXCEPTION 'terminal worker process is immutable';
  END IF;
  IF OLD.state = NEW.state
     AND NEW.transition_provenance_id <> OLD.transition_provenance_id THEN
    RAISE EXCEPTION 'process transition provenance can change only with state';
  END IF;
  IF (
    to_jsonb(NEW) - 'state' - 'heartbeat_at' - 'completed_at' - 'exit_code'
      - 'termination_reason' - 'transition_provenance_id'
      - 'reconciliation_id' - 'reconciliation_owner'
      - 'reconciliation_claimed_at' - 'reconciliation_claim_expires_at'
      - 'reconciliation_provenance_id'
  ) IS DISTINCT FROM (
    to_jsonb(OLD) - 'state' - 'heartbeat_at' - 'completed_at' - 'exit_code'
      - 'termination_reason' - 'transition_provenance_id'
      - 'reconciliation_id' - 'reconciliation_owner'
      - 'reconciliation_claimed_at' - 'reconciliation_claim_expires_at'
      - 'reconciliation_provenance_id'
  ) THEN
    RAISE EXCEPTION 'worker process identity is immutable';
  END IF;
  IF NEW.heartbeat_at < OLD.heartbeat_at THEN
    RAISE EXCEPTION 'worker process heartbeat cannot move backward';
  END IF;
  IF NEW.completed_at IS NOT NULL AND NEW.completed_at < NEW.started_at THEN
    RAISE EXCEPTION 'worker process completion cannot precede its start';
  END IF;
  IF NOT acp.runtime_provenance_matches_context(
    NEW.transition_provenance_id,
    NEW.mission_id
  ) OR NOT EXISTS (
    SELECT 1 FROM acp.runtime_provenance AS provenance
    WHERE provenance.provenance_id = NEW.transition_provenance_id
      AND provenance.host_identifier = NEW.host_identifier
  ) THEN
    RAISE EXCEPTION 'worker process transition provenance does not match mission and host';
  END IF;
  IF ROW(
    NEW.reconciliation_id,
    NEW.reconciliation_owner,
    NEW.reconciliation_claimed_at,
    NEW.reconciliation_claim_expires_at,
    NEW.reconciliation_provenance_id
  ) IS DISTINCT FROM ROW(
    OLD.reconciliation_id,
    OLD.reconciliation_owner,
    OLD.reconciliation_claimed_at,
    OLD.reconciliation_claim_expires_at,
    OLD.reconciliation_provenance_id
  ) THEN
    IF OLD.reconciliation_id IS NOT NULL
       AND OLD.reconciliation_claim_expires_at > statement_timestamp() THEN
      RAISE EXCEPTION 'active worker process reconciliation claim cannot be replaced';
    END IF;
    IF NEW.reconciliation_id IS NOT NULL AND (
      NOT acp.runtime_provenance_matches_context(
        NEW.reconciliation_provenance_id,
        NEW.mission_id
      ) OR NOT EXISTS (
        SELECT 1 FROM acp.runtime_provenance AS provenance
        WHERE provenance.provenance_id = NEW.reconciliation_provenance_id
          AND provenance.host_identifier = NEW.host_identifier
      )
    ) THEN
      RAISE EXCEPTION 'worker process reconciliation provenance does not match mission and host';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER worker_processes_protect_identity
BEFORE INSERT OR UPDATE OR DELETE ON acp.worker_processes
FOR EACH ROW EXECUTE FUNCTION acp.protect_worker_process_identity();

CREATE FUNCTION acp.require_worker_process_stop_before_node_terminal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.state = 'running' AND NEW.state <> 'running' AND EXISTS (
    SELECT 1 FROM acp.worker_processes AS process
    WHERE process.mission_id = NEW.mission_id
      AND process.node_id = NEW.node_id
      AND process.state = 'running'
  ) THEN
    RAISE EXCEPTION 'mission node cannot finish while its worker process is running';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER mission_nodes_require_worker_process_stop
BEFORE UPDATE OF state ON acp.mission_nodes
FOR EACH ROW EXECUTE FUNCTION acp.require_worker_process_stop_before_node_terminal();

CREATE FUNCTION acp.require_worker_process_stop_before_mission_terminal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state IN ('complete_for_scope', 'failed', 'cancelled')
     AND OLD.state <> NEW.state AND EXISTS (
       SELECT 1 FROM acp.worker_processes AS process
       WHERE process.mission_id = NEW.mission_id
         AND process.state = 'running'
     ) THEN
    RAISE EXCEPTION 'mission cannot finish while a worker process is running';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER missions_require_worker_process_stop
BEFORE UPDATE OF state ON acp.missions
FOR EACH ROW EXECUTE FUNCTION acp.require_worker_process_stop_before_mission_terminal();

CREATE TRIGGER capability_grant_uses_are_immutable
BEFORE UPDATE OR DELETE ON acp.capability_grant_uses
FOR EACH ROW EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE FUNCTION acp.validate_worker_host_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'worker hosts cannot be deleted';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM acp.runtime_provenance AS provenance
    WHERE provenance.provenance_id IN (
      NEW.provenance_id,
      NEW.transition_provenance_id
    )
      AND provenance.host_identifier = NEW.host_identifier
    GROUP BY provenance.host_identifier
    HAVING count(DISTINCT provenance.provenance_id) = CASE
      WHEN NEW.provenance_id = NEW.transition_provenance_id THEN 1 ELSE 2
    END
  ) THEN
    RAISE EXCEPTION 'worker host provenance does not match the host';
  END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF OLD.host_identifier <> NEW.host_identifier
     OR OLD.host_kind <> NEW.host_kind
     OR OLD.provenance_id <> NEW.provenance_id THEN
    RAISE EXCEPTION 'worker host identity is immutable';
  END IF;
  IF NEW.heartbeat_at < OLD.heartbeat_at THEN
    RAISE EXCEPTION 'worker host heartbeat cannot move backward';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER worker_hosts_validate_update
BEFORE INSERT OR UPDATE OR DELETE ON acp.worker_hosts
FOR EACH ROW EXECUTE FUNCTION acp.validate_worker_host_update();
