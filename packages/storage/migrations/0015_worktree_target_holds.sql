-- Storage-only prospective target holds. No native identity, process launch,
-- transfer, release or expiry-based takeover is established by this migration.
-- Lock old writer DML through projection backfill and trigger installation.
LOCK TABLE acp.filesystem_writer_leases,acp.filesystem_writer_releases,
  acp.repository_bindings,acp.worktree_bindings,acp.filesystem_directory_reservations IN ACCESS EXCLUSIVE MODE;

CREATE TABLE acp.worktree_reservations (
  reservation_id acp.stable_id PRIMARY KEY CHECK (reservation_id::text ~ '^wtr_'),
  repository_binding_id acp.stable_id NOT NULL REFERENCES acp.repository_bindings(repository_binding_id),
  mission_id acp.stable_id NOT NULL REFERENCES acp.missions(mission_id),
  node_id acp.stable_id NOT NULL REFERENCES acp.mission_nodes(node_id),
  -- Existing selected dispatch identity, not a fabricated admitted worker run.
  dispatch_run_id acp.stable_id NOT NULL,
  dispatch_generation integer NOT NULL,
  graph_revision text NOT NULL CHECK (length(btrim(graph_revision)) BETWEEN 1 AND 1024 AND graph_revision !~ '[[:cntrl:]]'),
  workspace_path text NOT NULL CHECK (acp.canonical_windows_binding_path(workspace_path)),
  branch_ref text NOT NULL CHECK (length(branch_ref) BETWEEN 12 AND 1024 AND starts_with(branch_ref,'refs/heads/') AND branch_ref !~ '[[:cntrl:]]'),
  project_id acp.stable_id NOT NULL REFERENCES acp.projects(project_id),
  project_profile_id acp.stable_id NOT NULL,
  project_profile_version text NOT NULL,
  repository_id acp.stable_id NOT NULL REFERENCES acp.repositories(repository_id),
  host_identifier text NOT NULL,
  owner_session_id acp.stable_id NOT NULL,
  application_version text NOT NULL,
  machine_fingerprint text NOT NULL,
  workspace_key text NOT NULL,
  physical_repository_key text NOT NULL,
  branch_key text NOT NULL,
  path_key text NOT NULL,
  provenance_id acp.stable_id NOT NULL REFERENCES acp.runtime_provenance(provenance_id),
  acquired_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revision integer NOT NULL CHECK (revision>0),
  FOREIGN KEY(project_profile_id,project_profile_version) REFERENCES acp.project_profiles(profile_id,version),
  FOREIGN KEY(dispatch_run_id,dispatch_generation) REFERENCES acp.worker_dispatch_assignments(run_id,generation),
  FOREIGN KEY(host_identifier,owner_session_id,application_version) REFERENCES acp.worker_host_session_history(host_identifier,session_id,application_version),
  CHECK (isfinite(acquired_at) AND isfinite(heartbeat_at) AND isfinite(expires_at)),
  CHECK (heartbeat_at>=acquired_at AND expires_at>heartbeat_at)
);
CREATE TRIGGER worktree_reservations_retained BEFORE DELETE OR TRUNCATE ON acp.worktree_reservations
FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();

