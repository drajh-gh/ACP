// One read-only statement / MVCC snapshot, including the mission and nodes.
// No context-packet builder: status also applies to terminal missions and
// retired runtimes, and must not need or renew an execution grant.
const evaluationJson=`jsonb_build_object('evaluationId',e.evaluation_id,'missionId',e.mission_id,
  'contract',jsonb_build_object('id',e.contract_id,'version',e.contract_version),'status',e.status,'evaluatedAt',e.evaluated_at,
  'reasons',e.reasons,'disqualifiers',e.disqualifiers,'requiredReceiptsVerified',e.required_receipts_verified,
  'evidenceFreshnessVerified',e.evidence_freshness_verified,'lifecycleDigest',e.lifecycle_digest,'provenanceId',e.provenance_id)`;

export const counterpartMissionStatusSql=`WITH
mission AS MATERIALIZED (SELECT * FROM acp.missions WHERE mission_id=$1),
nodes AS MATERIALIZED (SELECT n.* FROM acp.mission_nodes n JOIN mission m USING(mission_id) ORDER BY n.node_id LIMIT ($2::integer+1)),
candidate AS MATERIALIZED (SELECT c.* FROM acp.candidate_records c JOIN mission m USING(mission_id)
  ORDER BY c.observed_at DESC,c.record_id DESC LIMIT 1),
deployments AS MATERIALIZED (SELECT * FROM (
  SELECT DISTINCT ON (d.environment) d.* FROM acp.deployment_records d JOIN mission m USING(mission_id)
  ORDER BY d.environment,d.observed_at DESC,d.record_id DESC
) selected ORDER BY environment LIMIT ($3::integer+1)),
acceptance AS MATERIALIZED (SELECT a.* FROM acp.acceptance_records a JOIN mission m USING(mission_id)
  ORDER BY a.observed_at DESC,a.record_id DESC LIMIT 1),
tracker AS MATERIALIZED (SELECT t.* FROM acp.tracker_records t JOIN mission m USING(mission_id)
  ORDER BY t.observed_at DESC,t.record_id DESC LIMIT 1),
business AS MATERIALIZED (SELECT b.* FROM acp.business_completion_records b JOIN mission m USING(mission_id)
  ORDER BY b.observed_at DESC,b.record_id DESC LIMIT 1),
effects AS MATERIALIZED (SELECT e.* FROM acp.effect_proposals e JOIN mission m USING(mission_id)
  ORDER BY e.effect_id LIMIT ($2::integer+1)),
latest_evaluation AS MATERIALIZED (SELECT e.* FROM acp.completion_evaluations e JOIN mission m USING(mission_id)
  ORDER BY e.evaluated_at DESC,e.evaluation_id DESC LIMIT 1),
applied_evaluation AS MATERIALIZED (SELECT e.* FROM acp.completion_evaluations e JOIN mission m ON e.evaluation_id=m.completed_by_evaluation_id),
evidence_arrays AS MATERIALIZED (
  SELECT evidence_ids AS ids FROM candidate UNION ALL SELECT evidence_ids FROM deployments
  UNION ALL SELECT evidence_ids FROM acceptance UNION ALL SELECT evidence_ids FROM business
),
selected_evidence_ids AS MATERIALIZED (
  SELECT DISTINCT id FROM evidence_arrays a,
    LATERAL jsonb_array_elements_text(CASE WHEN jsonb_array_length(a.ids)<=$2::integer THEN a.ids ELSE '[]'::jsonb END) selected(id)
  ORDER BY id LIMIT ($2::integer+1)
),
evidence AS MATERIALIZED (SELECT e.* FROM acp.evidence_records e JOIN selected_evidence_ids i ON e.evidence_id::text=i.id),
selected_provenance AS MATERIALIZED (
  SELECT provenance_id FROM candidate UNION SELECT provenance_id FROM deployments UNION SELECT provenance_id FROM acceptance
  UNION SELECT provenance_id FROM tracker UNION SELECT provenance_id FROM business
  UNION SELECT provenance_id FROM effects UNION SELECT provenance_id FROM latest_evaluation UNION SELECT provenance_id FROM applied_evaluation
),
checks AS MATERIALIZED (SELECT
  (SELECT count(*) FROM nodes)>$2::integer OR (SELECT count(*) FROM effects)>$2::integer
    OR (SELECT count(*) FROM deployments)>$3::integer OR (SELECT count(*) FROM selected_evidence_ids)>$2::integer
    OR EXISTS(SELECT 1 FROM evidence_arrays WHERE jsonb_array_length(ids)>$2::integer) AS too_many,
  EXISTS(SELECT 1 FROM selected_evidence_ids i LEFT JOIN evidence e ON e.evidence_id::text=i.id
    WHERE e.evidence_id IS NULL OR e.project_id IS DISTINCT FROM m.project_id OR e.sensitivity='restricted')
    OR EXISTS(SELECT 1 FROM effects WHERE project_id IS DISTINCT FROM m.project_id)
    OR EXISTS(SELECT 1 FROM selected_provenance p WHERE NOT acp.runtime_provenance_matches_context(p.provenance_id,m.mission_id))
    OR EXISTS(SELECT 1 FROM applied_evaluation WHERE mission_id IS DISTINCT FROM m.mission_id) AS invalid_references
  FROM mission m
),
payload AS MATERIALIZED (SELECT checks.*,CASE WHEN NOT checks.too_many AND NOT checks.invalid_references THEN
  jsonb_build_object('missionId',m.mission_id,'projectId',m.project_id,'state',m.state,'requestedScope',m.requested_scope,
    'workflowId',m.workflow_id,'workflowVersion',m.workflow_version,'completionContractId',m.completion_contract_id,
    'completionContractVersion',m.completion_contract_version,'createdAt',m.created_at,'updatedAt',m.updated_at,
    'nodes',(SELECT coalesce(jsonb_agg(jsonb_build_object('nodeId',n.node_id,'nodeType',n.node_type,'workerRole',n.worker_role,
      'state',n.state,'graphRevision',n.graph_revision) ORDER BY n.node_id),'[]'::jsonb) FROM nodes n),
    'statusSchemaVersion','1.0.0','asOf',statement_timestamp(),
    'lifecycle',jsonb_build_object(
      'candidate',(SELECT jsonb_build_object('candidateId',c.candidate_id,'state',c.state,
        'observation',jsonb_build_object('recordId',c.record_id,'observedAt',c.observed_at),
        'revision',jsonb_build_object('repositoryId',c.repository_id,'worktreePath',c.worktree_path,'branch',c.branch,
          'headSha',c.head_sha,'evidenceIds',c.evidence_ids)) FROM candidate c),
      'deployments',(SELECT coalesce(jsonb_agg(jsonb_build_object('environment',d.environment,'state',d.state,
        'artifactVersion',CASE WHEN d.artifact_digest IS NULL THEN jsonb_build_object('status','unknown')
          ELSE jsonb_build_object('status','known','digest',d.artifact_digest) END,
        'observation',jsonb_build_object('recordId',d.record_id,'observedAt',d.observed_at),'evidenceIds',d.evidence_ids)
        ORDER BY d.environment),'[]'::jsonb) FROM deployments d),
      'acceptance',(SELECT jsonb_strip_nulls(jsonb_build_object('state',a.state,'candidateRevision',a.candidate_revision,
        'evidenceIds',a.evidence_ids,'waiver',a.waiver,'observation',jsonb_build_object('recordId',a.record_id,'observedAt',a.observed_at))) FROM acceptance a),
      'tracker',(SELECT jsonb_strip_nulls(jsonb_build_object('adapterId',t.adapter_id,'externalId',t.external_id,
        'nativeState',t.native_state,'semanticCategory',t.semantic_category,'sourceVersion',t.source_version,
        'observation',jsonb_build_object('recordId',t.record_id,'observedAt',t.observed_at))) FROM tracker t),
      'effects',(SELECT coalesce(jsonb_agg(jsonb_build_object('effectId',e.effect_id,'state',e.state) ORDER BY e.effect_id),'[]'::jsonb) FROM effects e),
      'businessCompletion',(SELECT jsonb_build_object('state',b.state,'evidenceIds',b.evidence_ids,
        'observation',jsonb_build_object('recordId',b.record_id,'observedAt',b.observed_at)) FROM business b)
    ),
    'completion',jsonb_build_object('appliedEvaluationId',m.completed_by_evaluation_id,
      'appliedEvaluation',(SELECT ${evaluationJson} FROM applied_evaluation e),
      'latestEvaluation',(SELECT ${evaluationJson} FROM latest_evaluation e)),
    'assessment',jsonb_build_object('kind','recorded_only','freshness','not_assessed','conflicts','not_assessed'),
    'evidence',(SELECT coalesce(jsonb_agg(jsonb_build_object('evidenceId',e.evidence_id,'observedAt',e.observed_at,
      'freshness',e.freshness,'accessibility',e.accessibility) ORDER BY e.evidence_id),'[]'::jsonb) FROM evidence e)
  ) END AS snapshot FROM mission m CROSS JOIN checks
)
SELECT CASE WHEN invalid_references THEN 'invalid_references'
  WHEN too_many OR octet_length(snapshot::text)>$4::integer THEN 'too_large' ELSE NULL END AS status_error,
  CASE WHEN NOT invalid_references AND NOT too_many AND octet_length(snapshot::text)<=$4::integer THEN snapshot ELSE NULL END AS snapshot
FROM payload`;
