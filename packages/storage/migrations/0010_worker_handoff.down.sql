-- Never restore an owner's authority while an abandoned execution is unresolved.
LOCK TABLE acp.worker_run_recovery_handoffs IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM acp.worker_run_recovery_handoffs h JOIN acp.worker_runs r USING(run_id) WHERE r.state = 'started') THEN
    RAISE EXCEPTION '0010 downgrade requires all handed-off runs to be reconciled';
  END IF;
END; $$;
DROP TRIGGER worker_runs_aa_handoff ON acp.worker_runs;
DROP TRIGGER worker_processes_ac_handoff ON acp.worker_processes;
DROP FUNCTION acp.fence_handed_off_run_result();
DROP FUNCTION acp.fence_handed_off_process();
DROP FUNCTION acp.handoff_recovery_provenance_valid(acp.stable_id, acp.stable_id, text);
DROP FUNCTION acp.handoff_worker_run(acp.stable_id, integer, text, acp.stable_id, text);
DROP FUNCTION acp.worker_run_recovery_eligible(acp.stable_id);
DROP FUNCTION acp.worker_run_handed_off(acp.stable_id);
DROP TABLE acp.worker_run_recovery_handoffs;
DROP FUNCTION acp.audit_worker_run_handoff();
DROP FUNCTION acp.validate_worker_run_handoff();
-- The append-only worker.recovery-handed-off mission events remain as receipts.
