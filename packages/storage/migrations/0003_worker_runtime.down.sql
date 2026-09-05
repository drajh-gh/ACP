-- Transaction ownership belongs to the migration runner.

DROP TRIGGER IF EXISTS worker_hosts_validate_update ON acp.worker_hosts;
DROP FUNCTION IF EXISTS acp.validate_worker_host_update();
DROP TRIGGER IF EXISTS capability_grant_uses_are_immutable
  ON acp.capability_grant_uses;
DROP TRIGGER IF EXISTS missions_require_worker_process_stop ON acp.missions;
DROP FUNCTION IF EXISTS acp.require_worker_process_stop_before_mission_terminal();
DROP TRIGGER IF EXISTS mission_nodes_require_worker_process_stop
  ON acp.mission_nodes;
DROP FUNCTION IF EXISTS acp.require_worker_process_stop_before_node_terminal();
DROP TRIGGER IF EXISTS worker_processes_protect_identity ON acp.worker_processes;
DROP FUNCTION IF EXISTS acp.protect_worker_process_identity();
DROP TABLE IF EXISTS acp.worker_processes;

DROP TRIGGER IF EXISTS worker_runs_validate_result ON acp.worker_runs;
DROP FUNCTION IF EXISTS acp.validate_worker_run_result();
DROP TRIGGER IF EXISTS worker_runs_record_capability_use ON acp.worker_runs;
DROP FUNCTION IF EXISTS acp.record_capability_grant_use();
DROP TRIGGER IF EXISTS worker_runs_authorize ON acp.worker_runs;
DROP FUNCTION IF EXISTS acp.authorize_worker_run();
DROP TABLE IF EXISTS acp.capability_grant_uses;
DROP INDEX IF EXISTS acp.worker_runs_one_active_node;

ALTER TABLE acp.worker_runs
  DROP CONSTRAINT IF EXISTS worker_runs_context_capability_fk,
  DROP CONSTRAINT IF EXISTS worker_runs_timeout_after_start,
  DROP CONSTRAINT IF EXISTS worker_runs_run_grant_unique,
  DROP COLUMN IF EXISTS capability_grant_id,
  DROP COLUMN IF EXISTS host_identifier,
  DROP COLUMN IF EXISTS resource_class,
  DROP COLUMN IF EXISTS operation,
  DROP COLUMN IF EXISTS resource,
  DROP COLUMN IF EXISTS requested_mode,
  DROP COLUMN IF EXISTS workspace,
  DROP COLUMN IF EXISTS network_destination,
  DROP COLUMN IF EXISTS timeout_at;

DROP TABLE IF EXISTS acp.worker_hosts;

DROP TRIGGER IF EXISTS context_packets_validate_identity ON acp.context_packets;
DROP FUNCTION IF EXISTS acp.validate_context_packet_identity();
ALTER TABLE acp.context_packets
  DROP CONSTRAINT IF EXISTS context_packets_capability_grant_fk,
  DROP CONSTRAINT IF EXISTS context_packets_capability_identity_unique,
  DROP COLUMN IF EXISTS capability_grant_id;

DROP TRIGGER IF EXISTS capability_grants_are_immutable ON acp.capability_grants;
DROP TRIGGER IF EXISTS capability_grants_validate ON acp.capability_grants;
DROP FUNCTION IF EXISTS acp.validate_capability_grant();
DROP TABLE IF EXISTS acp.capability_grants;
DROP TRIGGER IF EXISTS capability_grant_evaluations_are_immutable
  ON acp.capability_grant_evaluations;
DROP TRIGGER IF EXISTS capability_grant_evaluations_validate
  ON acp.capability_grant_evaluations;
DROP FUNCTION IF EXISTS acp.validate_capability_grant_evaluation();
DROP TABLE IF EXISTS acp.capability_grant_evaluations;
DROP FUNCTION IF EXISTS acp.jsonb_sha256(jsonb);
DROP FUNCTION IF EXISTS acp.canonical_jsonb_text(jsonb);
