-- Inert, append-only native claims. No GO, recovery authority, Git operation,
-- successful provisioning, reservation release or worker admission is enabled.
CREATE FUNCTION acp.provisioner_utc7_filetime(value text) RETURNS numeric LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE year_value integer; day_value date; hour_value integer; minute_value integer; second_value integer;
BEGIN
  IF length(value)<>28 OR value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{7}Z$' THEN RETURN NULL; END IF;
  year_value:=substring(value,1,4)::integer;
  IF year_value<1601 THEN RETURN NULL; END IF;
  day_value:=make_date(year_value,substring(value,6,2)::integer,substring(value,9,2)::integer);
  hour_value:=substring(value,12,2)::integer; minute_value:=substring(value,15,2)::integer; second_value:=substring(value,18,2)::integer;
  IF hour_value>23 OR minute_value>59 OR second_value>59 THEN RETURN NULL; END IF;
  RETURN ((day_value-date '1601-01-01')::numeric*86400+hour_value*3600+minute_value*60+second_value)*10000000+substring(value,21,7)::numeric;
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RETURN NULL;
END;
$$;
CREATE FUNCTION acp.provisioner_native_root_valid(pid integer,token text,started text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(pid>0 AND length(token) BETWEEN 31 AND 35 AND token ~ '^win32-filetime:[1-9][0-9]{15,19}$'
    AND token='win32-filetime:'||acp.provisioner_utc7_filetime(started)::text,false);
$$;
CREATE FUNCTION acp.provisioner_native_scope_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE boot text; session_value text;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(value))<>3 OR NOT value ?& ARRAY['machineFingerprint','bootedAt','sessionId'] THEN RETURN false; END IF;
  boot:=value->>'bootedAt'; session_value:=value->>'sessionId';
  RETURN coalesce(jsonb_typeof(value->'machineFingerprint')='string' AND length(value->>'machineFingerprint')=64
    AND value->>'machineFingerprint' ~ '^[0-9a-f]{64}$' AND jsonb_typeof(value->'bootedAt')='string'
    AND length(boot)=24 AND boot ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    AND acp.provisioner_utc7_filetime(replace(boot,'Z','0000Z')) IS NOT NULL AND jsonb_typeof(value->'sessionId')='number'
    AND session_value ~ '^(0|[1-9][0-9]*)$' AND length(session_value)<=10 AND session_value::numeric<=2147483647,false);
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END;
$$;
CREATE FUNCTION acp.provisioner_root_within_recording_window(started text,created timestamptz,observed timestamptz)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  -- Identity remains exact UTC7; database time bounds only resolve microseconds.
  -- Use integer quotient: numeric division can round these large values before floor().
  SELECT coalesce(div(acp.provisioner_utc7_filetime(started),10) BETWEEN
    extract(epoch FROM created)*1000000+11644473600000000 AND extract(epoch FROM observed)*1000000+11644473600000000,false);
$$;

