-- A derived exclusion projection; no native operation or execution authority.
LOCK TABLE acp.worker_launch_intents,acp.worker_processes,acp.worker_launch_stops,
  acp.worktree_provisioner_processes,acp.worktree_provisioner_stops IN ACCESS EXCLUSIVE MODE NOWAIT;

CREATE TABLE acp.windows_native_root_claims (
  owner_id acp.stable_id PRIMARY KEY,
  owner_kind text NOT NULL,
  host_identifier text NOT NULL,
  tree_identifier text NOT NULL,
  process_id bigint NOT NULL CHECK(process_id>0),
  process_start_token text NOT NULL CHECK(length(process_start_token) BETWEEN 31 AND 35
    AND process_start_token ~ '^win32-filetime:[0-9]{16,20}$'),
  supervision_scope jsonb NOT NULL,
  machine_fingerprint text GENERATED ALWAYS AS (supervision_scope->>'machineFingerprint') STORED NOT NULL,
  process_start_filetime numeric(20,0) GENERATED ALWAYS AS (substring(process_start_token FROM 16)::numeric) STORED NOT NULL,
  CHECK((owner_kind='worker' AND left(owner_id::text,4)='wpr_') OR (owner_kind='provisioner' AND left(owner_id::text,4)='wpa_')),
  CHECK(length(machine_fingerprint)=64 AND machine_fingerprint ~ '^[0-9a-f]{64}$'),
  UNIQUE(machine_fingerprint,process_id,process_start_filetime)
);
CREATE TRIGGER windows_native_root_claims_retained BEFORE UPDATE OR DELETE OR TRUNCATE ON acp.windows_native_root_claims
FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();

-- VOLATILE deliberately sees the source row from its AFTER INSERT caller.
CREATE FUNCTION acp.windows_native_root_source(target_kind text,target_id acp.stable_id)
RETURNS TABLE(owner_kind text,owner_id acp.stable_id,host_identifier text,tree_identifier text,
  process_id bigint,process_start_token text,supervision_scope jsonb,source_relation text)
LANGUAGE sql VOLATILE AS $$
  SELECT 'worker',p.worker_process_id,p.host_identifier,p.tree_identifier,p.process_id,p.process_start_token,p.supervision_scope,'worker_processes'
    FROM acp.worker_processes p WHERE target_kind='worker' AND p.worker_process_id=target_id
      AND p.supervision_kind='windows_job' AND p.supervision_scope IS NOT NULL
  UNION ALL
  SELECT 'worker',i.worker_process_id,i.host_identifier,i.tree_identifier,s.root_process_id::bigint,s.root_process_start_token,i.supervision_scope,'worker_launch_stops'
    FROM acp.worker_launch_stops s JOIN acp.worker_launch_intents i USING(run_id)
    WHERE target_kind='worker' AND i.worker_process_id=target_id AND s.root_process_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM acp.worker_processes p WHERE p.worker_process_id=i.worker_process_id)
  UNION ALL
  SELECT 'provisioner',p.attempt_id,p.host_identifier,p.tree_identifier,p.root_process_id::bigint,p.root_process_start_token,p.supervision_scope,'worktree_provisioner_processes'
    FROM acp.worktree_provisioner_processes p WHERE target_kind='provisioner' AND p.attempt_id=target_id
  UNION ALL
  SELECT 'provisioner',s.attempt_id,s.host_identifier,s.tree_identifier,s.root_process_id::bigint,s.root_process_start_token,s.supervision_scope,'worktree_provisioner_stops'
    FROM acp.worktree_provisioner_stops s WHERE target_kind='provisioner' AND s.attempt_id=target_id AND s.root_process_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM acp.worktree_provisioner_processes p WHERE p.attempt_id=s.attempt_id);
$$;
CREATE FUNCTION acp.validate_windows_native_root_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source record;
BEGIN
  SELECT * INTO STRICT source FROM acp.windows_native_root_source(NEW.owner_kind,NEW.owner_id);
  IF ROW(NEW.owner_kind,NEW.owner_id,NEW.host_identifier,NEW.tree_identifier,NEW.process_id,NEW.process_start_token,NEW.supervision_scope)
    IS DISTINCT FROM ROW(source.owner_kind,source.owner_id,source.host_identifier,source.tree_identifier,source.process_id,source.process_start_token,source.supervision_scope) THEN
    RAISE EXCEPTION 'native root claim must match its exact retained source';
  END IF;
  RETURN NEW;
EXCEPTION WHEN no_data_found OR too_many_rows THEN RAISE EXCEPTION 'native root claim requires one exact scoped retained source';
END;
$$;
CREATE TRIGGER windows_native_root_claims_validate BEFORE INSERT ON acp.windows_native_root_claims
FOR EACH ROW EXECUTE FUNCTION acp.validate_windows_native_root_claim();

