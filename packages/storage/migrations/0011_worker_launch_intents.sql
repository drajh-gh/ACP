-- Transaction ownership belongs to the migration runner. Legacy runs stay legacy.
ALTER TABLE acp.worker_runs ADD COLUMN launch_worker_process_id acp.stable_id
  CHECK (launch_worker_process_id::text ~ '^wpr_');

CREATE TABLE acp.worker_launch_intents (
  run_id acp.stable_id PRIMARY KEY REFERENCES acp.worker_runs(run_id),
  worker_process_id acp.stable_id NOT NULL UNIQUE CHECK (worker_process_id::text ~ '^wpr_'),
  protocol text NOT NULL CHECK (protocol = 'windows_fence_v1'),
  generation integer NOT NULL CHECK (generation > 0),
  host_identifier text NOT NULL,
  owner_session_id acp.stable_id NOT NULL,
  application_version text NOT NULL,
  provenance_id acp.stable_id NOT NULL REFERENCES acp.runtime_provenance(provenance_id),
  directory_path text NOT NULL,
  directory_identity text NOT NULL CHECK (directory_identity ~ '^win32-dir:[0-9a-f]{8}:[0-9a-f]{16}$'),
  supervision_scope jsonb NOT NULL,
  tree_identifier text NOT NULL CHECK (tree_identifier = 'Local\ACP.Worker.' || worker_process_id::text),
  deadline_at timestamptz NOT NULL,
  admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, worker_process_id)
);
CREATE INDEX worker_launch_intents_by_owner ON acp.worker_launch_intents(host_identifier, owner_session_id, worker_process_id);

-- A committed intent-mode run must have its exact immutable intent. The existing
-- worker_runs_protect_identity trigger also protects NULL -> WPR after admission.
ALTER TABLE acp.worker_runs ADD CONSTRAINT worker_runs_launch_intent
  FOREIGN KEY (run_id, launch_worker_process_id)
  REFERENCES acp.worker_launch_intents(run_id, worker_process_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TRIGGER worker_launch_intents_are_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON acp.worker_launch_intents
FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE FUNCTION acp.validate_worker_launch_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r acp.worker_runs; a acp.worker_dispatch_assignments; v text;
BEGIN
  SELECT * INTO STRICT r FROM acp.worker_runs WHERE run_id = NEW.run_id;
  PERFORM 1 FROM acp.missions WHERE mission_id = r.mission_id FOR UPDATE;
  PERFORM 1 FROM acp.mission_nodes WHERE node_id = r.node_id FOR UPDATE;
  SELECT * INTO STRICT r FROM acp.worker_runs WHERE run_id = NEW.run_id FOR UPDATE;
  PERFORM 1 FROM acp.worker_host_sessions WHERE host_identifier = r.host_identifier FOR SHARE;
  PERFORM 1 FROM acp.worker_hosts WHERE host_identifier = r.host_identifier FOR SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended('acp:worker-launch-identity:' || NEW.worker_process_id::text, 0));
  IF EXISTS (SELECT 1 FROM acp.worker_processes WHERE worker_process_id = NEW.worker_process_id) THEN
    RAISE EXCEPTION 'launch identity is already reserved by a process journal';
  END IF;
  SELECT * INTO STRICT a FROM acp.worker_dispatch_assignments
    WHERE run_id = r.run_id AND generation = r.dispatch_generation;
  SELECT application_version INTO STRICT v FROM acp.worker_dispatches WHERE run_id = r.run_id;
  IF r.state <> 'started' OR r.launch_worker_process_id IS DISTINCT FROM NEW.worker_process_id
    OR r.timeout_at <= clock_timestamp()
    OR NOT acp.worker_recovery_runtime_live(r.run_id, r.host_identifier, a.host_session_id, v)
    OR acp.worker_cancellation_requested(r.mission_id, (SELECT graph_revision FROM acp.mission_nodes WHERE node_id = r.node_id))
    OR EXISTS (SELECT 1 FROM acp.worker_processes WHERE run_id = r.run_id) THEN
    RAISE EXCEPTION 'launch intent requires exact newly admitted current-owner run authority';
  END IF;
  IF length(NEW.directory_path) > 4096 OR NEW.directory_path !~ '^[A-Za-z]:\\[^\\]'
    OR NEW.directory_path ~ '[[:cntrl:]]'
    OR (jsonb_typeof(NEW.supervision_scope) = 'object'
      AND NEW.supervision_scope ?& ARRAY['machineFingerprint', 'bootedAt', 'sessionId']
      AND NEW.supervision_scope - ARRAY['machineFingerprint', 'bootedAt', 'sessionId'] = '{}'::jsonb
      AND jsonb_typeof(NEW.supervision_scope -> 'machineFingerprint') = 'string'
      AND NEW.supervision_scope ->> 'machineFingerprint' ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof(NEW.supervision_scope -> 'bootedAt') = 'string'
      AND (NEW.supervision_scope ->> 'bootedAt')::timestamptz >= '2000-01-01Z'::timestamptz
      AND (NEW.supervision_scope ->> 'bootedAt')::timestamptz <= r.started_at
      AND jsonb_typeof(NEW.supervision_scope -> 'sessionId') = 'number'
      AND NEW.supervision_scope ->> 'sessionId' ~ '^[0-9]{1,10}$'
      AND (NEW.supervision_scope ->> 'sessionId')::bigint <= 2147483647) IS NOT TRUE THEN
    RAISE EXCEPTION 'launch intent requires exact local directory and OS scope';
  END IF;
  -- These are database authority, never caller-supplied observations.
  NEW.generation := r.dispatch_generation;
  NEW.host_identifier := r.host_identifier;
  NEW.owner_session_id := a.host_session_id;
  NEW.application_version := v;
  NEW.provenance_id := r.provenance_id;
  NEW.tree_identifier := 'Local\ACP.Worker.' || NEW.worker_process_id::text;
  NEW.deadline_at := r.timeout_at;
  NEW.admitted_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER worker_launch_intents_validate BEFORE INSERT ON acp.worker_launch_intents