-- One cross-kind unique constraint, not two independently exclusive tables.
-- Original writer indexes remain authoritative across an empty-hold downgrade.
CREATE TABLE acp.filesystem_exclusion_keys (
  key text PRIMARY KEY,
  writer_lease_id acp.stable_id REFERENCES acp.filesystem_writer_leases(lease_id),
  reservation_id acp.stable_id REFERENCES acp.worktree_reservations(reservation_id),
  CHECK (num_nonnulls(writer_lease_id,reservation_id)=1)
);
CREATE INDEX filesystem_exclusion_keys_writer ON acp.filesystem_exclusion_keys(writer_lease_id);
CREATE INDEX filesystem_exclusion_keys_reservation ON acp.filesystem_exclusion_keys(reservation_id);
CREATE TRIGGER filesystem_exclusion_keys_no_truncate BEFORE TRUNCATE ON acp.filesystem_exclusion_keys
FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE FUNCTION acp.filesystem_prospective_path_key(target_host text,target_path text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT 'host:'||target_host||':path:'||encode(sha256(convert_to(lower(target_path),'UTF8')),'hex');
$$;
CREATE FUNCTION acp.filesystem_paths_overlap(left_path text,right_path text) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT lower(left_path)=lower(right_path) OR starts_with(lower(left_path),lower(right_path)||chr(92))
    OR starts_with(lower(right_path),lower(left_path)||chr(92));
$$;
CREATE FUNCTION acp.writer_exclusion_keys(target_lease acp.stable_id) RETURNS SETOF text LANGUAGE sql VOLATILE AS $$
  SELECT unnest(ARRAY[l.workspace_key,l.physical_workspace_key,l.physical_repository_key,l.branch_key,
    acp.filesystem_prospective_path_key(l.host_identifier,w.workspace_path)])
  FROM acp.filesystem_writer_leases l JOIN acp.worktree_bindings w USING(worktree_binding_id) WHERE l.lease_id=target_lease;
$$;
CREATE FUNCTION acp.reservation_exclusion_keys(target_reservation acp.stable_id) RETURNS SETOF text LANGUAGE sql VOLATILE AS $$
  SELECT unnest(ARRAY[workspace_key,physical_repository_key,branch_key,path_key])
  FROM acp.worktree_reservations WHERE reservation_id=target_reservation;
$$;

CREATE FUNCTION acp.lock_worktree_reservation(target_mission acp.stable_id,target_node acp.stable_id,
  target_repository acp.stable_id,target_host text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM acp.missions WHERE mission_id=target_mission FOR SHARE;
  PERFORM 1 FROM acp.mission_nodes WHERE node_id=target_node AND mission_id=target_mission FOR SHARE;
  PERFORM 1 FROM acp.worker_dispatches WHERE mission_id=target_mission AND node_id=target_node
    AND state IN ('pending','assigned','running') ORDER BY run_id FOR SHARE;
  PERFORM 1 FROM acp.worker_dispatch_assignments a JOIN acp.worker_dispatches d
    ON d.run_id=a.run_id AND d.generation=a.generation WHERE d.mission_id=target_mission AND d.node_id=target_node
    AND d.state IN ('pending','assigned','running') ORDER BY a.run_id,a.generation FOR SHARE OF a;
  PERFORM 1 FROM acp.worker_host_sessions WHERE host_identifier=target_host FOR SHARE;
  PERFORM 1 FROM acp.worker_hosts WHERE host_identifier=target_host FOR SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended('acp:filesystem-binding-registration:'||target_host,0));
  PERFORM 1 FROM acp.repository_bindings WHERE repository_binding_id=target_repository FOR SHARE;
END;
$$;
CREATE FUNCTION acp.worktree_reservation_owner_valid(target_mission acp.stable_id,target_node acp.stable_id,target_graph text,
  target_repository acp.stable_id,target_host text,target_session acp.stable_id,target_version text,target_provenance acp.stable_id,
  target_dispatch acp.stable_id,target_generation integer,target_workspace text)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS (SELECT 1 FROM acp.missions m JOIN acp.mission_nodes n USING(mission_id)
    JOIN acp.repository_bindings b ON b.repository_binding_id=target_repository
    JOIN acp.worker_dispatches d ON d.mission_id=m.mission_id AND d.node_id=n.node_id
    JOIN acp.worker_dispatch_assignments a ON a.run_id=d.run_id AND a.generation=d.generation
    JOIN acp.capability_grants g ON g.grant_id=d.grant_id
    WHERE m.mission_id=target_mission AND n.node_id=target_node AND n.graph_revision=target_graph
      -- Dispatch preparation marks a node running BEFORE worker-run admission.
      -- The actual started-run absence, not that label alone, defines pre-run.
      AND m.state='executing' AND n.state IN ('runnable','running') AND n.worker_role='delivery'
      AND d.run_id=target_dispatch AND d.generation=target_generation AND d.state='assigned'
      AND d.application_version=target_version AND a.host_identifier=target_host AND a.host_session_id=target_session
      AND a.expires_at>clock_timestamp() AND g.valid_from<=clock_timestamp() AND g.expires_at>clock_timestamp()
      AND g.role='delivery' AND g.mode='write' AND g.workspace=target_workspace
      AND NOT EXISTS (SELECT 1 FROM acp.worker_runs r WHERE r.run_id=d.run_id)
      AND NOT EXISTS (SELECT 1 FROM acp.worker_runs r WHERE r.node_id=n.node_id AND r.state='started')
      AND b.project_id=m.project_id AND b.host_identifier=target_host
      AND NOT EXISTS (SELECT 1 FROM acp.repository_binding_retirements WHERE repository_binding_id=b.repository_binding_id)
      AND NOT acp.worker_cancellation_requested(m.mission_id,n.graph_revision)
      AND acp.runtime_provenance_matches_context(target_provenance,m.mission_id)
      AND acp.filesystem_observation_actor_valid(m.project_id,target_host,target_session,target_version,target_provenance));
$$;

CREATE FUNCTION acp.validate_worktree_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b acp.repository_bindings; p acp.runtime_provenance; observed timestamptz;
BEGIN
  PERFORM acp.lock_worktree_reservation(NEW.mission_id,NEW.node_id,NEW.repository_binding_id,NEW.host_identifier);
  IF TG_OP='INSERT' THEN
    -- The live-node unique index makes selection unambiguous. Never take a
    -- caller-supplied generation or silently select an arbitrary assignment.
    SELECT d.run_id,d.generation INTO NEW.dispatch_run_id,NEW.dispatch_generation FROM acp.worker_dispatches d
      JOIN acp.worker_dispatch_assignments a ON a.run_id=d.run_id AND a.generation=d.generation
      WHERE d.mission_id=NEW.mission_id AND d.node_id=NEW.node_id AND d.state='assigned'
        AND d.application_version=NEW.application_version AND a.host_identifier=NEW.host_identifier
        AND a.host_session_id=NEW.owner_session_id;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['heartbeat_at','expires_at','revision']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['heartbeat_at','expires_at','revision']) THEN
      RAISE EXCEPTION 'pre-run reservation identity is immutable';
    END IF;
    IF OLD.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'expired pre-run reservation cannot renew'; END IF;
  END IF;
  IF NOT acp.worktree_reservation_owner_valid(NEW.mission_id,NEW.node_id,NEW.graph_revision,NEW.repository_binding_id,
    NEW.host_identifier,NEW.owner_session_id,NEW.application_version,NEW.provenance_id,
    NEW.dispatch_run_id,NEW.dispatch_generation,NEW.workspace_path) THEN
    RAISE EXCEPTION 'pre-run reservation requires exact unstarted delivery context and original runtime';
  END IF;
  IF TG_OP='INSERT' THEN
    SELECT * INTO STRICT b FROM acp.repository_bindings WHERE repository_binding_id=NEW.repository_binding_id;
    SELECT * INTO STRICT p FROM acp.runtime_provenance WHERE provenance_id=NEW.provenance_id;
    -- Prospective paths cannot overlap any retained role, even retired history,
    -- or another prospective path. Host registration serializes both directions.
    IF EXISTS (SELECT 1 FROM acp.filesystem_directory_reservations d WHERE d.host_identifier=NEW.host_identifier
      AND acp.filesystem_paths_overlap(NEW.workspace_path,d.canonical_path)) OR EXISTS (
      SELECT 1 FROM acp.worktree_reservations r WHERE r.host_identifier=NEW.host_identifier
      AND acp.filesystem_paths_overlap(NEW.workspace_path,r.workspace_path)) THEN
      RAISE EXCEPTION 'prospective workspace overlaps retained or reserved filesystem paths';
    END IF;
    NEW.project_id:=b.project_id; NEW.repository_id:=b.repository_id; NEW.machine_fingerprint:=b.machine_fingerprint;
    NEW.project_profile_id:=p.project_profile_id; NEW.project_profile_version:=p.project_profile_version;
    NEW.workspace_key:='repo:'||b.repository_id::text||':worktree:'||NEW.mission_id::text;
    NEW.physical_repository_key:='host:'||b.host_identifier||':machine:'||b.machine_fingerprint||':git:'||b.common_git_directory_identity;
    NEW.branch_key:='branch:'||b.repository_id::text||':'||encode(sha256(convert_to(NEW.branch_ref,'UTF8')),'hex');
    NEW.path_key:=acp.filesystem_prospective_path_key(NEW.host_identifier,NEW.workspace_path);
  END IF;
  observed:=clock_timestamp();
  IF TG_OP='INSERT' THEN NEW.acquired_at:=observed; NEW.revision:=1; ELSE NEW.revision:=OLD.revision+1; END IF;
  NEW.heartbeat_at:=observed;
  SELECT least(observed+interval '20 seconds',a.expires_at,g.expires_at) INTO NEW.expires_at
    FROM acp.worker_dispatch_assignments a JOIN acp.worker_dispatches d ON d.run_id=a.run_id
    JOIN acp.capability_grants g ON g.grant_id=d.grant_id
    WHERE a.run_id=NEW.dispatch_run_id AND a.generation=NEW.dispatch_generation;
  RETURN NEW;
