-- Transaction ownership belongs to the migration runner.
CREATE TABLE acp.filesystem_writer_leases (
  lease_id acp.stable_id PRIMARY KEY CHECK (lease_id::text ~ '^lea_'),
  run_id acp.stable_id NOT NULL UNIQUE,
  worker_process_id acp.stable_id NOT NULL,
  worktree_binding_id acp.stable_id NOT NULL REFERENCES acp.worktree_bindings(worktree_binding_id),
  repository_binding_id acp.stable_id NOT NULL REFERENCES acp.repository_bindings(repository_binding_id),
  host_identifier text NOT NULL,
  owner_session_id acp.stable_id NOT NULL,
  application_version text NOT NULL,
  workspace_key text NOT NULL,
  physical_workspace_key text NOT NULL,
  physical_repository_key text NOT NULL,
  branch_key text NOT NULL,
  provenance_id acp.stable_id NOT NULL REFERENCES acp.runtime_provenance(provenance_id),
  acquired_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  released_at timestamptz,
  FOREIGN KEY (run_id,worker_process_id) REFERENCES acp.worker_launch_intents(run_id,worker_process_id),
  CHECK (isfinite(acquired_at) AND isfinite(heartbeat_at) AND isfinite(expires_at)),
  CHECK (heartbeat_at >= acquired_at AND expires_at > heartbeat_at),
  CHECK (released_at IS NULL OR (isfinite(released_at) AND released_at >= acquired_at))
);
-- Expiry is deliberately absent: loss of a heartbeat is not process-stop proof.
CREATE UNIQUE INDEX filesystem_writer_workspace_exclusive ON acp.filesystem_writer_leases(workspace_key) WHERE released_at IS NULL;
CREATE UNIQUE INDEX filesystem_writer_physical_exclusive ON acp.filesystem_writer_leases(physical_workspace_key) WHERE released_at IS NULL;
-- Shared Windows Git metadata can alias case-varied loose refs. Conservatively
-- admit only one writer per physical common directory, without folding logical refs.
CREATE UNIQUE INDEX filesystem_writer_repository_exclusive ON acp.filesystem_writer_leases(physical_repository_key) WHERE released_at IS NULL;
CREATE UNIQUE INDEX filesystem_writer_branch_exclusive ON acp.filesystem_writer_leases(branch_key) WHERE released_at IS NULL;

CREATE TABLE acp.filesystem_writer_releases (
  lease_id acp.stable_id PRIMARY KEY REFERENCES acp.filesystem_writer_leases(lease_id),
  run_id acp.stable_id NOT NULL REFERENCES acp.worker_launch_stops(run_id),
  host_identifier text NOT NULL,
  owner_session_id acp.stable_id NOT NULL,
  application_version text NOT NULL,
  provenance_id acp.stable_id NOT NULL UNIQUE REFERENCES acp.runtime_provenance(provenance_id),
  released_at timestamptz NOT NULL
);
CREATE TRIGGER filesystem_writer_releases_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON acp.filesystem_writer_releases
FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();
CREATE TRIGGER filesystem_writer_leases_retained BEFORE DELETE OR TRUNCATE ON acp.filesystem_writer_leases
FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE FUNCTION acp.lock_filesystem_writer(target_run acp.stable_id,target_binding acp.stable_id) RETURNS void LANGUAGE plpgsql AS $$
DECLARE parent acp.stable_id;
BEGIN
  PERFORM acp.lock_worker_launch(target_run);
  SELECT repository_binding_id INTO STRICT parent FROM acp.worktree_bindings WHERE worktree_binding_id=target_binding;
  PERFORM 1 FROM acp.repository_bindings WHERE repository_binding_id=parent FOR SHARE;
  PERFORM 1 FROM acp.worktree_bindings WHERE worktree_binding_id=target_binding FOR SHARE;
END;
$$;

