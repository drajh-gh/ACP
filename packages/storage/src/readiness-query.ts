// One bounded MVCC statement. Latest selection precedes identity and usability checks.
export const projectReadinessSql = `WITH
profile AS MATERIALIZED (SELECT project_id,profile_id,version FROM acp.project_profiles
  WHERE project_id=$1 AND profile_id=$2 AND version=$3),
requested AS MATERIALIZED (SELECT i.value->>'capability' AS capability,i.value->>'resourceKey' AS resource_key,
  i.value->>'resourceVersion' AS resource_version,i.ordinality AS ordinal FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY i),
latest AS MATERIALIZED (SELECT r.*,k.ordinal FROM profile p CROSS JOIN requested k CROSS JOIN LATERAL (
  SELECT r.* FROM acp.capability_readiness_assessments r
  WHERE r.scope_digest=acp.readiness_scope_digest(p.project_id,p.profile_id,p.version,k.capability,k.resource_key,k.resource_version)
    AND r.project_id=p.project_id AND r.profile_id=p.profile_id AND r.profile_version=p.version
    AND r.capability=k.capability AND r.resource_key=k.resource_key AND r.resource_version=k.resource_version
  ORDER BY r.assessed_at DESC LIMIT 1
) r),
pins AS MATERIALIZED (SELECT p.* FROM acp.capability_readiness_evidence p JOIN latest l USING(assessment_id)),
referenced AS MATERIALIZED (SELECT DISTINCT id FROM latest l CROSS JOIN LATERAL jsonb_array_elements_text(l.evidence_ids) i(id)),
evidence AS MATERIALIZED (SELECT e.evidence_id,e.project_id,e.observed_at,e.retrieved_at,e.sensitivity,e.freshness,e.accessibility,
  e.content_hash IS NOT NULL AS has_hash,acp.readiness_evidence_fingerprint(e) AS identity_digest
  FROM acp.evidence_records e JOIN referenced r ON e.evidence_id::text=r.id),
checks AS MATERIALIZED (SELECT
  EXISTS(SELECT 1 FROM referenced r LEFT JOIN evidence e ON e.evidence_id::text=r.id
    WHERE e.evidence_id IS NULL OR e.project_id<>p.project_id OR e.sensitivity='restricted' OR e.identity_digest IS NULL
      OR e.observed_at>e.retrieved_at OR e.retrieved_at>statement_timestamp())
  OR EXISTS(SELECT 1 FROM latest l WHERE
    (SELECT count(*) FROM pins pin WHERE pin.assessment_id=l.assessment_id)<>jsonb_array_length(l.evidence_ids)
    OR l.assessed_at>statement_timestamp())
  OR EXISTS(SELECT 1 FROM pins pin JOIN latest l USING(assessment_id)
    WHERE l.evidence_ids->>(pin.ordinal-1) IS DISTINCT FROM pin.evidence_id::text) AS invalid_references
  FROM profile p),
payload AS MATERIALIZED (SELECT checks.invalid_references,CASE WHEN NOT checks.invalid_references THEN
  jsonb_build_object('projectId',p.project_id,'profileId',p.profile_id,'profileVersion',p.version,'keys',$4::jsonb,
    'asOf',acp.readiness_timestamp(statement_timestamp()),
    'latest',(SELECT coalesce(jsonb_agg(acp.readiness_assessment_json(jsonb_populate_record(NULL::acp.capability_readiness_assessments,to_jsonb(l))) ORDER BY l.ordinal),'[]'::jsonb) FROM latest l),
    'identityMatches',(SELECT coalesce(jsonb_agg(jsonb_build_object('assessmentId',l.assessment_id,'matches',
      NOT EXISTS(SELECT 1 FROM pins pin JOIN evidence e USING(evidence_id) WHERE pin.assessment_id=l.assessment_id
        AND pin.identity_digest IS DISTINCT FROM e.identity_digest)) ORDER BY l.ordinal),'[]'::jsonb) FROM latest l),
    'evidence',(SELECT coalesce(jsonb_agg(jsonb_build_object('evidenceId',e.evidence_id,'projectId',e.project_id,
      'observedAt',acp.readiness_timestamp(e.observed_at),'retrievedAt',acp.readiness_timestamp(e.retrieved_at),
      'sensitivity',e.sensitivity,'freshness',e.freshness,'accessibility',e.accessibility,
      'contentHash',CASE WHEN e.has_hash THEN 'present' ELSE NULL END) ORDER BY e.evidence_id),'[]'::jsonb) FROM evidence e))
  END AS snapshot FROM profile p CROSS JOIN checks)
SELECT CASE WHEN invalid_references THEN 'invalid_references' WHEN octet_length(snapshot::text)>$5::integer THEN 'too_large' ELSE NULL END AS readiness_error,
  CASE WHEN NOT invalid_references AND octet_length(snapshot::text)<=$5::integer THEN snapshot ELSE NULL END AS snapshot FROM payload`;
