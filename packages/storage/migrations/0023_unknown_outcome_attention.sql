-- Separate catch-up capture: attention admission must never roll back an external
-- effect receipt. Eligibility is an observed snapshot, not resolution authority.
CREATE FUNCTION acp.unknown_effect_attention_eligible(project acp.stable_id, receipt acp.stable_id)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM acp.effect_receipts r JOIN acp.effect_proposals e USING(effect_id)
    JOIN acp.runtime_provenance p ON p.provenance_id=r.provenance_id
    WHERE r.receipt_id=receipt AND e.project_id=project AND r.state='unknown_outcome' AND e.state='unknown_outcome'
      AND isfinite(r.attempted_at) AND r.attempted_at>='0001-01-01T00:00:00Z' AND r.attempted_at<=statement_timestamp()
      AND isfinite(p.recorded_at) AND p.recorded_at>='0001-01-01T00:00:00Z' AND p.recorded_at<=r.attempted_at
      AND NOT EXISTS(SELECT 1 FROM acp.effect_receipts newer WHERE newer.effect_id=r.effect_id AND newer.attempt_number>r.attempt_number)
      AND NOT EXISTS(SELECT 1 FROM acp.effect_reconciliations c WHERE c.unknown_receipt_id=r.receipt_id AND c.outcome IN ('applied','not_applied')))
$$;
CREATE FUNCTION acp.unknown_effect_attention_body(item acp.stable_id, receipt acp.stable_id)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('itemId',item,'projectId',e.project_id,'missionIds',jsonb_build_array(e.mission_id),
    'type','unknown_external_outcome','urgency','normal','title','An effect attempt recorded an unknown outcome',
    'explanation','Receipt '||r.receipt_id::text||' for effect '||e.effect_id::text||' recorded unknown_outcome. The external result of that attempt was not confirmed.',
    'whyHumanIsNeeded','Review the recorded attempt and any subsequent reconciliation before deciding whether human intervention is still needed.',
    'recommendation','Inspect current effect status and reconciliation evidence. Do not repeat the external action merely because its reply was lost.',
    'alternatives',jsonb_build_array('Inspect recorded reconciliation','Investigate the external target using an authorized read'),
    'consequenceOfNoAction','No success-dependent progress can rely on an unconfirmed external result.',
    'evidenceIds','[]'::jsonb,'effectPreviewIds',jsonb_build_array(e.effect_id),
    'allowedResponses',jsonb_build_array('Review recorded outcome','Clarify a permitted investigation'),
    'deduplicationKey','unknown-effect-receipt:v1:'||r.receipt_id::text,
    'quietHoursDisposition','Not evaluated; this record does not request notification or quiet-hours interruption.')
  FROM acp.effect_receipts r JOIN acp.effect_proposals e USING(effect_id) WHERE r.receipt_id=receipt AND r.state='unknown_outcome'
