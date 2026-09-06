LOCK TABLE acp.project_profile_proposals,acp.project_profile_proposal_evidence IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM acp.project_profile_proposals) OR EXISTS(SELECT 1 FROM acp.project_profile_proposal_evidence) THEN
    RAISE EXCEPTION '0018 downgrade would remove retained profile proposal history'; END IF;
END; $$;
DROP TRIGGER project_profile_proposals_commit ON acp.project_profile_proposals;
DROP TRIGGER project_profile_proposals_pin ON acp.project_profile_proposals;
DROP TRIGGER project_profile_proposals_validate ON acp.project_profile_proposals;
DROP TRIGGER project_profile_proposal_evidence_validate ON acp.project_profile_proposal_evidence;
DROP FUNCTION acp.require_profile_proposal_commit();
DROP FUNCTION acp.insert_profile_proposal_pins();
DROP FUNCTION acp.validate_profile_proposal_pin();
DROP FUNCTION acp.validate_profile_proposal();
DROP TABLE acp.project_profile_proposal_evidence;
DROP TABLE acp.project_profile_proposals;
DROP FUNCTION acp.profile_proposal_evidence_ids(jsonb);
DROP FUNCTION acp.profile_proposal_field_ids();
