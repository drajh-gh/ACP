-- Transaction ownership belongs to the migration runner.

ALTER TABLE acp.project_profiles
  ADD CONSTRAINT project_profiles_project_identity_unique
  UNIQUE (project_id, profile_id, version);

ALTER TABLE acp.project_workflow_bindings
  ADD CONSTRAINT project_workflow_bindings_profile_project_fk
  FOREIGN KEY (project_id, profile_id, profile_version)
  REFERENCES acp.project_profiles (project_id, profile_id, version),
  ADD CONSTRAINT project_workflow_bindings_scope_unique
  UNIQUE (
    project_id,
    binding_id,
    workflow_id,
    workflow_version,
    completion_contract_id,
    completion_contract_version
  ),
  ADD CONSTRAINT project_workflow_bindings_runtime_tuple_unique
  UNIQUE (
    binding_id,
    workflow_id,
    workflow_version,
    profile_id,
    profile_version,
    completion_contract_id,
    completion_contract_version,
    policy_id,
    policy_version
  );

ALTER TABLE acp.missions
  ADD CONSTRAINT missions_mission_project_unique
  UNIQUE (mission_id, project_id),
  ADD CONSTRAINT missions_workflow_execution_scope_unique
  UNIQUE (mission_id, workflow_id, workflow_version, workflow_binding_id),
  ADD CONSTRAINT missions_binding_scope_fk
  FOREIGN KEY (
    project_id,
    workflow_binding_id,
    workflow_id,
    workflow_version,
    completion_contract_id,
    completion_contract_version
  ) REFERENCES acp.project_workflow_bindings (
    project_id,
    binding_id,
    workflow_id,
    workflow_version,
    completion_contract_id,
    completion_contract_version
  );

ALTER TABLE acp.effect_proposals
  ADD CONSTRAINT effect_proposals_mission_project_fk
  FOREIGN KEY (mission_id, project_id)
  REFERENCES acp.missions (mission_id, project_id);

ALTER TABLE acp.effect_proposals
  ADD COLUMN transition_provenance_id acp.stable_id,
  ADD COLUMN execution_precondition_evaluation_id acp.stable_id,
  ADD COLUMN verification_receipt_id acp.stable_id;

UPDATE acp.effect_proposals
SET transition_provenance_id = provenance_id;

ALTER TABLE acp.effect_proposals
  ALTER COLUMN transition_provenance_id SET NOT NULL,
  ADD CONSTRAINT effect_proposals_transition_provenance_fk
    FOREIGN KEY (transition_provenance_id)
    REFERENCES acp.runtime_provenance (provenance_id),
  ADD CONSTRAINT effect_proposals_verification_receipt_fk
    FOREIGN KEY (verification_receipt_id, effect_id)
    REFERENCES acp.effect_receipts (receipt_id, effect_id);

ALTER TABLE acp.approval_envelopes
  ADD CONSTRAINT approval_envelopes_mission_project_fk
  FOREIGN KEY (mission_id, project_id)
  REFERENCES acp.missions (mission_id, project_id);

ALTER TABLE acp.runtime_provenance
  ADD CONSTRAINT runtime_provenance_binding_tuple_fk
    FOREIGN KEY (
      workflow_binding_id,
      workflow_id,
      workflow_version,
      project_profile_id,
      project_profile_version,
      completion_contract_id,
      completion_contract_version,
      policy_id,
      policy_version
    ) REFERENCES acp.project_workflow_bindings (
      binding_id,
      workflow_id,
      workflow_version,
      profile_id,
      profile_version,
      completion_contract_id,
      completion_contract_version,
      policy_id,
      policy_version
    );

CREATE FUNCTION acp.runtime_provenance_matches_context(
  p_provenance_id acp.stable_id,
  p_mission_id acp.stable_id,
  p_adapter_key text DEFAULT NULL,
  p_adapter_version text DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM acp.runtime_provenance AS provenance
    JOIN acp.missions AS mission
      ON mission.mission_id = p_mission_id
    JOIN acp.project_workflow_bindings AS binding
      ON binding.binding_id = mission.workflow_binding_id
     AND binding.project_id = mission.project_id
    LEFT JOIN acp.adapter_definitions AS adapter
      ON adapter.adapter_id = provenance.adapter_id
     AND adapter.version = provenance.adapter_version
    WHERE provenance.provenance_id = p_provenance_id
      AND provenance.workflow_binding_id = mission.workflow_binding_id
      AND provenance.workflow_id = mission.workflow_id
      AND provenance.workflow_version = mission.workflow_version
      AND provenance.project_profile_id = binding.profile_id
      AND provenance.project_profile_version = binding.profile_version
      AND provenance.policy_id = binding.policy_id
      AND provenance.policy_version = binding.policy_version
      AND provenance.completion_contract_id = mission.completion_contract_id
      AND provenance.completion_contract_version = mission.completion_contract_version
      AND (
        (p_adapter_key IS NULL AND p_adapter_version IS NULL)
        OR (
          p_adapter_key IS NOT NULL
          AND p_adapter_version IS NOT NULL
          AND adapter.adapter_key = p_adapter_key
          AND provenance.adapter_version = p_adapter_version
        )
      )
  );
$$;

-- Rows whose 0001 representation cannot prove the stronger 0002 authority or
-- recovery invariants must be reconciled explicitly before this migration.
-- The migration never upgrades ambiguous lifecycle state into trusted state.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM acp.missions WHERE state = 'complete_for_scope') THEN
    RAISE EXCEPTION
      '0002 preflight requires complete missions to be reopened and re-evaluated';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM acp.missions
    WHERE state IN (
      'planning', 'awaiting_approval', 'executing', 'verifying',
      'awaiting_external'
    )
  ) THEN
    RAISE EXCEPTION
      '0002 preflight requires active legacy missions to be reset or reconciled';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM acp.missions AS mission
    WHERE NOT EXISTS (
      SELECT 1
      FROM acp.runtime_provenance AS provenance
      WHERE provenance.workflow_binding_id = mission.workflow_binding_id
        AND provenance.workflow_id = mission.workflow_id
        AND provenance.workflow_version = mission.workflow_version
        AND provenance.completion_contract_id = mission.completion_contract_id
        AND provenance.completion_contract_version =
              mission.completion_contract_version
    )
  ) THEN
    RAISE EXCEPTION
      '0002 preflight requires context-matching mission provenance';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM acp.completion_evaluations AS evaluation
    JOIN acp.missions AS mission
      ON mission.mission_id = evaluation.mission_id
    WHERE evaluation.contract_id <> mission.completion_contract_id
       OR evaluation.contract_version <> mission.completion_contract_version
       OR evaluation.evaluated_at < mission.created_at
       OR evaluation.evaluated_at > statement_timestamp()
       OR NOT acp.runtime_provenance_matches_context(
         evaluation.provenance_id,
         evaluation.mission_id
       )
  ) THEN
    RAISE EXCEPTION
      '0002 preflight requires context-bound and chronologically valid completion evaluations';
  END IF;
  IF EXISTS (
    SELECT 1 FROM acp.effect_proposals
    WHERE state NOT IN ('proposed', 'previewed', 'failed', 'rolled_back', 'invalidated')
       OR NOT acp.runtime_provenance_matches_context(
         provenance_id, mission_id, adapter_id, adapter_version
       )
  ) THEN
    RAISE EXCEPTION
      '0002 preflight requires active or context-unbound effects to be reconciled';
  END IF;
  IF EXISTS (SELECT 1 FROM acp.effect_receipts)
     OR EXISTS (SELECT 1 FROM acp.effect_approval_evaluations)
     OR EXISTS (SELECT 1 FROM acp.precondition_snapshots)
     OR EXISTS (SELECT 1 FROM acp.approval_envelopes) THEN
    RAISE EXCEPTION
      '0002 preflight requires legacy effect authority and receipts to be reconciled';
  END IF;
  IF EXISTS (SELECT 1 FROM acp.resource_leases) THEN
    RAISE EXCEPTION
      '0002 preflight requires legacy leases to be drained and reconciled';
  END IF;
  IF EXISTS (
    SELECT 1 FROM acp.candidate_records
    WHERE jsonb_array_length(evidence_ids) = 0
  ) THEN
    RAISE EXCEPTION '0002 preflight requires candidate evidence';
  END IF;
  IF EXISTS (
    SELECT 1 FROM acp.acceptance_records
    WHERE (state = 'passed' AND jsonb_array_length(evidence_ids) = 0)
       OR (state = 'waived' AND (
         candidate_revision IS NULL
         OR waiver IS NULL
         OR nullif(btrim(waiver ->> 'authority'), '') IS NULL
         OR nullif(btrim(waiver ->> 'reason'), '') IS NULL
         OR nullif(btrim(waiver ->> 'scope'), '') IS NULL
         OR nullif(btrim(waiver ->> 'waivedAt'), '') IS NULL
         OR waiver ->> 'candidateRevision' IS DISTINCT FROM candidate_revision
       ))
  ) THEN
    RAISE EXCEPTION '0002 preflight requires auditable acceptance evidence';
  END IF;
END;
$$;

ALTER TABLE acp.effect_approval_evaluations
  DROP CONSTRAINT effect_approval_evaluations_pkey,
  ADD COLUMN approval_evaluation_id acp.stable_id NOT NULL,
  ADD COLUMN recorded_order bigint GENERATED ALWAYS AS IDENTITY,
  ADD CONSTRAINT effect_approval_evaluations_pkey
    PRIMARY KEY (approval_evaluation_id),
  ADD CONSTRAINT effect_approval_evaluations_identity_scope_unique
    UNIQUE (approval_evaluation_id, effect_id, approval_id),
  ADD CONSTRAINT effect_approval_evaluations_recorded_order_unique
    UNIQUE (recorded_order),
  ADD CONSTRAINT effect_approval_evaluations_id_prefix
    CHECK (left(approval_evaluation_id::text, 4) = 'ape_');

ALTER TABLE acp.missions
  ADD COLUMN transition_provenance_id acp.stable_id;

UPDATE acp.missions AS mission
SET transition_provenance_id = (
  SELECT provenance.provenance_id
  FROM acp.runtime_provenance AS provenance
  WHERE provenance.workflow_binding_id = mission.workflow_binding_id
    AND provenance.workflow_id = mission.workflow_id
    AND provenance.workflow_version = mission.workflow_version
    AND provenance.completion_contract_id = mission.completion_contract_id
    AND provenance.completion_contract_version = mission.completion_contract_version
  ORDER BY provenance.recorded_at DESC, provenance.provenance_id
  LIMIT 1
);

ALTER TABLE acp.missions
  ALTER COLUMN transition_provenance_id SET NOT NULL,
  ADD CONSTRAINT missions_transition_provenance_fk
    FOREIGN KEY (transition_provenance_id)
    REFERENCES acp.runtime_provenance (provenance_id);

