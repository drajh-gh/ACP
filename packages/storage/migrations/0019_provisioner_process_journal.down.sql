-- Exclude journal writers before deciding that there is no retained history.
LOCK TABLE acp.worktree_provisioner_processes,acp.worktree_provisioner_stops IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM acp.worktree_provisioner_processes) OR EXISTS(SELECT 1 FROM acp.worktree_provisioner_stops) THEN
    RAISE EXCEPTION 'cannot downgrade retained provisioner process or stop history';
  END IF;
END $$;
DROP TABLE acp.worktree_provisioner_stops;
DROP TABLE acp.worktree_provisioner_processes;
DROP FUNCTION acp.audit_provisioner_journal();
DROP FUNCTION acp.require_provisioner_journal_commit_authority();
DROP FUNCTION acp.validate_provisioner_journal();
DROP FUNCTION acp.provisioner_journal_actor_valid(acp.stable_id,boolean);
DROP FUNCTION acp.lock_provisioner_journal(acp.stable_id);
DROP FUNCTION acp.provisioner_native_scope_valid(jsonb);
DROP FUNCTION acp.provisioner_root_within_recording_window(text,timestamptz,timestamptz);
DROP FUNCTION acp.provisioner_native_root_valid(integer,text,text);
DROP FUNCTION acp.provisioner_utc7_filetime(text);
