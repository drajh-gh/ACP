LOCK TABLE acp.worktree_provisioner_processes,acp.worktree_provisioner_stops,
  acp.windows_native_root_claims,acp.worktree_provisioner_admissions IN ACCESS EXCLUSIVE MODE NOWAIT;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM acp.worktree_provisioner_admissions) THEN
    RAISE EXCEPTION 'cannot downgrade retained provisioner admission history';
  END IF;
END $$;
ALTER TABLE acp.worktree_provisioner_processes DROP CONSTRAINT worktree_provisioner_process_admission_pair;
DROP TABLE acp.worktree_provisioner_admissions;
DROP FUNCTION acp.audit_provisioner_admission();
DROP FUNCTION acp.require_provisioner_admission_commit_authority();
DROP FUNCTION acp.validate_provisioner_admission();
DROP FUNCTION acp.provisioner_admission_source_valid(acp.stable_id);
ALTER TABLE acp.worktree_provisioner_processes DROP COLUMN admission_attempt_id;
CREATE OR REPLACE FUNCTION acp.audit_provisioner_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p acp.worktree_provisioner_attempts; payload jsonb; event_kind text;
BEGIN
  SELECT * INTO STRICT p FROM acp.worktree_provisioner_attempts WHERE attempt_id=NEW.attempt_id;
  payload:=to_jsonb(NEW); event_kind:=CASE WHEN TG_TABLE_NAME='worktree_provisioner_processes' THEN 'filesystem.provisioner-process-recorded' ELSE 'filesystem.provisioner-stopped' END;
  INSERT INTO acp.mission_events(event_id,mission_id,event_type,event_version,idempotency_key,event_digest,payload,occurred_at,provenance_id)
    VALUES(('evt_'||gen_random_uuid())::acp.stable_id,p.mission_id,event_kind,'1.0.0',p.attempt_id::text,acp.jsonb_sha256(payload),payload,NEW.recorded_at,NEW.provenance_id);
  RETURN NEW;
END;
$$;