CREATE FUNCTION acp.acquire_effect_authority_lock()
RETURNS void
LANGUAGE sql
VOLATILE
AS $$
  SELECT pg_catalog.pg_advisory_xact_lock(1094929713, 1162237008);
$$;

CREATE FUNCTION acp.require_effect_authority_lock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_locks
    WHERE locktype = 'advisory'
      AND pid = pg_catalog.pg_backend_pid()
      AND classid = 1094929713::oid
      AND objid = 1162237008::oid
      AND objsubid = 2
      AND mode = 'ExclusiveLock'
      AND granted
  ) THEN
    RAISE EXCEPTION
      'effect authority mutation requires the transaction authority lock';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE acp.runtime_control_authorizations (
  authorization_id acp.stable_id PRIMARY KEY,
  scope_type text NOT NULL CHECK (scope_type IN ('global', 'project')),
  scope_id text NOT NULL,
  action text NOT NULL CHECK (action = 'unpause_effects'),
  authorized_by text NOT NULL CHECK (length(btrim(authorized_by)) > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  valid_from timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (left(authorization_id::text, 4) = 'rca_'),
  CHECK (
    (scope_type = 'global' AND scope_id = 'global')
    OR (scope_type = 'project' AND left(scope_id, 4) = 'prj_')
  ),
  CHECK (expires_at > valid_from)
);

CREATE TRIGGER runtime_control_authorizations_are_immutable
BEFORE UPDATE OR DELETE ON acp.runtime_control_authorizations
FOR EACH ROW EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE FUNCTION acp.validate_runtime_control_scope_provenance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.scope_type = 'project' AND NOT EXISTS (
    SELECT 1
    FROM acp.runtime_provenance AS provenance
    JOIN acp.project_workflow_bindings AS binding
      ON binding.binding_id = provenance.workflow_binding_id
    WHERE provenance.provenance_id = NEW.provenance_id
      AND binding.project_id::text = NEW.scope_id
  ) THEN
    RAISE EXCEPTION
      'project runtime control provenance must belong to the scoped project';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER runtime_control_authorizations_validate_scope_provenance
BEFORE INSERT ON acp.runtime_control_authorizations
FOR EACH ROW EXECUTE FUNCTION acp.validate_runtime_control_scope_provenance();

ALTER TABLE acp.runtime_controls
  ADD COLUMN authorization_id acp.stable_id,
  ADD COLUMN last_control_event_id acp.stable_id,
  ADD CONSTRAINT runtime_controls_unpause_requires_authorization
  CHECK (
    effects_paused
    OR authorization_id IS NOT NULL
  ),
  ADD CONSTRAINT runtime_controls_authorization_fk
    FOREIGN KEY (authorization_id)
    REFERENCES acp.runtime_control_authorizations (authorization_id);

CREATE TABLE acp.runtime_control_events (
  control_event_id acp.stable_id PRIMARY KEY,
  scope_type text NOT NULL CHECK (scope_type IN ('global', 'project')),
  scope_id text NOT NULL,
  previous_effects_paused boolean,
  effects_paused boolean NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  updated_by text NOT NULL CHECK (length(btrim(updated_by)) > 0),
  authorization_id acp.stable_id
    REFERENCES acp.runtime_control_authorizations (authorization_id),
  occurred_at timestamptz NOT NULL,
  provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id),
  CHECK (left(control_event_id::text, 4) = 'rce_'),
  CHECK (
    (scope_type = 'global' AND scope_id = 'global')
    OR (scope_type = 'project' AND left(scope_id, 4) = 'prj_')
  ),
  CHECK (
    effects_paused
    OR authorization_id IS NOT NULL
  )
);

CREATE UNIQUE INDEX runtime_control_events_one_authorization_use
ON acp.runtime_control_events (authorization_id)
WHERE authorization_id IS NOT NULL;

CREATE FUNCTION acp.validate_runtime_control_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.occurred_at > statement_timestamp() THEN
    RAISE EXCEPTION 'runtime control event cannot be future-dated';
  END IF;
  IF NEW.effects_paused AND NEW.authorization_id IS NOT NULL THEN
    RAISE EXCEPTION 'pausing effects must not consume an unpause authorization';
  END IF;
  IF NOT NEW.effects_paused AND NOT EXISTS (
    SELECT 1
    FROM acp.runtime_control_authorizations AS auth
    WHERE auth.authorization_id = NEW.authorization_id
      AND auth.scope_type = NEW.scope_type
      AND auth.scope_id = NEW.scope_id
      AND auth.action = 'unpause_effects'
      AND auth.valid_from <= NEW.occurred_at
      AND auth.expires_at > NEW.occurred_at
      AND auth.valid_from <= statement_timestamp()
      AND auth.expires_at > statement_timestamp()
  ) THEN
    RAISE EXCEPTION 'unpausing effects requires a current exact-scope authorization';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER runtime_control_events_validate_authorization
BEFORE INSERT ON acp.runtime_control_events
FOR EACH ROW EXECUTE FUNCTION acp.validate_runtime_control_event();

CREATE TRIGGER runtime_control_events_validate_scope_provenance
BEFORE INSERT ON acp.runtime_control_events
FOR EACH ROW EXECUTE FUNCTION acp.validate_runtime_control_scope_provenance();

CREATE TRIGGER runtime_control_authorizations_require_authority_lock
BEFORE INSERT OR UPDATE OR DELETE ON acp.runtime_control_authorizations
FOR EACH ROW EXECUTE FUNCTION acp.require_effect_authority_lock();

CREATE TRIGGER runtime_control_events_require_authority_lock
BEFORE INSERT OR UPDATE OR DELETE ON acp.runtime_control_events
FOR EACH ROW EXECUTE FUNCTION acp.require_effect_authority_lock();

CREATE TRIGGER runtime_controls_require_authority_lock
BEFORE INSERT OR UPDATE OR DELETE ON acp.runtime_controls
FOR EACH ROW EXECUTE FUNCTION acp.require_effect_authority_lock();

CREATE TRIGGER approval_envelopes_require_authority_lock
BEFORE INSERT OR UPDATE OR DELETE ON acp.approval_envelopes
FOR EACH ROW EXECUTE FUNCTION acp.require_effect_authority_lock();

CREATE TRIGGER effect_approval_evaluations_require_authority_lock
BEFORE INSERT OR UPDATE OR DELETE ON acp.effect_approval_evaluations
FOR EACH ROW EXECUTE FUNCTION acp.require_effect_authority_lock();

CREATE TRIGGER resource_leases_require_authority_lock
BEFORE INSERT OR UPDATE OR DELETE ON acp.resource_leases
FOR EACH ROW EXECUTE FUNCTION acp.require_effect_authority_lock();

CREATE TRIGGER runtime_control_events_are_immutable
BEFORE UPDATE OR DELETE ON acp.runtime_control_events
FOR EACH ROW EXECUTE FUNCTION acp.reject_immutable_mutation();

ALTER TABLE acp.runtime_controls
  ADD CONSTRAINT runtime_controls_last_event_fk
  FOREIGN KEY (last_control_event_id)
  REFERENCES acp.runtime_control_events (control_event_id);

CREATE FUNCTION acp.authorize_runtime_control_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  authorized_event_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'runtime_controls cannot be deleted';
  END IF;

  authorized_event_id := nullif(
    current_setting('acp.runtime_control_event_id', true),
    ''
  );
  IF authorized_event_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM acp.runtime_control_events AS event
    WHERE event.control_event_id::text = authorized_event_id
      AND event.scope_type = NEW.scope_type
      AND event.scope_id = NEW.scope_id
      AND event.previous_effects_paused IS NOT DISTINCT FROM
        CASE WHEN TG_OP = 'UPDATE' THEN OLD.effects_paused ELSE NULL END
      AND event.effects_paused = NEW.effects_paused
      AND event.reason = NEW.reason
      AND event.updated_by = NEW.updated_by
      AND event.authorization_id IS NOT DISTINCT FROM NEW.authorization_id
      AND event.occurred_at = NEW.updated_at
  ) THEN
    RAISE EXCEPTION
      'runtime control mutation requires its matching append-only control event';
  END IF;
  IF NOT NEW.effects_paused AND NOT EXISTS (
    SELECT 1
    FROM acp.runtime_control_events AS event
    JOIN acp.runtime_control_authorizations AS auth
      ON auth.authorization_id = event.authorization_id
     AND auth.scope_type = event.scope_type
     AND auth.scope_id = event.scope_id
     AND auth.action = 'unpause_effects'
    WHERE event.control_event_id::text = authorized_event_id
      AND auth.valid_from <= statement_timestamp()
      AND auth.expires_at > statement_timestamp()
  ) THEN
    RAISE EXCEPTION
      'runtime control projection requires a currently valid unpause authorization';
  END IF;
  IF NEW.last_control_event_id::text IS DISTINCT FROM authorized_event_id
     OR (TG_OP = 'UPDATE'
         AND NEW.last_control_event_id IS NOT DISTINCT FROM OLD.last_control_event_id) THEN
    RAISE EXCEPTION 'runtime control mutation requires a fresh control event';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'runtime control events must advance monotonically';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER runtime_controls_require_audit_event
BEFORE INSERT OR UPDATE OR DELETE ON acp.runtime_controls
FOR EACH ROW EXECUTE FUNCTION acp.authorize_runtime_control_mutation();

CREATE TABLE acp.intake_dispositions (
  disposition_claim_id acp.stable_id PRIMARY KEY,
  intake_id acp.stable_id NOT NULL REFERENCES acp.intake_records (intake_id),
  project_id acp.stable_id REFERENCES acp.projects (project_id),
  disposition text NOT NULL CHECK (
    disposition IN (
      'verified_or_likely_defect', 'feature_or_change_request',
      'support_or_usage_question', 'incident', 'duplicate_or_continuation',
      'already_resolved', 'not_warranted_or_out_of_scope',
      'insufficient_evidence', 'wrong_project_or_source',
      'requires_business_decision'
    )
  ),
  confidence double precision NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  evidence_ids jsonb NOT NULL CHECK (
    jsonb_typeof(evidence_ids) = 'array' AND jsonb_array_length(evidence_ids) > 0
  ),
  provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id),
  unresolved_reason text,
  classified_at timestamptz NOT NULL,
  CHECK (left(disposition_claim_id::text, 4) = 'clm_'),
  CHECK (
    disposition NOT IN (
      'insufficient_evidence', 'wrong_project_or_source',
      'requires_business_decision'
    )
    OR (
      unresolved_reason IS NOT NULL
      AND length(btrim(unresolved_reason)) > 0
    )
  )
);

CREATE TRIGGER intake_dispositions_are_immutable
BEFORE UPDATE OR DELETE ON acp.intake_dispositions
FOR EACH ROW EXECUTE FUNCTION acp.reject_immutable_mutation();

ALTER TABLE acp.completion_evaluations
  ADD COLUMN required_receipts_verified boolean,
  ADD COLUMN evidence_freshness_verified boolean,
  ADD COLUMN lifecycle_digest text;

