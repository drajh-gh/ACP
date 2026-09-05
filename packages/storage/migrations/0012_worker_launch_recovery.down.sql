-- Never discard the only durable proof for a no-journal launch. Such history
-- intentionally requires retaining this migration, even after run completion.
LOCK TABLE acp.missions, acp.mission_nodes, acp.worker_runs, acp.worker_host_sessions,
  acp.worker_hosts, acp.worker_launch_intents, acp.worker_launch_revocations,
  acp.worker_launch_claims, acp.worker_launch_stops, acp.worker_processes IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM acp.worker_runs WHERE launch_worker_process_id IS NOT NULL AND state = 'started')
    OR EXISTS (SELECT 1 FROM acp.worker_launch_stops s WHERE NOT acp.worker_launch_stop_confirmed_0011(s.run_id)) THEN
    RAISE EXCEPTION 'launch recovery downgrade requires resolved runs and independent legacy-compatible stop journals';
  END IF;
END; $$;

DROP TRIGGER worker_runs_ab_launch_stop ON acp.worker_runs;
DROP TRIGGER mission_nodes_require_launch_stop ON acp.mission_nodes;
DROP TRIGGER missions_require_launch_stop ON acp.missions;
DROP FUNCTION acp.require_worker_launch_stop();
ALTER FUNCTION acp.require_worker_launch_stop_0011() RENAME TO require_worker_launch_stop;
DROP FUNCTION acp.worker_launch_stop_confirmed(acp.stable_id);
ALTER FUNCTION acp.worker_launch_stop_confirmed_0011(acp.stable_id) RENAME TO worker_launch_stop_confirmed;
CREATE TRIGGER worker_runs_ab_launch_stop BEFORE UPDATE ON acp.worker_runs FOR EACH ROW EXECUTE FUNCTION acp.require_worker_launch_stop();
CREATE TRIGGER mission_nodes_require_launch_stop BEFORE UPDATE OF state ON acp.mission_nodes FOR EACH ROW EXECUTE FUNCTION acp.require_worker_launch_stop();
CREATE TRIGGER missions_require_launch_stop BEFORE UPDATE OF state ON acp.missions FOR EACH ROW EXECUTE FUNCTION acp.require_worker_launch_stop();

DROP TRIGGER worker_processes_require_launch_receipt ON acp.worker_processes;
DROP FUNCTION acp.require_launch_process_stop_receipt();
DROP TRIGGER worker_processes_ad_launch_intent ON acp.worker_processes;
DROP FUNCTION acp.fence_worker_launch_journal();
ALTER FUNCTION acp.fence_worker_launch_journal_0011() RENAME TO fence_worker_launch_journal;
CREATE TRIGGER worker_processes_ad_launch_intent BEFORE INSERT OR UPDATE ON acp.worker_processes
FOR EACH ROW EXECUTE FUNCTION acp.fence_worker_launch_journal();

DROP FUNCTION acp.handoff_worker_run(acp.stable_id, integer, text, acp.stable_id, text);
ALTER FUNCTION acp.handoff_worker_run_legacy(acp.stable_id, integer, text, acp.stable_id, text) RENAME TO handoff_worker_run;
DROP TABLE acp.worker_launch_stops;
DROP TABLE acp.worker_launch_claims;
DROP TABLE acp.worker_launch_revocations;
DROP FUNCTION acp.audit_worker_launch_recovery();
DROP FUNCTION acp.require_launch_receipt_commit_authority();
DROP FUNCTION acp.validate_worker_launch_stop();
DROP FUNCTION acp.worker_launch_claim_held(acp.stable_id, acp.stable_id, acp.stable_id);
DROP FUNCTION acp.validate_worker_launch_claim();
DROP FUNCTION acp.validate_worker_launch_revocation();
DROP FUNCTION acp.make_worker_launch_recovery_provenance(acp.stable_id, text, acp.stable_id, text);
DROP FUNCTION acp.worker_launch_recovery_actor_valid(acp.stable_id, acp.stable_id, acp.stable_id, text, timestamptz);
DROP FUNCTION acp.lock_worker_launch(acp.stable_id);
-- Independent immutable mission-event receipts and native seals remain retained.
