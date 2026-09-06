-- Original request identity and recorded mission associations only.
-- Transaction ownership belongs to the migration runner. No execution/grant/closure path.
LOCK TABLE acp.intake_records IN ACCESS EXCLUSIVE MODE NOWAIT;
ALTER TABLE acp.intake_records ADD CONSTRAINT intake_records_intake_project_unique UNIQUE(intake_id,project_id);

CREATE TABLE acp.request_records (
  request_id acp.stable_id PRIMARY KEY CHECK(request_id::text ~ '^req_'),
  project_id acp.stable_id NOT NULL REFERENCES acp.projects(project_id),
  source_intake_id acp.stable_id NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  provenance_id acp.stable_id NOT NULL REFERENCES acp.runtime_provenance(provenance_id),
  recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at)),
  UNIQUE(request_id,project_id),
  FOREIGN KEY(source_intake_id,project_id) REFERENCES acp.intake_records(intake_id,project_id)
);
CREATE INDEX request_records_project ON acp.request_records(project_id,recorded_at,request_id);
CREATE TABLE acp.request_mission_associations (
  request_id acp.stable_id NOT NULL,
  project_id acp.stable_id NOT NULL,
  mission_id acp.stable_id NOT NULL,
  reason text NOT NULL,
  provenance_id acp.stable_id NOT NULL REFERENCES acp.runtime_provenance(provenance_id),
  recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at)),
  PRIMARY KEY(request_id,mission_id),
  FOREIGN KEY(request_id,project_id) REFERENCES acp.request_records(request_id,project_id),
  FOREIGN KEY(mission_id,project_id) REFERENCES acp.missions(mission_id,project_id)
);
CREATE INDEX request_mission_associations_mission ON acp.request_mission_associations(mission_id,request_id);

CREATE FUNCTION acp.request_registration_body(r acp.request_records) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('requestId',r.request_id,'projectId',r.project_id,'sourceIntakeId',r.source_intake_id,'title',r.title,'summary',r.summary)
$$;
CREATE FUNCTION acp.request_mission_link_body(r acp.request_mission_associations) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('requestId',r.request_id,'projectId',r.project_id,'missionId',r.mission_id,'reason',r.reason)
$$;
CREATE FUNCTION acp.validate_request_identity_body(body jsonb, kind text) RETURNS void LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE keys text[]; key text; prefix text;
BEGIN
  IF kind IS NULL OR kind NOT IN ('registration','association') THEN RAISE EXCEPTION 'unknown request recording kind'; END IF;
  keys:=CASE kind WHEN 'registration' THEN ARRAY['requestId','projectId','sourceIntakeId','title','summary'] ELSE ARRAY['requestId','projectId','missionId','reason'] END;
  IF jsonb_typeof(body) IS DISTINCT FROM 'object' OR octet_length(body::text)>32768 OR NOT body ?& keys OR body-keys<>'{}'::jsonb THEN
    RAISE EXCEPTION 'exact bounded request body required'; END IF;
  FOREACH key IN ARRAY keys LOOP
    IF jsonb_typeof(body->key) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'request fields must be strings'; END IF;
    prefix:=CASE key WHEN 'requestId' THEN 'req' WHEN 'projectId' THEN 'prj' WHEN 'sourceIntakeId' THEN 'int' WHEN 'missionId' THEN 'mis' ELSE NULL END;
    IF prefix IS NOT NULL THEN
      IF body->>key !~ ('^'||prefix||'_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') THEN
        RAISE EXCEPTION 'typed request reference required'; END IF;
    ELSIF NOT acp.attention_text(body->>key,CASE key WHEN 'title' THEN 240 WHEN 'summary' THEN 4000 ELSE 1000 END,key='title') THEN
      RAISE EXCEPTION 'bounded canonical request description required';
    END IF;
  END LOOP;
END; $$;

-- This private producer gate authorizes only recording, never the linked work.
-- Constructor-bound provenance must name a currently active same-project binding.
CREATE FUNCTION acp.require_request_recording_provenance(project acp.stable_id, provenance acp.stable_id)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE p acp.runtime_provenance; b acp.project_workflow_bindings; observed timestamptz;
BEGIN
  SELECT * INTO STRICT p FROM acp.runtime_provenance WHERE provenance_id=provenance;
  SELECT * INTO STRICT b FROM acp.project_workflow_bindings WHERE binding_id=p.workflow_binding_id FOR SHARE;
  observed:=clock_timestamp();
  IF NOT isfinite(p.recorded_at) OR p.recorded_at<'0001-01-01T00:00:00Z' OR p.recorded_at>='10000-01-01T00:00:00Z' OR p.recorded_at>observed
    OR b.project_id<>project OR (b.profile_id,b.profile_version) IS DISTINCT FROM (p.project_profile_id,p.project_profile_version)
    OR b.active_from>observed OR (b.retired_at IS NOT NULL AND b.retired_at<=observed) THEN
    RAISE EXCEPTION 'request recording requires current same-project producer provenance'; END IF;
