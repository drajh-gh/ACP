-- Transaction ownership belongs to the migration runner.
CREATE TABLE acp.worker_launch_revocations (
  run_id acp.stable_id PRIMARY KEY REFERENCES acp.worker_launch_intents(run_id),
  owner_session_id acp.stable_id NOT NULL,
  application_version text NOT NULL,
  provenance_id acp.stable_id NOT NULL REFERENCES acp.runtime_provenance(provenance_id),
  reason text NOT NULL CHECK (reason IN ('manager_dispatch_ended_without_result', 'original_owner_retired')),
  revoked_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE acp.worker_launch_claims (
  reconciliation_id acp.stable_id PRIMARY KEY CHECK (reconciliation_id::text ~ '^rcn_'),
  run_id acp.stable_id NOT NULL REFERENCES acp.worker_launch_intents(run_id),
  owner_session_id acp.stable_id NOT NULL,
  application_version text NOT NULL,
  provenance_id acp.stable_id NOT NULL UNIQUE REFERENCES acp.runtime_provenance(provenance_id),
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > claimed_at)
);
CREATE INDEX worker_launch_claims_by_run ON acp.worker_launch_claims(run_id, expires_at DESC);
CREATE TABLE acp.worker_launch_stops (
  run_id acp.stable_id PRIMARY KEY REFERENCES acp.worker_launch_intents(run_id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('owner', 'recovery')),
  owner_session_id acp.stable_id NOT NULL,
  application_version text NOT NULL,
  provenance_id acp.stable_id NOT NULL REFERENCES acp.runtime_provenance(provenance_id),
  reconciliation_id acp.stable_id REFERENCES acp.worker_launch_claims(reconciliation_id),
  launch_sealed boolean NOT NULL CHECK (launch_sealed),
  process_state text NOT NULL CHECK (process_state IN ('exited', 'terminated', 'lost')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  exit_code integer,
  root_process_id integer CHECK (root_process_id > 0),
  root_process_start_token text CHECK (root_process_start_token ~ '^win32-filetime:[0-9]{16,20}$'),
  root_started_at timestamptz CHECK (isfinite(root_started_at)),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((root_process_id IS NULL AND root_process_start_token IS NULL AND root_started_at IS NULL)
    OR (root_process_id IS NOT NULL AND root_process_start_token IS NOT NULL AND root_started_at IS NOT NULL)),
  CHECK ((actor_kind = 'owner' AND reconciliation_id IS NULL) OR (actor_kind = 'recovery' AND reconciliation_id IS NOT NULL)),
  CHECK ((process_state = 'lost' AND exit_code IS NULL) OR (process_state <> 'lost' AND exit_code IS NOT NULL))
);
CREATE TRIGGER worker_launch_revocations_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON acp.worker_launch_revocations
FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();
CREATE TRIGGER worker_launch_claims_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON acp.worker_launch_claims
FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();
CREATE TRIGGER worker_launch_stops_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON acp.worker_launch_stops
FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE FUNCTION acp.lock_worker_launch(target_run acp.stable_id) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r acp.worker_runs;
BEGIN
  SELECT * INTO STRICT r FROM acp.worker_runs WHERE run_id = target_run;
  PERFORM 1 FROM acp.missions WHERE mission_id = r.mission_id FOR UPDATE;
  PERFORM 1 FROM acp.mission_nodes WHERE node_id = r.node_id FOR UPDATE;
  PERFORM 1 FROM acp.worker_runs WHERE run_id = target_run FOR UPDATE;
  PERFORM 1 FROM acp.worker_host_sessions WHERE host_identifier = r.host_identifier FOR SHARE;
  PERFORM 1 FROM acp.worker_hosts WHERE host_identifier = r.host_identifier FOR SHARE;
  PERFORM 1 FROM acp.worker_launch_intents WHERE run_id = target_run FOR UPDATE;
END;
$$;

CREATE FUNCTION acp.worker_launch_recovery_actor_valid(target_run acp.stable_id, target_provenance acp.stable_id,
  target_session acp.stable_id, target_version text, since_time timestamptz) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS (SELECT 1 FROM acp.worker_launch_intents i JOIN acp.worker_runs r USING (run_id)
    JOIN acp.missions m USING (mission_id) JOIN acp.context_packets packet USING (context_packet_id)
    JOIN acp.worker_host_runtimes rt ON rt.host_identifier = i.host_identifier AND rt.workflow_binding_id = m.workflow_binding_id
      AND rt.session_id = target_session AND rt.application_version = target_version
    JOIN acp.runtime_provenance t ON t.provenance_id = rt.template_provenance_id
    JOIN acp.runtime_provenance p ON p.provenance_id = target_provenance
    JOIN acp.worker_host_session_history session ON session.session_id = target_session
      AND session.host_identifier = i.host_identifier AND session.application_version = target_version
    WHERE i.run_id = target_run AND p.provenance_id <> i.provenance_id
      AND p.recorded_at >= since_time AND p.recorded_at >= session.issued_at AND p.recorded_at <= clock_timestamp()
      AND p.context_packet_digest = packet.digest AND p.context_packet_schema_version = packet.schema_version
      AND acp.runtime_provenance_matches_context(t.provenance_id, r.mission_id)
      AND acp.worker_recovery_runtime_live(r.run_id, i.host_identifier, target_session, target_version)
      AND (to_jsonb(p) - ARRAY['provenance_id', 'recorded_at', 'context_packet_digest', 'context_packet_schema_version'])
        = (to_jsonb(t) - ARRAY['provenance_id', 'recorded_at', 'context_packet_digest', 'context_packet_schema_version']));
$$;

CREATE FUNCTION acp.make_worker_launch_recovery_provenance(target_run acp.stable_id, target_host text,
  target_session acp.stable_id, target_version text) RETURNS acp.stable_id LANGUAGE plpgsql AS $$
DECLARE created acp.stable_id;
BEGIN
  INSERT INTO acp.runtime_provenance
  SELECT (jsonb_populate_record(NULL::acp.runtime_provenance, to_jsonb(t) || jsonb_build_object(
    'provenance_id', 'prv_' || gen_random_uuid(), 'context_packet_schema_version', packet.schema_version::text,
    'context_packet_digest', packet.digest::text, 'recorded_at', clock_timestamp()))).*
  FROM acp.worker_launch_intents i JOIN acp.worker_runs r USING (run_id) JOIN acp.missions m USING (mission_id)
    JOIN acp.context_packets packet USING (context_packet_id)
    JOIN acp.worker_host_runtimes rt ON rt.host_identifier = i.host_identifier AND rt.workflow_binding_id = m.workflow_binding_id
      AND rt.session_id = target_session AND rt.application_version = target_version
    JOIN acp.runtime_provenance t ON t.provenance_id = rt.template_provenance_id
  WHERE i.run_id = target_run AND i.host_identifier = target_host AND r.state = 'started'
    AND (acp.worker_run_owner_retired(r.run_id) OR EXISTS (SELECT 1 FROM acp.worker_launch_revocations WHERE run_id = r.run_id))
    AND acp.worker_recovery_runtime_live(r.run_id, target_host, target_session, target_version)
    AND acp.runtime_provenance_matches_context(t.provenance_id, r.mission_id)
  RETURNING provenance_id INTO created;
  RETURN created;
END;
$$;

CREATE FUNCTION acp.validate_worker_launch_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i acp.worker_launch_intents; r acp.worker_runs;
BEGIN
  PERFORM acp.lock_worker_launch(NEW.run_id);
  SELECT * INTO STRICT i FROM acp.worker_launch_intents WHERE run_id = NEW.run_id;
  SELECT * INTO STRICT r FROM acp.worker_runs WHERE run_id = NEW.run_id;
  PERFORM worker_process_id FROM acp.worker_processes WHERE run_id = NEW.run_id ORDER BY worker_process_id FOR UPDATE;
  IF r.state <> 'started' THEN RAISE EXCEPTION 'terminal launch cannot be revoked'; END IF;
  IF NEW.reason = 'manager_dispatch_ended_without_result' THEN
    IF NEW.owner_session_id <> i.owner_session_id OR NEW.application_version <> i.application_version
      OR NEW.provenance_id <> i.provenance_id
      OR NOT acp.worker_recovery_runtime_live(i.run_id, i.host_identifier, i.owner_session_id, i.application_version) THEN
      RAISE EXCEPTION 'launch handoff requires its exact original live owner';
    END IF;
  ELSIF NEW.reason = 'original_owner_retired' THEN
    IF NOT acp.worker_run_owner_retired(NEW.run_id)
      OR NOT acp.worker_launch_recovery_actor_valid(NEW.run_id, NEW.provenance_id, NEW.owner_session_id, NEW.application_version, i.admitted_at) THEN
      RAISE EXCEPTION 'launch retirement requires a fresh current recovery actor';
    END IF;
  ELSE RAISE EXCEPTION 'invalid launch revocation reason';
  END IF;
  NEW.revoked_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER worker_launch_revocations_validate BEFORE INSERT ON acp.worker_launch_revocations
FOR EACH ROW EXECUTE FUNCTION acp.validate_worker_launch_revocation();

CREATE FUNCTION acp.validate_worker_launch_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revoked timestamptz;
BEGIN
  PERFORM acp.lock_worker_launch(NEW.run_id);
  SELECT revoked_at INTO revoked FROM acp.worker_launch_revocations WHERE run_id = NEW.run_id;
  IF revoked IS NULL OR NOT EXISTS (SELECT 1 FROM acp.worker_runs WHERE run_id = NEW.run_id AND state = 'started')
    OR EXISTS (SELECT 1 FROM acp.worker_launch_stops WHERE run_id = NEW.run_id)
    OR EXISTS (SELECT 1 FROM acp.worker_launch_claims WHERE run_id = NEW.run_id AND expires_at > clock_timestamp())
    OR NOT acp.worker_launch_recovery_actor_valid(NEW.run_id, NEW.provenance_id, NEW.owner_session_id, NEW.application_version, revoked) THEN
    RAISE EXCEPTION 'launch claim requires exclusive fresh revoked-run recovery authority';
  END IF;
  NEW.claimed_at := clock_timestamp();
  NEW.expires_at := NEW.claimed_at + interval '20 seconds';
  RETURN NEW;
END;
$$;
CREATE TRIGGER worker_launch_claims_validate BEFORE INSERT ON acp.worker_launch_claims
FOR EACH ROW EXECUTE FUNCTION acp.validate_worker_launch_claim();

CREATE FUNCTION acp.worker_launch_claim_held(target_run acp.stable_id, target_claim acp.stable_id,
  target_provenance acp.stable_id) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE c acp.worker_launch_claims; i acp.worker_launch_intents; revoked timestamptz; lock_key bigint;
BEGIN
  SELECT * INTO c FROM acp.worker_launch_claims WHERE reconciliation_id = target_claim AND run_id = target_run;
  SELECT * INTO i FROM acp.worker_launch_intents WHERE run_id = target_run;
  SELECT revoked_at INTO revoked FROM acp.worker_launch_revocations WHERE run_id = target_run;
  IF c.reconciliation_id IS NULL OR i.run_id IS NULL OR revoked IS NULL OR c.provenance_id <> target_provenance
    OR c.expires_at <= clock_timestamp()
    OR NOT acp.worker_launch_recovery_actor_valid(target_run, target_provenance, c.owner_session_id, c.application_version, revoked) THEN RETURN false; END IF;
  lock_key := hashtextextended('acp:worker-launch-reconciliation:' || i.worker_process_id::text, 0);
  RETURN EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
    AND classid = ((lock_key >> 32) & 4294967295)::oid AND objid = (lock_key & 4294967295)::oid AND objsubid = 1);
