LOCK TABLE acp.capability_readiness_assessments,acp.capability_readiness_evidence IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM acp.capability_readiness_assessments) OR EXISTS(SELECT 1 FROM acp.capability_readiness_evidence) THEN
    RAISE EXCEPTION '0017 downgrade would remove retained readiness assessment history';
  END IF;
END; $$;
DROP TRIGGER capability_readiness_commit ON acp.capability_readiness_assessments;
DROP TRIGGER capability_readiness_pin ON acp.capability_readiness_assessments;
DROP TRIGGER capability_readiness_validate ON acp.capability_readiness_assessments;
DROP TRIGGER capability_readiness_evidence_derive ON acp.capability_readiness_evidence;
DROP FUNCTION acp.require_readiness_commit_authority();
DROP FUNCTION acp.insert_readiness_evidence_pins();
DROP FUNCTION acp.derive_readiness_evidence_pin();
DROP FUNCTION acp.validate_readiness_assessment();
DROP FUNCTION acp.readiness_assessment_json(acp.capability_readiness_assessments);
DROP FUNCTION acp.require_readiness_authority(acp.capability_readiness_assessments);
DROP TABLE acp.capability_readiness_evidence;
DROP TABLE acp.capability_readiness_assessments;
DROP FUNCTION acp.readiness_evidence_fingerprint(acp.evidence_records);
DROP FUNCTION acp.readiness_timestamp(timestamptz);
DROP FUNCTION acp.readiness_scope_digest(text,text,text,text,text,text);
DROP FUNCTION acp.readiness_canonical_text(text,integer);
