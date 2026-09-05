-- Never erase the identity of an unresolved launch or remove native tombstones.
LOCK TABLE acp.missions, acp.mission_nodes, acp.worker_runs, acp.worker_host_sessions,
  acp.worker_hosts, acp.worker_launch_intents, acp.worker_processes IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM acp.worker_runs WHERE launch_worker_process_id IS NOT NULL
    AND (state = 'started' OR NOT acp.worker_launch_stop_confirmed(run_id))) THEN
    RAISE EXCEPTION 'downgrade requires all launch-intent runs to be resolved';
  END IF;
END; $$;
DROP TRIGGER worker_host_sessions_deny_truncate ON acp.worker_host_sessions;
DROP TRIGGER worker_host_runtimes_deny_truncate ON acp.worker_host_runtimes;
DROP TRIGGER worker_host_sessions_zz_launch_retirement ON acp.worker_host_sessions;
DROP TRIGGER worker_hosts_zz_launch_retirement ON acp.worker_hosts;
DROP FUNCTION acp.fence_launch_owner_retirement();
DROP TRIGGER worker_run_recovery_handoffs_aa_launch ON acp.worker_run_recovery_handoffs;
DROP FUNCTION acp.deny_legacy_launch_handoff();
DROP TRIGGER worker_runs_ab_launch_stop ON acp.worker_runs;
DROP TRIGGER mission_nodes_require_launch_stop ON acp.mission_nodes;
DROP TRIGGER missions_require_launch_stop ON acp.missions;
DROP FUNCTION acp.require_worker_launch_stop();
DROP FUNCTION acp.worker_launch_stop_confirmed(acp.stable_id);
DROP TRIGGER worker_processes_ad_launch_intent ON acp.worker_processes;
DROP FUNCTION acp.fence_worker_launch_journal();
ALTER TABLE acp.worker_runs DROP CONSTRAINT worker_runs_launch_intent;
DROP TABLE acp.worker_launch_intents;
DROP FUNCTION acp.audit_worker_launch_intent();
DROP FUNCTION acp.validate_worker_launch_intent();
ALTER TABLE acp.worker_runs DROP COLUMN launch_worker_process_id;
-- Independent worker.launch-admitted mission events remain append-only.
