-- Transaction ownership belongs to the migration runner. Do not invent OS identity for historical rows.
ALTER TABLE acp.worker_processes ADD COLUMN supervision_scope jsonb;
CREATE FUNCTION acp.validate_worker_supervision_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.supervision_kind = 'windows_job' AND (
    jsonb_typeof(NEW.supervision_scope) IS NOT DISTINCT FROM 'object'
    AND NEW.supervision_scope ?& ARRAY['machineFingerprint', 'bootedAt', 'sessionId']
    AND NEW.supervision_scope - ARRAY['machineFingerprint', 'bootedAt', 'sessionId'] = '{}'::jsonb
    AND jsonb_typeof(NEW.supervision_scope -> 'machineFingerprint') = 'string'
    AND NEW.supervision_scope ->> 'machineFingerprint' ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(NEW.supervision_scope -> 'bootedAt') = 'string'
    AND (NEW.supervision_scope ->> 'bootedAt')::timestamptz >= '2000-01-01Z'::timestamptz
    AND (NEW.supervision_scope ->> 'bootedAt')::timestamptz <= NEW.started_at
    AND jsonb_typeof(NEW.supervision_scope -> 'sessionId') = 'number'
    AND NEW.supervision_scope ->> 'sessionId' ~ '^[0-9]{1,10}$'
    AND (NEW.supervision_scope ->> 'sessionId')::bigint <= 2147483647
  ) IS NOT TRUE THEN RAISE EXCEPTION 'new supervised worker requires exact OS machine/boot/session identity'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION acp.worker_recovery_runtime_live(target_run acp.stable_id, target_host text,
  target_session acp.stable_id, target_version text) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS (SELECT 1 FROM acp.worker_runs r JOIN acp.missions m USING (mission_id)
    JOIN acp.worker_hosts h ON h.host_identifier = r.host_identifier
    JOIN acp.worker_host_sessions s ON s.host_identifier = h.host_identifier
    JOIN acp.worker_host_runtimes rt ON rt.host_identifier = h.host_identifier
      AND rt.workflow_binding_id = m.workflow_binding_id AND rt.session_id = s.session_id
    WHERE r.run_id = target_run AND h.host_identifier = target_host
      AND s.session_id = target_session AND s.application_version = target_version
      AND rt.application_version = target_version AND s.state = 'active' AND h.state IN ('active', 'draining')
      AND least(s.heartbeat_at, h.heartbeat_at, rt.heartbeat_at) + make_interval(secs => h.heartbeat_ttl_seconds) > clock_timestamp());
$$;
CREATE TRIGGER worker_processes_ab_scope BEFORE INSERT ON acp.worker_processes
FOR EACH ROW EXECUTE FUNCTION acp.validate_worker_supervision_scope();

-- A healthy owner may be between process exit and valid result persistence.
-- Recovery must not turn that normal gap into a manufactured failure.
CREATE FUNCTION acp.worker_run_owner_retired(target_run acp.stable_id) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS (SELECT 1 FROM acp.worker_runs r
    JOIN acp.worker_dispatch_assignments a ON a.run_id = r.run_id AND a.generation = r.dispatch_generation
    JOIN acp.worker_host_sessions s ON s.host_identifier = a.host_identifier
    WHERE r.run_id = target_run AND (s.session_id <> a.host_session_id OR s.state = 'closed'));
$$;
