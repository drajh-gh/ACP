-- Recorded human attention, not decisions, notifications or execution authority.
-- Transaction ownership belongs to the migration runner.
CREATE FUNCTION acp.attention_text(value text, maximum_units integer, single_line boolean DEFAULT false)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT value IS NOT NULL AND value<>'' AND value=btrim(value,E' \t\r\n')
    AND (CASE WHEN single_line THEN value ELSE translate(value,E'\t\r\n','') END) !~ '[[:cntrl:]]'
    AND value !~ U&'^[\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]|[\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]$'
    AND char_length(value)+char_length(regexp_replace(value,U&'[\0001-\FFFF]','','g'))<=maximum_units
$$;
CREATE FUNCTION acp.validate_attention_body(body jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE required text[]:=ARRAY['itemId','projectId','missionIds','type','urgency','title','explanation','whyHumanIsNeeded','evidenceIds','allowedResponses','deduplicationKey','quietHoursDisposition'];
  optional text[]:=ARRAY['recommendation','alternatives','consequenceOfNoAction','effectPreviewIds','expiresAt'];
  key text; ids jsonb; prefix text; maximum integer; minimum integer; val jsonb; expires timestamptz;
BEGIN
  IF jsonb_typeof(body) IS DISTINCT FROM 'object' OR octet_length(body::text)>65536 OR NOT body ?& required OR body-(required||optional)<>'{}'::jsonb THEN
    RAISE EXCEPTION 'exact bounded attention body required'; END IF;
  IF jsonb_typeof(body->'itemId') IS DISTINCT FROM 'string' OR body->>'itemId' !~ '^ati_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR jsonb_typeof(body->'projectId') IS DISTINCT FROM 'string' OR body->>'projectId' !~ '^prj_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR jsonb_typeof(body->'type') IS DISTINCT FROM 'string' OR body->>'type' NOT IN ('exact_approval_requested','business_or_product_decision_required',
      'material_ambiguity','credible_source_conflict','approval_invalidated_by_drift','unknown_external_outcome','repeated_automated_repair_failure',
      'failed_independent_acceptance','credential_expired_or_revoked','capability_became_unavailable','critical_incident_notification','unrecoverable_coverage_gap')
    OR jsonb_typeof(body->'urgency') IS DISTINCT FROM 'string' OR body->>'urgency' NOT IN ('critical','high','normal','low') THEN
    RAISE EXCEPTION 'exact attention identity and vocabulary required'; END IF;
  FOREACH key IN ARRAY ARRAY['title','explanation','whyHumanIsNeeded','recommendation','consequenceOfNoAction','deduplicationKey','quietHoursDisposition'] LOOP
    IF NOT body ? key THEN CONTINUE; END IF;
    maximum:=CASE key WHEN 'title' THEN 240 WHEN 'deduplicationKey' THEN 200 WHEN 'quietHoursDisposition' THEN 1000 ELSE 4000 END;
    IF jsonb_typeof(body->key) IS DISTINCT FROM 'string' OR NOT acp.attention_text(body->>key,maximum,key IN ('title','deduplicationKey')) THEN
      RAISE EXCEPTION 'bounded canonical attention description required'; END IF;
  END LOOP;
  FOREACH key IN ARRAY ARRAY['missionIds','evidenceIds','effectPreviewIds'] LOOP
    IF NOT body ? key THEN CONTINUE; END IF; ids:=body->key;
    prefix:=CASE key WHEN 'missionIds' THEN 'mis' WHEN 'evidenceIds' THEN 'evd' ELSE 'eff' END;
    IF jsonb_typeof(ids) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'attention references require arrays'; END IF;
    IF jsonb_array_length(ids)>50 OR EXISTS(SELECT 1 FROM jsonb_array_elements(ids) i WHERE jsonb_typeof(i)<>'string')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(ids) i(id) WHERE id !~ ('^'||prefix||'_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
      OR ids IS DISTINCT FROM (SELECT coalesce(jsonb_agg(id ORDER BY id COLLATE "C"),'[]'::jsonb) FROM (SELECT DISTINCT id FROM jsonb_array_elements_text(ids) i(id)) s) THEN
      RAISE EXCEPTION 'bounded unique sorted attention references required'; END IF;
  END LOOP;
  FOREACH key IN ARRAY ARRAY['alternatives','allowedResponses'] LOOP
    IF NOT body ? key THEN CONTINUE; END IF; ids:=body->key; minimum:=CASE key WHEN 'allowedResponses' THEN 1 ELSE 0 END;
    maximum:=CASE key WHEN 'allowedResponses' THEN 200 ELSE 1000 END;
    IF jsonb_typeof(ids) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'attention descriptions require arrays'; END IF;
    IF jsonb_array_length(ids) NOT BETWEEN minimum AND 10
      OR (SELECT count(DISTINCT i) FROM jsonb_array_elements(ids) i)<>jsonb_array_length(ids) THEN RAISE EXCEPTION 'bounded unique attention descriptions required'; END IF;
    FOR val IN SELECT value FROM jsonb_array_elements(ids) LOOP
      IF jsonb_typeof(val) IS DISTINCT FROM 'string' OR NOT acp.attention_text(val#>>'{}',maximum) THEN RAISE EXCEPTION 'canonical attention description required'; END IF;
    END LOOP;
  END LOOP;
  IF body ? 'expiresAt' THEN
    IF jsonb_typeof(body->'expiresAt') IS DISTINCT FROM 'string' OR body->>'expiresAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$' THEN
      RAISE EXCEPTION 'canonical attention UTC6 expiry required'; END IF;
    expires:=(body->>'expiresAt')::timestamptz;
    IF NOT isfinite(expires) OR expires<'0001-01-01T00:00:00Z' OR expires>='10000-01-01T00:00:00Z'
      OR acp.readiness_timestamp(expires) IS DISTINCT FROM body->>'expiresAt' THEN RAISE EXCEPTION 'valid attention expiry required'; END IF;
  END IF;
END; $$;

CREATE TABLE acp.attention_items (
  item_id acp.stable_id PRIMARY KEY CHECK (item_id::text ~ '^ati_'),
  project_id acp.stable_id NOT NULL REFERENCES acp.projects(project_id),
  deduplication_key text NOT NULL,
  body jsonb NOT NULL,
  storage_digest text NOT NULL CHECK (storage_digest ~ '^sha256:[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL,
  provenance_id acp.stable_id NOT NULL REFERENCES acp.runtime_provenance(provenance_id),
  UNIQUE(project_id,deduplication_key), UNIQUE(item_id,project_id)
);
CREATE INDEX attention_items_queue ON acp.attention_items(project_id,
  (CASE body->>'urgency' WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END),recorded_at,item_id);
CREATE TABLE acp.attention_requests (
  request_id acp.stable_id PRIMARY KEY CHECK (request_id::text ~ '^ati_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  item_id acp.stable_id NOT NULL,
  project_id acp.stable_id NOT NULL,
  provenance_id acp.stable_id NOT NULL REFERENCES acp.runtime_provenance(provenance_id),
  recorded_at timestamptz NOT NULL,
  FOREIGN KEY(item_id,project_id) REFERENCES acp.attention_items(item_id,project_id)
);
CREATE TABLE acp.attention_item_missions (
  item_id acp.stable_id NOT NULL REFERENCES acp.attention_items(item_id),
  mission_id acp.stable_id NOT NULL REFERENCES acp.missions(mission_id), PRIMARY KEY(item_id,mission_id)
);
CREATE INDEX attention_item_missions_lookup ON acp.attention_item_missions(mission_id,item_id);
CREATE TABLE acp.attention_item_evidence (
  item_id acp.stable_id NOT NULL REFERENCES acp.attention_items(item_id),
  evidence_id acp.stable_id NOT NULL REFERENCES acp.evidence_records(evidence_id), PRIMARY KEY(item_id,evidence_id)
);
CREATE TABLE acp.attention_item_effect_previews (
  item_id acp.stable_id NOT NULL REFERENCES acp.attention_items(item_id),
  effect_id acp.stable_id NOT NULL REFERENCES acp.effect_proposals(effect_id), PRIMARY KEY(item_id,effect_id)
);

CREATE FUNCTION acp.require_attention_authority(project acp.stable_id, provenance acp.stable_id) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p acp.runtime_provenance; b acp.project_workflow_bindings; observed timestamptz;
BEGIN
  SELECT * INTO STRICT p FROM acp.runtime_provenance WHERE provenance_id=provenance;
  SELECT * INTO STRICT b FROM acp.project_workflow_bindings WHERE binding_id=p.workflow_binding_id FOR SHARE;
  observed:=clock_timestamp();
  IF NOT isfinite(p.recorded_at) OR p.recorded_at<'0001-01-01T00:00:00Z' OR p.recorded_at>='10000-01-01T00:00:00Z' OR p.recorded_at>observed
    OR b.project_id<>project OR (b.profile_id,b.profile_version) IS DISTINCT FROM (p.project_profile_id,p.project_profile_version)
    OR b.active_from>observed OR (b.retired_at IS NOT NULL AND b.retired_at<=observed) THEN RAISE EXCEPTION 'attention requires current project-bound producer provenance'; END IF;
END; $$;
CREATE FUNCTION acp.require_attention_references(r acp.attention_items) RETURNS void LANGUAGE plpgsql AS $$
DECLARE m acp.missions; e acp.evidence_records; f acp.effect_proposals; n integer:=0; ids jsonb; observed timestamptz;
BEGIN
  FOR m IN SELECT x.* FROM acp.missions x JOIN jsonb_array_elements_text(r.body->'missionIds') i(id) ON x.mission_id::text=i.id ORDER BY x.mission_id FOR SHARE OF x LOOP
    IF m.project_id<>r.project_id THEN RAISE EXCEPTION 'attention mission scope mismatch'; END IF; n:=n+1;
  END LOOP;
  IF n<>jsonb_array_length(r.body->'missionIds') THEN RAISE EXCEPTION 'attention mission missing'; END IF;
  ids:=r.body->'evidenceIds'; n:=0;
  FOR f IN SELECT x.* FROM acp.effect_proposals x JOIN jsonb_array_elements_text(coalesce(r.body->'effectPreviewIds','[]'::jsonb)) i(id) ON x.effect_id::text=i.id ORDER BY x.effect_id FOR SHARE OF x LOOP
    IF f.project_id<>r.project_id OR NOT (r.body->'missionIds') ? f.mission_id::text
      OR jsonb_typeof(f.evidence_ids) IS DISTINCT FROM 'array' OR jsonb_array_length(f.evidence_ids)>50 THEN RAISE EXCEPTION 'attention effect preview scope or references invalid'; END IF;
    ids:=ids||f.evidence_ids; n:=n+1;
  END LOOP;
  IF n<>jsonb_array_length(coalesce(r.body->'effectPreviewIds','[]'::jsonb)) THEN RAISE EXCEPTION 'attention effect preview missing'; END IF;
  SELECT coalesce(jsonb_agg(id ORDER BY id),'[]'::jsonb) INTO ids FROM (SELECT DISTINCT id FROM jsonb_array_elements_text(ids) i(id)) all_ids;
  n:=0;
  FOR e IN SELECT x.* FROM acp.evidence_records x JOIN jsonb_array_elements_text(ids) i(id) ON x.evidence_id::text=i.id ORDER BY x.evidence_id FOR SHARE OF x LOOP
    IF e.project_id<>r.project_id OR e.sensitivity='restricted' OR acp.readiness_evidence_fingerprint(e) IS NULL THEN
      RAISE EXCEPTION 'attention evidence is invalid or undisclosable'; END IF; n:=n+1;
  END LOOP;
  observed:=clock_timestamp();
  IF n<>jsonb_array_length(ids) OR EXISTS(SELECT 1 FROM acp.evidence_records x JOIN jsonb_array_elements_text(ids) i(id) ON x.evidence_id::text=i.id
    WHERE x.observed_at>x.retrieved_at OR x.retrieved_at>observed) THEN RAISE EXCEPTION 'attention evidence is missing or temporally invalid'; END IF;
END; $$;
CREATE FUNCTION acp.validate_attention_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.project_id IS NOT NULL OR NEW.deduplication_key IS NOT NULL OR NEW.storage_digest IS NOT NULL OR NEW.recorded_at IS NOT NULL THEN
    RAISE EXCEPTION 'attention derived fields are server owned'; END IF;
  PERFORM acp.validate_attention_body(NEW.body);
  IF NEW.item_id::text IS DISTINCT FROM NEW.body->>'itemId' THEN RAISE EXCEPTION 'attention item identity mismatch'; END IF;
  NEW.project_id:=(NEW.body->>'projectId')::acp.stable_id; NEW.deduplication_key:=NEW.body->>'deduplicationKey';
  PERFORM acp.require_attention_authority(NEW.project_id,NEW.provenance_id); PERFORM acp.require_attention_references(NEW);
  NEW.recorded_at:=clock_timestamp(); NEW.storage_digest:=acp.jsonb_sha256(NEW.body); RETURN NEW;
END; $$;
CREATE TRIGGER attention_items_validate BEFORE INSERT ON acp.attention_items FOR EACH ROW EXECUTE FUNCTION acp.validate_attention_item();
CREATE FUNCTION acp.validate_attention_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r acp.attention_items;
BEGIN
  IF NEW.project_id IS NOT NULL OR NEW.recorded_at IS NOT NULL THEN RAISE EXCEPTION 'attention request derived fields are server owned'; END IF;
  SELECT * INTO STRICT r FROM acp.attention_items WHERE item_id=NEW.item_id;
  IF EXISTS(SELECT 1 FROM acp.attention_items WHERE item_id=NEW.request_id AND item_id<>NEW.item_id) THEN RAISE EXCEPTION 'attention ID cannot alias another canonical item'; END IF;
  NEW.project_id:=r.project_id;
  PERFORM acp.require_attention_authority(r.project_id,NEW.provenance_id); PERFORM acp.require_attention_references(r);
  NEW.recorded_at:=clock_timestamp(); RETURN NEW;
END; $$;
CREATE TRIGGER attention_requests_validate BEFORE INSERT ON acp.attention_requests FOR EACH ROW EXECUTE FUNCTION acp.validate_attention_request();
CREATE FUNCTION acp.validate_attention_reference() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE body jsonb; key text; id text;
BEGIN
  SELECT i.body INTO STRICT body FROM acp.attention_items i WHERE item_id=NEW.item_id;
  key:=CASE TG_TABLE_NAME WHEN 'attention_item_missions' THEN 'missionIds' WHEN 'attention_item_evidence' THEN 'evidenceIds' ELSE 'effectPreviewIds' END;
  id:=CASE TG_TABLE_NAME WHEN 'attention_item_missions' THEN to_jsonb(NEW)->>'mission_id' WHEN 'attention_item_evidence' THEN to_jsonb(NEW)->>'evidence_id' ELSE to_jsonb(NEW)->>'effect_id' END;
  IF NOT coalesce((body->key) ? id,false) THEN RAISE EXCEPTION 'attention reference absent from immutable item'; END IF; RETURN NEW;
END; $$;
CREATE TRIGGER attention_item_missions_validate BEFORE INSERT ON acp.attention_item_missions FOR EACH ROW EXECUTE FUNCTION acp.validate_attention_reference();
CREATE TRIGGER attention_item_evidence_validate BEFORE INSERT ON acp.attention_item_evidence FOR EACH ROW EXECUTE FUNCTION acp.validate_attention_reference();
CREATE TRIGGER attention_item_effect_previews_validate BEFORE INSERT ON acp.attention_item_effect_previews FOR EACH ROW EXECUTE FUNCTION acp.validate_attention_reference();
CREATE FUNCTION acp.project_attention_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO acp.attention_requests(request_id,item_id,provenance_id) VALUES(NEW.item_id,NEW.item_id,NEW.provenance_id);
  INSERT INTO acp.attention_item_missions SELECT NEW.item_id,id::acp.stable_id FROM jsonb_array_elements_text(NEW.body->'missionIds') i(id);
  INSERT INTO acp.attention_item_evidence SELECT NEW.item_id,id::acp.stable_id FROM jsonb_array_elements_text(NEW.body->'evidenceIds') i(id);
  INSERT INTO acp.attention_item_effect_previews SELECT NEW.item_id,id::acp.stable_id FROM jsonb_array_elements_text(coalesce(NEW.body->'effectPreviewIds','[]'::jsonb)) i(id);
  RETURN NEW;
END; $$;
CREATE TRIGGER attention_items_project AFTER INSERT ON acp.attention_items FOR EACH ROW EXECUTE FUNCTION acp.project_attention_item();
CREATE FUNCTION acp.require_attention_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r acp.attention_items;
BEGIN
  SELECT * INTO STRICT r FROM acp.attention_items WHERE item_id=NEW.item_id;
  PERFORM acp.require_attention_authority(r.project_id,NEW.provenance_id); PERFORM acp.require_attention_references(r);
  IF (SELECT count(*) FROM acp.attention_requests WHERE request_id=r.item_id AND item_id=r.item_id)<>1
    OR (SELECT count(*) FROM acp.attention_item_missions WHERE item_id=r.item_id)<>jsonb_array_length(r.body->'missionIds')
    OR (SELECT count(*) FROM acp.attention_item_evidence WHERE item_id=r.item_id)<>jsonb_array_length(r.body->'evidenceIds')
    OR (SELECT count(*) FROM acp.attention_item_effect_previews WHERE item_id=r.item_id)<>jsonb_array_length(coalesce(r.body->'effectPreviewIds','[]'::jsonb)) THEN
    RAISE EXCEPTION 'attention history projection incomplete'; END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER attention_items_commit AFTER INSERT ON acp.attention_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acp.require_attention_commit();
CREATE CONSTRAINT TRIGGER attention_requests_commit AFTER INSERT ON acp.attention_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acp.require_attention_commit();
CREATE TRIGGER attention_items_retained BEFORE UPDATE OR DELETE OR TRUNCATE ON acp.attention_items FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();
CREATE TRIGGER attention_requests_retained BEFORE UPDATE OR DELETE OR TRUNCATE ON acp.attention_requests FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();
CREATE TRIGGER attention_item_missions_retained BEFORE UPDATE OR DELETE OR TRUNCATE ON acp.attention_item_missions FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();
CREATE TRIGGER attention_item_evidence_retained BEFORE UPDATE OR DELETE OR TRUNCATE ON acp.attention_item_evidence FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();
CREATE TRIGGER attention_item_effect_previews_retained BEFORE UPDATE OR DELETE OR TRUNCATE ON acp.attention_item_effect_previews FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE FUNCTION acp.attention_receipt(r acp.attention_items, request acp.attention_requests, replayed boolean) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('item',r.body,'recordedAt',acp.readiness_timestamp(r.recorded_at),'provenanceId',r.provenance_id,
    'requestId',request.request_id,'requestRecordedAt',acp.readiness_timestamp(request.recorded_at),'requestProvenanceId',request.provenance_id,'replayed',replayed)
$$;
-- Current disclosure only. Historical evidence need not be fresh or accessible;
-- no observation is upgraded into truth, readiness or authority.
CREATE FUNCTION acp.attention_item_disclosable(r acp.attention_items) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT r.body->>'itemId'=r.item_id::text AND r.body->>'projectId'=r.project_id::text
    AND r.body->>'deduplicationKey'=r.deduplication_key AND r.storage_digest=acp.jsonb_sha256(r.body)
    AND isfinite(r.recorded_at) AND r.recorded_at<=statement_timestamp()
    AND r.body->'missionIds' IS NOT DISTINCT FROM (SELECT coalesce(jsonb_agg(mission_id ORDER BY mission_id),'[]'::jsonb) FROM acp.attention_item_missions WHERE item_id=r.item_id)
    AND r.body->'evidenceIds' IS NOT DISTINCT FROM (SELECT coalesce(jsonb_agg(evidence_id ORDER BY evidence_id),'[]'::jsonb) FROM acp.attention_item_evidence WHERE item_id=r.item_id)
    AND coalesce(r.body->'effectPreviewIds','[]'::jsonb) IS NOT DISTINCT FROM (SELECT coalesce(jsonb_agg(effect_id ORDER BY effect_id),'[]'::jsonb) FROM acp.attention_item_effect_previews WHERE item_id=r.item_id)
    AND NOT EXISTS(SELECT 1 FROM acp.attention_item_missions ref LEFT JOIN acp.missions m USING(mission_id)
      WHERE ref.item_id=r.item_id AND (m.mission_id IS NULL OR m.project_id<>r.project_id))
    AND NOT EXISTS(SELECT 1 FROM acp.attention_item_effect_previews ref LEFT JOIN acp.effect_proposals f USING(effect_id)
      WHERE ref.item_id=r.item_id AND (f.effect_id IS NULL OR f.project_id<>r.project_id OR NOT (r.body->'missionIds') ? f.mission_id::text
        OR jsonb_typeof(f.evidence_ids) IS DISTINCT FROM 'array' OR jsonb_array_length(CASE WHEN jsonb_typeof(f.evidence_ids)='array' THEN f.evidence_ids ELSE '[]'::jsonb END)>50))
    AND NOT EXISTS(WITH ids AS (
      SELECT evidence_id::text AS id FROM acp.attention_item_evidence WHERE item_id=r.item_id
      UNION SELECT id FROM acp.attention_item_effect_previews ref JOIN acp.effect_proposals f USING(effect_id)
        CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(f.evidence_ids)='array' THEN f.evidence_ids ELSE '[]'::jsonb END) i(id) WHERE ref.item_id=r.item_id
    ) SELECT 1 FROM ids LEFT JOIN acp.evidence_records e ON e.evidence_id::text=ids.id
      WHERE e.evidence_id IS NULL OR e.project_id<>r.project_id OR e.sensitivity='restricted' OR acp.readiness_evidence_fingerprint(e) IS NULL
        OR e.observed_at>e.retrieved_at OR e.retrieved_at>statement_timestamp())
$$;
CREATE FUNCTION acp.record_attention_request(input jsonb, provenance acp.stable_id) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r acp.attention_items; request acp.attention_requests; id acp.stable_id; project acp.stable_id; key text; replayed boolean:=true;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'attention recording requires read committed isolation'; END IF;
  PERFORM acp.validate_attention_body(input); id:=(input->>'itemId')::acp.stable_id; project:=(input->>'projectId')::acp.stable_id; key:=input->>'deduplicationKey';
  PERFORM pg_advisory_xact_lock(hashtextextended('acp:attention-request:'||id::text,0));
  SELECT * INTO request FROM acp.attention_requests WHERE request_id=id;
  IF FOUND THEN
    SELECT * INTO STRICT r FROM acp.attention_items WHERE item_id=request.item_id;
    IF (r.body-'itemId') IS DISTINCT FROM (input-'itemId') THEN RAISE EXCEPTION 'attention request aliases different semantic terms'; END IF;
    RETURN acp.attention_receipt(r,request,true);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('acp:attention-key:'||jsonb_build_array(project,key)::text,0));
  SELECT * INTO r FROM acp.attention_items WHERE project_id=project AND deduplication_key=key;
  IF FOUND THEN
    IF (r.body-'itemId') IS DISTINCT FROM (input-'itemId') THEN RAISE EXCEPTION 'attention deduplication key aliases different semantic terms'; END IF;
    INSERT INTO acp.attention_requests(request_id,item_id,provenance_id) VALUES(id,r.item_id,provenance) RETURNING * INTO request;
  ELSE
    INSERT INTO acp.attention_items(item_id,body,provenance_id) VALUES(id,input,provenance) RETURNING * INTO r;
    SELECT * INTO STRICT request FROM acp.attention_requests WHERE request_id=id; replayed:=false;
  END IF;
  RETURN acp.attention_receipt(r,request,replayed);
END; $$;