END;
$$;

CREATE FUNCTION acp.validate_worker_launch_stop() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i acp.worker_launch_intents; p acp.worker_processes; c acp.worker_launch_claims;
BEGIN
  PERFORM acp.lock_worker_launch(NEW.run_id);
  SELECT * INTO STRICT i FROM acp.worker_launch_intents WHERE run_id = NEW.run_id;
  IF NOT EXISTS (SELECT 1 FROM acp.worker_runs WHERE run_id = NEW.run_id AND state = 'started') THEN
    RAISE EXCEPTION 'terminal launch winner cannot receive new stop evidence';
  END IF;
  SELECT * INTO p FROM acp.worker_processes WHERE worker_process_id = i.worker_process_id FOR UPDATE;
  IF p.worker_process_id IS NOT NULL AND (p.run_id <> i.run_id OR p.supervision_scope <> i.supervision_scope
    OR p.tree_identifier <> i.tree_identifier OR NEW.root_process_id IS DISTINCT FROM p.process_id
    OR NEW.root_process_start_token IS DISTINCT FROM p.process_start_token) THEN
    RAISE EXCEPTION 'launch stop root does not match its exact journal';
  END IF;
  IF NEW.actor_kind = 'owner' THEN
    IF EXISTS (SELECT 1 FROM acp.worker_launch_revocations WHERE run_id = NEW.run_id)
      OR NEW.owner_session_id <> i.owner_session_id OR NEW.application_version <> i.application_version
      OR NEW.provenance_id <> i.provenance_id OR NEW.root_process_id IS NULL
      OR p.worker_process_id IS NULL OR p.state NOT IN ('exited', 'terminated')
      OR p.state <> NEW.process_state OR p.exit_code IS DISTINCT FROM NEW.exit_code
      OR p.transition_provenance_id <> i.provenance_id OR NEW.reason <> 'owner_tree_closed_and_launch_sealed'
      OR NOT acp.worker_recovery_runtime_live(i.run_id, i.host_identifier, i.owner_session_id, i.application_version) THEN
      RAISE EXCEPTION 'owner launch stop requires its exact live unrevoked stopped journal';
    END IF;
  ELSIF NEW.actor_kind = 'recovery' THEN
    SELECT * INTO c FROM acp.worker_launch_claims WHERE reconciliation_id = NEW.reconciliation_id;
    IF NEW.owner_session_id IS DISTINCT FROM c.owner_session_id OR NEW.application_version IS DISTINCT FROM c.application_version
      OR NOT acp.worker_launch_claim_held(NEW.run_id, NEW.reconciliation_id, NEW.provenance_id) THEN
      RAISE EXCEPTION 'launch stop requires its exact held live recovery claim';
    END IF;
    IF NOT ((NEW.process_state = 'terminated' AND NEW.reason = 'exact_owned_tree_terminated' AND NEW.exit_code IS NOT NULL AND NEW.root_process_id IS NOT NULL)
      OR (NEW.process_state = 'lost' AND NEW.exit_code IS NULL AND
        ((NEW.reason IN ('sealed_launch_job_absent', 'sealed_launch_job_empty') AND NEW.root_process_id IS NULL)
          OR (NEW.reason IN ('owned_job_and_original_root_absent', 'owned_job_empty') AND NEW.root_process_id IS NOT NULL)))) THEN
      RAISE EXCEPTION 'launch recovery requires a supported native seal and stop observation';
    END IF;
    IF p.worker_process_id IS NOT NULL AND p.state = 'running' THEN
      UPDATE acp.worker_processes SET state = NEW.process_state, exit_code = NEW.exit_code,
        completed_at = clock_timestamp(), termination_reason = NEW.reason, transition_provenance_id = NEW.provenance_id
        WHERE worker_process_id = p.worker_process_id;
    END IF;
  ELSE RAISE EXCEPTION 'invalid launch stop actor';
  END IF;
  IF EXISTS (SELECT 1 FROM acp.worker_processes WHERE run_id = NEW.run_id AND state = 'running') THEN
    RAISE EXCEPTION 'launch stop cannot leave a running journal';
  END IF;
  NEW.observed_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER worker_launch_stops_validate BEFORE INSERT ON acp.worker_launch_stops