FOR EACH ROW EXECUTE FUNCTION acp.validate_worker_launch_intent();

CREATE FUNCTION acp.audit_worker_launch_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt jsonb;
BEGIN
  receipt := to_jsonb(NEW);
  INSERT INTO acp.mission_events(event_id, mission_id, event_type, event_version,
    idempotency_key, event_digest, payload, occurred_at, provenance_id)
  SELECT ('evt_' || gen_random_uuid())::acp.stable_id, r.mission_id, 'worker.launch-admitted', '1.0.0',
    NEW.run_id::text, acp.jsonb_sha256(receipt), receipt, NEW.admitted_at, NEW.provenance_id
    FROM acp.worker_runs r WHERE r.run_id = NEW.run_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER worker_launch_intents_audit AFTER INSERT ON acp.worker_launch_intents
FOR EACH ROW EXECUTE FUNCTION acp.audit_worker_launch_intent();

CREATE FUNCTION acp.fence_worker_launch_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i acp.worker_launch_intents; marker acp.stable_id;
BEGIN
  -- INSERT's earlier supervised-admission trigger already holds canonical parent
  -- locks. UPDATE must not acquire run locks after its process row lock.
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('acp:worker-launch-identity:' || NEW.worker_process_id::text, 0));
    IF EXISTS (SELECT 1 FROM acp.worker_launch_intents WHERE worker_process_id = NEW.worker_process_id AND run_id <> NEW.run_id) THEN
      RAISE EXCEPTION 'process identity is already reserved by a launch intent';
    END IF;
  END IF;
  SELECT launch_worker_process_id INTO marker FROM acp.worker_runs WHERE run_id = NEW.run_id;
  IF marker IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO i FROM acp.worker_launch_intents WHERE run_id = NEW.run_id;
  IF NOT FOUND OR NEW.worker_process_id <> marker
    OR NEW.supervision_kind IS DISTINCT FROM 'windows_job'
    OR NEW.tree_identifier IS DISTINCT FROM i.tree_identifier
    OR NEW.supervision_scope IS DISTINCT FROM i.supervision_scope THEN
    RAISE EXCEPTION 'process journal does not match its durable launch intent';
  END IF;
  IF NEW.reconciliation_id IS NOT NULL THEN
    RAISE EXCEPTION 'launch intent cannot use the legacy process recovery lane';
  END IF;
  IF NEW.transition_provenance_id <> i.provenance_id
    OR NOT acp.worker_recovery_runtime_live(i.run_id, i.host_identifier, i.owner_session_id, i.application_version) THEN
    RAISE EXCEPTION 'launch mutation requires its original live owner provenance';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER worker_processes_ad_launch_intent BEFORE INSERT OR UPDATE ON acp.worker_processes
FOR EACH ROW EXECUTE FUNCTION acp.fence_worker_launch_journal();

-- This foundation is deliberately not enabled by the manager/transport. A later
-- recovery migration supplies durable seal/stop evidence for missing journals.
-- For now only the exact existing terminal journal can discharge an intent.
CREATE FUNCTION acp.worker_launch_stop_confirmed(target_run acp.stable_id) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT NOT EXISTS (SELECT 1 FROM acp.worker_runs WHERE run_id = target_run AND launch_worker_process_id IS NOT NULL)
    OR (EXISTS (SELECT 1 FROM acp.worker_launch_intents i JOIN acp.worker_processes p USING (worker_process_id)
      WHERE i.run_id = target_run AND p.run_id = i.run_id AND p.state <> 'running'
        AND p.supervision_kind = 'windows_job' AND p.tree_identifier = i.tree_identifier
        AND p.supervision_scope = i.supervision_scope)
      AND NOT EXISTS (SELECT 1 FROM acp.worker_processes WHERE run_id = target_run AND state = 'running'));
