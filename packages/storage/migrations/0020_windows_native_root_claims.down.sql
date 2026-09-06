-- Only this deterministic projection is removed; every original source survives.
LOCK TABLE acp.worker_launch_intents,acp.worker_processes,acp.worker_launch_stops,
  acp.worktree_provisioner_processes,acp.worktree_provisioner_stops,
  acp.windows_native_root_claims IN ACCESS EXCLUSIVE MODE NOWAIT;
DROP TRIGGER worker_processes_zz_native_root_claim ON acp.worker_processes;
DROP TRIGGER worker_launch_stops_zz_native_root_claim ON acp.worker_launch_stops;
DROP TRIGGER worktree_provisioner_processes_zz_native_root_claim ON acp.worktree_provisioner_processes;
DROP TRIGGER worktree_provisioner_stops_zz_native_root_claim ON acp.worktree_provisioner_stops;
DROP FUNCTION acp.project_windows_native_root_claim();
DROP FUNCTION acp.ensure_windows_native_root_claim(text,acp.stable_id);
DROP TABLE acp.windows_native_root_claims;
DROP FUNCTION acp.validate_windows_native_root_claim();
DROP FUNCTION acp.windows_native_root_source(text,acp.stable_id);
