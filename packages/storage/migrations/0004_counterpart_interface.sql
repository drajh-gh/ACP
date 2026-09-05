-- Transaction ownership belongs to the migration runner.

CREATE TABLE acp.counterpart_mission_requests (
  client_request_id text PRIMARY KEY CHECK (
    length(btrim(client_request_id)) > 0
    AND length(client_request_id) <= 200
  ),
  request_digest text NOT NULL CHECK (
    request_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  mission_id acp.stable_id NOT NULL UNIQUE
    REFERENCES acp.missions (mission_id),
  provenance_id acp.stable_id NOT NULL
    REFERENCES acp.runtime_provenance (provenance_id),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE FUNCTION acp.validate_counterpart_mission_request()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT acp.runtime_provenance_matches_context(
    NEW.provenance_id,
    NEW.mission_id
  ) THEN
    RAISE EXCEPTION
      'counterpart mission request provenance does not match mission context';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER counterpart_mission_requests_validate
BEFORE INSERT ON acp.counterpart_mission_requests
FOR EACH ROW EXECUTE FUNCTION acp.validate_counterpart_mission_request();

CREATE TRIGGER counterpart_mission_requests_are_immutable
BEFORE UPDATE OR DELETE ON acp.counterpart_mission_requests
FOR EACH ROW EXECUTE FUNCTION acp.reject_immutable_mutation();
