-- Recorded readiness is not an execution grant or a live provider probe.
CREATE FUNCTION acp.readiness_canonical_text(value text, maximum_units integer)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT value IS NOT NULL AND value<>'' AND value=btrim(value)
    AND value !~ '[[:cntrl:]]'
    AND value !~ U&'^[\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]|[\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]$'
    AND char_length(value)+char_length(regexp_replace(value,U&'[\0001-\FFFF]','','g'))<=maximum_units
$$;

CREATE FUNCTION acp.readiness_scope_digest(project text, profile text, version text, capability text, resource text, resource_version text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT acp.jsonb_sha256(jsonb_build_array(project,profile,version,capability,resource,resource_version))
$$;

CREATE FUNCTION acp.readiness_timestamp(value timestamptz)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT to_char(value AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

-- Opaque retained fingerprint, never a source/reference/hash disclosure.
-- Freshness/accessibility/sensitivity remain mutable current metadata.
CREATE FUNCTION acp.readiness_evidence_fingerprint(e acp.evidence_records)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN acp.readiness_canonical_text(e.source_type,200) AND acp.readiness_canonical_text(e.source_ref,2000)
      AND (e.content_hash IS NULL OR acp.readiness_canonical_text(e.content_hash,512))
      AND (e.source_version IS NULL OR acp.readiness_canonical_text(e.source_version,512))
      AND (e.raw_content_ref IS NULL OR acp.readiness_canonical_text(e.raw_content_ref,2000))
      AND char_length(e.redacted_summary)<=4000 AND isfinite(e.observed_at) AND isfinite(e.retrieved_at)
      AND e.observed_at>='0001-01-01T00:00:00Z' AND e.observed_at<'10000-01-01T00:00:00Z'
      AND e.retrieved_at>='0001-01-01T00:00:00Z' AND e.retrieved_at<'10000-01-01T00:00:00Z'
    THEN acp.jsonb_sha256(jsonb_build_object('project',e.project_id,'sourceType',e.source_type,'sourceRef',e.source_ref,
      'observedAt',acp.readiness_timestamp(e.observed_at),'retrievedAt',acp.readiness_timestamp(e.retrieved_at),
      'sourceVersion',e.source_version,'contentHash',e.content_hash,'rawContentRef',e.raw_content_ref,'summary',e.redacted_summary)) END
$$;

CREATE TABLE acp.capability_readiness_assessments (
  assessment_id acp.stable_id PRIMARY KEY CHECK (assessment_id::text ~ '^cra_'),
  project_id acp.stable_id NOT NULL,
  profile_id acp.stable_id NOT NULL,
  profile_version acp.semantic_version NOT NULL CHECK (acp.readiness_canonical_text(profile_version,100)),
  capability text NOT NULL CHECK (acp.readiness_canonical_text(capability,200)),
  resource_key text NOT NULL CHECK (acp.readiness_canonical_text(resource_key,512)),
  resource_version text NOT NULL CHECK (acp.readiness_canonical_text(resource_version,200)),
  scope_digest text NOT NULL CHECK (scope_digest ~ '^sha256:[0-9a-f]{64}$'),
  recorded_state text NOT NULL CHECK (recorded_state IN ('available','degraded','unconfigured','blocked','stale','revoked','unknown')),
  recorded_reason text NOT NULL CHECK (acp.readiness_canonical_text(recorded_reason,2000)),
  assessed_at timestamptz NOT NULL CHECK (isfinite(assessed_at) AND assessed_at>='0001-01-01T00:00:00Z' AND assessed_at<'10000-01-01T00:00:00Z'),
  valid_until timestamptz NOT NULL CHECK (isfinite(valid_until) AND valid_until<'10000-01-01T00:00:00Z'),
  evidence_ids jsonb NOT NULL CHECK (jsonb_typeof(evidence_ids)='array' AND jsonb_array_length(evidence_ids)<=20),
  evaluator_version text NOT NULL CHECK (acp.readiness_canonical_text(evaluator_version,200)),
  provenance_id acp.stable_id NOT NULL REFERENCES acp.runtime_provenance(provenance_id),
  supersedes_assessment_id acp.stable_id UNIQUE,
  recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at)),
  FOREIGN KEY(project_id,profile_id,profile_version) REFERENCES acp.project_profiles(project_id,profile_id,version),
  UNIQUE(assessment_id,scope_digest),
  FOREIGN KEY(supersedes_assessment_id,scope_digest) REFERENCES acp.capability_readiness_assessments(assessment_id,scope_digest),
  UNIQUE(scope_digest,assessed_at),
  CHECK (valid_until>assessed_at AND valid_until-assessed_at<=interval '24 hours'),
  CHECK (supersedes_assessment_id IS DISTINCT FROM assessment_id),
  CHECK (recorded_state NOT IN ('available','degraded') OR jsonb_array_length(evidence_ids)>0)
);
CREATE UNIQUE INDEX capability_readiness_single_root ON acp.capability_readiness_assessments(scope_digest) WHERE supersedes_assessment_id IS NULL;
CREATE INDEX capability_readiness_latest ON acp.capability_readiness_assessments(scope_digest,assessed_at DESC);
CREATE TRIGGER capability_readiness_retained BEFORE UPDATE OR DELETE OR TRUNCATE ON acp.capability_readiness_assessments
FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE TABLE acp.capability_readiness_evidence (
  assessment_id acp.stable_id NOT NULL REFERENCES acp.capability_readiness_assessments(assessment_id),
  evidence_id acp.stable_id NOT NULL REFERENCES acp.evidence_records(evidence_id),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 20),
  identity_digest text NOT NULL CHECK (identity_digest ~ '^sha256:[0-9a-f]{64}$'),
  PRIMARY KEY(assessment_id,evidence_id), UNIQUE(assessment_id,ordinal)
);
CREATE TRIGGER capability_readiness_evidence_retained BEFORE UPDATE OR DELETE OR TRUNCATE ON acp.capability_readiness_evidence
FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE FUNCTION acp.require_readiness_authority(r acp.capability_readiness_assessments)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE p acp.runtime_provenance; b acp.project_workflow_bindings; observed_evidence acp.evidence_records; observed timestamptz;
BEGIN
  SELECT * INTO STRICT p FROM acp.runtime_provenance WHERE provenance_id=r.provenance_id;
  SELECT * INTO STRICT b FROM acp.project_workflow_bindings WHERE binding_id=p.workflow_binding_id FOR SHARE;
  -- Bindings/provenance content is immutable; retirement is locked and rechecked at commit.
  IF (b.project_id,b.profile_id,b.profile_version) IS DISTINCT FROM (r.project_id,r.profile_id,r.profile_version)
    OR (p.project_profile_id,p.project_profile_version) IS DISTINCT FROM (b.profile_id,b.profile_version) THEN
    RAISE EXCEPTION 'readiness provenance does not match the exact project profile';
  END IF;
  -- Lock mutable evidence in stable order before taking the subject advisory lock.
  FOR observed_evidence IN SELECT e.* FROM acp.evidence_records e JOIN jsonb_array_elements_text(r.evidence_ids) i(id) ON e.evidence_id::text=i.id
    ORDER BY e.evidence_id FOR SHARE OF e LOOP
    IF observed_evidence.project_id<>r.project_id OR observed_evidence.sensitivity='restricted' OR acp.readiness_evidence_fingerprint(observed_evidence) IS NULL THEN
      RAISE EXCEPTION 'readiness contains invalid or undisclosable evidence';
    END IF;
    IF r.recorded_state IN ('available','degraded') AND (observed_evidence.content_hash IS NULL OR observed_evidence.freshness<>'current' OR observed_evidence.accessibility<>'available') THEN
      RAISE EXCEPTION 'positive readiness requires usable evidence';
    END IF;
  END LOOP;
  observed:=clock_timestamp();
  IF b.active_from>observed OR (b.retired_at IS NOT NULL AND b.retired_at<=observed)
    OR r.assessed_at<greatest(p.recorded_at,b.active_from) OR r.assessed_at>observed OR r.valid_until<=observed THEN
    RAISE EXCEPTION 'readiness first insertion requires current binding and validity';
  END IF;
  IF (SELECT count(*) FROM acp.evidence_records e JOIN jsonb_array_elements_text(r.evidence_ids) i(id) ON e.evidence_id::text=i.id)
      <>jsonb_array_length(r.evidence_ids)
    OR EXISTS(SELECT 1 FROM acp.evidence_records e JOIN jsonb_array_elements_text(r.evidence_ids) i(id) ON e.evidence_id::text=i.id
      WHERE e.observed_at>e.retrieved_at OR e.retrieved_at>observed) THEN
    RAISE EXCEPTION 'readiness contains invalid or undisclosable evidence';
  END IF;