CREATE TABLE acp.worktree_provisioner_processes (
  attempt_id acp.stable_id PRIMARY KEY REFERENCES acp.worktree_provisioner_attempts(attempt_id),
  root_process_id integer NOT NULL,
  root_process_start_token text NOT NULL,
  root_started_at text NOT NULL,
  fence_namespace text NOT NULL CHECK(fence_namespace='acp-worktree-provisioner-v1'),
  fence_directory text NOT NULL,
  directory_identity text NOT NULL CHECK(length(directory_identity)=35 AND directory_identity ~ '^win32-dir:[0-9a-f]{8}:[0-9a-f]{16}$'),
  supervision_scope jsonb NOT NULL CHECK(acp.provisioner_native_scope_valid(supervision_scope)),
  tree_identifier text NOT NULL,
  host_identifier text NOT NULL,
  owner_session_id acp.stable_id NOT NULL,
  application_version text NOT NULL,
  provenance_id acp.stable_id NOT NULL REFERENCES acp.runtime_provenance(provenance_id),
  recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at)),
  FOREIGN KEY(host_identifier,owner_session_id,application_version) REFERENCES acp.worker_host_session_history(host_identifier,session_id,application_version),
  CHECK(acp.provisioner_native_root_valid(root_process_id,root_process_start_token,root_started_at))
);
CREATE TABLE acp.worktree_provisioner_stops (
  attempt_id acp.stable_id PRIMARY KEY REFERENCES acp.worktree_provisioner_attempts(attempt_id),
  launch_sealed boolean NOT NULL CHECK(launch_sealed),
  process_state text NOT NULL,
  reason text NOT NULL,
  exit_code integer,
  root_process_id integer,
  root_process_start_token text,
  root_started_at text,
  fence_namespace text NOT NULL CHECK(fence_namespace='acp-worktree-provisioner-v1'),
  fence_directory text NOT NULL,
  directory_identity text NOT NULL CHECK(length(directory_identity)=35 AND directory_identity ~ '^win32-dir:[0-9a-f]{8}:[0-9a-f]{16}$'),
  supervision_scope jsonb NOT NULL CHECK(acp.provisioner_native_scope_valid(supervision_scope)),
  tree_identifier text NOT NULL,
  host_identifier text NOT NULL,
  owner_session_id acp.stable_id NOT NULL,
  application_version text NOT NULL,
  provenance_id acp.stable_id NOT NULL REFERENCES acp.runtime_provenance(provenance_id),
  recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at)),
  FOREIGN KEY(host_identifier,owner_session_id,application_version) REFERENCES acp.worker_host_session_history(host_identifier,session_id,application_version),
  CHECK((root_process_id IS NULL AND root_process_start_token IS NULL AND root_started_at IS NULL)
    OR acp.provisioner_native_root_valid(root_process_id,root_process_start_token,root_started_at)),
  CHECK((process_state='terminated' AND reason='exact_owned_tree_terminated' AND exit_code IS NOT NULL AND root_process_id IS NOT NULL)
    OR (process_state='lost' AND exit_code IS NULL AND
      ((reason IN ('sealed_launch_job_absent','sealed_launch_job_empty') AND root_process_id IS NULL)
        OR (reason IN ('owned_job_and_original_root_absent','owned_job_empty') AND root_process_id IS NOT NULL))))
);
CREATE TRIGGER worktree_provisioner_processes_retained BEFORE UPDATE OR DELETE OR TRUNCATE ON acp.worktree_provisioner_processes
FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();
CREATE TRIGGER worktree_provisioner_stops_retained BEFORE UPDATE OR DELETE OR TRUNCATE ON acp.worktree_provisioner_stops
FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE FUNCTION acp.lock_provisioner_journal(target_attempt acp.stable_id) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p acp.worktree_provisioner_attempts;
BEGIN
  SELECT * INTO STRICT p FROM acp.worktree_provisioner_attempts WHERE attempt_id=target_attempt;
  PERFORM acp.lock_worktree_provisioner_plan(p.reservation_id);
  PERFORM 1 FROM acp.worktree_provisioner_attempts WHERE attempt_id=target_attempt FOR UPDATE;
  -- Actor validity consumes binding retirement state; keep it stable through COMMIT.
  PERFORM 1 FROM acp.project_workflow_bindings b JOIN acp.runtime_provenance v ON v.workflow_binding_id=b.binding_id
    WHERE v.provenance_id=p.provenance_id FOR SHARE OF b;
END;
$$;
CREATE FUNCTION acp.provisioner_journal_actor_valid(target_attempt acp.stable_id,require_live_plan boolean)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS(SELECT 1 FROM acp.worktree_provisioner_attempts p JOIN acp.worktree_reservations r USING(reservation_id)
    WHERE p.attempt_id=target_attempt
      AND acp.filesystem_observation_actor_valid(p.project_id,p.host_identifier,p.owner_session_id,p.application_version,p.provenance_id)
      AND (NOT require_live_plan OR (p.deadline_at>clock_timestamp() AND r.expires_at>clock_timestamp() AND p.reservation_revision=r.revision
        AND acp.worktree_reservation_owner_valid(r.mission_id,r.node_id,r.graph_revision,r.repository_binding_id,r.host_identifier,
          r.owner_session_id,r.application_version,r.provenance_id,r.dispatch_run_id,r.dispatch_generation,r.workspace_path))));
