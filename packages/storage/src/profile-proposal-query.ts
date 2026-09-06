// Exact historical proposal plus current disclosure and confirmation facts in one MVCC statement.
// The baseline is an exact immutable version, never an inferred current/active profile head.
export const projectProfileProposalSql = `WITH
proposal AS MATERIALIZED (SELECT * FROM acp.project_profile_proposals WHERE project_id=$1 AND proposal_id=$2),
pins AS MATERIALIZED (SELECT pin.* FROM acp.project_profile_proposal_evidence pin JOIN proposal p USING(proposal_id)),
evidence AS MATERIALIZED (SELECT e.evidence_id,e.project_id,e.observed_at,e.retrieved_at,e.sensitivity,e.freshness,e.accessibility,
  e.content_hash IS NOT NULL AS has_hash,acp.readiness_evidence_fingerprint(e) AS identity_digest
  FROM acp.evidence_records e JOIN pins pin USING(evidence_id)),
checks AS MATERIALIZED (SELECT p.*,
  (SELECT count(*) FROM pins)<>jsonb_array_length(p.evidence_pins)
  OR p.storage_digest IS DISTINCT FROM acp.jsonb_sha256(p.body)
  OR p.proposed_at>statement_timestamp()
  OR EXISTS(SELECT 1 FROM pins pin LEFT JOIN evidence e USING(evidence_id) WHERE e.evidence_id IS NULL
    OR e.project_id<>p.project_id OR e.sensitivity='restricted' OR e.identity_digest IS NULL
    OR e.observed_at>e.retrieved_at OR e.retrieved_at>statement_timestamp()
    OR p.evidence_pins->(pin.ordinal-1) IS DISTINCT FROM jsonb_build_object('evidenceId',pin.evidence_id,'projectId',p.project_id,'identityDigest',pin.identity_digest))
  AS invalid_references FROM proposal p),
payload AS MATERIALIZED (SELECT invalid_references,p.body::text AS body,CASE WHEN NOT invalid_references THEN jsonb_build_object(
  'asOf',acp.readiness_timestamp(statement_timestamp()),
  'currentProposalId',(SELECT proposal_id FROM acp.project_profile_proposals r WHERE r.scope_digest=p.scope_digest
    AND (r.project_id,r.profile_id,r.profile_version)=(p.project_id,p.profile_id,p.profile_version) ORDER BY proposed_at DESC LIMIT 1),
  'candidateProfileExists',EXISTS(SELECT 1 FROM acp.project_profiles b WHERE (b.profile_id,b.version)=(p.profile_id,p.profile_version)),
  'baseProfileDigest',(SELECT CASE WHEN octet_length(b.profile::text)<=$3 THEN acp.jsonb_sha256(b.profile) END FROM acp.project_profiles b
    WHERE (b.project_id,b.profile_id,b.version)=(p.project_id,p.profile_id,p.base_profile_version)),
  'evidence',(SELECT coalesce(jsonb_agg(jsonb_build_object('evidenceId',e.evidence_id,'projectId',e.project_id,'identityDigest',e.identity_digest,
    'observedAt',acp.readiness_timestamp(e.observed_at),'retrievedAt',acp.readiness_timestamp(e.retrieved_at),
    'sensitivity',e.sensitivity,'freshness',e.freshness,'accessibility',e.accessibility,'contentHashPresent',e.has_hash) ORDER BY e.evidence_id),'[]'::jsonb) FROM evidence e)
  ) END AS snapshot FROM checks p)
SELECT CASE WHEN invalid_references THEN 'invalid_references' WHEN octet_length(snapshot::text)>$3 OR octet_length(body)>$3 THEN 'too_large' ELSE NULL END AS proposal_error,
  CASE WHEN NOT invalid_references AND octet_length(snapshot::text)<=$3 AND octet_length(body)<=$3 THEN snapshot END AS snapshot,
  CASE WHEN NOT invalid_references AND octet_length(snapshot::text)<=$3 AND octet_length(body)<=$3 THEN body END AS body FROM payload`;
