/** One current MVCC page, including anchor scope and all direct/preview evidence
 * disclosure. No locks, policy execution, mutation, or silent replacement rows. */
export const attentionQueueSql = `WITH
q AS MATERIALIZED (SELECT $1::text AS project_id,$2::text AS mission_id,$3::text AS after_id,$4::int AS page_limit),
scope AS MATERIALIZED (SELECT q.* FROM q JOIN acp.projects p ON p.project_id::text=q.project_id
  WHERE q.mission_id IS NULL OR EXISTS(SELECT 1 FROM acp.missions m WHERE m.mission_id::text=q.mission_id AND m.project_id=p.project_id)),
anchor AS MATERIALIZED (SELECT a.item_id,a.recorded_at,
  CASE a.body->>'urgency' WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END AS rank
  FROM acp.attention_items a JOIN scope q ON a.project_id::text=q.project_id AND a.item_id::text=q.after_id
  WHERE q.mission_id IS NULL OR EXISTS(SELECT 1 FROM acp.attention_item_missions m WHERE m.item_id=a.item_id AND m.mission_id::text=q.mission_id)),
candidates AS MATERIALIZED (SELECT a.item_id,a.recorded_at,
  CASE a.body->>'urgency' WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END AS rank
  FROM acp.attention_items a JOIN scope q ON a.project_id::text=q.project_id
  WHERE (q.mission_id IS NULL OR EXISTS(SELECT 1 FROM acp.attention_item_missions m WHERE m.item_id=a.item_id AND m.mission_id::text=q.mission_id))
  AND (q.after_id IS NULL OR (CASE a.body->>'urgency' WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,a.recorded_at,a.item_id)
    >(SELECT rank,recorded_at,item_id FROM anchor))
  ORDER BY rank,a.recorded_at,a.item_id LIMIT ($4::int+1)),
page AS MATERIALIZED (SELECT * FROM candidates ORDER BY rank,recorded_at,item_id LIMIT $4::int),
inspection AS MATERIALIZED (SELECT item_id FROM candidates UNION SELECT item_id FROM anchor),
checks AS MATERIALIZED (SELECT q.*,
  q.after_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM anchor) AS invalid_cursor,
  EXISTS(SELECT 1 FROM inspection i JOIN acp.attention_items a USING(item_id) WHERE acp.attention_item_disclosable(a) IS NOT TRUE) AS invalid_references
  FROM scope q),
payload AS MATERIALIZED (SELECT invalid_cursor,invalid_references,CASE WHEN NOT invalid_cursor AND NOT invalid_references THEN jsonb_build_object(
  'schemaVersion','1.0.0','projectId',project_id,'missionId',mission_id,'afterItemId',after_id,'limit',page_limit,
  'asOf',acp.readiness_timestamp(statement_timestamp()),'coverage','recorded_items_only','freshness','not_assessed','authority','not_granted',
  'items',(SELECT coalesce(jsonb_agg(jsonb_build_object('item',a.body,'recordedAt',acp.readiness_timestamp(a.recorded_at),
    'expiry',CASE WHEN NOT a.body ? 'expiresAt' THEN 'not_expiring' WHEN (a.body->>'expiresAt')::timestamptz<=statement_timestamp() THEN 'expired' ELSE 'not_expired' END)
    ORDER BY p.rank,p.recorded_at,p.item_id),'[]'::jsonb) FROM page p JOIN acp.attention_items a USING(item_id)),
  'nextCursor',CASE WHEN (SELECT count(*) FROM candidates)>page_limit THEN (SELECT item_id FROM page ORDER BY rank DESC,recorded_at DESC,item_id DESC LIMIT 1) END
  ) END AS snapshot FROM checks)
SELECT CASE WHEN invalid_cursor THEN 'invalid_cursor' WHEN invalid_references THEN 'invalid_references'
  WHEN octet_length(snapshot::text)>$5::int THEN 'too_large' ELSE NULL END AS attention_error,
  CASE WHEN NOT invalid_cursor AND NOT invalid_references AND octet_length(snapshot::text)<=$5::int THEN snapshot END AS snapshot FROM payload`;