CREATE FUNCTION acp.filesystem_writer_owner_valid(target_run acp.stable_id,target_binding acp.stable_id)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS (SELECT 1 FROM acp.worker_runs r JOIN acp.worker_launch_intents i USING(run_id)
    JOIN acp.missions m USING(mission_id) JOIN acp.mission_nodes n ON n.node_id=r.node_id
    JOIN acp.capability_grants g ON g.grant_id=r.capability_grant_id
    JOIN acp.runtime_provenance p ON p.provenance_id=i.provenance_id
    JOIN acp.worktree_bindings w ON w.worktree_binding_id=target_binding
    JOIN acp.repository_bindings b USING(repository_binding_id)
    WHERE r.run_id=target_run AND r.state='started' AND r.timeout_at>clock_timestamp()
      AND m.state NOT IN ('complete_for_scope','failed','cancelled')
      AND g.role='delivery' AND g.mode='write' AND r.requested_mode='write' AND n.worker_role='delivery'
      AND g.valid_from<=clock_timestamp() AND g.expires_at>clock_timestamp()
      AND r.workspace=w.workspace_path AND g.workspace=w.workspace_path
      AND w.mission_id=r.mission_id AND w.project_id=m.project_id AND b.project_id=m.project_id
      AND w.project_profile_id=p.project_profile_id AND w.project_profile_version=p.project_profile_version
      -- The repository profile is historical observation provenance. New mission
      -- worktrees can use a retained same-project repository after a profile bump.
      AND w.host_identifier=i.host_identifier AND b.host_identifier=i.host_identifier
      AND w.machine_fingerprint=i.supervision_scope->>'machineFingerprint'
      AND NOT EXISTS (SELECT 1 FROM acp.repository_binding_retirements WHERE repository_binding_id=b.repository_binding_id)
      AND NOT EXISTS (SELECT 1 FROM acp.worktree_binding_retirements WHERE worktree_binding_id=w.worktree_binding_id)
      AND NOT EXISTS (SELECT 1 FROM acp.worker_launch_revocations WHERE run_id=r.run_id)
      AND NOT EXISTS (SELECT 1 FROM acp.worker_launch_stops WHERE run_id=r.run_id)
      AND NOT acp.worker_cancellation_requested(r.mission_id,n.graph_revision)
      AND acp.worker_recovery_runtime_live(r.run_id,i.host_identifier,i.owner_session_id,i.application_version));
$$;