$$;
CREATE FUNCTION acp.require_worker_launch_stop() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i acp.worker_launch_intents;
BEGIN
  IF TG_TABLE_NAME = 'worker_runs' THEN
    IF NEW.launch_worker_process_id IS NOT NULL AND NEW.state <> 'started' THEN
      SELECT * INTO STRICT i FROM acp.worker_launch_intents WHERE run_id = NEW.run_id;
      PERFORM 1 FROM acp.worker_host_sessions WHERE host_identifier = i.host_identifier FOR SHARE;
      PERFORM 1 FROM acp.worker_hosts WHERE host_identifier = i.host_identifier FOR SHARE;
      IF NEW.transition_provenance_id <> i.provenance_id
        OR NOT acp.worker_recovery_runtime_live(i.run_id, i.host_identifier, i.owner_session_id, i.application_version) THEN
        RAISE EXCEPTION 'launch result requires its original live owner provenance';
      END IF;
    END IF;
    IF NEW.state <> 'started' AND NOT acp.worker_launch_stop_confirmed(NEW.run_id) THEN
      RAISE EXCEPTION 'worker run requires exact launch stop evidence';
    END IF;
  ELSIF TG_TABLE_NAME = 'mission_nodes' THEN
    IF OLD.state = 'running' AND NEW.state <> 'running' AND EXISTS (SELECT 1 FROM acp.worker_runs r
      WHERE r.node_id = NEW.node_id AND NOT acp.worker_launch_stop_confirmed(r.run_id)) THEN
      RAISE EXCEPTION 'mission node has an unresolved worker launch intent';
    END IF;
  ELSE
    IF OLD.state <> NEW.state AND NEW.state IN ('complete_for_scope', 'failed', 'cancelled')
      AND EXISTS (SELECT 1 FROM acp.worker_runs r WHERE r.mission_id = NEW.mission_id
        AND NOT acp.worker_launch_stop_confirmed(r.run_id)) THEN
      RAISE EXCEPTION 'mission has an unresolved worker launch intent';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER worker_runs_ab_launch_stop BEFORE UPDATE ON acp.worker_runs
FOR EACH ROW EXECUTE FUNCTION acp.require_worker_launch_stop();
CREATE TRIGGER mission_nodes_require_launch_stop BEFORE UPDATE OF state ON acp.mission_nodes
FOR EACH ROW EXECUTE FUNCTION acp.require_worker_launch_stop();
CREATE TRIGGER missions_require_launch_stop BEFORE UPDATE OF state ON acp.missions
FOR EACH ROW EXECUTE FUNCTION acp.require_worker_launch_stop();

CREATE FUNCTION acp.deny_legacy_launch_handoff() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM acp.worker_runs WHERE run_id = NEW.run_id AND launch_worker_process_id IS NOT NULL) THEN
    RAISE EXCEPTION 'launch intent requires its own revocation and recovery lane';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER worker_run_recovery_handoffs_aa_launch BEFORE INSERT ON acp.worker_run_recovery_handoffs
FOR EACH ROW EXECUTE FUNCTION acp.deny_legacy_launch_handoff();

-- Authority-changing writes serialize with process mutations without adding
-- process -> parent locks. Heartbeat-only updates do not need this fence.
CREATE FUNCTION acp.fence_launch_owner_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'worker_host_sessions' THEN
    IF NEW.session_id = OLD.session_id AND NEW.state = OLD.state THEN RETURN NEW; END IF;
    -- registerRuntime changes host configuration after changing its session.
    -- Take this lock first to preserve session -> host -> process ordering.
    PERFORM 1 FROM acp.worker_hosts WHERE host_identifier = OLD.host_identifier FOR UPDATE;
    PERFORM p.worker_process_id FROM acp.worker_processes p JOIN acp.worker_launch_intents i USING (worker_process_id)
      WHERE i.host_identifier = OLD.host_identifier AND i.owner_session_id = OLD.session_id
      ORDER BY p.worker_process_id FOR UPDATE OF p;
  ELSE
    IF NEW.state = OLD.state AND NEW.heartbeat_ttl_seconds >= OLD.heartbeat_ttl_seconds THEN RETURN NEW; END IF;
    PERFORM p.worker_process_id FROM acp.worker_processes p JOIN acp.worker_launch_intents i USING (worker_process_id)
      WHERE i.host_identifier = OLD.host_identifier ORDER BY p.worker_process_id FOR UPDATE OF p;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER worker_host_sessions_zz_launch_retirement BEFORE UPDATE ON acp.worker_host_sessions
FOR EACH ROW EXECUTE FUNCTION acp.fence_launch_owner_retirement();
CREATE TRIGGER worker_hosts_zz_launch_retirement BEFORE UPDATE ON acp.worker_hosts
FOR EACH ROW EXECUTE FUNCTION acp.fence_launch_owner_retirement();
CREATE TRIGGER worker_host_sessions_deny_truncate BEFORE TRUNCATE ON acp.worker_host_sessions
FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();
CREATE TRIGGER worker_host_runtimes_deny_truncate BEFORE TRUNCATE ON acp.worker_host_runtimes
FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();
