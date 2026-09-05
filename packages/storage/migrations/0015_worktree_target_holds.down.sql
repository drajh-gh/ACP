-- Removing the additional projection is safe only before provisioning history.
-- Existing writer rows and their original four unique indexes remain untouched.
LOCK TABLE acp.filesystem_writer_leases,acp.filesystem_writer_releases,acp.repository_bindings,
  acp.worktree_bindings,acp.filesystem_directory_reservations,acp.worktree_reservations,acp.filesystem_exclusion_keys IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM acp.worktree_reservations) THEN
    RAISE EXCEPTION '0015 downgrade would remove retained pre-run target history';
  END IF;
END; $$;
DROP TRIGGER filesystem_directory_prospective_guard ON acp.filesystem_directory_reservations;
DROP TRIGGER filesystem_writer_leases_shared_keys ON acp.filesystem_writer_leases;
DROP TRIGGER filesystem_writer_shared_projection ON acp.filesystem_writer_leases;
DROP VIEW acp.worktree_reservation_status;
DROP TABLE acp.filesystem_exclusion_keys;
DROP TABLE acp.worktree_reservations;
DROP FUNCTION acp.audit_worktree_reservation();
DROP FUNCTION acp.require_worktree_reservation_commit_authority();
DROP FUNCTION acp.require_filesystem_exclusion_projection();
DROP FUNCTION acp.project_filesystem_exclusion_keys();
DROP FUNCTION acp.validate_filesystem_exclusion_key();
DROP FUNCTION acp.deny_binding_over_prospective_workspace();
DROP FUNCTION acp.validate_worktree_reservation();
DROP FUNCTION acp.worktree_reservation_owner_valid(acp.stable_id,acp.stable_id,text,acp.stable_id,text,acp.stable_id,text,acp.stable_id,acp.stable_id,integer,text);
DROP FUNCTION acp.lock_worktree_reservation(acp.stable_id,acp.stable_id,acp.stable_id,text);
DROP FUNCTION acp.reservation_exclusion_keys(acp.stable_id);
DROP FUNCTION acp.writer_exclusion_keys(acp.stable_id);
DROP FUNCTION acp.filesystem_paths_overlap(text,text);
DROP FUNCTION acp.filesystem_prospective_path_key(text,text);
