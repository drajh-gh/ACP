-- Transaction ownership belongs to the migration runner. Retained identity is never discarded by downgrade.
LOCK TABLE acp.request_records,acp.request_mission_associations,acp.intake_records IN ACCESS EXCLUSIVE MODE NOWAIT;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM acp.request_records) OR EXISTS(SELECT 1 FROM acp.request_mission_associations) THEN
    RAISE EXCEPTION 'request identity history requires preservation; downgrade refused'; END IF;
END $$;
DROP FUNCTION acp.record_request_mission_link(jsonb,acp.stable_id);
DROP FUNCTION acp.record_request_identity(jsonb,acp.stable_id);
DROP TRIGGER request_mission_link_insert ON acp.request_mission_associations;
DROP TRIGGER request_record_insert ON acp.request_records;
DROP FUNCTION acp.guard_request_mission_link_insert();
DROP FUNCTION acp.guard_request_record_insert();
DROP FUNCTION acp.require_request_recording_provenance(acp.stable_id,acp.stable_id);
DROP FUNCTION acp.validate_request_identity_body(jsonb,text);
DROP FUNCTION acp.request_mission_link_body(acp.request_mission_associations);
DROP FUNCTION acp.request_registration_body(acp.request_records);
DROP TABLE acp.request_mission_associations;
DROP TABLE acp.request_records;
ALTER TABLE acp.intake_records DROP CONSTRAINT intake_records_intake_project_unique;