FOR EACH ROW EXECUTE FUNCTION acp.validate_worker_launch_stop();

CREATE FUNCTION acp.require_launch_receipt_commit_authority() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i acp.worker_launch_intents;
BEGIN
  IF NEW.actor_kind = 'recovery' THEN
    IF NOT acp.worker_launch_claim_held(NEW.run_id, NEW.reconciliation_id, NEW.provenance_id) THEN
      RAISE EXCEPTION 'launch receipt claim expired before commit';
    END IF;
  ELSE
    SELECT * INTO STRICT i FROM acp.worker_launch_intents WHERE run_id = NEW.run_id;
    IF EXISTS (SELECT 1 FROM acp.worker_launch_revocations WHERE run_id = NEW.run_id)
      OR NOT acp.worker_recovery_runtime_live(i.run_id, i.host_identifier, i.owner_session_id, i.application_version) THEN
      RAISE EXCEPTION 'launch owner receipt authority ended before commit';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER worker_launch_stops_commit_authority AFTER INSERT ON acp.worker_launch_stops
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acp.require_launch_receipt_commit_authority();

CREATE FUNCTION acp.audit_worker_launch_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt jsonb; observed timestamptz; receipt_key text;
BEGIN
  receipt := to_jsonb(NEW);
  observed := coalesce((receipt ->> 'revoked_at')::timestamptz, (receipt ->> 'claimed_at')::timestamptz, (receipt ->> 'observed_at')::timestamptz);
  receipt_key := coalesce(receipt ->> 'reconciliation_id', NEW.run_id::text);
  INSERT INTO acp.mission_events(event_id, mission_id, event_type, event_version, idempotency_key,
    event_digest, payload, occurred_at, provenance_id)
  SELECT ('evt_' || gen_random_uuid())::acp.stable_id, r.mission_id, TG_ARGV[0], '1.0.0', receipt_key,
    acp.jsonb_sha256(receipt), receipt, observed, NEW.provenance_id FROM acp.worker_runs r WHERE r.run_id = NEW.run_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER worker_launch_revocations_audit AFTER INSERT ON acp.worker_launch_revocations