-- Legacy evaluations did not assert these facts. Preserve the rows while
-- backfilling an explicit fail-closed state rather than inventing success.
UPDATE acp.completion_evaluations
SET required_receipts_verified = false,
    evidence_freshness_verified = false,
    lifecycle_digest = 'legacy-unverified:' || evaluation_id::text
WHERE required_receipts_verified IS NULL
   OR evidence_freshness_verified IS NULL
   OR lifecycle_digest IS NULL;

ALTER TABLE acp.completion_evaluations
  ALTER COLUMN required_receipts_verified SET NOT NULL,
  ALTER COLUMN evidence_freshness_verified SET NOT NULL,
  ALTER COLUMN lifecycle_digest SET NOT NULL,
  ADD CONSTRAINT completion_evaluations_lifecycle_digest_nonblank
    CHECK (length(btrim(lifecycle_digest)) > 0);

CREATE FUNCTION acp.validate_completion_evaluation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  mission_record acp.missions%ROWTYPE;
BEGIN
  SELECT * INTO mission_record
  FROM acp.missions
  WHERE mission_id = NEW.mission_id;

  IF mission_record.mission_id IS NULL THEN
    RAISE EXCEPTION 'completion evaluation requires an existing mission';
  END IF;
  IF NEW.contract_id <> mission_record.completion_contract_id
     OR NEW.contract_version <> mission_record.completion_contract_version THEN
    RAISE EXCEPTION 'completion evaluation must use the mission pinned contract';
  END IF;
  IF NEW.evaluated_at < mission_record.created_at
     OR NEW.evaluated_at > statement_timestamp() THEN
    RAISE EXCEPTION 'completion evaluation time must be within the mission lifecycle';
  END IF;
  IF NOT acp.runtime_provenance_matches_context(
    NEW.provenance_id,
    NEW.mission_id
  ) THEN
    RAISE EXCEPTION 'completion evaluation provenance does not match mission context';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER completion_evaluations_validate
BEFORE INSERT ON acp.completion_evaluations
FOR EACH ROW EXECUTE FUNCTION acp.validate_completion_evaluation();

CREATE FUNCTION acp.validate_completed_mission()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state = 'complete_for_scope' AND NOT EXISTS (
    SELECT 1
    FROM acp.completion_evaluations AS evaluation
    WHERE evaluation.evaluation_id = NEW.completed_by_evaluation_id
      AND evaluation.mission_id = NEW.mission_id
      AND evaluation.contract_id = NEW.completion_contract_id
      AND evaluation.contract_version = NEW.completion_contract_version
      AND evaluation.status = 'passed'
      AND jsonb_array_length(evaluation.disqualifiers) = 0
      AND evaluation.required_receipts_verified
      AND evaluation.evidence_freshness_verified
  ) THEN
    RAISE EXCEPTION
      'mission % requires a passing evaluation for its pinned completion contract',
      NEW.mission_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER missions_require_matching_completion
AFTER INSERT OR UPDATE OF
  state,
  completed_by_evaluation_id,
  completion_contract_id,
  completion_contract_version
ON acp.missions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION acp.validate_completed_mission();

CREATE FUNCTION acp.validate_initial_mission_provenance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM acp.runtime_provenance AS provenance
    JOIN acp.project_workflow_bindings AS binding
      ON binding.binding_id = NEW.workflow_binding_id
     AND binding.project_id = NEW.project_id
    WHERE provenance.provenance_id = NEW.transition_provenance_id
      AND provenance.workflow_binding_id = NEW.workflow_binding_id
      AND provenance.workflow_id = NEW.workflow_id
      AND provenance.workflow_version = NEW.workflow_version
      AND provenance.project_profile_id = binding.profile_id
      AND provenance.project_profile_version = binding.profile_version
      AND provenance.policy_id = binding.policy_id
      AND provenance.policy_version = binding.policy_version
      AND provenance.completion_contract_id = NEW.completion_contract_id
      AND provenance.completion_contract_version =
            NEW.completion_contract_version
  ) THEN
    RAISE EXCEPTION 'initial mission provenance does not match mission context';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER missions_validate_initial_provenance
BEFORE INSERT ON acp.missions
FOR EACH ROW EXECUTE FUNCTION acp.validate_initial_mission_provenance();

CREATE FUNCTION acp.protect_mission_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'missions cannot be deleted';
  END IF;
  IF (to_jsonb(NEW) - 'state' - 'completed_by_evaluation_id' - 'updated_at'
       - 'transition_provenance_id')
      IS DISTINCT FROM
     (to_jsonb(OLD) - 'state' - 'completed_by_evaluation_id' - 'updated_at'
       - 'transition_provenance_id') THEN
    RAISE EXCEPTION 'mission identity and requested scope are immutable';
  END IF;
  IF OLD.state = NEW.state
     AND NEW.transition_provenance_id IS DISTINCT FROM
       OLD.transition_provenance_id THEN
    RAISE EXCEPTION 'mission transition provenance can change only with state';
  END IF;
  IF NEW.completed_by_evaluation_id IS DISTINCT FROM
       OLD.completed_by_evaluation_id
     AND NOT (
       OLD.state <> 'complete_for_scope'
       AND NEW.state = 'complete_for_scope'
       AND OLD.completed_by_evaluation_id IS NULL
       AND NEW.completed_by_evaluation_id IS NOT NULL
     ) THEN
    RAISE EXCEPTION
      'mission completion evaluation can be attached only on scoped completion';
  END IF;
  IF OLD.state <> NEW.state AND NOT acp.runtime_provenance_matches_context(
    NEW.transition_provenance_id,
    NEW.mission_id
  ) THEN
    RAISE EXCEPTION 'mission transition provenance does not match mission context';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER missions_protect_identity
BEFORE UPDATE OR DELETE ON acp.missions
FOR EACH ROW EXECUTE FUNCTION acp.protect_mission_identity();

CREATE FUNCTION acp.enforce_mission_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  allowed text[];
BEGIN
  IF OLD.state = NEW.state THEN
    RETURN NEW;
  END IF;
  allowed := CASE OLD.state
    WHEN 'received' THEN ARRAY['triaging', 'cancelled', 'failed']
    WHEN 'triaging' THEN ARRAY['needs_input', 'ready', 'cancelled', 'failed']
    WHEN 'needs_input' THEN ARRAY['triaging', 'planning', 'cancelled', 'failed']
    WHEN 'ready' THEN ARRAY['planning', 'executing', 'cancelled', 'failed']
    WHEN 'planning' THEN ARRAY['needs_input', 'awaiting_approval', 'executing', 'cancelled', 'failed']
    WHEN 'awaiting_approval' THEN ARRAY['executing', 'needs_input', 'cancelled', 'failed']
    WHEN 'executing' THEN ARRAY[
      'awaiting_approval', 'verifying', 'needs_input', 'awaiting_external',
      'cancelled', 'failed'
    ]
    WHEN 'verifying' THEN ARRAY[
      'executing', 'needs_input', 'awaiting_external', 'complete_for_scope',
      'cancelled', 'failed'
    ]
    WHEN 'awaiting_external' THEN ARRAY[
      'executing', 'verifying', 'needs_input', 'cancelled', 'failed'
    ]
    ELSE ARRAY[]::text[]
  END;
  IF NOT NEW.state = ANY(allowed) THEN
    RAISE EXCEPTION 'illegal mission transition: % -> %', OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER missions_enforce_state_transition
BEFORE UPDATE OF state ON acp.missions
FOR EACH ROW EXECUTE FUNCTION acp.enforce_mission_transition();

ALTER TABLE acp.resource_leases
  ADD CONSTRAINT resource_leases_id_token_unique
  UNIQUE (lease_id, fencing_token);

CREATE TABLE acp.execution_precondition_evaluations (
  execution_precondition_evaluation_id acp.stable_id PRIMARY KEY,
  effect_id acp.stable_id NOT NULL REFERENCES acp.effect_proposals (effect_id),
  approval_id acp.stable_id NOT NULL REFERENCES acp.approval_envelopes (approval_id),
  approval_evaluation_id acp.stable_id NOT NULL,
  lease_id acp.stable_id NOT NULL,
  fencing_token bigint NOT NULL,
  proposal_digest text NOT NULL CHECK (length(btrim(proposal_digest)) > 0),
  payload_digest text NOT NULL CHECK (length(btrim(payload_digest)) > 0),
  observed_target_digest text NOT NULL CHECK (length(btrim(observed_target_digest)) > 0),
  precondition_results jsonb NOT NULL CHECK (jsonb_typeof(precondition_results) = 'array'),
  result text NOT NULL CHECK (result IN ('passed', 'failed')),
  evaluated_at timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id),
  CHECK (left(execution_precondition_evaluation_id::text, 4) = 'epe_'),
  CHECK (valid_until > evaluated_at),
  FOREIGN KEY (lease_id, fencing_token)
    REFERENCES acp.resource_leases (lease_id, fencing_token),
  FOREIGN KEY (approval_evaluation_id, effect_id, approval_id)
    REFERENCES acp.effect_approval_evaluations (
      approval_evaluation_id,
      effect_id,
      approval_id
    ),
  UNIQUE (execution_precondition_evaluation_id, effect_id)
);

ALTER TABLE acp.effect_proposals
  ADD CONSTRAINT effect_proposals_execution_precondition_fk
  FOREIGN KEY (execution_precondition_evaluation_id, effect_id)
  REFERENCES acp.execution_precondition_evaluations (
    execution_precondition_evaluation_id,
    effect_id
  );

CREATE FUNCTION acp.validate_execution_precondition_evaluation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  effect_record acp.effect_proposals%ROWTYPE;
  approval_record acp.approval_envelopes%ROWTYPE;
  lease_record acp.resource_leases%ROWTYPE;
