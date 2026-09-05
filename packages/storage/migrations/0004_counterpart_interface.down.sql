-- Transaction ownership belongs to the migration runner.

DROP TABLE IF EXISTS acp.counterpart_mission_requests;
DROP FUNCTION IF EXISTS acp.validate_counterpart_mission_request();
