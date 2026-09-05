-- Transaction ownership belongs to the migration runner.
-- A handoff yields one journaled execution, never the host or its other runs.
CREATE TABLE acp.worker_run_recovery_handoffs (
  run_id acp.stable_id PRIMARY KEY REFERENCES acp.worker_runs(run_id),
  worker_process_id acp.stable_id NOT NULL REFERENCES acp.worker_processes(worker_process_id),
  generation integer NOT NULL CHECK (generation > 0),
  host_identifier text NOT NULL,
  owner_session_id acp.stable_id NOT NULL,
  application_version text NOT NULL,
  provenance_id acp.stable_id NOT NULL REFERENCES acp.runtime_provenance(provenance_id),
  reason text NOT NULL CHECK (reason = 'manager_dispatch_ended_without_result'),
  handed_off_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE TRIGGER worker_run_recovery_handoffs_are_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON acp.worker_run_recovery_handoffs
FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE FUNCTION acp.worker_run_handed_off(target_run acp.stable_id) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS (SELECT 1 FROM acp.worker_run_recovery_handoffs WHERE run_id = target_run);
$$;
CREATE FUNCTION acp.worker_run_recovery_eligible(target_run acp.stable_id) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT acp.worker_run_owner_retired(target_run) OR acp.worker_run_handed_off(target_run);
$$;

CREATE FUNCTION acp.validate_worker_run_handoff() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r acp.worker_runs;
BEGIN
  SELECT * INTO STRICT r FROM acp.worker_runs WHERE run_id = NEW.run_id;
  PERFORM 1 FROM acp.missions WHERE mission_id = r.mission_id FOR UPDATE;
  PERFORM 1 FROM acp.mission_nodes WHERE node_id = r.node_id FOR UPDATE;
  SELECT * INTO STRICT r FROM acp.worker_runs WHERE run_id = NEW.run_id FOR UPDATE;
  PERFORM 1 FROM acp.worker_host_sessions WHERE host_identifier = r.host_identifier FOR SHARE;
  PERFORM 1 FROM acp.worker_hosts WHERE host_identifier = r.host_identifier FOR SHARE;
  -- Serialize ordinary process UPDATE with the marker, without process->run locks.
  PERFORM 1 FROM acp.worker_processes WHERE run_id = r.run_id ORDER BY worker_process_id FOR UPDATE;
  IF r.state <> 'started' OR NEW.generation <> r.dispatch_generation
    OR NEW.host_identifier <> r.host_identifier OR NEW.provenance_id <> r.provenance_id
    OR NOT EXISTS (SELECT 1 FROM acp.worker_dispatch_assignments a JOIN acp.worker_dispatches d USING (run_id)
      WHERE a.run_id = r.run_id AND a.generation = r.dispatch_generation
        AND a.host_identifier = NEW.host_identifier AND a.host_session_id = NEW.owner_session_id
        AND d.application_version = NEW.application_version)
    OR NOT acp.worker_recovery_runtime_live(r.run_id, NEW.host_identifier, NEW.owner_session_id, NEW.application_version)
    OR NOT EXISTS (SELECT 1 FROM acp.worker_processes p WHERE p.worker_process_id = NEW.worker_process_id
      AND p.run_id = r.run_id AND p.supervision_kind = 'windows_job') THEN
    RAISE EXCEPTION 'handoff requires the exact current owner and journaled started run';
  END IF;
  NEW.handed_off_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER worker_run_recovery_handoffs_validate BEFORE INSERT ON acp.worker_run_recovery_handoffs
FOR EACH ROW EXECUTE FUNCTION acp.validate_worker_run_handoff();

-- Preserve an audit receipt independently of the projection table on downgrade.
CREATE FUNCTION acp.audit_worker_run_handoff() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE handoff_payload jsonb;
BEGIN
  handoff_payload := to_jsonb(NEW);
  INSERT INTO acp.mission_events(event_id, mission_id, event_type, event_version, idempotency_key,
    event_digest, payload, occurred_at, provenance_id)
  SELECT ('evt_' || gen_random_uuid())::acp.stable_id, r.mission_id, 'worker.recovery-handed-off', '1.0.0',
    NEW.run_id::text, acp.jsonb_sha256(handoff_payload), handoff_payload, NEW.handed_off_at, NEW.provenance_id
    FROM acp.worker_runs r WHERE r.run_id = NEW.run_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER worker_run_recovery_handoffs_audit AFTER INSERT ON acp.worker_run_recovery_handoffs
FOR EACH ROW EXECUTE FUNCTION acp.audit_worker_run_handoff();

CREATE FUNCTION acp.handoff_worker_run(target_run acp.stable_id, target_generation integer,
  target_host text, target_session acp.stable_id, target_version text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r acp.worker_runs; process_id acp.stable_id;
BEGIN
  SELECT * INTO r FROM acp.worker_runs WHERE run_id = target_run;
  IF NOT FOUND THEN RETURN 'obsolete'; END IF;
  PERFORM 1 FROM acp.missions WHERE mission_id = r.mission_id FOR UPDATE;
  PERFORM 1 FROM acp.mission_nodes WHERE node_id = r.node_id FOR UPDATE;
  SELECT * INTO STRICT r FROM acp.worker_runs WHERE run_id = target_run FOR UPDATE;
  IF r.dispatch_generation <> target_generation OR r.host_identifier <> target_host
    OR NOT EXISTS (SELECT 1 FROM acp.worker_dispatch_assignments a JOIN acp.worker_dispatches d USING (run_id)
      WHERE a.run_id = target_run AND a.generation = target_generation AND a.host_session_id = target_session
        AND a.host_identifier = target_host AND d.application_version = target_version) THEN RETURN 'obsolete'; END IF;
  IF r.state <> 'started' THEN RETURN 'terminal'; END IF;
  IF acp.worker_run_handed_off(target_run) THEN RETURN 'handed_off'; END IF;
  PERFORM 1 FROM acp.worker_host_sessions WHERE host_identifier = target_host FOR SHARE;
  PERFORM 1 FROM acp.worker_hosts WHERE host_identifier = target_host FOR SHARE;
  IF NOT acp.worker_recovery_runtime_live(target_run, target_host, target_session, target_version) THEN RETURN 'obsolete'; END IF;
  SELECT worker_process_id INTO process_id FROM acp.worker_processes
    WHERE run_id = target_run AND supervision_kind = 'windows_job' FOR UPDATE;
  IF NOT FOUND THEN RETURN 'pending'; END IF; -- No journal is not proof of no process.
  INSERT INTO acp.worker_run_recovery_handoffs(run_id, worker_process_id, generation, host_identifier,
    owner_session_id, application_version, provenance_id, reason)
    VALUES(target_run, process_id, target_generation, target_host, target_session, target_version,
      r.provenance_id, 'manager_dispatch_ended_without_result');
  RETURN 'handed_off';
END;
$$;

CREATE FUNCTION acp.handoff_recovery_provenance_valid(target_run acp.stable_id,
  target_provenance acp.stable_id, target_session text) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS (SELECT 1 FROM acp.worker_run_recovery_handoffs h
    JOIN acp.worker_runs r USING (run_id) JOIN acp.missions m USING (mission_id)
    JOIN acp.context_packets packet USING (context_packet_id)
    JOIN acp.worker_host_sessions s ON s.host_identifier = r.host_identifier
    JOIN acp.worker_host_runtimes rt ON rt.host_identifier = s.host_identifier AND rt.session_id = s.session_id
      AND rt.workflow_binding_id = m.workflow_binding_id
    JOIN acp.runtime_provenance t ON t.provenance_id = rt.template_provenance_id
    JOIN acp.runtime_provenance p ON p.provenance_id = target_provenance
    WHERE r.run_id = target_run AND s.session_id::text = target_session AND p.provenance_id <> r.provenance_id
      AND p.recorded_at >= h.handed_off_at AND p.context_packet_digest = packet.digest
      AND p.context_packet_schema_version = packet.schema_version
      AND acp.worker_recovery_runtime_live(r.run_id, r.host_identifier, s.session_id, s.application_version)
      AND (to_jsonb(p) - ARRAY['provenance_id', 'recorded_at', 'context_packet_digest', 'context_packet_schema_version'])
        = (to_jsonb(t) - ARRAY['provenance_id', 'recorded_at', 'context_packet_digest', 'context_packet_schema_version']));
$$;

CREATE FUNCTION acp.fence_handed_off_process() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lock_key bigint;
BEGIN
  IF NOT acp.worker_run_handed_off(NEW.run_id) THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN RAISE EXCEPTION 'handed-off owner cannot journal another process'; END IF;
  IF NEW.reconciliation_id IS DISTINCT FROM OLD.reconciliation_id THEN
    IF NEW.state = OLD.state AND NEW.heartbeat_at = OLD.heartbeat_at
      AND acp.handoff_recovery_provenance_valid(NEW.run_id, NEW.reconciliation_provenance_id, NEW.reconciliation_owner)
      AND NEW.reconciliation_claim_expires_at > clock_timestamp() THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'handed-off process requires fresh current recovery claim authority';
  END IF;
  -- Ordinary owner writes cannot reuse the inspector's held session or provenance.
  lock_key := hashtextextended('acp:worker-process-reconciliation:' || NEW.worker_process_id, 0);
  IF NEW.state <> 'running' AND NEW.transition_provenance_id = OLD.reconciliation_provenance_id
    AND OLD.reconciliation_claim_expires_at > clock_timestamp()
    AND acp.handoff_recovery_provenance_valid(NEW.run_id, NEW.transition_provenance_id, OLD.reconciliation_owner)
    AND EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
      AND classid = ((lock_key >> 32) & 4294967295)::oid AND objid = (lock_key & 4294967295)::oid AND objsubid = 1) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'handed-off owner cannot heartbeat or finish its process';
END;
$$;
CREATE TRIGGER worker_processes_ac_handoff BEFORE INSERT OR UPDATE ON acp.worker_processes
FOR EACH ROW EXECUTE FUNCTION acp.fence_handed_off_process();

CREATE FUNCTION acp.fence_handed_off_run_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_session text;
BEGIN
  IF NOT acp.worker_run_handed_off(NEW.run_id) THEN RETURN NEW; END IF;
  SELECT session_id::text INTO current_session FROM acp.worker_host_sessions WHERE host_identifier = NEW.host_identifier;
  IF NEW.state NOT IN ('failed', 'cancelled')
    OR NOT acp.handoff_recovery_provenance_valid(NEW.run_id, NEW.transition_provenance_id, current_session)
    OR NOT EXISTS (SELECT 1 FROM acp.worker_run_recovery_handoffs h JOIN acp.worker_processes p USING(worker_process_id)
      WHERE h.run_id = NEW.run_id AND p.state <> 'running') THEN
    RAISE EXCEPTION 'handed-off run requires stopped-process recovery, not a late owner result';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER worker_runs_aa_handoff BEFORE UPDATE ON acp.worker_runs
FOR EACH ROW EXECUTE FUNCTION acp.fence_handed_off_run_result();
