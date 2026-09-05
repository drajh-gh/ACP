LOCK TABLE acp.worktree_provisioner_attempts IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM acp.worktree_provisioner_attempts) THEN
    RAISE EXCEPTION '0016 downgrade would remove retained provisioner plan history';
  END IF;
END; $$;
DROP VIEW acp.worktree_provisioner_status;
DROP TABLE acp.worktree_provisioner_attempts;
DROP FUNCTION acp.audit_worktree_provisioner_plan();
DROP FUNCTION acp.require_worktree_provisioner_plan_commit_authority();
DROP FUNCTION acp.validate_worktree_provisioner_plan();
DROP FUNCTION acp.lock_worktree_provisioner_plan(acp.stable_id);
