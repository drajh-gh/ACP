-- Transaction ownership belongs to the migration runner.
DROP TRIGGER IF EXISTS worker_runs_aa_require_authoritative_context ON acp.worker_runs;
DROP FUNCTION IF EXISTS acp.require_authoritative_worker_context();
DROP TRIGGER IF EXISTS context_packets_validate_authoritative ON acp.context_packets;
DROP FUNCTION IF EXISTS acp.validate_authoritative_context_packet();
DROP FUNCTION IF EXISTS acp.build_context_packet_content(acp.stable_id, acp.stable_id, acp.stable_id, acp.stable_id, acp.stable_id);
ALTER TABLE acp.context_packets DROP COLUMN context_revision_id,
  DROP COLUMN build_request_digest, DROP COLUMN runtime_template_provenance_id;
DROP TABLE acp.node_context_revisions;
DROP FUNCTION acp.validate_node_context_revision();