FOR EACH ROW EXECUTE FUNCTION acp.audit_worker_launch_recovery('worker.launch-revoked');
CREATE TRIGGER worker_launch_claims_audit AFTER INSERT ON acp.worker_launch_claims
FOR EACH ROW EXECUTE FUNCTION acp.audit_worker_launch_recovery('worker.launch-claimed');
CREATE TRIGGER worker_launch_stops_audit AFTER INSERT ON acp.worker_launch_stops
FOR EACH ROW EXECUTE FUNCTION acp.audit_worker_launch_recovery('worker.launch-stopped');

ALTER FUNCTION acp.handoff_worker_run(acp.stable_id, integer, text, acp.stable_id, text) RENAME TO handoff_worker_run_legacy;
CREATE FUNCTION acp.handoff_worker_run(target_run acp.stable_id, target_generation integer,
  target_host text, target_session acp.stable_id, target_version text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r acp.worker_runs; i acp.worker_launch_intents;
BEGIN
  SELECT * INTO r FROM acp.worker_runs WHERE run_id = target_run;
  IF NOT FOUND THEN RETURN 'obsolete'; END IF;
  IF r.launch_worker_process_id IS NULL THEN
    RETURN acp.handoff_worker_run_legacy(target_run, target_generation, target_host, target_session, target_version);
  END IF;
  PERFORM acp.lock_worker_launch(target_run);
  SELECT * INTO STRICT r FROM acp.worker_runs WHERE run_id = target_run;
  SELECT * INTO STRICT i FROM acp.worker_launch_intents WHERE run_id = target_run;
  IF i.generation <> target_generation OR i.host_identifier <> target_host
    OR i.owner_session_id <> target_session OR i.application_version <> target_version THEN RETURN 'obsolete'; END IF;
  IF r.state <> 'started' THEN RETURN 'terminal'; END IF;
  IF EXISTS (SELECT 1 FROM acp.worker_launch_revocations WHERE run_id = target_run) THEN RETURN 'handed_off'; END IF;
  IF NOT acp.worker_recovery_runtime_live(target_run, target_host, target_session, target_version) THEN RETURN 'obsolete'; END IF;
  INSERT INTO acp.worker_launch_revocations(run_id, owner_session_id, application_version, provenance_id, reason)
    VALUES(target_run, target_session, target_version, i.provenance_id, 'manager_dispatch_ended_without_result');
  RETURN 'handed_off';
END;
$$;

-- Keep the original function for exact producer rollback, not a copied body.
ALTER FUNCTION acp.fence_worker_launch_journal() RENAME TO fence_worker_launch_journal_0011;
CREATE FUNCTION acp.fence_worker_launch_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i acp.worker_launch_intents; marker acp.stable_id;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('acp:worker-launch-identity:' || NEW.worker_process_id::text, 0));
    IF EXISTS (SELECT 1 FROM acp.worker_launch_intents WHERE worker_process_id = NEW.worker_process_id AND run_id <> NEW.run_id) THEN
      RAISE EXCEPTION 'process identity is already reserved by a launch intent';
    END IF;
  END IF;
  SELECT launch_worker_process_id INTO marker FROM acp.worker_runs WHERE run_id = NEW.run_id;
  IF marker IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO i FROM acp.worker_launch_intents WHERE run_id = NEW.run_id;
  IF NOT FOUND OR NEW.worker_process_id <> marker OR NEW.supervision_kind IS DISTINCT FROM 'windows_job'
    OR NEW.tree_identifier IS DISTINCT FROM i.tree_identifier OR NEW.supervision_scope IS DISTINCT FROM i.supervision_scope THEN
    RAISE EXCEPTION 'process journal does not match its durable launch intent';
  END IF;
  IF NEW.reconciliation_id IS NOT NULL OR NEW.reconciliation_owner IS NOT NULL OR NEW.reconciliation_provenance_id IS NOT NULL
    OR NEW.reconciliation_claimed_at IS NOT NULL OR NEW.reconciliation_claim_expires_at IS NOT NULL THEN
    RAISE EXCEPTION 'launch intent cannot use the legacy process recovery lane';
  END IF;
  IF EXISTS (SELECT 1 FROM acp.worker_launch_revocations WHERE run_id = NEW.run_id) THEN
    IF TG_OP = 'INSERT' THEN RAISE EXCEPTION 'revoked launch cannot admit a late journal'; END IF;
    IF OLD.state = 'running' AND NEW.state IN ('lost', 'terminated') AND EXISTS (SELECT 1 FROM acp.worker_launch_claims c
      WHERE c.run_id = NEW.run_id AND c.provenance_id = NEW.transition_provenance_id
        AND acp.worker_launch_claim_held(NEW.run_id, c.reconciliation_id, NEW.transition_provenance_id)) THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'revoked launch owner cannot heartbeat or finish';
  END IF;
  IF NEW.transition_provenance_id <> i.provenance_id
    OR NOT acp.worker_recovery_runtime_live(i.run_id, i.host_identifier, i.owner_session_id, i.application_version) THEN
    RAISE EXCEPTION 'launch mutation requires its original live owner provenance';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER worker_processes_ad_launch_intent ON acp.worker_processes;