BEGIN
  SELECT * INTO effect_record
    FROM acp.effect_proposals WHERE effect_id = NEW.effect_id;
  SELECT * INTO approval_record
    FROM acp.approval_envelopes WHERE approval_id = NEW.approval_id;
  SELECT * INTO lease_record
    FROM acp.resource_leases WHERE lease_id = NEW.lease_id;

  IF effect_record.effect_id IS NULL
     OR approval_record.approval_id IS NULL
     OR lease_record.lease_id IS NULL THEN
    RAISE EXCEPTION
      'execution precondition evaluation requires persisted effect, approval, and lease';
  END IF;
  IF NEW.evaluated_at > statement_timestamp() THEN
    RAISE EXCEPTION 'execution precondition evaluation cannot be future-dated';
  END IF;
  IF NEW.proposal_digest <> effect_record.proposal_digest
     OR NEW.payload_digest <> effect_record.payload_digest THEN
    RAISE EXCEPTION 'execution precondition evaluation does not bind current effect digests';
  END IF;
  IF effect_record.state <> 'revalidating' THEN
    RAISE EXCEPTION 'execution precondition evaluation requires a revalidating effect';
  END IF;
  IF lease_record.lease_key <> 'effect:' || effect_record.effect_id::text
     OR lease_record.mission_id <> effect_record.mission_id
     OR lease_record.fencing_token <> NEW.fencing_token
     OR lease_record.state NOT IN ('active', 'recovering')
     OR lease_record.acquired_at > NEW.evaluated_at
     OR lease_record.expires_at <= NEW.evaluated_at
     OR NEW.valid_until > lease_record.expires_at THEN
    RAISE EXCEPTION 'execution precondition evaluation lacks its exact current fenced lease';
  END IF;
  IF approval_record.project_id <> effect_record.project_id
     OR (approval_record.mission_id IS NOT NULL
         AND approval_record.mission_id <> effect_record.mission_id)
     OR approval_record.valid_from > NEW.evaluated_at
     OR approval_record.expires_at <= NEW.evaluated_at
     OR NEW.valid_until > approval_record.expires_at
     OR approval_record.revoked_at IS NOT NULL
     OR NOT EXISTS (
        SELECT 1
        FROM acp.effect_approval_evaluations AS evaluation
        WHERE evaluation.approval_evaluation_id = NEW.approval_evaluation_id
          AND evaluation.effect_id = NEW.effect_id
          AND evaluation.approval_id = NEW.approval_id
          AND evaluation.result = 'covered'
          AND evaluation.evaluated_at <= NEW.evaluated_at
         AND NOT EXISTS (
           SELECT 1
            FROM acp.effect_approval_evaluations AS newer_evaluation
            WHERE newer_evaluation.effect_id = evaluation.effect_id
              AND newer_evaluation.approval_id = evaluation.approval_id
              AND (
                newer_evaluation.evaluated_at > evaluation.evaluated_at
                OR (
                  newer_evaluation.evaluated_at = evaluation.evaluated_at
                  AND newer_evaluation.recorded_order > evaluation.recorded_order
                )
              )
              AND newer_evaluation.evaluated_at <= NEW.evaluated_at
         )
     ) THEN
    RAISE EXCEPTION 'execution precondition evaluation lacks a current covered approval';
  END IF;

  IF NEW.result = 'passed' AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(effect_record.required_preconditions) AS requirement
    WHERE nullif(btrim(requirement ->> 'sourceRef'), '') IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM jsonb_array_elements(NEW.precondition_results) AS observed
         JOIN acp.precondition_snapshots AS snapshot
         ON snapshot.snapshot_id::text = observed ->> 'approvedSnapshotId'
         AND snapshot.effect_id = effect_record.effect_id
         AND snapshot.source_ref = requirement ->> 'sourceRef'
         AND snapshot.snapshot = requirement -> 'expected'
         AND snapshot.captured_at <= NEW.evaluated_at
         WHERE jsonb_typeof(observed) = 'object'
           AND approval_record.precondition_snapshot_ids ? snapshot.snapshot_id::text
           AND observed ->> 'approvedDigest' = snapshot.digest
           AND observed ->> 'observedDigest' = snapshot.digest
           AND observed -> 'matched' = 'true'::jsonb
       )
  ) THEN
    RAISE EXCEPTION
      'passing execution precondition evaluation lacks exact current observations';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER execution_precondition_evaluations_validate
BEFORE INSERT ON acp.execution_precondition_evaluations
FOR EACH ROW EXECUTE FUNCTION acp.validate_execution_precondition_evaluation();

CREATE TRIGGER execution_precondition_evaluations_are_immutable
BEFORE UPDATE OR DELETE ON acp.execution_precondition_evaluations
FOR EACH ROW EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE TRIGGER execution_precondition_evaluations_require_authority_lock
BEFORE INSERT OR UPDATE OR DELETE ON acp.execution_precondition_evaluations
FOR EACH ROW EXECUTE FUNCTION acp.require_effect_authority_lock();

CREATE FUNCTION acp.validate_initial_effect_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state <> 'proposed'
     OR NEW.execution_fencing_token IS NOT NULL
     OR NEW.execution_precondition_evaluation_id IS NOT NULL
     OR NEW.verification_receipt_id IS NOT NULL THEN
    RAISE EXCEPTION 'effect proposals must begin in proposed state without execution authority';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW.required_preconditions) AS requirement
    WHERE jsonb_typeof(requirement) <> 'object'
       OR nullif(btrim(requirement ->> 'sourceRef'), '') IS NULL
       OR NOT (requirement ? 'expected')
  ) THEN
    RAISE EXCEPTION 'effect preconditions require sourceRef and expected value';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW.verification_plan) AS step
    WHERE jsonb_typeof(step) <> 'object'
       OR nullif(btrim(step ->> 'type'), '') IS NULL
       OR NOT (step ? 'expected')
  ) THEN
    RAISE EXCEPTION 'effect verification plan requires typed expected values';
  END IF;
  IF NEW.transition_provenance_id <> NEW.provenance_id THEN
    RAISE EXCEPTION 'initial effect transition provenance must equal creation provenance';
  END IF;
  IF NOT acp.runtime_provenance_matches_context(
    NEW.provenance_id,
    NEW.mission_id,
    NEW.adapter_id,
    NEW.adapter_version
  ) THEN
    RAISE EXCEPTION 'effect creation provenance does not match mission and adapter context';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER effect_proposals_validate_initial_state
BEFORE INSERT ON acp.effect_proposals
FOR EACH ROW EXECUTE FUNCTION acp.validate_initial_effect_state();

CREATE FUNCTION acp.protect_effect_proposal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'effect_proposals is append-only';
  END IF;
  IF (to_jsonb(NEW) - 'state' - 'updated_at' - 'execution_fencing_token'
       - 'execution_precondition_evaluation_id' - 'verification_receipt_id'
       - 'transition_provenance_id')
      IS DISTINCT FROM
     (to_jsonb(OLD) - 'state' - 'updated_at' - 'execution_fencing_token'
       - 'execution_precondition_evaluation_id' - 'verification_receipt_id'
       - 'transition_provenance_id') THEN
    RAISE EXCEPTION 'effect proposal content is immutable';
  END IF;
  IF OLD.state = NEW.state AND (
    NEW.execution_fencing_token IS DISTINCT FROM OLD.execution_fencing_token
    OR NEW.execution_precondition_evaluation_id
       IS DISTINCT FROM OLD.execution_precondition_evaluation_id
    OR NEW.verification_receipt_id IS DISTINCT FROM OLD.verification_receipt_id
    OR NEW.transition_provenance_id IS DISTINCT FROM OLD.transition_provenance_id
  ) THEN
    RAISE EXCEPTION 'effect transition authority can change only with state';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER effect_proposals_protect_content
BEFORE UPDATE OR DELETE ON acp.effect_proposals
FOR EACH ROW EXECUTE FUNCTION acp.protect_effect_proposal();

CREATE FUNCTION acp.enforce_effect_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  allowed text[];
  reconciliation_outcome text;