END;
$$;
CREATE TRIGGER worktree_reservations_validate BEFORE INSERT OR UPDATE ON acp.worktree_reservations
FOR EACH ROW EXECUTE FUNCTION acp.validate_worktree_reservation();

CREATE FUNCTION acp.deny_binding_over_prospective_workspace() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('acp:filesystem-binding-registration:'||NEW.host_identifier,0));
  IF EXISTS (SELECT 1 FROM acp.worktree_reservations r WHERE r.host_identifier=NEW.host_identifier
    AND acp.filesystem_paths_overlap(NEW.canonical_path,r.workspace_path)) THEN
    RAISE EXCEPTION 'binding overlaps reserved prospective workspace; conversion is not supported';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER filesystem_directory_prospective_guard BEFORE INSERT ON acp.filesystem_directory_reservations
FOR EACH ROW EXECUTE FUNCTION acp.deny_binding_over_prospective_workspace();

CREATE FUNCTION acp.validate_filesystem_exclusion_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'filesystem exclusion ownership is immutable'; END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.writer_lease_id IS NULL OR NOT EXISTS (SELECT 1 FROM acp.filesystem_writer_leases
      WHERE lease_id=OLD.writer_lease_id AND released_at IS NOT NULL) THEN
      RAISE EXCEPTION 'filesystem exclusion removal requires an already released writer';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.writer_lease_id IS NOT NULL THEN
    IF NEW.reservation_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM acp.filesystem_writer_leases
      WHERE lease_id=NEW.writer_lease_id AND released_at IS NULL)
      OR NEW.key NOT IN (SELECT acp.writer_exclusion_keys(NEW.writer_lease_id)) THEN
      RAISE EXCEPTION 'filesystem exclusion requires an exact unreleased writer key';
    END IF;
  ELSIF NEW.reservation_id IS NULL OR NOT EXISTS (SELECT 1 FROM acp.worktree_reservations WHERE reservation_id=NEW.reservation_id)
    OR NEW.key NOT IN (SELECT acp.reservation_exclusion_keys(NEW.reservation_id)) THEN
    RAISE EXCEPTION 'filesystem exclusion requires an exact retained reservation key';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER filesystem_exclusion_keys_validate BEFORE INSERT OR UPDATE OR DELETE ON acp.filesystem_exclusion_keys