INSERT INTO acp.windows_native_root_claims(owner_kind,owner_id,host_identifier,tree_identifier,process_id,process_start_token,supervision_scope)
  SELECT s.owner_kind,s.owner_id,s.host_identifier,s.tree_identifier,s.process_id,s.process_start_token,s.supervision_scope
  FROM (SELECT 'worker'::text AS kind,worker_process_id AS id FROM acp.worker_processes
    UNION SELECT 'worker',i.worker_process_id FROM acp.worker_launch_stops s JOIN acp.worker_launch_intents i USING(run_id)
    UNION SELECT 'provisioner',attempt_id FROM acp.worktree_provisioner_processes
    UNION SELECT 'provisioner',attempt_id FROM acp.worktree_provisioner_stops) owners
  CROSS JOIN LATERAL acp.windows_native_root_source(owners.kind,owners.id) s;

CREATE FUNCTION acp.ensure_windows_native_root_claim(target_kind text,target_id acp.stable_id)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE source record; retained acp.windows_native_root_claims;
BEGIN
  SELECT * INTO STRICT source FROM acp.windows_native_root_source(target_kind,target_id);
  SELECT * INTO retained FROM acp.windows_native_root_claims WHERE owner_id=target_id;
  IF FOUND THEN
    IF ROW(retained.owner_kind,retained.owner_id,retained.host_identifier,retained.tree_identifier,retained.process_id,retained.process_start_token,retained.supervision_scope)
      IS DISTINCT FROM ROW(source.owner_kind,source.owner_id,source.host_identifier,source.tree_identifier,source.process_id,source.process_start_token,source.supervision_scope) THEN
      RAISE EXCEPTION 'native root owner has a conflicting retained claim';
    END IF;
    RETURN;
  END IF;
  -- A process-backed stop validates prior ownership; it is not a repair API.
  IF (source.source_relation='worker_processes' AND EXISTS(SELECT 1 FROM acp.worker_launch_stops s
        JOIN acp.worker_launch_intents i USING(run_id) WHERE i.worker_process_id=target_id))
    OR (source.source_relation='worktree_provisioner_processes' AND EXISTS(SELECT 1 FROM acp.worktree_provisioner_stops WHERE attempt_id=target_id)) THEN
    RAISE EXCEPTION 'process-backed stop requires its existing native root claim';
  END IF;
  -- Plain insertion: the unique index, not a pre-wait snapshot, arbitrates owners.
  INSERT INTO acp.windows_native_root_claims(owner_kind,owner_id,host_identifier,tree_identifier,process_id,process_start_token,supervision_scope)
    VALUES(source.owner_kind,source.owner_id,source.host_identifier,source.tree_identifier,source.process_id,source.process_start_token,source.supervision_scope);
END;
$$;
CREATE FUNCTION acp.project_windows_native_root_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id acp.stable_id; target_kind text;
BEGIN
  IF TG_TABLE_NAME='worker_processes' THEN
    -- Historical scope is never invented; new supervised inserts require scope upstream.
    IF NEW.supervision_kind IS DISTINCT FROM 'windows_job' OR NEW.supervision_scope IS NULL THEN RETURN NEW; END IF;
    target_kind:='worker'; target_id:=NEW.worker_process_id;
  ELSIF TG_TABLE_NAME='worker_launch_stops' THEN
    IF NEW.root_process_id IS NULL THEN RETURN NEW; END IF;
    target_kind:='worker'; SELECT worker_process_id INTO STRICT target_id FROM acp.worker_launch_intents WHERE run_id=NEW.run_id;
  ELSE
    IF NEW.root_process_id IS NULL THEN RETURN NEW; END IF;
    target_kind:='provisioner'; target_id:=NEW.attempt_id;
  END IF;
  PERFORM acp.ensure_windows_native_root_claim(target_kind,target_id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER worker_processes_zz_native_root_claim AFTER INSERT ON acp.worker_processes FOR EACH ROW EXECUTE FUNCTION acp.project_windows_native_root_claim();
CREATE TRIGGER worker_launch_stops_zz_native_root_claim AFTER INSERT ON acp.worker_launch_stops FOR EACH ROW EXECUTE FUNCTION acp.project_windows_native_root_claim();
CREATE TRIGGER worktree_provisioner_processes_zz_native_root_claim AFTER INSERT ON acp.worktree_provisioner_processes FOR EACH ROW EXECUTE FUNCTION acp.project_windows_native_root_claim();
CREATE TRIGGER worktree_provisioner_stops_zz_native_root_claim AFTER INSERT ON acp.worktree_provisioner_stops FOR EACH ROW EXECUTE FUNCTION acp.project_windows_native_root_claim();