BEGIN
  IF OLD.state = NEW.state THEN
    RETURN NEW;
  END IF;
  IF NOT acp.runtime_provenance_matches_context(
    NEW.transition_provenance_id,
    NEW.mission_id,
    NEW.adapter_id,
    NEW.adapter_version
  ) THEN
    RAISE EXCEPTION 'effect transition provenance does not match mission and adapter context';
  END IF;
  IF (NEW.execution_fencing_token IS DISTINCT FROM OLD.execution_fencing_token
      OR NEW.execution_precondition_evaluation_id
         IS DISTINCT FROM OLD.execution_precondition_evaluation_id)
     AND NOT (OLD.state = 'revalidating' AND NEW.state = 'executing') THEN
    RAISE EXCEPTION 'execution authority can be attached only when execution begins';
  END IF;
  IF NEW.verification_receipt_id IS DISTINCT FROM OLD.verification_receipt_id
     AND NEW.state <> 'verified' THEN
    RAISE EXCEPTION 'verification receipt can be attached only when verification succeeds';
  END IF;
  allowed := CASE OLD.state
    WHEN 'proposed' THEN ARRAY['previewed', 'invalidated']
    WHEN 'previewed' THEN ARRAY['authorized', 'invalidated']
    WHEN 'authorized' THEN ARRAY['revalidating', 'invalidated']
    WHEN 'revalidating' THEN ARRAY['executing', 'failed', 'invalidated']
    WHEN 'executing' THEN ARRAY['applied', 'failed', 'unknown_outcome']
    WHEN 'applied' THEN ARRAY['verifying', 'failed', 'unknown_outcome']
    WHEN 'verifying' THEN ARRAY['verified', 'failed', 'unknown_outcome']
    WHEN 'failed' THEN ARRAY['rolled_back']
    WHEN 'unknown_outcome' THEN ARRAY[
      'revalidating', 'applied', 'verifying', 'failed', 'rolled_back'
    ]
    ELSE ARRAY[]::text[]
  END;
  IF NOT NEW.state = ANY(allowed) THEN
    RAISE EXCEPTION 'illegal effect transition: % -> %', OLD.state, NEW.state;
  END IF;
  IF (OLD.state = 'previewed' AND NEW.state = 'authorized')
     OR (OLD.state = 'revalidating' AND NEW.state = 'executing') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_locks
      WHERE locktype = 'advisory'
        AND pid = pg_catalog.pg_backend_pid()
        AND classid = 1094929713::oid
        AND objid = 1162237008::oid
        AND objsubid = 2
        AND mode = 'ExclusiveLock'
        AND granted
    ) THEN
      IF NEW.state = 'authorized' THEN
        RAISE EXCEPTION
          'effect authorization requires the transaction authority lock';
      END IF;
      RAISE EXCEPTION
        'effect execution requires the transaction authority lock';
    END IF;
  END IF;
  IF OLD.state = 'previewed' AND NEW.state = 'authorized' AND NOT EXISTS (
    SELECT 1
    FROM acp.effect_approval_evaluations AS evaluation
    JOIN acp.approval_envelopes AS approval
      ON approval.approval_id = evaluation.approval_id
    WHERE evaluation.effect_id = NEW.effect_id
      AND evaluation.result = 'covered'
      AND evaluation.evaluated_at <= statement_timestamp()
      AND NOT EXISTS (
        SELECT 1
        FROM acp.effect_approval_evaluations AS newer_evaluation
        WHERE newer_evaluation.effect_id = evaluation.effect_id
          AND newer_evaluation.approval_id = evaluation.approval_id
          AND (
            newer_evaluation.evaluated_at > evaluation.evaluated_at
            OR (
              newer_evaluation.evaluated_at = evaluation.evaluated_at
              AND newer_evaluation.recorded_order > evaluation.recorded_order
            )
          )
      )
      AND approval.project_id = NEW.project_id
      AND (approval.mission_id IS NULL OR approval.mission_id = NEW.mission_id)
      AND approval.valid_from <= statement_timestamp()
      AND approval.expires_at > statement_timestamp()
      AND approval.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'effect % requires a current covered approval before authorization', NEW.effect_id;
  END IF;
  IF OLD.state = 'unknown_outcome' THEN
    SELECT reconciliation.outcome
      INTO reconciliation_outcome
      FROM LATERAL (
        SELECT receipt_id, effect_id
        FROM acp.effect_receipts
        WHERE effect_id = OLD.effect_id
          AND state = 'unknown_outcome'
        ORDER BY attempt_number DESC
        LIMIT 1
      ) AS receipt
      LEFT JOIN acp.effect_reconciliations AS reconciliation
        ON reconciliation.unknown_receipt_id = receipt.receipt_id
       AND reconciliation.effect_id = receipt.effect_id;
    IF reconciliation_outcome IS NULL OR reconciliation_outcome = 'inconclusive' THEN
      RAISE EXCEPTION 'effect % requires conclusive reconciliation before transition', OLD.effect_id;
    END IF;
    IF reconciliation_outcome = 'not_applied'
       AND NEW.state NOT IN ('revalidating', 'failed', 'rolled_back') THEN
      RAISE EXCEPTION 'not-applied reconciliation cannot transition effect % to %', OLD.effect_id, NEW.state;
    END IF;
    IF reconciliation_outcome = 'applied'
       AND NEW.state NOT IN ('applied', 'verifying', 'failed', 'rolled_back') THEN
      RAISE EXCEPTION 'applied reconciliation cannot re-execute effect %', OLD.effect_id;
    END IF;
  END IF;
  IF NEW.state = 'verified' AND (
    NEW.verification_receipt_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM acp.effect_receipts AS receipt
      WHERE receipt.receipt_id = NEW.verification_receipt_id
        AND receipt.effect_id = NEW.effect_id
        AND receipt.state = 'verified'
    )
  ) THEN
    RAISE EXCEPTION 'effect % can be verified only by a verified receipt', NEW.effect_id;
  END IF;
  IF OLD.state = 'revalidating' AND NEW.state = 'executing' THEN
    IF NEW.execution_fencing_token IS NULL
       OR NEW.execution_precondition_evaluation_id IS NULL
       OR NOT EXISTS (
      SELECT 1
      FROM acp.resource_leases AS lease
      WHERE lease.lease_key = 'effect:' || NEW.effect_id::text
        AND lease.mission_id = NEW.mission_id
        AND lease.fencing_token = NEW.execution_fencing_token
        AND lease.state IN ('active', 'recovering')
        AND lease.expires_at > statement_timestamp()
    ) THEN
      RAISE EXCEPTION 'effect % requires a current fenced writer lease', NEW.effect_id;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM acp.runtime_controls
      WHERE scope_type = 'global' AND scope_id = 'global'
    ) OR EXISTS (
      SELECT 1 FROM acp.runtime_controls
      WHERE (scope_type = 'global' AND scope_id = 'global'
             OR scope_type = 'project' AND scope_id = NEW.project_id::text)
        AND effects_paused
    ) THEN
      RAISE EXCEPTION 'effect % is paused by runtime control', NEW.effect_id;
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM acp.execution_precondition_evaluations AS precondition_evaluation
      JOIN acp.effect_approval_evaluations AS evaluation
        ON evaluation.approval_evaluation_id =
             precondition_evaluation.approval_evaluation_id
       AND evaluation.effect_id = precondition_evaluation.effect_id
       AND evaluation.approval_id = precondition_evaluation.approval_id
      JOIN acp.approval_envelopes AS approval
        ON approval.approval_id = evaluation.approval_id
      JOIN acp.resource_leases AS lease
        ON lease.lease_id = precondition_evaluation.lease_id
       AND lease.fencing_token = precondition_evaluation.fencing_token
      WHERE precondition_evaluation.execution_precondition_evaluation_id
              = NEW.execution_precondition_evaluation_id
        AND precondition_evaluation.effect_id = NEW.effect_id
        AND precondition_evaluation.result = 'passed'
        AND precondition_evaluation.proposal_digest = NEW.proposal_digest
        AND precondition_evaluation.payload_digest = NEW.payload_digest
        AND precondition_evaluation.fencing_token = NEW.execution_fencing_token
        AND precondition_evaluation.evaluated_at <= statement_timestamp()
        AND precondition_evaluation.valid_until > statement_timestamp()
        AND evaluation.result = 'covered'
        AND evaluation.evaluated_at <= precondition_evaluation.evaluated_at
        AND NOT EXISTS (
          SELECT 1
          FROM acp.effect_approval_evaluations AS newer_evaluation
          WHERE newer_evaluation.effect_id = evaluation.effect_id
            AND newer_evaluation.approval_id = evaluation.approval_id
            AND (
              newer_evaluation.evaluated_at > evaluation.evaluated_at
              OR (
                newer_evaluation.evaluated_at = evaluation.evaluated_at
                AND newer_evaluation.recorded_order > evaluation.recorded_order
              )
            )
        )
        AND approval.project_id = NEW.project_id
        AND (approval.mission_id IS NULL OR approval.mission_id = NEW.mission_id)
        AND approval.valid_from <= statement_timestamp()
        AND approval.expires_at > statement_timestamp()
        AND approval.revoked_at IS NULL
        AND lease.lease_key = 'effect:' || NEW.effect_id::text
        AND lease.mission_id = NEW.mission_id
        AND lease.state IN ('active', 'recovering')
        AND lease.expires_at > statement_timestamp()
    ) THEN
      RAISE EXCEPTION
        'effect % requires its exact passing execution precondition evaluation',
        NEW.effect_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER effect_proposals_enforce_state_transition
BEFORE UPDATE OF state ON acp.effect_proposals
FOR EACH ROW EXECUTE FUNCTION acp.enforce_effect_transition();

CREATE FUNCTION acp.protect_approval_envelope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approval_envelopes is append-only';
  END IF;
  IF (to_jsonb(NEW) - 'revoked_at')
      IS DISTINCT FROM
     (to_jsonb(OLD) - 'revoked_at') THEN
    RAISE EXCEPTION 'approval envelope content is immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'approval revocation is irreversible';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER approval_envelopes_protect_content
BEFORE UPDATE OR DELETE ON acp.approval_envelopes
FOR EACH ROW EXECUTE FUNCTION acp.protect_approval_envelope();

CREATE FUNCTION acp.protect_workflow_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'project_workflow_bindings is append-only';
  END IF;
  IF (to_jsonb(NEW) - 'retired_at')
      IS DISTINCT FROM
     (to_jsonb(OLD) - 'retired_at') THEN
    RAISE EXCEPTION 'workflow binding content is immutable';
  END IF;
  IF OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL THEN
    RAISE EXCEPTION 'workflow binding retirement is irreversible';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER project_workflow_bindings_protect_content
BEFORE UPDATE OR DELETE ON acp.project_workflow_bindings
FOR EACH ROW EXECUTE FUNCTION acp.protect_workflow_binding();

CREATE TRIGGER completion_contracts_are_immutable
BEFORE UPDATE OR DELETE ON acp.completion_contracts
FOR EACH ROW EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE TRIGGER project_profiles_are_immutable
BEFORE UPDATE OR DELETE ON acp.project_profiles
FOR EACH ROW EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE TRIGGER completion_evaluations_are_immutable
BEFORE UPDATE OR DELETE ON acp.completion_evaluations
FOR EACH ROW EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE TRIGGER precondition_snapshots_are_immutable
BEFORE UPDATE OR DELETE ON acp.precondition_snapshots
FOR EACH ROW EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE FUNCTION acp.validate_covered_approval_evaluation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  effect_record acp.effect_proposals%ROWTYPE;
  approval_record acp.approval_envelopes%ROWTYPE;