FOR EACH ROW EXECUTE FUNCTION acp.validate_filesystem_exclusion_key();

INSERT INTO acp.filesystem_exclusion_keys(key,writer_lease_id)
  SELECT k,l.lease_id FROM acp.filesystem_writer_leases l CROSS JOIN LATERAL acp.writer_exclusion_keys(l.lease_id) k
  WHERE l.released_at IS NULL;

CREATE FUNCTION acp.project_filesystem_exclusion_keys() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='worktree_reservations' THEN
    INSERT INTO acp.filesystem_exclusion_keys(key,reservation_id) SELECT acp.reservation_exclusion_keys(NEW.reservation_id),NEW.reservation_id;
  ELSIF TG_OP='INSERT' THEN
    INSERT INTO acp.filesystem_exclusion_keys(key,writer_lease_id) SELECT acp.writer_exclusion_keys(NEW.lease_id),NEW.lease_id;
  ELSIF OLD.released_at IS NULL AND NEW.released_at IS NOT NULL THEN
    DELETE FROM acp.filesystem_exclusion_keys WHERE writer_lease_id=NEW.lease_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER worktree_reservations_keys AFTER INSERT ON acp.worktree_reservations
FOR EACH ROW EXECUTE FUNCTION acp.project_filesystem_exclusion_keys();
CREATE TRIGGER filesystem_writer_leases_shared_keys AFTER INSERT OR UPDATE ON acp.filesystem_writer_leases
FOR EACH ROW EXECUTE FUNCTION acp.project_filesystem_exclusion_keys();

