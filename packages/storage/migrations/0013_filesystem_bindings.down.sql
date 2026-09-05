-- Binding identity is retained history, not disposable runtime configuration.
LOCK TABLE acp.repositories,acp.repository_bindings,acp.worktree_bindings,
  acp.repository_binding_retirements,acp.worktree_binding_retirements,acp.filesystem_directory_reservations IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM acp.repositories) THEN
    RAISE EXCEPTION 'filesystem binding downgrade requires no retained repository identity history';
  END IF;
END; $$;
DROP TABLE acp.worktree_binding_retirements;
DROP TABLE acp.repository_binding_retirements;
DROP TABLE acp.filesystem_directory_reservations;
DROP TABLE acp.worktree_bindings;
DROP TABLE acp.repository_bindings;
DROP TABLE acp.repositories;
DROP FUNCTION acp.require_filesystem_binding_commit_authority();
DROP FUNCTION acp.validate_filesystem_retirement();
DROP FUNCTION acp.validate_filesystem_binding();
DROP FUNCTION acp.validate_repository_identity();
DROP FUNCTION acp.reserve_filesystem_binding_directories();
DROP FUNCTION acp.validate_filesystem_directory_reservation();
DROP FUNCTION acp.filesystem_observation_actor_valid(acp.stable_id,text,acp.stable_id,text,acp.stable_id);
DROP FUNCTION acp.canonical_windows_binding_path(text);