CREATE TRIGGER worker_processes_ad_launch_intent BEFORE INSERT OR UPDATE ON acp.worker_processes
FOR EACH ROW EXECUTE FUNCTION acp.fence_worker_launch_journal();

CREATE FUNCTION acp.require_launch_process_stop_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'running' AND EXISTS (SELECT 1 FROM acp.worker_launch_intents WHERE run_id = NEW.run_id)
    AND NOT EXISTS (SELECT 1 FROM acp.worker_launch_stops s WHERE s.run_id = NEW.run_id
      AND s.root_process_id = NEW.process_id AND s.root_process_start_token = NEW.process_start_token
      AND s.process_state = NEW.state AND s.exit_code IS NOT DISTINCT FROM NEW.exit_code
      AND s.provenance_id = NEW.transition_provenance_id) THEN
    RAISE EXCEPTION 'intent process completion and sealed stop receipt must commit together';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER worker_processes_require_launch_receipt AFTER UPDATE ON acp.worker_processes
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acp.require_launch_process_stop_receipt();

ALTER FUNCTION acp.worker_launch_stop_confirmed(acp.stable_id) RENAME TO worker_launch_stop_confirmed_0011;
CREATE FUNCTION acp.worker_launch_stop_confirmed(target_run acp.stable_id) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT NOT EXISTS (SELECT 1 FROM acp.worker_runs WHERE run_id = target_run AND launch_worker_process_id IS NOT NULL)
    OR (EXISTS (SELECT 1 FROM acp.worker_launch_stops WHERE run_id = target_run)
      AND NOT EXISTS (SELECT 1 FROM acp.worker_processes WHERE run_id = target_run AND state = 'running'))
    -- Already-terminal 0011 history is not retroactively deprived of stop evidence.
    OR (EXISTS (SELECT 1 FROM acp.worker_runs WHERE run_id = target_run AND state <> 'started')
      AND acp.worker_launch_stop_confirmed_0011(target_run));