$$;
CREATE TABLE acp.unknown_effect_attention_sources (
  receipt_id acp.stable_id PRIMARY KEY REFERENCES acp.effect_receipts(receipt_id),
  item_id acp.stable_id NOT NULL UNIQUE REFERENCES acp.attention_items(item_id),
  project_id acp.stable_id NOT NULL REFERENCES acp.projects(project_id),
  effect_id acp.stable_id NOT NULL REFERENCES acp.effect_proposals(effect_id),
  mission_id acp.stable_id NOT NULL REFERENCES acp.missions(mission_id),
  observed_at timestamptz NOT NULL,
  provenance_id acp.stable_id NOT NULL REFERENCES acp.runtime_provenance(provenance_id),
  FOREIGN KEY(receipt_id,effect_id) REFERENCES acp.effect_receipts(receipt_id,effect_id),
  FOREIGN KEY(item_id,project_id) REFERENCES acp.attention_items(item_id,project_id)
);
CREATE FUNCTION acp.validate_unknown_effect_attention_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r acp.effect_receipts; e acp.effect_proposals; a acp.attention_items;
BEGIN
  IF NEW.project_id IS NOT NULL OR NEW.effect_id IS NOT NULL OR NEW.mission_id IS NOT NULL OR NEW.observed_at IS NOT NULL THEN
    RAISE EXCEPTION 'unknown-outcome source fields are server owned'; END IF;
  SELECT * INTO STRICT r FROM acp.effect_receipts WHERE receipt_id=NEW.receipt_id;
  SELECT * INTO STRICT e FROM acp.effect_proposals WHERE effect_id=r.effect_id;
  SELECT * INTO STRICT a FROM acp.attention_items WHERE item_id=NEW.item_id;
  IF NOT acp.unknown_effect_attention_eligible(e.project_id,r.receipt_id) THEN RAISE EXCEPTION 'unknown-outcome source no longer eligible at capture'; END IF;
  IF a.body IS DISTINCT FROM acp.unknown_effect_attention_body(a.item_id,r.receipt_id) OR a.provenance_id<>NEW.provenance_id
    OR a.recorded_at<r.attempted_at OR a.project_id<>e.project_id THEN RAISE EXCEPTION 'unknown-outcome source does not match the exact attributed attention body'; END IF;
  PERFORM acp.require_attention_authority(e.project_id,NEW.provenance_id);
  NEW.project_id:=e.project_id; NEW.effect_id:=e.effect_id; NEW.mission_id:=e.mission_id; NEW.observed_at:=clock_timestamp(); RETURN NEW;
END; $$;
CREATE TRIGGER unknown_effect_attention_sources_validate BEFORE INSERT ON acp.unknown_effect_attention_sources
FOR EACH ROW EXECUTE FUNCTION acp.validate_unknown_effect_attention_source();
CREATE TRIGGER unknown_effect_attention_sources_retained BEFORE UPDATE OR DELETE OR TRUNCATE ON acp.unknown_effect_attention_sources
FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE FUNCTION acp.capture_unknown_effect_attention(project acp.stable_id, receipt acp.stable_id, provenance acp.stable_id)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE source acp.unknown_effect_attention_sources; item acp.stable_id; body jsonb; recorded jsonb; replayed boolean:=true;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'unknown-outcome capture requires read committed isolation'; END IF;
  IF project IS NULL OR receipt IS NULL
    OR project::text !~ '^prj_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR receipt::text !~ '^rcp_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'exact unknown-outcome source IDs required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('acp:unknown-effect-attention:'||receipt::text,0));
  SELECT * INTO source FROM acp.unknown_effect_attention_sources WHERE receipt_id=receipt;
  IF FOUND THEN
    IF source.project_id<>project THEN RAISE EXCEPTION 'unknown-outcome source scope mismatch'; END IF;
  ELSE
    IF NOT acp.unknown_effect_attention_eligible(project,receipt) THEN
      RETURN jsonb_build_object('kind','not_eligible','projectId',project,'receiptId',receipt); END IF;
    item:=('ati_'||gen_random_uuid()::text)::acp.stable_id; body:=acp.unknown_effect_attention_body(item,receipt);
    recorded:=acp.record_attention_request(body,provenance);
    IF recorded->'item'->>'itemId' IS DISTINCT FROM item::text OR (recorded->>'replayed')::boolean THEN
      RAISE EXCEPTION 'unknown-outcome attention deduplication key already names other history'; END IF;
    INSERT INTO acp.unknown_effect_attention_sources(receipt_id,item_id,provenance_id) VALUES(receipt,item,provenance) RETURNING * INTO source;
    replayed:=false;
  END IF;
  RETURN jsonb_build_object('kind','recorded','projectId',source.project_id,'receiptId',source.receipt_id,'itemId',source.item_id,
    'observedAt',acp.readiness_timestamp(source.observed_at),'provenanceId',source.provenance_id,'replayed',replayed);
END; $$;