BEGIN
  IF NEW.result <> 'covered' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO effect_record
    FROM acp.effect_proposals WHERE effect_id = NEW.effect_id;
  SELECT * INTO approval_record
    FROM acp.approval_envelopes WHERE approval_id = NEW.approval_id;
  IF effect_record.effect_id IS NULL OR approval_record.approval_id IS NULL THEN
    RAISE EXCEPTION 'covered approval evaluation requires persisted effect and approval';
  END IF;
  IF approval_record.project_id <> effect_record.project_id
     OR (approval_record.mission_id IS NOT NULL
         AND approval_record.mission_id <> effect_record.mission_id)
     OR NEW.evaluated_at < approval_record.valid_from
     OR NEW.evaluated_at >= approval_record.expires_at
     OR approval_record.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'covered approval evaluation is outside approval identity or time bounds';
  END IF;
  IF NEW.evaluated_at > statement_timestamp() THEN
    RAISE EXCEPTION 'covered approval evaluation cannot be future-dated';
  END IF;
  IF nullif(btrim(effect_record.target ->> 'type'), '') IS NULL
     OR nullif(btrim(effect_record.target ->> 'externalId'), '') IS NULL
     OR NOT (approval_record.allowed_effect_types ? effect_record.effect_type)
     OR NOT (approval_record.allowed_adapter_account_ids ? effect_record.adapter_account_id)
     OR NOT (approval_record.allowed_target_ids ? (effect_record.target ->> 'externalId'))
     OR array_position(ARRAY['R0','R1','R2','R3','R4'], effect_record.risk_class)
        > array_position(ARRAY['R0','R1','R2','R3','R4'], approval_record.maximum_risk_class) THEN
    RAISE EXCEPTION 'covered approval evaluation exceeds effect, account, target, or risk scope';
  END IF;
  IF approval_record.candidate_revisions IS NOT NULL
     AND (effect_record.candidate_revision IS NULL
          OR NOT (approval_record.candidate_revisions ? effect_record.candidate_revision)) THEN
    RAISE EXCEPTION 'covered approval evaluation does not bind the candidate';
  END IF;
  IF approval_record.payload_digests IS NOT NULL
     AND NOT (approval_record.payload_digests ? effect_record.payload_digest) THEN
    RAISE EXCEPTION 'covered approval evaluation does not bind the payload';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(effect_record.required_preconditions) AS requirement
    WHERE NOT EXISTS (
      SELECT 1 FROM acp.precondition_snapshots AS snapshot
      WHERE snapshot.effect_id = effect_record.effect_id
        AND snapshot.source_ref = requirement ->> 'sourceRef'
        AND snapshot.snapshot = requirement -> 'expected'
        AND snapshot.captured_at <= NEW.evaluated_at
        AND approval_record.precondition_snapshot_ids ? snapshot.snapshot_id::text
    )
  ) THEN
    RAISE EXCEPTION 'covered approval evaluation lacks an exact precondition snapshot';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(approval_record.required_gates) AS gate
    WHERE coalesce(jsonb_typeof(NEW.assessment_context -> 'passedGates'), 'null') <> 'array'
       OR NOT ((NEW.assessment_context -> 'passedGates') ? gate)
  ) THEN
    RAISE EXCEPTION 'covered approval evaluation lacks a required gate';
  END IF;
  IF jsonb_array_length(approval_record.allowed_environments) > 0
     AND NOT (approval_record.allowed_environments ? coalesce(NEW.assessment_context ->> 'environment', '')) THEN
    RAISE EXCEPTION 'covered approval evaluation lacks an allowed environment';
  END IF;
  IF approval_record.behavioral_contract_id IS NOT NULL
     AND approval_record.behavioral_contract_id
         IS DISTINCT FROM NEW.assessment_context ->> 'behavioralContractId' THEN
    RAISE EXCEPTION 'covered approval evaluation lacks the behavioral contract';
  END IF;
  IF approval_record.maximum_change_size IS NOT NULL AND (
    coalesce(jsonb_typeof(NEW.assessment_context -> 'changeSize'), 'null') <> 'object'
    OR EXISTS (
      SELECT 1 FROM jsonb_each_text(approval_record.maximum_change_size) AS maximum
      WHERE NOT ((NEW.assessment_context -> 'changeSize') ? maximum.key)
         OR (NEW.assessment_context -> 'changeSize' ->> maximum.key)::numeric
            > maximum.value::numeric
    )
  ) THEN
    RAISE EXCEPTION 'covered approval evaluation exceeds maximum change size';
  END IF;
  IF coalesce((NEW.assessment_context ->> 'repairClassRequired')::boolean, false)
     OR NEW.assessment_context ? 'repairClass' THEN
    IF NOT (
      approval_record.allowed_repair_classes
      ? coalesce(NEW.assessment_context ->> 'repairClass', '')
    ) THEN
      RAISE EXCEPTION 'covered approval evaluation lacks an allowed repair class';
    END IF;
  END IF;
  IF NEW.assessment_context ? 'rollbackEffectType'
     AND NOT (
       coalesce(approval_record.rollback_authorization, '[]'::jsonb)
       ? coalesce(NEW.assessment_context ->> 'rollbackEffectType', '')
     ) THEN
    RAISE EXCEPTION 'covered approval evaluation lacks rollback authorization';
  END IF;
  IF NEW.assessment_context -> 'drift' ->> 'material' = 'true' THEN
    RAISE EXCEPTION 'covered approval evaluation cannot contain material drift';
  END IF;
  IF NEW.assessment_context ? 'drift'
     AND NEW.assessment_context -> 'drift' ->> 'material' = 'false'
     AND approval_record.non_material_drift_policy IS NULL THEN
    RAISE EXCEPTION 'covered approval evaluation lacks non-material drift policy';
  END IF;
  IF effect_record.risk_class = 'R4' AND (
    approval_record.mission_id IS NULL
    OR jsonb_array_length(approval_record.allowed_effect_types) <> 1
    OR jsonb_array_length(approval_record.allowed_adapter_account_ids) <> 1
    OR jsonb_array_length(approval_record.allowed_target_ids) <> 1
    OR jsonb_array_length(coalesce(approval_record.payload_digests, '[]'::jsonb)) <> 1
    OR NOT (approval_record.payload_digests ? effect_record.payload_digest)
    OR (effect_record.candidate_revision IS NOT NULL AND (
      jsonb_array_length(coalesce(approval_record.candidate_revisions, '[]'::jsonb)) <> 1
      OR NOT (approval_record.candidate_revisions ? effect_record.candidate_revision)
    ))
  ) THEN
    RAISE EXCEPTION 'R4 covered approval evaluation must bind one exact effect';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER effect_approval_evaluations_validate_coverage
BEFORE INSERT ON acp.effect_approval_evaluations
FOR EACH ROW EXECUTE FUNCTION acp.validate_covered_approval_evaluation();

CREATE TRIGGER effect_approval_evaluations_are_immutable
BEFORE UPDATE OR DELETE ON acp.effect_approval_evaluations
FOR EACH ROW EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE TRIGGER effect_receipts_are_immutable
BEFORE UPDATE OR DELETE ON acp.effect_receipts
FOR EACH ROW EXECUTE FUNCTION acp.reject_immutable_mutation();

ALTER TABLE acp.effect_receipts
  ADD CONSTRAINT effect_receipts_verified_readback_required
  CHECK (
    (state = 'verified' AND verified_at IS NOT NULL AND verification_record IS NOT NULL)
    OR (state <> 'verified' AND verified_at IS NULL AND verification_record IS NULL)
  ),
  ADD CONSTRAINT effect_receipts_verified_timing
  CHECK (
    state <> 'verified'
    OR verified_at >= attempted_at
  );

CREATE FUNCTION acp.validate_effect_record_provenance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  effect_record record;
BEGIN
  SELECT mission_id, adapter_id, adapter_version
    INTO effect_record
    FROM acp.effect_proposals
    WHERE effect_id = NEW.effect_id;
  IF effect_record.mission_id IS NULL OR NOT acp.runtime_provenance_matches_context(
    NEW.provenance_id,
    effect_record.mission_id,
    effect_record.adapter_id,
    effect_record.adapter_version
  ) THEN
    RAISE EXCEPTION '% provenance does not match effect context', TG_TABLE_NAME;
  END IF;
  IF TG_TABLE_NAME = 'precondition_snapshots' THEN
    IF NEW.captured_at > statement_timestamp() THEN
      RAISE EXCEPTION 'precondition snapshot cannot be future-dated';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER effect_receipts_validate_provenance
BEFORE INSERT ON acp.effect_receipts
FOR EACH ROW EXECUTE FUNCTION acp.validate_effect_record_provenance();

CREATE TRIGGER effect_approval_evaluations_validate_provenance
BEFORE INSERT ON acp.effect_approval_evaluations
FOR EACH ROW EXECUTE FUNCTION acp.validate_effect_record_provenance();

CREATE TRIGGER execution_precondition_evaluations_validate_provenance
BEFORE INSERT ON acp.execution_precondition_evaluations
FOR EACH ROW EXECUTE FUNCTION acp.validate_effect_record_provenance();

CREATE TRIGGER precondition_snapshots_validate_provenance
BEFORE INSERT ON acp.precondition_snapshots
FOR EACH ROW EXECUTE FUNCTION acp.validate_effect_record_provenance();

CREATE FUNCTION acp.validate_verified_receipt_plan()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  effect_record record;
  results jsonb;
BEGIN
  IF NEW.attempted_at > statement_timestamp()
     OR (NEW.verified_at IS NOT NULL
         AND NEW.verified_at > statement_timestamp()) THEN
    RAISE EXCEPTION 'effect receipt cannot be future-dated';
  END IF;
  IF NEW.state <> 'verified' THEN
    RETURN NEW;
  END IF;

  SELECT verification_plan, project_id
    INTO effect_record
    FROM acp.effect_proposals
    WHERE effect_id = NEW.effect_id;
  results := NEW.verification_record -> 'steps';

  IF jsonb_typeof(NEW.verification_record) IS DISTINCT FROM 'object'
     OR NEW.verification_record ->> 'result' IS DISTINCT FROM 'passed'
     OR jsonb_typeof(results) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'verified receipt requires a passed structured verification record';
  END IF;
  IF jsonb_array_length(results) <> jsonb_array_length(effect_record.verification_plan)
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(effect_record.verification_plan)
         WITH ORDINALITY AS planned(step, ordinal)
       WHERE jsonb_typeof(results -> ((planned.ordinal - 1)::integer))
               IS DISTINCT FROM 'object'
          OR results -> ((planned.ordinal - 1)::integer) -> 'stepIndex'
               IS DISTINCT FROM to_jsonb((planned.ordinal - 1)::integer)
          OR results -> ((planned.ordinal - 1)::integer) ->> 'type'
               IS DISTINCT FROM planned.step ->> 'type'
          OR results -> ((planned.ordinal - 1)::integer) -> 'expected'
               IS DISTINCT FROM planned.step -> 'expected'
          OR NOT (results -> ((planned.ordinal - 1)::integer) ? 'observed')
          OR nullif(btrim(
               results -> ((planned.ordinal - 1)::integer) ->> 'observedDigest'
             ), '') IS NULL
          OR results -> ((planned.ordinal - 1)::integer) -> 'matched'
               IS DISTINCT FROM 'true'::jsonb
          OR nullif(btrim(
               results -> ((planned.ordinal - 1)::integer) ->> 'observedAt'
             ), '') IS NULL
          OR (results -> ((planned.ordinal - 1)::integer) ->> 'observedAt')::timestamptz
               < NEW.attempted_at
          OR (results -> ((planned.ordinal - 1)::integer) ->> 'observedAt')::timestamptz
               > NEW.verified_at
          OR jsonb_typeof(
               results -> ((planned.ordinal - 1)::integer) -> 'evidenceIds'
             ) IS DISTINCT FROM 'array'
          OR CASE
               WHEN jsonb_typeof(
                 results -> ((planned.ordinal - 1)::integer) -> 'evidenceIds'
               ) = 'array'
               THEN jsonb_array_length(
                 results -> ((planned.ordinal - 1)::integer) -> 'evidenceIds'
               ) = 0
               ELSE true
             END
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              CASE
                WHEN jsonb_typeof(
                  results -> ((planned.ordinal - 1)::integer) -> 'evidenceIds'
                ) = 'array'
                THEN results -> ((planned.ordinal - 1)::integer) -> 'evidenceIds'
                ELSE '[]'::jsonb
              END
            ) AS verification_evidence(value)
            WHERE jsonb_typeof(verification_evidence.value) <> 'string'
               OR NOT EXISTS (
                 SELECT 1
                 FROM acp.evidence_records AS evidence
                 WHERE evidence.evidence_id::text =
                         (verification_evidence.value #>> '{}')
                   AND evidence.project_id = effect_record.project_id
                   AND evidence.accessibility = 'available'
                   AND evidence.freshness = 'current'
                   AND evidence.content_hash =
                         results -> ((planned.ordinal - 1)::integer)
                           ->> 'observedDigest'
                   AND evidence.observed_at =
                         (results -> ((planned.ordinal - 1)::integer)
                           ->> 'observedAt')::timestamptz
               )
          )
     ) THEN
    RAISE EXCEPTION
      'verified receipt must contain one evidenced passing result for every verification-plan step';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER effect_receipts_validate_verification_plan
BEFORE INSERT ON acp.effect_receipts
FOR EACH ROW EXECUTE FUNCTION acp.validate_verified_receipt_plan();

ALTER TABLE acp.resource_leases
  ADD CONSTRAINT resource_leases_canonical_key
  CHECK (
    lease_key = lower(btrim(lease_key))
    AND lease_key ~ '^[a-z][a-z0-9._-]*:[a-z0-9][a-z0-9._:/@-]*$'
  );

ALTER TABLE acp.candidate_records
  ADD CONSTRAINT candidate_records_evidence_required
  CHECK (jsonb_array_length(evidence_ids) > 0);