$$;

ALTER FUNCTION acp.require_worker_launch_stop() RENAME TO require_worker_launch_stop_0011;
CREATE FUNCTION acp.require_worker_launch_stop() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i acp.worker_launch_intents; revoked timestamptz; s acp.worker_host_sessions;
BEGIN
  IF TG_TABLE_NAME = 'worker_runs' THEN
    IF NEW.launch_worker_process_id IS NOT NULL AND NEW.state <> 'started' THEN
      SELECT * INTO STRICT i FROM acp.worker_launch_intents WHERE run_id = NEW.run_id;
      SELECT * INTO STRICT s FROM acp.worker_host_sessions WHERE host_identifier = i.host_identifier FOR SHARE;
      PERFORM 1 FROM acp.worker_hosts WHERE host_identifier = i.host_identifier FOR SHARE;
      SELECT revoked_at INTO revoked FROM acp.worker_launch_revocations WHERE run_id = NEW.run_id;
      IF revoked IS NULL THEN
        IF NEW.transition_provenance_id <> i.provenance_id
          OR NOT acp.worker_recovery_runtime_live(i.run_id, i.host_identifier, i.owner_session_id, i.application_version) THEN
          RAISE EXCEPTION 'launch result requires its original live owner provenance';
        END IF;
      ELSIF NEW.state NOT IN ('failed', 'cancelled')
        OR NOT acp.worker_launch_recovery_actor_valid(NEW.run_id, NEW.transition_provenance_id, s.session_id, s.application_version, revoked) THEN
        RAISE EXCEPTION 'revoked launch requires a fresh current recovery failure result';
      END IF;
      -- Do not use NEW.state to activate the historical terminal fallback.
      IF NOT EXISTS (SELECT 1 FROM acp.worker_launch_stops WHERE run_id = NEW.run_id)
        OR EXISTS (SELECT 1 FROM acp.worker_processes WHERE run_id = NEW.run_id AND state = 'running') THEN
        RAISE EXCEPTION 'worker run requires durable sealed launch stop evidence';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'mission_nodes' THEN
    IF OLD.state = 'running' AND NEW.state <> 'running' AND EXISTS (SELECT 1 FROM acp.worker_runs r
      WHERE r.node_id = NEW.node_id AND NOT acp.worker_launch_stop_confirmed(r.run_id)) THEN
      RAISE EXCEPTION 'mission node has an unresolved worker launch intent';
    END IF;
  ELSE
    IF OLD.state <> NEW.state AND NEW.state IN ('complete_for_scope', 'failed', 'cancelled')
      AND EXISTS (SELECT 1 FROM acp.worker_runs r WHERE r.mission_id = NEW.mission_id AND NOT acp.worker_launch_stop_confirmed(r.run_id)) THEN
      RAISE EXCEPTION 'mission has an unresolved worker launch intent';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER worker_runs_ab_launch_stop ON acp.worker_runs;
DROP TRIGGER mission_nodes_require_launch_stop ON acp.mission_nodes;
DROP TRIGGER missions_require_launch_stop ON acp.missions;
CREATE TRIGGER worker_runs_ab_launch_stop BEFORE UPDATE ON acp.worker_runs FOR EACH ROW EXECUTE FUNCTION acp.require_worker_launch_stop();
CREATE TRIGGER mission_nodes_require_launch_stop BEFORE UPDATE OF state ON acp.mission_nodes FOR EACH ROW EXECUTE FUNCTION acp.require_worker_launch_stop();
CREATE TRIGGER missions_require_launch_stop BEFORE UPDATE OF state ON acp.missions FOR EACH ROW EXECUTE FUNCTION acp.require_worker_launch_stop();
