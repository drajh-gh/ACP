import { parseRequestHistory, parseRequestHistoryQuery, requestHistoryMaximumAssociations, requestHistoryMaximumBytes, type RequestHistory } from "@acp/domain";
import type { QueryExecutor } from "./database.ts";

/** Private one-statement recorded history. Caller owns bounded connection and SQL
 * settings. No locks, authority checks with side effects, or fallback snapshots. */
export async function getRequestHistory(executor: QueryExecutor, queryValue: unknown): Promise<RequestHistory | undefined> {
  const query = parseRequestHistoryQuery(queryValue);
  const rows = (await executor.query(requestHistorySql, [query.projectId, query.requestId, requestHistoryMaximumAssociations, requestHistoryMaximumBytes])).rows;
  if (!rows.length) return undefined;
  if (rows.length !== 1 || rows[0]?.request_error !== null) throw new Error("Recorded request history is unavailable; no partial history returned.");
  return parseRequestHistory(query, rows[0]?.snapshot);
}
export const requestHistorySql = `WITH
scope AS MATERIALIZED (SELECT request_id,project_id,source_intake_id,title,summary,recorded_at FROM acp.request_records
  WHERE project_id=$1::acp.stable_id AND request_id=$2::acp.stable_id),
links AS MATERIALIZED (SELECT a.mission_id,a.reason,a.recorded_at FROM acp.request_mission_associations a JOIN scope r
  ON a.request_id=r.request_id AND a.project_id=r.project_id ORDER BY a.mission_id::text COLLATE "C" LIMIT ($3::int+1)),
payload AS MATERIALIZED (SELECT (SELECT count(*) FROM links)>$3::int AS too_many,
  CASE WHEN (SELECT count(*) FROM links)<=$3::int THEN jsonb_build_object(
    'schemaVersion','1.0.0','asOf',acp.readiness_timestamp(statement_timestamp()),
    'request',jsonb_build_object('requestId',r.request_id,'projectId',r.project_id,'sourceIntakeId',r.source_intake_id,'title',r.title,'summary',r.summary),
    'recordedAt',acp.readiness_timestamp(r.recorded_at),'missionAssociations',
    (SELECT coalesce(jsonb_agg(jsonb_build_object('missionId',a.mission_id,'reason',a.reason,'recordedAt',acp.readiness_timestamp(a.recorded_at))
      ORDER BY a.mission_id::text COLLATE "C"),'[]'::jsonb) FROM links a),
    'coverage','recorded_associations_only','freshness','not_assessed','authority','not_granted') END AS snapshot FROM scope r)
SELECT CASE WHEN too_many THEN 'too_many' WHEN octet_length(snapshot::text)>$4::int THEN 'too_large' ELSE NULL END AS request_error,
  CASE WHEN NOT too_many AND octet_length(snapshot::text)<=$4::int THEN snapshot END AS snapshot FROM payload`;