$$;
CREATE FUNCTION acp.validate_provisioner_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p acp.worktree_provisioner_attempts; previous acp.worktree_provisioner_processes; observed timestamptz; ticks numeric; is_process boolean;
BEGIN
  PERFORM acp.lock_provisioner_journal(NEW.attempt_id);
  SELECT * INTO STRICT p FROM acp.worktree_provisioner_attempts WHERE attempt_id=NEW.attempt_id;
  is_process:=TG_TABLE_NAME='worktree_provisioner_processes'; observed:=clock_timestamp();
  IF NEW.host_identifier IS DISTINCT FROM p.host_identifier OR NEW.owner_session_id IS DISTINCT FROM p.owner_session_id
    OR NEW.application_version IS DISTINCT FROM p.application_version OR NOT acp.provisioner_journal_actor_valid(p.attempt_id,is_process) THEN
    RAISE EXCEPTION 'provisioner journal requires exact current original runtime and applicable plan authority';
  END IF;
  IF NEW.fence_namespace IS DISTINCT FROM p.fence_namespace OR NEW.fence_directory IS DISTINCT FROM p.fence_directory
    OR NOT acp.provisioner_native_scope_valid(NEW.supervision_scope) OR NEW.supervision_scope->>'machineFingerprint' IS DISTINCT FROM p.machine_fingerprint THEN
    RAISE EXCEPTION 'provisioner journal requires exact planned fence and machine scope';
  END IF;
  IF NEW.root_process_id IS NOT NULL THEN
    ticks:=acp.provisioner_utc7_filetime(NEW.root_started_at);
    IF NOT acp.provisioner_native_root_valid(NEW.root_process_id,NEW.root_process_start_token,NEW.root_started_at)
      OR NOT acp.provisioner_root_within_recording_window(NEW.root_started_at,p.created_at,observed)
      OR ticks<acp.provisioner_utc7_filetime(replace(NEW.supervision_scope->>'bootedAt','Z','0000Z')) THEN
      RAISE EXCEPTION 'provisioner root requires exact FILETIME identity between plan creation and database now';
    END IF;
  END IF;
  IF is_process THEN
    IF EXISTS(SELECT 1 FROM acp.worktree_provisioner_stops WHERE attempt_id=p.attempt_id) THEN
      RAISE EXCEPTION 'sealed provisioner stop permanently denies later process admission';
    END IF;
  ELSE
    SELECT * INTO previous FROM acp.worktree_provisioner_processes WHERE attempt_id=p.attempt_id;
    IF previous.attempt_id IS NOT NULL AND (NEW.root_process_id IS DISTINCT FROM previous.root_process_id
      OR NEW.root_process_start_token IS DISTINCT FROM previous.root_process_start_token OR NEW.root_started_at IS DISTINCT FROM previous.root_started_at
      OR NEW.directory_identity IS DISTINCT FROM previous.directory_identity OR NEW.supervision_scope IS DISTINCT FROM previous.supervision_scope) THEN
      RAISE EXCEPTION 'provisioner stop must match its exact recorded native root and fence';
    END IF;
  END IF;
  NEW.fence_namespace:=p.fence_namespace; NEW.fence_directory:=p.fence_directory;
  NEW.tree_identifier:='Local'||chr(92)||'ACP.Provisioner.'||p.attempt_id::text;
  NEW.host_identifier:=p.host_identifier; NEW.owner_session_id:=p.owner_session_id; NEW.application_version:=p.application_version;
  NEW.provenance_id:=p.provenance_id; NEW.recorded_at:=observed;
  RETURN NEW;
END;
$$;
CREATE TRIGGER worktree_provisioner_processes_validate BEFORE INSERT ON acp.worktree_provisioner_processes FOR EACH ROW EXECUTE FUNCTION acp.validate_provisioner_journal();
CREATE TRIGGER worktree_provisioner_stops_validate BEFORE INSERT ON acp.worktree_provisioner_stops FOR EACH ROW EXECUTE FUNCTION acp.validate_provisioner_journal();
CREATE FUNCTION acp.require_provisioner_journal_commit_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT acp.provisioner_journal_actor_valid(NEW.attempt_id,TG_TABLE_NAME='worktree_provisioner_processes') THEN
    RAISE EXCEPTION 'provisioner journal authority ended before commit';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER worktree_provisioner_processes_commit_authority AFTER INSERT ON acp.worktree_provisioner_processes
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acp.require_provisioner_journal_commit_authority();
CREATE CONSTRAINT TRIGGER worktree_provisioner_stops_commit_authority AFTER INSERT ON acp.worktree_provisioner_stops
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acp.require_provisioner_journal_commit_authority();
CREATE FUNCTION acp.audit_provisioner_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p acp.worktree_provisioner_attempts; payload jsonb; event_kind text;
BEGIN
  SELECT * INTO STRICT p FROM acp.worktree_provisioner_attempts WHERE attempt_id=NEW.attempt_id;
  payload:=to_jsonb(NEW); event_kind:=CASE WHEN TG_TABLE_NAME='worktree_provisioner_processes' THEN 'filesystem.provisioner-process-recorded' ELSE 'filesystem.provisioner-stopped' END;
  INSERT INTO acp.mission_events(event_id,mission_id,event_type,event_version,idempotency_key,event_digest,payload,occurred_at,provenance_id)
    VALUES(('evt_'||gen_random_uuid())::acp.stable_id,p.mission_id,event_kind,'1.0.0',p.attempt_id::text,acp.jsonb_sha256(payload),payload,NEW.recorded_at,NEW.provenance_id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER worktree_provisioner_processes_audit AFTER INSERT ON acp.worktree_provisioner_processes FOR EACH ROW EXECUTE FUNCTION acp.audit_provisioner_journal();
CREATE TRIGGER worktree_provisioner_stops_audit AFTER INSERT ON acp.worktree_provisioner_stops FOR EACH ROW EXECUTE FUNCTION acp.audit_provisioner_journal();
