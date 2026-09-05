-- Transaction ownership belongs to the migration runner. Legacy journals remain readable.
ALTER TABLE acp.worker_processes ADD COLUMN supervision_kind text,
  ADD COLUMN tree_identifier text,
  ADD CONSTRAINT worker_process_supervision_pair CHECK (
    (supervision_kind IS NULL AND tree_identifier IS NULL)
    OR (supervision_kind IS NOT NULL AND tree_identifier IS NOT NULL
      AND supervision_kind = 'windows_job' AND tree_identifier = 'Local\ACP.Worker.' || worker_process_id::text)
  );
CREATE UNIQUE INDEX worker_processes_one_owned_root_per_run ON acp.worker_processes (run_id)
  WHERE supervision_kind IS NOT NULL;

CREATE FUNCTION acp.admit_supervised_worker_process() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r acp.worker_runs; n acp.mission_nodes; m acp.missions;
BEGIN
  SELECT * INTO STRICT r FROM acp.worker_runs WHERE run_id = NEW.run_id;
  SELECT * INTO STRICT m FROM acp.missions WHERE mission_id = r.mission_id FOR UPDATE;
  SELECT * INTO STRICT n FROM acp.mission_nodes WHERE node_id = r.node_id FOR UPDATE;
  SELECT * INTO STRICT r FROM acp.worker_runs WHERE run_id = NEW.run_id FOR UPDATE;
  PERFORM 1 FROM acp.worker_host_sessions WHERE host_identifier = r.host_identifier FOR SHARE;
  PERFORM 1 FROM acp.worker_hosts WHERE host_identifier = r.host_identifier FOR SHARE;
  IF r.state <> 'started' OR n.state <> 'running' OR m.state <> 'executing'
     OR acp.worker_cancellation_requested(m.mission_id, n.graph_revision)
     OR r.timeout_at <= clock_timestamp()
     OR NEW.supervision_kind IS DISTINCT FROM 'windows_job'
     OR NEW.tree_identifier IS DISTINCT FROM 'Local\ACP.Worker.' || NEW.worker_process_id::text
     OR NEW.process_start_token !~ '^win32-filetime:[0-9]{16,20}$' THEN
    RAISE EXCEPTION 'worker process requires active uncancelled supervised run authority';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM acp.worker_dispatch_assignments a
    JOIN acp.worker_host_sessions s ON s.host_identifier = a.host_identifier AND s.session_id = a.host_session_id
    JOIN acp.worker_hosts h ON h.host_identifier = s.host_identifier
    WHERE a.run_id = r.run_id AND a.generation = r.dispatch_generation AND s.state = 'active'
      AND h.state IN ('active', 'draining')
      AND least(s.heartbeat_at, h.heartbeat_at) + make_interval(secs => h.heartbeat_ttl_seconds) > clock_timestamp()) THEN
    RAISE EXCEPTION 'worker process session is no longer authoritative';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER worker_processes_aa_supervised_admission BEFORE INSERT ON acp.worker_processes
FOR EACH ROW EXECUTE FUNCTION acp.admit_supervised_worker_process();
