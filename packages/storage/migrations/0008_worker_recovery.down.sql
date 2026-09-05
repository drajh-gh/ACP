-- Transaction ownership belongs to the migration runner.
DROP FUNCTION acp.worker_recovery_runtime_live(acp.stable_id, text, acp.stable_id, text);
DROP FUNCTION acp.worker_run_owner_retired(acp.stable_id);
DROP TRIGGER worker_processes_ab_scope ON acp.worker_processes;
DROP FUNCTION acp.validate_worker_supervision_scope();
ALTER TABLE acp.worker_processes DROP COLUMN supervision_scope;
