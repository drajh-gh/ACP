-- Transaction ownership belongs to the migration runner. Observation only;
-- these bindings do not authorize Git execution or change generic lease semantics.
CREATE FUNCTION acp.canonical_windows_binding_path(value text) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT length(value) BETWEEN 4 AND 4096 AND left(value,2) ~ '^[A-Za-z]:$'
    AND substring(value FROM 3 FOR 1) = chr(92)
    AND substring(value FROM 4) !~ '[:/<>"|?*[:cntrl:]]'
    AND NOT EXISTS (SELECT 1 FROM unnest(string_to_array(substring(value FROM 4),chr(92))) AS part
      WHERE part IN ('','.','..') OR part ~ '[. ]$' OR part ~* '^(con|prn|aux|nul|com[1-9]|lpt[1-9])([.]|$)');
$$;

CREATE TABLE acp.repositories (
  repository_id acp.stable_id PRIMARY KEY CHECK (repository_id::text ~ '^repo_'),
  project_id acp.stable_id NOT NULL REFERENCES acp.projects(project_id),
  provenance_id acp.stable_id NOT NULL REFERENCES acp.runtime_provenance(provenance_id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(repository_id,project_id)
);
CREATE TABLE acp.repository_bindings (
  repository_binding_id acp.stable_id PRIMARY KEY CHECK (repository_binding_id::text ~ '^rpb_'),
  repository_id acp.stable_id NOT NULL,
  project_id acp.stable_id NOT NULL,
  project_profile_id acp.stable_id NOT NULL,
  project_profile_version text NOT NULL,
  host_identifier text NOT NULL REFERENCES acp.worker_hosts(host_identifier),
  owner_session_id acp.stable_id NOT NULL,
  application_version text NOT NULL,
  machine_fingerprint text NOT NULL CHECK (machine_fingerprint ~ '^[0-9a-f]{64}$'),
  checkout_path text NOT NULL CHECK (acp.canonical_windows_binding_path(checkout_path)),
  checkout_identity text NOT NULL CHECK (checkout_identity ~ '^win32-dir:[0-9a-f]{8}:[0-9a-f]{16}$'),
  common_git_directory_path text NOT NULL CHECK (acp.canonical_windows_binding_path(common_git_directory_path)),
  common_git_directory_identity text NOT NULL CHECK (common_git_directory_identity ~ '^win32-dir:[0-9a-f]{8}:[0-9a-f]{16}$'),
  observed_at timestamptz NOT NULL CHECK (isfinite(observed_at)),
  provenance_id acp.stable_id NOT NULL REFERENCES acp.runtime_provenance(provenance_id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(repository_id,project_id) REFERENCES acp.repositories(repository_id,project_id),
  FOREIGN KEY(project_profile_id,project_profile_version) REFERENCES acp.project_profiles(profile_id,version),
  FOREIGN KEY(host_identifier,owner_session_id,application_version) REFERENCES acp.worker_host_session_history(host_identifier,session_id,application_version),
  CHECK (checkout_identity <> common_git_directory_identity AND lower(checkout_path) <> lower(common_git_directory_path)),
  UNIQUE(host_identifier,machine_fingerprint,common_git_directory_identity),
  UNIQUE(host_identifier,machine_fingerprint,checkout_identity)
);
CREATE UNIQUE INDEX repository_bindings_common_path ON acp.repository_bindings(host_identifier,machine_fingerprint,lower(common_git_directory_path));
CREATE UNIQUE INDEX repository_bindings_checkout_path ON acp.repository_bindings(host_identifier,machine_fingerprint,lower(checkout_path));
CREATE TABLE acp.worktree_bindings (
  worktree_binding_id acp.stable_id PRIMARY KEY CHECK (worktree_binding_id::text ~ '^wtb_'),
  repository_binding_id acp.stable_id NOT NULL REFERENCES acp.repository_bindings(repository_binding_id),
  mission_id acp.stable_id NOT NULL REFERENCES acp.missions(mission_id),
  project_id acp.stable_id NOT NULL REFERENCES acp.projects(project_id),
  project_profile_id acp.stable_id NOT NULL,
  project_profile_version text NOT NULL,
  host_identifier text NOT NULL REFERENCES acp.worker_hosts(host_identifier),
  owner_session_id acp.stable_id NOT NULL,
  application_version text NOT NULL,
  machine_fingerprint text NOT NULL CHECK (machine_fingerprint ~ '^[0-9a-f]{64}$'),
  workspace_path text NOT NULL CHECK (acp.canonical_windows_binding_path(workspace_path)),
  workspace_identity text NOT NULL CHECK (workspace_identity ~ '^win32-dir:[0-9a-f]{8}:[0-9a-f]{16}$'),
  git_directory_path text NOT NULL CHECK (acp.canonical_windows_binding_path(git_directory_path)),
  git_directory_identity text NOT NULL CHECK (git_directory_identity ~ '^win32-dir:[0-9a-f]{8}:[0-9a-f]{16}$'),
  branch_ref text NOT NULL CHECK (length(branch_ref) BETWEEN 12 AND 1024 AND starts_with(branch_ref,'refs/heads/') AND branch_ref !~ '[[:cntrl:]]'),
  head_revision text NOT NULL CHECK (head_revision ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  observed_at timestamptz NOT NULL CHECK (isfinite(observed_at)),
  provenance_id acp.stable_id NOT NULL REFERENCES acp.runtime_provenance(provenance_id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(project_profile_id,project_profile_version) REFERENCES acp.project_profiles(profile_id,version),
  FOREIGN KEY(host_identifier,owner_session_id,application_version) REFERENCES acp.worker_host_session_history(host_identifier,session_id,application_version),
  CHECK (workspace_identity <> git_directory_identity AND lower(workspace_path) <> lower(git_directory_path)),
  UNIQUE(host_identifier,machine_fingerprint,workspace_identity),
  UNIQUE(host_identifier,machine_fingerprint,git_directory_identity)
);
CREATE UNIQUE INDEX worktree_bindings_workspace_path ON acp.worktree_bindings(host_identifier,machine_fingerprint,lower(workspace_path));
CREATE UNIQUE INDEX worktree_bindings_git_path ON acp.worktree_bindings(host_identifier,machine_fingerprint,lower(git_directory_path));
-- Cross-table uniqueness is essential: a workspace cannot alias another
-- repository's checkout or Git metadata under an independent logical key.
CREATE TABLE acp.filesystem_directory_reservations (
  host_identifier text NOT NULL,
  machine_fingerprint text NOT NULL,
  directory_identity text NOT NULL,
  canonical_path text NOT NULL,
  binding_id acp.stable_id NOT NULL,
  role text NOT NULL CHECK (role IN ('checkout','common_git_directory','workspace','git_directory')),
  PRIMARY KEY(host_identifier,machine_fingerprint,directory_identity)
);
CREATE UNIQUE INDEX filesystem_directory_reservations_path ON acp.filesystem_directory_reservations(host_identifier,lower(canonical_path));
CREATE FUNCTION acp.reserve_filesystem_binding_directories() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='repository_bindings' THEN
    INSERT INTO acp.filesystem_directory_reservations(host_identifier,machine_fingerprint,directory_identity,canonical_path,binding_id,role)
      VALUES(NEW.host_identifier,NEW.machine_fingerprint,NEW.checkout_identity,NEW.checkout_path,NEW.repository_binding_id,'checkout'),
        (NEW.host_identifier,NEW.machine_fingerprint,NEW.common_git_directory_identity,NEW.common_git_directory_path,NEW.repository_binding_id,'common_git_directory');
  ELSE
    INSERT INTO acp.filesystem_directory_reservations(host_identifier,machine_fingerprint,directory_identity,canonical_path,binding_id,role)
      VALUES(NEW.host_identifier,NEW.machine_fingerprint,NEW.workspace_identity,NEW.workspace_path,NEW.worktree_binding_id,'workspace'),
        (NEW.host_identifier,NEW.machine_fingerprint,NEW.git_directory_identity,NEW.git_directory_path,NEW.worktree_binding_id,'git_directory');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER repository_bindings_reserve AFTER INSERT ON acp.repository_bindings FOR EACH ROW EXECUTE FUNCTION acp.reserve_filesystem_binding_directories();
CREATE TRIGGER worktree_bindings_reserve AFTER INSERT ON acp.worktree_bindings FOR EACH ROW EXECUTE FUNCTION acp.reserve_filesystem_binding_directories();
CREATE FUNCTION acp.validate_filesystem_directory_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('acp:filesystem-binding-registration:'||NEW.host_identifier,0));
  IF NOT EXISTS (SELECT 1 FROM acp.repository_bindings r WHERE r.repository_binding_id=NEW.binding_id
    AND r.host_identifier=NEW.host_identifier AND r.machine_fingerprint=NEW.machine_fingerprint
    AND ((NEW.role='checkout' AND r.checkout_path=NEW.canonical_path AND r.checkout_identity=NEW.directory_identity)
      OR (NEW.role='common_git_directory' AND r.common_git_directory_path=NEW.canonical_path AND r.common_git_directory_identity=NEW.directory_identity)))
    AND NOT EXISTS (SELECT 1 FROM acp.worktree_bindings w WHERE w.worktree_binding_id=NEW.binding_id
      AND w.host_identifier=NEW.host_identifier AND w.machine_fingerprint=NEW.machine_fingerprint
      AND ((NEW.role='workspace' AND w.workspace_path=NEW.canonical_path AND w.workspace_identity=NEW.directory_identity)
        OR (NEW.role='git_directory' AND w.git_directory_path=NEW.canonical_path AND w.git_directory_identity=NEW.directory_identity))) THEN
    RAISE EXCEPTION 'directory reservation requires its exact persisted binding';
  END IF;
  IF EXISTS (SELECT 1 FROM acp.filesystem_directory_reservations d WHERE d.host_identifier=NEW.host_identifier
    AND (NEW.role='workspace' OR d.role='workspace')
    AND (lower(NEW.canonical_path)=lower(d.canonical_path)
      OR starts_with(lower(NEW.canonical_path),lower(d.canonical_path)||chr(92))
      OR starts_with(lower(d.canonical_path),lower(NEW.canonical_path)||chr(92)))) THEN
    RAISE EXCEPTION 'workspace binding overlaps retained checkout, workspace or Git metadata';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER filesystem_directory_reservations_validate BEFORE INSERT ON acp.filesystem_directory_reservations FOR EACH ROW EXECUTE FUNCTION acp.validate_filesystem_directory_reservation();
CREATE TRIGGER filesystem_directory_reservations_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON acp.filesystem_directory_reservations FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();
CREATE TABLE acp.repository_binding_retirements (
  repository_binding_id acp.stable_id PRIMARY KEY REFERENCES acp.repository_bindings(repository_binding_id),
  project_id acp.stable_id NOT NULL,
  host_identifier text NOT NULL,
  owner_session_id acp.stable_id NOT NULL,
  application_version text NOT NULL,
  provenance_id acp.stable_id NOT NULL REFERENCES acp.runtime_provenance(provenance_id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE acp.worktree_binding_retirements (
  worktree_binding_id acp.stable_id PRIMARY KEY REFERENCES acp.worktree_bindings(worktree_binding_id),
  project_id acp.stable_id NOT NULL,
  host_identifier text NOT NULL,
  owner_session_id acp.stable_id NOT NULL,
  application_version text NOT NULL,
  provenance_id acp.stable_id NOT NULL REFERENCES acp.runtime_provenance(provenance_id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION acp.filesystem_observation_actor_valid(target_project acp.stable_id,target_host text,
  target_session acp.stable_id,target_version text,target_provenance acp.stable_id) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS (SELECT 1 FROM acp.runtime_provenance p JOIN acp.project_workflow_bindings b ON b.binding_id=p.workflow_binding_id
    JOIN acp.worker_hosts h ON h.host_identifier=target_host JOIN acp.worker_host_sessions s ON s.host_identifier=h.host_identifier
    JOIN acp.worker_host_session_history history ON history.session_id=s.session_id
    JOIN acp.worker_host_runtimes rt ON rt.host_identifier=h.host_identifier AND rt.session_id=s.session_id AND rt.workflow_binding_id=b.binding_id
    JOIN acp.runtime_provenance t ON t.provenance_id=rt.template_provenance_id
    WHERE p.provenance_id=target_provenance AND p.host_identifier=target_host AND b.project_id=target_project
      AND s.session_id=target_session AND s.application_version=target_version AND rt.application_version=target_version
      AND s.state='active' AND h.state='active' AND b.retired_at IS NULL AND b.active_from<=clock_timestamp()
      AND least(s.heartbeat_at,h.heartbeat_at,rt.heartbeat_at)+make_interval(secs=>h.heartbeat_ttl_seconds)>clock_timestamp()
      AND p.recorded_at>=history.issued_at AND p.recorded_at<=clock_timestamp()
      AND (to_jsonb(p)-ARRAY['provenance_id','recorded_at','context_packet_schema_version','context_packet_digest'])
        =(to_jsonb(t)-ARRAY['provenance_id','recorded_at','context_packet_schema_version','context_packet_digest']));
$$;
CREATE FUNCTION acp.validate_repository_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM acp.runtime_provenance p JOIN acp.project_workflow_bindings b ON b.binding_id=p.workflow_binding_id
    WHERE p.provenance_id=NEW.provenance_id AND b.project_id=NEW.project_id AND p.recorded_at<=clock_timestamp()) THEN
    RAISE EXCEPTION 'repository identity requires exact project provenance';
  END IF;
  NEW.recorded_at:=clock_timestamp(); RETURN NEW;
END;
$$;
CREATE TRIGGER repositories_validate BEFORE INSERT ON acp.repositories FOR EACH ROW EXECUTE FUNCTION acp.validate_repository_identity();

CREATE FUNCTION acp.validate_filesystem_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p acp.runtime_provenance; r acp.repository_bindings; m acp.missions; metadata_prefix text;
BEGIN
  IF TG_TABLE_NAME='worktree_bindings' THEN
    SELECT * INTO STRICT m FROM acp.missions WHERE mission_id=NEW.mission_id FOR SHARE;
  END IF;
  PERFORM 1 FROM acp.worker_host_sessions WHERE host_identifier=NEW.host_identifier FOR SHARE;
  PERFORM 1 FROM acp.worker_hosts WHERE host_identifier=NEW.host_identifier FOR SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended('acp:filesystem-binding-registration:'||NEW.host_identifier,0));
  IF TG_TABLE_NAME='worktree_bindings' THEN
    SELECT * INTO STRICT r FROM acp.repository_bindings WHERE repository_binding_id=NEW.repository_binding_id FOR SHARE;
    IF r.host_identifier<>NEW.host_identifier OR m.project_id<>r.project_id
      OR EXISTS (SELECT 1 FROM acp.repository_binding_retirements WHERE repository_binding_id=r.repository_binding_id)
      OR NOT acp.runtime_provenance_matches_context(NEW.provenance_id,NEW.mission_id) THEN
      RAISE EXCEPTION 'worktree observation requires its exact active repository and mission context';
    END IF;
    NEW.project_id:=m.project_id; NEW.machine_fingerprint:=r.machine_fingerprint;
    metadata_prefix:=lower(r.common_git_directory_path)||chr(92)||'worktrees'||chr(92);
    IF NOT starts_with(lower(NEW.git_directory_path),metadata_prefix)
      OR strpos(substring(NEW.git_directory_path FROM length(metadata_prefix)+1),chr(92))>0
      OR NEW.workspace_identity IN (r.checkout_identity,r.common_git_directory_identity)
      OR NEW.git_directory_identity IN (r.checkout_identity,r.common_git_directory_identity)
      OR lower(NEW.workspace_path)=lower(r.checkout_path)
      OR lower(NEW.workspace_path)=lower(r.common_git_directory_path)
      OR starts_with(lower(NEW.workspace_path),lower(r.common_git_directory_path)||chr(92)) THEN
      RAISE EXCEPTION 'worktree requires a distinct workspace and linked Git metadata directory';
    END IF;
  END IF;
  IF NOT acp.filesystem_observation_actor_valid(NEW.project_id,NEW.host_identifier,NEW.owner_session_id,NEW.application_version,NEW.provenance_id)
    OR NEW.observed_at>clock_timestamp() OR NEW.observed_at<clock_timestamp()-interval '5 minutes' THEN
    RAISE EXCEPTION 'filesystem binding requires fresh observation and exact current host provenance';
  END IF;
  SELECT * INTO STRICT p FROM acp.runtime_provenance WHERE provenance_id=NEW.provenance_id;
  NEW.project_profile_id:=p.project_profile_id; NEW.project_profile_version:=p.project_profile_version;
  NEW.recorded_at:=clock_timestamp(); RETURN NEW;
END;
$$;
CREATE TRIGGER repository_bindings_validate BEFORE INSERT ON acp.repository_bindings FOR EACH ROW EXECUTE FUNCTION acp.validate_filesystem_binding();
CREATE TRIGGER worktree_bindings_validate BEFORE INSERT ON acp.worktree_bindings FOR EACH ROW EXECUTE FUNCTION acp.validate_filesystem_binding();

CREATE FUNCTION acp.validate_filesystem_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_project acp.stable_id; target_host text;
BEGIN
  PERFORM 1 FROM acp.worker_host_sessions WHERE host_identifier=NEW.host_identifier FOR SHARE;
  PERFORM 1 FROM acp.worker_hosts WHERE host_identifier=NEW.host_identifier FOR SHARE;
  IF TG_TABLE_NAME='repository_binding_retirements' THEN
    SELECT project_id,host_identifier INTO STRICT target_project,target_host FROM acp.repository_bindings WHERE repository_binding_id=NEW.repository_binding_id FOR UPDATE;
  ELSE
    SELECT project_id,host_identifier INTO STRICT target_project,target_host FROM acp.worktree_bindings WHERE worktree_binding_id=NEW.worktree_binding_id FOR UPDATE;
  END IF;
  IF NEW.host_identifier<>target_host OR NOT acp.filesystem_observation_actor_valid(target_project,target_host,NEW.owner_session_id,NEW.application_version,NEW.provenance_id) THEN
    RAISE EXCEPTION 'filesystem retirement requires exact current host and project authority';
  END IF;
  NEW.project_id:=target_project; NEW.recorded_at:=clock_timestamp(); RETURN NEW;
END;
$$;
CREATE TRIGGER repository_binding_retirements_validate BEFORE INSERT ON acp.repository_binding_retirements FOR EACH ROW EXECUTE FUNCTION acp.validate_filesystem_retirement();
CREATE TRIGGER worktree_binding_retirements_validate BEFORE INSERT ON acp.worktree_binding_retirements FOR EACH ROW EXECUTE FUNCTION acp.validate_filesystem_retirement();
CREATE FUNCTION acp.require_filesystem_binding_commit_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT acp.filesystem_observation_actor_valid(NEW.project_id,NEW.host_identifier,NEW.owner_session_id,NEW.application_version,NEW.provenance_id) THEN
    RAISE EXCEPTION 'filesystem observation authority ended before commit';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER repository_bindings_commit_authority AFTER INSERT ON acp.repository_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acp.require_filesystem_binding_commit_authority();
CREATE CONSTRAINT TRIGGER worktree_bindings_commit_authority AFTER INSERT ON acp.worktree_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acp.require_filesystem_binding_commit_authority();
CREATE CONSTRAINT TRIGGER repository_binding_retirements_commit_authority AFTER INSERT ON acp.repository_binding_retirements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acp.require_filesystem_binding_commit_authority();
CREATE CONSTRAINT TRIGGER worktree_binding_retirements_commit_authority AFTER INSERT ON acp.worktree_binding_retirements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acp.require_filesystem_binding_commit_authority();
CREATE TRIGGER repositories_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON acp.repositories FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();
CREATE TRIGGER repository_bindings_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON acp.repository_bindings FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();
CREATE TRIGGER worktree_bindings_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON acp.worktree_bindings FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();
CREATE TRIGGER repository_binding_retirements_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON acp.repository_binding_retirements FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();
CREATE TRIGGER worktree_binding_retirements_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON acp.worktree_binding_retirements FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();
