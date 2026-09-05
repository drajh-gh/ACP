-- Transaction ownership belongs to the migration runner.
DROP TRIGGER worker_processes_aa_supervised_admission ON acp.worker_processes;
DROP FUNCTION acp.admit_supervised_worker_process();
DROP INDEX acp.worker_processes_one_owned_root_per_run;
ALTER TABLE acp.worker_processes DROP CONSTRAINT worker_process_supervision_pair,
  DROP COLUMN supervision_kind, DROP COLUMN tree_identifier;