ALTER TABLE acp.acceptance_records
  ADD CONSTRAINT acceptance_records_audit_contract
  CHECK (
    (
      state = 'waived'
      AND candidate_revision IS NOT NULL
      AND waiver IS NOT NULL
      AND nullif(btrim(waiver ->> 'authority'), '') IS NOT NULL
      AND nullif(btrim(waiver ->> 'reason'), '') IS NOT NULL
      AND nullif(btrim(waiver ->> 'scope'), '') IS NOT NULL
      AND nullif(btrim(waiver ->> 'waivedAt'), '') IS NOT NULL
      AND waiver ->> 'candidateRevision' IS NOT NULL
      AND waiver ->> 'candidateRevision' IS NOT DISTINCT FROM candidate_revision
    )
    OR (state <> 'waived' AND waiver IS NULL)
  ),
  ADD CONSTRAINT acceptance_records_passed_evidence_required
  CHECK (state <> 'passed' OR jsonb_array_length(evidence_ids) > 0);

CREATE TABLE acp.mission_nodes (
  node_id acp.stable_id PRIMARY KEY,
  mission_id acp.stable_id NOT NULL REFERENCES acp.missions (mission_id),
  node_type text NOT NULL,
  worker_role text NOT NULL CHECK (
    worker_role IN (
      'counterpart', 'context_intake', 'research', 'diagnosis', 'decision',
      'delivery', 'assurance', 'acceptance', 'coordination', 'learning',
      'effect_executor', 'reconciler'
    )
  ),
  state text NOT NULL CHECK (
    state IN (
      'pending', 'runnable', 'running', 'awaiting_event', 'succeeded',
      'failed', 'needs_input', 'cancelled'
    )
  ),
  dependencies jsonb NOT NULL CHECK (jsonb_typeof(dependencies) = 'array'),
  retry_policy jsonb NOT NULL CHECK (jsonb_typeof(retry_policy) = 'object'),
  graph_revision text NOT NULL,
  available_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id),
  transition_provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id),
  UNIQUE (mission_id, node_id),
  CHECK (left(node_id::text, 4) = 'nod_')
);

CREATE TABLE acp.context_packets (
  context_packet_id acp.stable_id PRIMARY KEY,
  mission_id acp.stable_id NOT NULL,
  node_id acp.stable_id NOT NULL,
  schema_version acp.semantic_version NOT NULL,
  digest text NOT NULL CHECK (length(btrim(digest)) > 0),
  packet jsonb NOT NULL CHECK (jsonb_typeof(packet) = 'object'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id),
  FOREIGN KEY (mission_id, node_id)
    REFERENCES acp.mission_nodes (mission_id, node_id),
  UNIQUE (context_packet_id, mission_id, node_id),
  CHECK (left(context_packet_id::text, 4) = 'ctx_')
);

CREATE FUNCTION acp.validate_context_packet_provenance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM acp.runtime_provenance AS provenance
    WHERE provenance.provenance_id = NEW.provenance_id
      AND acp.runtime_provenance_matches_context(
        provenance.provenance_id,
        NEW.mission_id
      )
      AND provenance.context_packet_schema_version = NEW.schema_version
      AND provenance.context_packet_digest = NEW.digest
  ) THEN
    RAISE EXCEPTION 'context packet provenance does not match mission, schema, and digest';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER context_packets_validate_provenance
BEFORE INSERT ON acp.context_packets
FOR EACH ROW EXECUTE FUNCTION acp.validate_context_packet_provenance();

CREATE TABLE acp.worker_runs (
  run_id acp.stable_id PRIMARY KEY,
  mission_id acp.stable_id NOT NULL,
  node_id acp.stable_id NOT NULL,
  context_packet_id acp.stable_id NOT NULL
    REFERENCES acp.context_packets (context_packet_id),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  state text NOT NULL CHECK (
    state IN ('started', 'succeeded', 'failed', 'needs_input', 'cancelled')
  ),
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id),
  transition_provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id),
  FOREIGN KEY (mission_id, node_id)
    REFERENCES acp.mission_nodes (mission_id, node_id),
  FOREIGN KEY (context_packet_id, mission_id, node_id)
    REFERENCES acp.context_packets (context_packet_id, mission_id, node_id),
  UNIQUE (node_id, attempt_number),
  UNIQUE (run_id, mission_id, node_id),
  CHECK (left(run_id::text, 4) = 'run_'),
  CHECK ((state = 'started') = (completed_at IS NULL)),
  CHECK ((state = 'started') = (result IS NULL))
);

ALTER TABLE acp.resource_leases
  ADD CONSTRAINT resource_leases_mission_node_fk
    FOREIGN KEY (mission_id, node_id)
    REFERENCES acp.mission_nodes (mission_id, node_id),
  ADD CONSTRAINT resource_leases_owner_run_fk
    FOREIGN KEY (owner_run_id, mission_id, node_id)
    REFERENCES acp.worker_runs (run_id, mission_id, node_id);

CREATE TABLE acp.mission_workflow_runs (
  workflow_execution_id acp.stable_id PRIMARY KEY,
  mission_id acp.stable_id NOT NULL REFERENCES acp.missions (mission_id),
  dbos_workflow_id text NOT NULL UNIQUE,
  workflow_id acp.stable_id NOT NULL,
  workflow_version acp.semantic_version NOT NULL,
  workflow_binding_id acp.stable_id NOT NULL,
  dbos_application_version text NOT NULL,
  graph_revision text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'running', 'success', 'error', 'cancelled')),
  provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id),
  transition_provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  completed_at timestamptz,
  FOREIGN KEY (mission_id, workflow_id, workflow_version, workflow_binding_id)
    REFERENCES acp.missions (
      mission_id,
      workflow_id,
      workflow_version,
      workflow_binding_id
  ),
  CHECK (left(workflow_execution_id::text, 4) = 'wfx_'),
  CHECK ((state IN ('pending', 'running')) = (completed_at IS NULL))
);

CREATE TABLE acp.durable_subscriptions (
  subscription_id acp.stable_id PRIMARY KEY,
  mission_id acp.stable_id NOT NULL REFERENCES acp.missions (mission_id),
  node_id acp.stable_id NOT NULL,
  dbos_workflow_id text NOT NULL,
  topic text NOT NULL,
  semantic_digest text NOT NULL CHECK (length(btrim(semantic_digest)) > 0),
  state text NOT NULL CHECK (state IN ('waiting', 'received', 'expired', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz,
  resolved_at timestamptz,
  provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id),
  transition_provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id),
  FOREIGN KEY (mission_id, node_id)
    REFERENCES acp.mission_nodes (mission_id, node_id),
  CHECK (left(subscription_id::text, 4) = 'sub_'),
  CHECK ((state = 'waiting') = (resolved_at IS NULL)),
  UNIQUE (dbos_workflow_id, topic)
);

CREATE TABLE acp.effect_reconciliations (
  reconciliation_id acp.stable_id PRIMARY KEY,
  effect_id acp.stable_id NOT NULL REFERENCES acp.effect_proposals (effect_id),
  unknown_receipt_id acp.stable_id NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('applied', 'not_applied', 'inconclusive')),
  observed_state jsonb NOT NULL CHECK (jsonb_typeof(observed_state) = 'object'),
  evidence_ids jsonb NOT NULL CHECK (
    jsonb_typeof(evidence_ids) = 'array' AND jsonb_array_length(evidence_ids) > 0
  ),
  reconciled_at timestamptz NOT NULL,
  provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id),
  CHECK (left(reconciliation_id::text, 4) = 'rcn_'),
  FOREIGN KEY (unknown_receipt_id, effect_id)
    REFERENCES acp.effect_receipts (receipt_id, effect_id),
  UNIQUE (unknown_receipt_id)
);

CREATE FUNCTION acp.validate_effect_reconciliation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  unknown_attempted_at timestamptz;
  effect_project_id acp.stable_id;
  observed_at_value timestamptz;
BEGIN
  SELECT receipt.attempted_at, effect.project_id
    INTO unknown_attempted_at, effect_project_id
    FROM acp.effect_receipts AS receipt
    JOIN acp.effect_proposals AS effect ON effect.effect_id = receipt.effect_id
    WHERE receipt.receipt_id = NEW.unknown_receipt_id
      AND receipt.effect_id = NEW.effect_id
      AND receipt.state = 'unknown_outcome';
  IF unknown_attempted_at IS NULL THEN
    RAISE EXCEPTION 'reconciliation requires an unknown-outcome receipt for the same effect';
  END IF;
  IF NEW.reconciled_at < unknown_attempted_at
     OR NEW.reconciled_at > statement_timestamp() THEN
    RAISE EXCEPTION 'reconciliation time must follow the attempt and not be future-dated';
  END IF;
  IF NEW.observed_state ->> 'outcome' IS DISTINCT FROM NEW.outcome
     OR nullif(btrim(NEW.observed_state ->> 'sourceRef'), '') IS NULL
     OR nullif(btrim(NEW.observed_state ->> 'observedDigest'), '') IS NULL
     OR nullif(btrim(NEW.observed_state ->> 'observedAt'), '') IS NULL THEN
    RAISE EXCEPTION 'reconciliation requires outcome-specific observed state';
  END IF;
  BEGIN
    observed_at_value := (NEW.observed_state ->> 'observedAt')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'reconciliation observedAt must be an ISO timestamp';
  END;
  IF observed_at_value < unknown_attempted_at OR observed_at_value > NEW.reconciled_at THEN
    RAISE EXCEPTION 'reconciliation observation must follow the attempt and precede reconciliation';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(NEW.evidence_ids) AS requested(evidence_id)
    LEFT JOIN acp.evidence_records AS evidence
      ON evidence.evidence_id::text = requested.evidence_id
     AND evidence.project_id = effect_project_id
     AND evidence.accessibility = 'available'
    WHERE evidence.evidence_id IS NULL
  ) THEN
    RAISE EXCEPTION 'reconciliation evidence must exist and be available in the effect project';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(NEW.evidence_ids) AS requested(evidence_id)
    JOIN acp.evidence_records AS evidence
      ON evidence.evidence_id::text = requested.evidence_id
     AND evidence.project_id = effect_project_id
     AND evidence.accessibility = 'available'
    WHERE evidence.source_ref = NEW.observed_state ->> 'sourceRef'
      AND evidence.content_hash = NEW.observed_state ->> 'observedDigest'
      AND evidence.observed_at = observed_at_value
      AND (NEW.outcome = 'inconclusive' OR evidence.freshness = 'current')
  ) THEN
    RAISE EXCEPTION
      'reconciliation evidence must match the observation source, digest, and time';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER effect_reconciliations_validate_receipt
BEFORE INSERT ON acp.effect_reconciliations
FOR EACH ROW EXECUTE FUNCTION acp.validate_effect_reconciliation();

CREATE TRIGGER effect_reconciliations_validate_provenance
BEFORE INSERT ON acp.effect_reconciliations
FOR EACH ROW EXECUTE FUNCTION acp.validate_effect_record_provenance();