CREATE FUNCTION acp.require_filesystem_exclusion_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='worktree_reservations' THEN
    IF EXISTS (SELECT acp.reservation_exclusion_keys(NEW.reservation_id) EXCEPT
      SELECT key FROM acp.filesystem_exclusion_keys WHERE reservation_id=NEW.reservation_id) THEN
      RAISE EXCEPTION 'pre-run reservation exclusion projection is incomplete';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM acp.filesystem_writer_leases WHERE lease_id=NEW.lease_id AND released_at IS NULL) THEN
    IF EXISTS (SELECT acp.writer_exclusion_keys(NEW.lease_id) EXCEPT
      SELECT key FROM acp.filesystem_exclusion_keys WHERE writer_lease_id=NEW.lease_id) THEN
      RAISE EXCEPTION 'filesystem writer exclusion projection is incomplete';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM acp.filesystem_exclusion_keys WHERE writer_lease_id=NEW.lease_id) THEN
    RAISE EXCEPTION 'released writer retained active projection keys';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER worktree_reservations_projection AFTER INSERT OR UPDATE ON acp.worktree_reservations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acp.require_filesystem_exclusion_projection();
CREATE CONSTRAINT TRIGGER filesystem_writer_shared_projection AFTER INSERT OR UPDATE ON acp.filesystem_writer_leases
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acp.require_filesystem_exclusion_projection();

CREATE FUNCTION acp.require_worktree_reservation_commit_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.expires_at<=clock_timestamp() OR NOT acp.worktree_reservation_owner_valid(NEW.mission_id,NEW.node_id,NEW.graph_revision,
    NEW.repository_binding_id,NEW.host_identifier,NEW.owner_session_id,NEW.application_version,NEW.provenance_id,
    NEW.dispatch_run_id,NEW.dispatch_generation,NEW.workspace_path) THEN
    RAISE EXCEPTION 'pre-run reservation authority ended before commit';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER worktree_reservations_commit_authority AFTER INSERT OR UPDATE ON acp.worktree_reservations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acp.require_worktree_reservation_commit_authority();
CREATE FUNCTION acp.audit_worktree_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payload jsonb; event_kind text;
BEGIN
  payload:=to_jsonb(NEW); event_kind:=CASE WHEN TG_OP='INSERT' THEN 'filesystem.target-held' ELSE 'filesystem.target-hold-renewed' END;
  INSERT INTO acp.mission_events(event_id,mission_id,event_type,event_version,idempotency_key,event_digest,payload,occurred_at,provenance_id)
    VALUES(('evt_'||gen_random_uuid())::acp.stable_id,NEW.mission_id,event_kind,'1.0.0',NEW.reservation_id::text||':'||NEW.revision::text,
      acp.jsonb_sha256(payload),payload,NEW.heartbeat_at,NEW.provenance_id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER worktree_reservations_audit AFTER INSERT OR UPDATE ON acp.worktree_reservations
FOR EACH ROW EXECUTE FUNCTION acp.audit_worktree_reservation();
CREATE VIEW acp.worktree_reservation_status AS SELECT r.*,
  CASE WHEN expires_at<=clock_timestamp() OR NOT acp.worktree_reservation_owner_valid(mission_id,node_id,graph_revision,
    repository_binding_id,host_identifier,owner_session_id,application_version,provenance_id,
    dispatch_run_id,dispatch_generation,workspace_path) THEN 'recovering' ELSE 'held' END AS state
  FROM acp.worktree_reservations r;