END; $$;
CREATE FUNCTION acp.guard_request_record_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.recorded_at IS NOT NULL THEN RAISE EXCEPTION 'request recording time is server-owned'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('acp:request-identity:'||NEW.request_id,0));
  PERFORM acp.validate_request_identity_body(acp.request_registration_body(NEW),'registration');
  PERFORM acp.require_request_recording_provenance(NEW.project_id,NEW.provenance_id);
  NEW.recorded_at:=clock_timestamp(); RETURN NEW;
END; $$;
CREATE FUNCTION acp.guard_request_mission_link_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.recorded_at IS NOT NULL THEN RAISE EXCEPTION 'request association time is server-owned'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('acp:request-identity:'||NEW.request_id,0));
  PERFORM acp.validate_request_identity_body(acp.request_mission_link_body(NEW),'association');
  PERFORM acp.require_request_recording_provenance(NEW.project_id,NEW.provenance_id);
  NEW.recorded_at:=clock_timestamp(); RETURN NEW;
END; $$;
CREATE TRIGGER request_record_insert BEFORE INSERT ON acp.request_records FOR EACH ROW EXECUTE FUNCTION acp.guard_request_record_insert();
CREATE TRIGGER request_mission_link_insert BEFORE INSERT ON acp.request_mission_associations FOR EACH ROW EXECUTE FUNCTION acp.guard_request_mission_link_insert();
CREATE TRIGGER request_records_retained BEFORE UPDATE OR DELETE OR TRUNCATE ON acp.request_records
FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();
CREATE TRIGGER request_mission_associations_retained BEFORE UPDATE OR DELETE OR TRUNCATE ON acp.request_mission_associations
FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE FUNCTION acp.record_request_identity(body jsonb, producer acp.stable_id) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r acp.request_records; was_replayed boolean;
BEGIN
  PERFORM acp.validate_request_identity_body(body,'registration');
  PERFORM pg_advisory_xact_lock(hashtextextended('acp:request-identity:'||(body->>'requestId'),0));
  SELECT * INTO r FROM acp.request_records WHERE request_id=(body->>'requestId')::acp.stable_id;
  was_replayed:=FOUND;
  IF was_replayed THEN
    IF acp.request_registration_body(r) IS DISTINCT FROM body OR r.provenance_id IS DISTINCT FROM producer THEN
      RAISE EXCEPTION 'request identity aliases different immutable terms or producer'; END IF;
  ELSE
    INSERT INTO acp.request_records(request_id,project_id,source_intake_id,title,summary,provenance_id)
      VALUES((body->>'requestId')::acp.stable_id,(body->>'projectId')::acp.stable_id,(body->>'sourceIntakeId')::acp.stable_id,body->>'title',body->>'summary',producer)
      RETURNING * INTO r;
  END IF;
  RETURN jsonb_build_object('schemaVersion','1.0.0','record',acp.request_registration_body(r),
    'recordedAt',acp.readiness_timestamp(r.recorded_at),'provenanceId',r.provenance_id,'replayed',was_replayed,'authority','not_granted');
END; $$;
CREATE FUNCTION acp.record_request_mission_link(body jsonb, producer acp.stable_id) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r acp.request_mission_associations; was_replayed boolean;
BEGIN
  PERFORM acp.validate_request_identity_body(body,'association');
  PERFORM pg_advisory_xact_lock(hashtextextended('acp:request-identity:'||(body->>'requestId'),0));
  SELECT * INTO r FROM acp.request_mission_associations WHERE request_id=(body->>'requestId')::acp.stable_id AND mission_id=(body->>'missionId')::acp.stable_id;
  was_replayed:=FOUND;
  IF was_replayed THEN
    IF acp.request_mission_link_body(r) IS DISTINCT FROM body OR r.provenance_id IS DISTINCT FROM producer THEN
      RAISE EXCEPTION 'request association aliases different immutable terms or producer'; END IF;
  ELSE
    INSERT INTO acp.request_mission_associations(request_id,project_id,mission_id,reason,provenance_id)
      VALUES((body->>'requestId')::acp.stable_id,(body->>'projectId')::acp.stable_id,(body->>'missionId')::acp.stable_id,body->>'reason',producer)
      RETURNING * INTO r;
  END IF;
  RETURN jsonb_build_object('schemaVersion','1.0.0','record',acp.request_mission_link_body(r),
    'recordedAt',acp.readiness_timestamp(r.recorded_at),'provenanceId',r.provenance_id,'replayed',was_replayed,'authority','not_granted');
END; $$;
