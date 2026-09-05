-- Inert, immutable provisioner plans. No native fence, process, Git mutation,
-- stop, success, transfer, release or retry authority is created here.
CREATE TABLE acp.worktree_provisioner_attempts (
  attempt_id acp.stable_id PRIMARY KEY CHECK (attempt_id::text ~ '^wpa_'),
  reservation_id acp.stable_id NOT NULL UNIQUE REFERENCES acp.worktree_reservations(reservation_id),
  reservation_revision integer NOT NULL CHECK (reservation_revision>0),
  base_revision text NOT NULL CHECK (base_revision ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  parent_path text NOT NULL CHECK (acp.canonical_windows_binding_path(parent_path)),
  parent_identity text NOT NULL CHECK (parent_identity ~ '^win32-dir:[0-9a-f]{8}:[0-9a-f]{16}$'),
  parent_observed_at timestamptz NOT NULL CHECK (isfinite(parent_observed_at)),
  fence_namespace text NOT NULL CHECK (fence_namespace='acp-worktree-provisioner-v1'),
  fence_directory text NOT NULL CHECK (acp.canonical_windows_binding_path(fence_directory)),
  fence_key text NOT NULL,
  deadline_at timestamptz NOT NULL CHECK (isfinite(deadline_at)),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  repository_binding_id acp.stable_id NOT NULL REFERENCES acp.repository_bindings(repository_binding_id),
  repository_id acp.stable_id NOT NULL REFERENCES acp.repositories(repository_id),
  project_id acp.stable_id NOT NULL REFERENCES acp.projects(project_id),
  project_profile_id acp.stable_id NOT NULL,
  project_profile_version text NOT NULL,
  mission_id acp.stable_id NOT NULL REFERENCES acp.missions(mission_id),
  node_id acp.stable_id NOT NULL REFERENCES acp.mission_nodes(node_id),
  graph_revision text NOT NULL,
  dispatch_run_id acp.stable_id NOT NULL,
  dispatch_generation integer NOT NULL,
  workspace_path text NOT NULL,
  branch_ref text NOT NULL,
  common_git_directory_path text NOT NULL,
  common_git_directory_identity text NOT NULL,
  host_identifier text NOT NULL,
  owner_session_id acp.stable_id NOT NULL,
  application_version text NOT NULL,
  machine_fingerprint text NOT NULL,
  provenance_id acp.stable_id NOT NULL REFERENCES acp.runtime_provenance(provenance_id),
  FOREIGN KEY(project_profile_id,project_profile_version) REFERENCES acp.project_profiles(profile_id,version),
  FOREIGN KEY(dispatch_run_id,dispatch_generation) REFERENCES acp.worker_dispatch_assignments(run_id,generation),
  FOREIGN KEY(host_identifier,owner_session_id,application_version) REFERENCES acp.worker_host_session_history(host_identifier,session_id,application_version),
  CHECK (deadline_at>created_at AND deadline_at>parent_observed_at)
);
CREATE INDEX worktree_provisioner_attempts_host_cursor ON acp.worktree_provisioner_attempts(host_identifier,attempt_id);
CREATE TRIGGER worktree_provisioner_attempts_retained BEFORE UPDATE OR DELETE OR TRUNCATE ON acp.worktree_provisioner_attempts
FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE FUNCTION acp.lock_worktree_provisioner_plan(target_reservation acp.stable_id) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r acp.worktree_reservations;
BEGIN
  -- Unlocked routing read uses immutable fields only. Lock parents first,
  -- then re-read the hold after obtaining its row lock; never invert this order.
  SELECT * INTO STRICT r FROM acp.worktree_reservations WHERE reservation_id=target_reservation;
  PERFORM acp.lock_worktree_reservation(r.mission_id,r.node_id,r.repository_binding_id,r.host_identifier);
  PERFORM 1 FROM acp.worktree_reservations WHERE reservation_id=target_reservation FOR UPDATE;
END;
$$;
CREATE FUNCTION acp.validate_worktree_provisioner_plan() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r acp.worktree_reservations; b acp.repository_bindings; observed timestamptz;
BEGIN
  PERFORM acp.lock_worktree_provisioner_plan(NEW.reservation_id);
  SELECT * INTO STRICT r FROM acp.worktree_reservations WHERE reservation_id=NEW.reservation_id;
  SELECT * INTO STRICT b FROM acp.repository_bindings WHERE repository_binding_id=r.repository_binding_id;
  observed:=clock_timestamp();
  IF length(r.workspace_path)-length(split_part(reverse(r.workspace_path),chr(92),1))=3 THEN
    RAISE EXCEPTION 'direct-root provisioner workspace plans are not supported';
  END IF;
  IF NEW.host_identifier IS DISTINCT FROM r.host_identifier OR NEW.owner_session_id IS DISTINCT FROM r.owner_session_id
    OR NEW.application_version IS DISTINCT FROM r.application_version OR NEW.reservation_revision IS DISTINCT FROM r.revision
    OR r.expires_at<=observed OR NOT acp.worktree_reservation_owner_valid(r.mission_id,r.node_id,r.graph_revision,r.repository_binding_id,
      r.host_identifier,r.owner_session_id,r.application_version,r.provenance_id,r.dispatch_run_id,r.dispatch_generation,r.workspace_path) THEN
    RAISE EXCEPTION 'provisioner plan requires exact live original hold revision and owner';
  END IF;
  IF NEW.parent_path IS DISTINCT FROM left(r.workspace_path,length(r.workspace_path)-length(split_part(reverse(r.workspace_path),chr(92),1))-1)
    OR NEW.parent_observed_at>observed OR NEW.parent_observed_at<observed-interval '5 seconds'
    OR NEW.deadline_at<=observed OR NEW.deadline_at>r.expires_at THEN
    RAISE EXCEPTION 'provisioner plan requires exact reported parent, recent observation and hold-bounded deadline';
  END IF;
  IF acp.filesystem_paths_overlap(NEW.fence_directory,r.workspace_path)
    OR acp.filesystem_paths_overlap(NEW.fence_directory,b.checkout_path)
    OR acp.filesystem_paths_overlap(NEW.fence_directory,b.common_git_directory_path) THEN
    RAISE EXCEPTION 'planned provisioner fence directory overlaps the target or repository';
  END IF;
  -- Supplied authority/target fields are never accepted as facts. The only
  -- caller-selected native data is explicitly reported or planned, not proved.
  NEW.repository_binding_id:=r.repository_binding_id; NEW.repository_id:=r.repository_id; NEW.project_id:=r.project_id;
  NEW.project_profile_id:=r.project_profile_id; NEW.project_profile_version:=r.project_profile_version;
  NEW.mission_id:=r.mission_id; NEW.node_id:=r.node_id; NEW.graph_revision:=r.graph_revision;
  NEW.dispatch_run_id:=r.dispatch_run_id; NEW.dispatch_generation:=r.dispatch_generation;
  NEW.workspace_path:=r.workspace_path; NEW.branch_ref:=r.branch_ref;
  NEW.common_git_directory_path:=b.common_git_directory_path; NEW.common_git_directory_identity:=b.common_git_directory_identity;
  NEW.host_identifier:=r.host_identifier; NEW.owner_session_id:=r.owner_session_id; NEW.application_version:=r.application_version;
  NEW.machine_fingerprint:=r.machine_fingerprint; NEW.provenance_id:=r.provenance_id;
  NEW.fence_key:=NEW.attempt_id::text||'.provision'; NEW.created_at:=observed;
  RETURN NEW;
END;
$$;
CREATE TRIGGER worktree_provisioner_attempts_validate BEFORE INSERT ON acp.worktree_provisioner_attempts
FOR EACH ROW EXECUTE FUNCTION acp.validate_worktree_provisioner_plan();

CREATE FUNCTION acp.require_worktree_provisioner_plan_commit_authority() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r acp.worktree_reservations; observed timestamptz;
BEGIN
  SELECT * INTO STRICT r FROM acp.worktree_reservations WHERE reservation_id=NEW.reservation_id;
  observed:=clock_timestamp();
  IF r.revision<>NEW.reservation_revision OR NEW.deadline_at<=observed OR r.expires_at<=observed
    OR NEW.deadline_at>r.expires_at OR NEW.parent_observed_at>observed OR NEW.parent_observed_at<observed-interval '5 seconds'
    OR NOT acp.worktree_reservation_owner_valid(r.mission_id,r.node_id,r.graph_revision,r.repository_binding_id,
      r.host_identifier,r.owner_session_id,r.application_version,r.provenance_id,r.dispatch_run_id,r.dispatch_generation,r.workspace_path) THEN
    RAISE EXCEPTION 'provisioner plan authority or reported observation ended before commit';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER worktree_provisioner_attempts_commit_authority AFTER INSERT ON acp.worktree_provisioner_attempts
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acp.require_worktree_provisioner_plan_commit_authority();
CREATE FUNCTION acp.audit_worktree_provisioner_plan() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payload jsonb;
BEGIN
  payload:=to_jsonb(NEW);
  INSERT INTO acp.mission_events(event_id,mission_id,event_type,event_version,idempotency_key,event_digest,payload,occurred_at,provenance_id)
    VALUES(('evt_'||gen_random_uuid())::acp.stable_id,NEW.mission_id,'filesystem.provisioner-planned','1.0.0',NEW.attempt_id::text,
      acp.jsonb_sha256(payload),payload,NEW.created_at,NEW.provenance_id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER worktree_provisioner_attempts_audit AFTER INSERT ON acp.worktree_provisioner_attempts
FOR EACH ROW EXECUTE FUNCTION acp.audit_worktree_provisioner_plan();

CREATE VIEW acp.worktree_provisioner_status AS SELECT p.*,
  CASE WHEN p.deadline_at<=clock_timestamp() OR r.expires_at<=clock_timestamp() OR r.revision IS DISTINCT FROM p.reservation_revision
    OR NOT acp.worktree_reservation_owner_valid(r.mission_id,r.node_id,r.graph_revision,r.repository_binding_id,
      r.host_identifier,r.owner_session_id,r.application_version,r.provenance_id,r.dispatch_run_id,r.dispatch_generation,r.workspace_path)
    THEN 'recovering' ELSE 'planned' END AS state
  FROM acp.worktree_provisioner_attempts p JOIN acp.worktree_reservations r USING(reservation_id);