END;
$$;

CREATE FUNCTION acp.validate_readiness_assessment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous acp.capability_readiness_assessments; canonical_ids jsonb;
BEGIN
  IF jsonb_typeof(NEW.evidence_ids) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.evidence_ids)>20
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.evidence_ids) i WHERE jsonb_typeof(i)<>'string') THEN
    RAISE EXCEPTION 'readiness evidence must be a bounded identifier set';
  END IF;
  SELECT coalesce(jsonb_agg(id ORDER BY id),'[]'::jsonb) INTO canonical_ids FROM (SELECT DISTINCT id FROM jsonb_array_elements_text(NEW.evidence_ids) i(id)) ids;
  IF jsonb_array_length(canonical_ids)<>jsonb_array_length(NEW.evidence_ids)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(canonical_ids) i(id) WHERE id !~ '^evd_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'readiness evidence must be a unique exact identifier set';
  END IF;
  NEW.evidence_ids:=canonical_ids;
  NEW.scope_digest:=acp.readiness_scope_digest(NEW.project_id,NEW.profile_id,NEW.profile_version,NEW.capability,NEW.resource_key,NEW.resource_version);
  PERFORM acp.require_readiness_authority(NEW);
  PERFORM pg_advisory_xact_lock(hashtextextended('acp-readiness:'||NEW.scope_digest,0));
  SELECT * INTO previous FROM acp.capability_readiness_assessments WHERE scope_digest=NEW.scope_digest
    AND (project_id,profile_id,profile_version,capability,resource_key,resource_version)=
      (NEW.project_id,NEW.profile_id,NEW.profile_version,NEW.capability,NEW.resource_key,NEW.resource_version)
    ORDER BY assessed_at DESC LIMIT 1 FOR UPDATE;
  IF NEW.supersedes_assessment_id IS DISTINCT FROM previous.assessment_id
    OR (previous.assessment_id IS NOT NULL AND NEW.assessed_at<=previous.assessed_at) THEN
    RAISE EXCEPTION 'readiness successor must name the exact latest assessment and a later instant';
  END IF;
  NEW.recorded_at:=clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER capability_readiness_validate BEFORE INSERT ON acp.capability_readiness_assessments