CREATE FUNCTION acp.validate_filesystem_writer_lease() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i acp.worker_launch_intents; w acp.worktree_bindings; b acp.repository_bindings; observed timestamptz;
BEGIN
  PERFORM acp.lock_filesystem_writer(NEW.run_id,NEW.worktree_binding_id);
  SELECT * INTO STRICT i FROM acp.worker_launch_intents WHERE run_id=NEW.run_id;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['heartbeat_at','expires_at','revision','released_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['heartbeat_at','expires_at','revision','released_at']) OR OLD.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'filesystem writer identity and released history are immutable';
    END IF;
    IF NEW.released_at IS DISTINCT FROM OLD.released_at THEN
      IF NEW.heartbeat_at<>OLD.heartbeat_at OR NEW.expires_at<>OLD.expires_at OR NOT EXISTS (
        SELECT 1 FROM acp.filesystem_writer_releases x WHERE x.lease_id=OLD.lease_id AND x.run_id=OLD.run_id AND x.released_at=NEW.released_at) THEN
        RAISE EXCEPTION 'filesystem writer release requires its exact durable receipt';
      END IF;
      NEW.revision:=OLD.revision+1; RETURN NEW;
    END IF;
    IF OLD.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'expired filesystem writer cannot renew'; END IF;
  ELSE
    IF NEW.released_at IS NOT NULL OR EXISTS (SELECT 1 FROM acp.worker_processes WHERE run_id=NEW.run_id) THEN
      RAISE EXCEPTION 'filesystem writer must be reserved before process registration';
    END IF;
    SELECT * INTO STRICT w FROM acp.worktree_bindings WHERE worktree_binding_id=NEW.worktree_binding_id;
    SELECT * INTO STRICT b FROM acp.repository_bindings WHERE repository_binding_id=w.repository_binding_id;
    NEW.repository_binding_id:=b.repository_binding_id;
    NEW.workspace_key:='repo:'||b.repository_id::text||':worktree:'||w.mission_id::text;
    NEW.physical_workspace_key:='host:'||w.host_identifier||':machine:'||w.machine_fingerprint||':workspace:'||w.workspace_identity;
    NEW.physical_repository_key:='host:'||b.host_identifier||':machine:'||b.machine_fingerprint||':git:'||b.common_git_directory_identity;
    NEW.branch_key:='branch:'||b.repository_id::text||':'||encode(sha256(convert_to(w.branch_ref,'UTF8')),'hex');
  END IF;
  IF NEW.worker_process_id<>i.worker_process_id OR NEW.host_identifier<>i.host_identifier
    OR NEW.owner_session_id<>i.owner_session_id OR NEW.application_version<>i.application_version OR NEW.provenance_id<>i.provenance_id
    OR NOT acp.filesystem_writer_owner_valid(NEW.run_id,NEW.worktree_binding_id) THEN
    RAISE EXCEPTION 'filesystem writer requires exact live delivery owner and retained workspace';
  END IF;
  observed:=clock_timestamp();
  IF TG_OP='INSERT' THEN NEW.acquired_at:=observed; NEW.revision:=1; ELSE NEW.revision:=OLD.revision+1; END IF;
  NEW.heartbeat_at:=observed;
  SELECT least(observed+interval '20 seconds',r.timeout_at,g.expires_at) INTO NEW.expires_at
    FROM acp.worker_runs r JOIN acp.capability_grants g ON g.grant_id=r.capability_grant_id WHERE r.run_id=NEW.run_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER filesystem_writer_leases_validate BEFORE INSERT OR UPDATE ON acp.filesystem_writer_leases
FOR EACH ROW EXECUTE FUNCTION acp.validate_filesystem_writer_lease();

CREATE FUNCTION acp.filesystem_writer_release_valid(target_lease acp.stable_id,target_provenance acp.stable_id,
  target_host text,target_session acp.stable_id,target_version text) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS (SELECT 1 FROM acp.filesystem_writer_leases l JOIN acp.worker_runs r USING(run_id)
    JOIN acp.worker_launch_intents i USING(run_id) JOIN acp.worker_launch_stops s USING(run_id)
    WHERE l.lease_id=target_lease AND l.worker_process_id=i.worker_process_id AND l.host_identifier=target_host
      AND r.state<>'started' AND s.launch_sealed AND NOT EXISTS (SELECT 1 FROM acp.worker_processes WHERE run_id=r.run_id AND state='running')
      AND acp.worker_launch_recovery_actor_valid(r.run_id,target_provenance,target_session,target_version,s.observed_at));
$$;

CREATE FUNCTION acp.make_filesystem_writer_release_provenance(target_lease acp.stable_id,target_host text,
  target_session acp.stable_id,target_version text) RETURNS acp.stable_id LANGUAGE plpgsql AS $$
DECLARE created acp.stable_id;
BEGIN
  INSERT INTO acp.runtime_provenance
  SELECT (jsonb_populate_record(NULL::acp.runtime_provenance,to_jsonb(t)||jsonb_build_object(
    'provenance_id','prv_'||gen_random_uuid(),'recorded_at',clock_timestamp(),
    'context_packet_schema_version',packet.schema_version::text,'context_packet_digest',packet.digest::text))).*
  FROM acp.filesystem_writer_leases l JOIN acp.worker_runs r USING(run_id) JOIN acp.worker_launch_stops s USING(run_id)
    JOIN acp.missions m USING(mission_id) JOIN acp.context_packets packet USING(context_packet_id)
    JOIN acp.worker_host_runtimes rt ON rt.host_identifier=l.host_identifier AND rt.workflow_binding_id=m.workflow_binding_id
      AND rt.session_id=target_session AND rt.application_version=target_version
    JOIN acp.runtime_provenance t ON t.provenance_id=rt.template_provenance_id
  WHERE l.lease_id=target_lease AND l.host_identifier=target_host AND l.released_at IS NULL AND r.state<>'started'
    AND acp.worker_recovery_runtime_live(r.run_id,target_host,target_session,target_version)
    AND acp.runtime_provenance_matches_context(t.provenance_id,r.mission_id)
  RETURNING provenance_id INTO created;
  RETURN created;
END;
$$;

CREATE FUNCTION acp.validate_filesystem_writer_release() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l acp.filesystem_writer_leases;
BEGIN
  SELECT * INTO STRICT l FROM acp.filesystem_writer_leases WHERE lease_id=NEW.lease_id;
  PERFORM acp.lock_filesystem_writer(l.run_id,l.worktree_binding_id);
  SELECT * INTO STRICT l FROM acp.filesystem_writer_leases WHERE lease_id=NEW.lease_id FOR UPDATE;
  IF l.released_at IS NOT NULL OR NEW.run_id<>l.run_id OR NOT acp.filesystem_writer_release_valid(
    NEW.lease_id,NEW.provenance_id,NEW.host_identifier,NEW.owner_session_id,NEW.application_version) THEN
    RAISE EXCEPTION 'filesystem writer release requires terminal run, sealed stop and fresh current authority';
  END IF;
  NEW.released_at:=clock_timestamp(); RETURN NEW;
END;
$$;
CREATE TRIGGER filesystem_writer_releases_validate BEFORE INSERT ON acp.filesystem_writer_releases
FOR EACH ROW EXECUTE FUNCTION acp.validate_filesystem_writer_release();
CREATE FUNCTION acp.project_filesystem_writer_release() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE acp.filesystem_writer_leases SET released_at=NEW.released_at WHERE lease_id=NEW.lease_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER filesystem_writer_releases_project AFTER INSERT ON acp.filesystem_writer_releases
FOR EACH ROW EXECUTE FUNCTION acp.project_filesystem_writer_release();

CREATE FUNCTION acp.require_filesystem_writer_commit_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='filesystem_writer_releases' THEN
    IF NOT acp.filesystem_writer_release_valid(NEW.lease_id,NEW.provenance_id,NEW.host_identifier,NEW.owner_session_id,NEW.application_version) THEN
      RAISE EXCEPTION 'filesystem writer release authority ended before commit';
    END IF;
  ELSIF NEW.released_at IS NULL AND (NEW.expires_at<=clock_timestamp() OR NOT acp.filesystem_writer_owner_valid(NEW.run_id,NEW.worktree_binding_id)) THEN
    RAISE EXCEPTION 'filesystem writer owner authority ended before commit';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER filesystem_writer_leases_commit_authority AFTER INSERT OR UPDATE ON acp.filesystem_writer_leases
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acp.require_filesystem_writer_commit_authority();
CREATE CONSTRAINT TRIGGER filesystem_writer_releases_commit_authority AFTER INSERT ON acp.filesystem_writer_releases
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acp.require_filesystem_writer_commit_authority();

CREATE FUNCTION acp.audit_filesystem_writer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payload jsonb; actor acp.stable_id; event_kind text;
BEGIN
  payload:=to_jsonb(NEW); actor:=NEW.provenance_id;
  event_kind:=CASE WHEN TG_OP='INSERT' THEN 'filesystem.writer-acquired' ELSE 'filesystem.writer-renewed' END;
  IF NEW.released_at IS NOT NULL THEN
    SELECT provenance_id INTO STRICT actor FROM acp.filesystem_writer_releases WHERE lease_id=NEW.lease_id;
    event_kind:='filesystem.writer-released';
  END IF;
  INSERT INTO acp.mission_events(event_id,mission_id,event_type,event_version,idempotency_key,event_digest,payload,occurred_at,provenance_id)
    SELECT ('evt_'||gen_random_uuid())::acp.stable_id,r.mission_id,event_kind,'1.0.0',NEW.lease_id::text||':'||NEW.revision::text,
      acp.jsonb_sha256(payload),payload,coalesce(NEW.released_at,NEW.heartbeat_at),actor FROM acp.worker_runs r WHERE r.run_id=NEW.run_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER filesystem_writer_leases_audit AFTER INSERT OR UPDATE ON acp.filesystem_writer_leases
FOR EACH ROW EXECUTE FUNCTION acp.audit_filesystem_writer();

CREATE VIEW acp.filesystem_writer_lease_status AS SELECT l.*,
  CASE WHEN released_at IS NOT NULL THEN 'released'
    WHEN expires_at<=clock_timestamp() OR NOT acp.filesystem_writer_owner_valid(run_id,worktree_binding_id) THEN 'recovering'
    ELSE 'active' END AS state FROM acp.filesystem_writer_leases l;