CREATE FUNCTION acp.validate_runtime_projection_provenance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NOT acp.runtime_provenance_matches_context(
    NEW.provenance_id,
    NEW.mission_id
  ) THEN
    RAISE EXCEPTION '% creation provenance does not match mission context', TG_TABLE_NAME;
  END IF;
  IF (TG_OP = 'INSERT' OR OLD.state IS DISTINCT FROM NEW.state)
     AND NOT acp.runtime_provenance_matches_context(
       NEW.transition_provenance_id,
       NEW.mission_id
     ) THEN
    RAISE EXCEPTION '% transition provenance does not match mission context', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER mission_nodes_validate_provenance
BEFORE INSERT OR UPDATE ON acp.mission_nodes
FOR EACH ROW EXECUTE FUNCTION acp.validate_runtime_projection_provenance();

CREATE TRIGGER worker_runs_validate_provenance
BEFORE INSERT OR UPDATE ON acp.worker_runs
FOR EACH ROW EXECUTE FUNCTION acp.validate_runtime_projection_provenance();

CREATE TRIGGER mission_workflow_runs_validate_provenance
BEFORE INSERT OR UPDATE ON acp.mission_workflow_runs
FOR EACH ROW EXECUTE FUNCTION acp.validate_runtime_projection_provenance();

CREATE TRIGGER durable_subscriptions_validate_provenance
BEFORE INSERT OR UPDATE ON acp.durable_subscriptions
FOR EACH ROW EXECUTE FUNCTION acp.validate_runtime_projection_provenance();

CREATE FUNCTION acp.validate_worker_run_context_provenance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  packet record;
BEGIN
  SELECT schema_version, digest, mission_id, node_id
    INTO packet
    FROM acp.context_packets
    WHERE context_packet_id = NEW.context_packet_id
      AND mission_id = NEW.mission_id
      AND node_id = NEW.node_id;
  IF packet.schema_version IS NULL THEN
    RAISE EXCEPTION 'worker run requires its exact context packet';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1
    FROM acp.runtime_provenance AS provenance
    WHERE provenance.provenance_id = NEW.provenance_id
      AND provenance.context_packet_schema_version = packet.schema_version
      AND provenance.context_packet_digest = packet.digest
  ) THEN
    RAISE EXCEPTION 'worker creation provenance does not match context packet';
  END IF;
  IF (TG_OP = 'INSERT' OR OLD.state IS DISTINCT FROM NEW.state)
     AND NOT EXISTS (
       SELECT 1
       FROM acp.runtime_provenance AS provenance
       WHERE provenance.provenance_id = NEW.transition_provenance_id
         AND provenance.context_packet_schema_version = packet.schema_version
         AND provenance.context_packet_digest = packet.digest
     ) THEN
    RAISE EXCEPTION 'worker transition provenance does not match context packet';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER worker_runs_validate_context_provenance
BEFORE INSERT OR UPDATE ON acp.worker_runs
FOR EACH ROW EXECUTE FUNCTION acp.validate_worker_run_context_provenance();

CREATE FUNCTION acp.sync_effect_state_from_receipt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_state text;
BEGIN
  target_state := CASE NEW.state
    WHEN 'applied' THEN 'applied'
    WHEN 'verified' THEN 'verified'
    WHEN 'failed' THEN 'failed'
    WHEN 'unknown_outcome' THEN 'unknown_outcome'
    WHEN 'rolled_back' THEN 'rolled_back'
  END;
  UPDATE acp.effect_proposals
     SET state = target_state,
         verification_receipt_id = CASE
           WHEN NEW.state = 'verified' THEN NEW.receipt_id
           ELSE verification_receipt_id
         END,
         transition_provenance_id = CASE
           WHEN state IS DISTINCT FROM target_state THEN NEW.provenance_id
           ELSE transition_provenance_id
         END,
         updated_at = statement_timestamp()
   WHERE effect_id = NEW.effect_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'receipt effect % does not exist', NEW.effect_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER effect_receipts_sync_effect_state
AFTER INSERT ON acp.effect_receipts
FOR EACH ROW EXECUTE FUNCTION acp.sync_effect_state_from_receipt();

CREATE FUNCTION acp.require_unknown_outcome_reconciliation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  latest_unknown_receipt acp.stable_id;
BEGIN
  IF NEW.attempt_number > 1 THEN
    SELECT receipt_id
      INTO latest_unknown_receipt
      FROM acp.effect_receipts
      WHERE effect_id = NEW.effect_id
        AND state = 'unknown_outcome'
        AND attempt_number < NEW.attempt_number
      ORDER BY attempt_number DESC
      LIMIT 1;

    IF latest_unknown_receipt IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM acp.effect_reconciliations
      WHERE unknown_receipt_id = latest_unknown_receipt
        AND (
          outcome = 'not_applied'
          OR (
            outcome = 'applied'
            AND NEW.state = 'verified'
            AND EXISTS (
              SELECT 1 FROM acp.effect_proposals AS effect
              WHERE effect.effect_id = NEW.effect_id
                AND effect.state = 'verifying'
            )
          )
        )
    ) THEN
      RAISE EXCEPTION
        'effect % must reconcile unknown outcome before retry',
        NEW.effect_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER effect_receipts_require_reconciliation
BEFORE INSERT ON acp.effect_receipts
FOR EACH ROW EXECUTE FUNCTION acp.require_unknown_outcome_reconciliation();

CREATE FUNCTION acp.protect_runtime_projection_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  mutable_columns text[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
  END IF;
  IF TG_TABLE_NAME = 'worker_runs'
     AND OLD.state IN ('succeeded', 'failed', 'needs_input', 'cancelled') THEN
    RAISE EXCEPTION 'terminal worker result is immutable';
  END IF;
  IF OLD.state = NEW.state
     AND NEW.transition_provenance_id IS DISTINCT FROM OLD.transition_provenance_id THEN
    RAISE EXCEPTION 'transition provenance can change only with state';
  END IF;
  mutable_columns := CASE TG_TABLE_NAME
    WHEN 'mission_nodes' THEN ARRAY[
      'state', 'available_at', 'started_at', 'completed_at', 'transition_provenance_id'
    ]
    WHEN 'worker_runs' THEN ARRAY[
      'state', 'result', 'completed_at', 'transition_provenance_id'
    ]
    WHEN 'mission_workflow_runs' THEN ARRAY[
      'state', 'completed_at', 'transition_provenance_id'
    ]
    WHEN 'durable_subscriptions' THEN ARRAY[
      'state', 'resolved_at', 'transition_provenance_id'
    ]
    ELSE ARRAY[]::text[]
  END;
  IF (to_jsonb(NEW) - mutable_columns) IS DISTINCT FROM (to_jsonb(OLD) - mutable_columns) THEN
    RAISE EXCEPTION '% identity is immutable', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER mission_nodes_protect_identity
BEFORE UPDATE OR DELETE ON acp.mission_nodes
FOR EACH ROW EXECUTE FUNCTION acp.protect_runtime_projection_identity();

CREATE TRIGGER context_packets_are_immutable
BEFORE UPDATE OR DELETE ON acp.context_packets
FOR EACH ROW EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE TRIGGER worker_runs_protect_identity
BEFORE UPDATE OR DELETE ON acp.worker_runs
FOR EACH ROW EXECUTE FUNCTION acp.protect_runtime_projection_identity();

CREATE TRIGGER mission_workflow_runs_protect_identity
BEFORE UPDATE OR DELETE ON acp.mission_workflow_runs
FOR EACH ROW EXECUTE FUNCTION acp.protect_runtime_projection_identity();

CREATE TRIGGER durable_subscriptions_protect_identity
BEFORE UPDATE OR DELETE ON acp.durable_subscriptions
FOR EACH ROW EXECUTE FUNCTION acp.protect_runtime_projection_identity();

CREATE TABLE acp.state_transition_events (
  transition_event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type text NOT NULL CHECK (
    entity_type IN (
      'mission', 'effect', 'mission_node', 'worker_run', 'workflow_run',
      'subscription'
    )
  ),
  entity_id text NOT NULL,
  previous_state text NOT NULL,
  next_state text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id)
);

CREATE TRIGGER state_transition_events_are_immutable
BEFORE UPDATE OR DELETE ON acp.state_transition_events
FOR EACH ROW EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE FUNCTION acp.record_state_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  entity_type text;
  entity_id text;
  entity_id_column text;
BEGIN
  IF OLD.state = NEW.state THEN
    RETURN NEW;
  END IF;
  entity_type := CASE TG_TABLE_NAME
    WHEN 'missions' THEN 'mission'
    WHEN 'effect_proposals' THEN 'effect'
    WHEN 'mission_nodes' THEN 'mission_node'
    WHEN 'worker_runs' THEN 'worker_run'
    WHEN 'mission_workflow_runs' THEN 'workflow_run'
    WHEN 'durable_subscriptions' THEN 'subscription'
  END;
  entity_id_column := CASE TG_TABLE_NAME
    WHEN 'missions' THEN 'mission_id'
    WHEN 'effect_proposals' THEN 'effect_id'
    WHEN 'mission_nodes' THEN 'node_id'
    WHEN 'worker_runs' THEN 'run_id'
    WHEN 'mission_workflow_runs' THEN 'workflow_execution_id'
    WHEN 'durable_subscriptions' THEN 'subscription_id'
  END;
  entity_id := to_jsonb(NEW) ->> entity_id_column;
  INSERT INTO acp.state_transition_events (
    entity_type, entity_id, previous_state, next_state, provenance_id
  ) VALUES (
    entity_type,
    entity_id,
    OLD.state,
    NEW.state,
    NEW.transition_provenance_id
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER effect_proposals_record_state_transition
AFTER UPDATE OF state ON acp.effect_proposals
FOR EACH ROW EXECUTE FUNCTION acp.record_state_transition();
CREATE TRIGGER missions_record_state_transition
AFTER UPDATE OF state ON acp.missions
FOR EACH ROW EXECUTE FUNCTION acp.record_state_transition();
CREATE TRIGGER mission_nodes_record_state_transition
AFTER UPDATE OF state ON acp.mission_nodes
FOR EACH ROW EXECUTE FUNCTION acp.record_state_transition();
CREATE TRIGGER worker_runs_record_state_transition
AFTER UPDATE OF state ON acp.worker_runs
FOR EACH ROW EXECUTE FUNCTION acp.record_state_transition();
CREATE TRIGGER mission_workflow_runs_record_state_transition
AFTER UPDATE OF state ON acp.mission_workflow_runs
FOR EACH ROW EXECUTE FUNCTION acp.record_state_transition();
CREATE TRIGGER durable_subscriptions_record_state_transition
AFTER UPDATE OF state ON acp.durable_subscriptions
FOR EACH ROW EXECUTE FUNCTION acp.record_state_transition();

CREATE TRIGGER effect_reconciliations_are_immutable
BEFORE UPDATE OR DELETE ON acp.effect_reconciliations
FOR EACH ROW EXECUTE FUNCTION acp.reject_immutable_mutation();