FOR EACH ROW EXECUTE FUNCTION acp.validate_readiness_assessment();

CREATE FUNCTION acp.derive_readiness_evidence_pin() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r acp.capability_readiness_assessments; e acp.evidence_records;
BEGIN
  SELECT * INTO STRICT r FROM acp.capability_readiness_assessments WHERE assessment_id=NEW.assessment_id;
  IF NEW.ordinal NOT BETWEEN 1 AND 20 OR r.evidence_ids->>(NEW.ordinal-1) IS DISTINCT FROM NEW.evidence_id::text THEN
    RAISE EXCEPTION 'readiness pin must match the exact recorded evidence set';
  END IF;
  SELECT * INTO STRICT e FROM acp.evidence_records WHERE evidence_id=NEW.evidence_id FOR SHARE;
  NEW.identity_digest:=acp.readiness_evidence_fingerprint(e);
  RETURN NEW;
END;
$$;
CREATE TRIGGER capability_readiness_evidence_derive BEFORE INSERT ON acp.capability_readiness_evidence
FOR EACH ROW EXECUTE FUNCTION acp.derive_readiness_evidence_pin();

CREATE FUNCTION acp.insert_readiness_evidence_pins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO acp.capability_readiness_evidence(assessment_id,evidence_id,ordinal)
    SELECT NEW.assessment_id,id::acp.stable_id,ordinal::integer FROM jsonb_array_elements_text(NEW.evidence_ids) WITH ORDINALITY i(id,ordinal);
  RETURN NEW;
END;
$$;
CREATE TRIGGER capability_readiness_pin AFTER INSERT ON acp.capability_readiness_assessments
FOR EACH ROW EXECUTE FUNCTION acp.insert_readiness_evidence_pins();

CREATE FUNCTION acp.require_readiness_commit_authority() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r acp.capability_readiness_assessments;
BEGIN
  SELECT * INTO STRICT r FROM acp.capability_readiness_assessments WHERE assessment_id=NEW.assessment_id;
  PERFORM acp.require_readiness_authority(r);
  IF (SELECT count(*) FROM acp.capability_readiness_evidence WHERE assessment_id=r.assessment_id)<>jsonb_array_length(r.evidence_ids)
    OR EXISTS(SELECT 1 FROM acp.capability_readiness_evidence p JOIN acp.evidence_records e USING(evidence_id)
      WHERE p.assessment_id=r.assessment_id AND p.identity_digest IS DISTINCT FROM acp.readiness_evidence_fingerprint(e)) THEN
    RAISE EXCEPTION 'readiness evidence identity changed before commit';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER capability_readiness_commit AFTER INSERT ON acp.capability_readiness_assessments
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acp.require_readiness_commit_authority();

CREATE FUNCTION acp.readiness_assessment_json(r acp.capability_readiness_assessments)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('assessmentId',r.assessment_id,'projectId',r.project_id,'profileId',r.profile_id,'profileVersion',r.profile_version,
    'capability',r.capability,'resourceKey',r.resource_key,'resourceVersion',r.resource_version,'recordedState',r.recorded_state,'recordedReason',r.recorded_reason,
    'assessedAt',acp.readiness_timestamp(r.assessed_at),'validUntil',acp.readiness_timestamp(r.valid_until),'evidenceIds',r.evidence_ids,
    'evaluatorVersion',r.evaluator_version,'provenanceId',r.provenance_id,'supersedesAssessmentId',r.supersedes_assessment_id)
$$;
