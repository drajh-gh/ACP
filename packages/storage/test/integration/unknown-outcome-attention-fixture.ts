import assert from "node:assert/strict";
import type { Pool, PoolClient } from "pg";
import { createStableId, type StableId } from "@acp/domain";

export const legacy = (prefix: string, suffix = "001") => `${prefix}_00000000-0000-4000-8000-000000000${suffix}`;
export const projectId = legacy("prj") as StableId<"project">, missionId = legacy("mis") as StableId<"mission">,
  provenanceId = legacy("prv") as StableId<"provenance">;
export async function clone(client: Pick<PoolClient, "query">, table: string, key: string, source: string, overrides: object) {
  assert.equal((await client.query(`INSERT INTO acp.${table} SELECT (jsonb_populate_record(NULL::acp.${table},to_jsonb(source)||$1::jsonb)).*
    FROM acp.${table} source WHERE ${key}=$2`, [JSON.stringify(overrides), source])).rowCount, 1);
}
async function control(client: PoolClient, paused: boolean, authorization: StableId<"runtimeControlAuthorization"> | null) {
  const eventId = createStableId("runtimeControlEvent"), reason = "Owned synthetic unknown-outcome fixture only";
  await client.query(`INSERT INTO acp.runtime_control_events(control_event_id,scope_type,scope_id,previous_effects_paused,effects_paused,
    reason,updated_by,authorization_id,occurred_at,provenance_id)
    SELECT $1,'global','global',effects_paused,$2,$3,'operator:synthetic-attention',$4,statement_timestamp(),$5
    FROM acp.runtime_controls WHERE scope_type='global' AND scope_id='global'`, [eventId, paused, reason, authorization, provenanceId]);
  await client.query("SELECT set_config('acp.runtime_control_event_id',$1,true)", [eventId]);
  assert.equal((await client.query(`UPDATE acp.runtime_controls c SET effects_paused=e.effects_paused,reason=e.reason,updated_by=e.updated_by,
    authorization_id=e.authorization_id,updated_at=e.occurred_at,last_control_event_id=e.control_event_id
    FROM acp.runtime_control_events e WHERE e.control_event_id=$1 AND c.scope_type='global' AND c.scope_id='global'`, [eventId])).rowCount, 1);
}
/** Real guard-complete synthetic DB history. Global unpause and re-pause happen
 * inside one transaction; no other connection observes enabled external effects.
 * No adapter, remote endpoint or external mutation is invoked. */
export async function unknownReceipt(pool: Pool) {
  const effectId = createStableId("effect"), receiptId = createStableId("receipt"), approvalId = createStableId("approval"),
    evaluationId = createStableId("approvalEvaluation"), leaseId = createStableId("lease"), preconditionId = createStableId("executionPreconditionEvaluation"),
    authorization = createStableId("runtimeControlAuthorization"), evidenceId = createStableId("evidence");
  const client = await pool.connect();
  try {
    await client.query("BEGIN"); await client.query("SELECT acp.acquire_effect_authority_lock()");
    assert.equal((await client.query("SELECT effects_paused FROM acp.runtime_controls WHERE scope_type='global' AND scope_id='global'")).rows[0]?.effects_paused, true);
    await client.query(`INSERT INTO acp.runtime_control_authorizations(authorization_id,scope_type,scope_id,action,authorized_by,reason,valid_from,expires_at,provenance_id)
      VALUES($1,'global','global','unpause_effects','operator:synthetic-attention','Owned synthetic fixture',statement_timestamp(),statement_timestamp()+interval '5 minutes',$2)`, [authorization, provenanceId]);
    await control(client, false, authorization);
    const clock = (await client.query("SELECT acp.readiness_timestamp(statement_timestamp()) AS at,acp.readiness_timestamp(statement_timestamp()+interval '10 minutes') AS until")).rows[0];
    await clone(client, "evidence_records", "evidence_id", legacy("evd"), { evidence_id: evidenceId,
      source_ref: "synthetic:unknown-attention", redacted_summary: "synthetic-private-execution-must-not-leak", observed_at: clock.at, retrieved_at: clock.at });
    await clone(client, "effect_proposals", "effect_id", legacy("eff", "002"), { effect_id: effectId, idempotency_key: effectId, state: "proposed",
      execution_fencing_token: null, execution_precondition_evaluation_id: null, verification_receipt_id: null, created_at: clock.at, updated_at: clock.at,
      provenance_id: provenanceId, transition_provenance_id: provenanceId, evidence_ids: [evidenceId] });
    await clone(client, "approval_envelopes", "approval_id", legacy("apr"), { approval_id: approvalId, valid_from: clock.at, expires_at: clock.until,
      revoked_at: null, precondition_snapshot_ids: [] });
    await client.query("UPDATE acp.effect_proposals SET state='previewed',updated_at=statement_timestamp() WHERE effect_id=$1", [effectId]);
    await client.query(`INSERT INTO acp.effect_approval_evaluations(approval_evaluation_id,effect_id,approval_id,evaluated_at,result,reasons,assessment_context,provenance_id)
      VALUES($1,$2,$3,statement_timestamp(),'covered','[]','{}',$4)`, [evaluationId, effectId, approvalId, provenanceId]);
    await client.query("UPDATE acp.effect_proposals SET state='authorized',updated_at=statement_timestamp() WHERE effect_id=$1", [effectId]);
    await client.query("UPDATE acp.effect_proposals SET state='revalidating',updated_at=statement_timestamp() WHERE effect_id=$1", [effectId]);
    const lease = (await client.query(`INSERT INTO acp.resource_leases(lease_id,lease_key,mission_id,node_id,owner_run_id,state,acquired_at,expires_at,heartbeat_at,recovery_state)
      VALUES($1,$2,$3,$4,$5,'active',statement_timestamp(),statement_timestamp()+interval '10 minutes',statement_timestamp(),'{}') RETURNING fencing_token::text`,
      [leaseId, `effect:${effectId}`, missionId, legacy("nod"), legacy("run")])).rows[0];
    await client.query(`INSERT INTO acp.execution_precondition_evaluations(execution_precondition_evaluation_id,effect_id,approval_id,approval_evaluation_id,
      lease_id,fencing_token,proposal_digest,payload_digest,observed_target_digest,precondition_results,result,evaluated_at,valid_until,provenance_id)
      SELECT $1,effect_id,$3,$4,$5,$6,proposal_digest,payload_digest,'sha256:synthetic-unknown-observation','[]','passed',statement_timestamp(),
      statement_timestamp()+interval '2 minutes',$7 FROM acp.effect_proposals WHERE effect_id=$2`, [preconditionId, effectId, approvalId, evaluationId, leaseId, lease.fencing_token, provenanceId]);
    await client.query(`UPDATE acp.effect_proposals SET state='executing',execution_fencing_token=$2,execution_precondition_evaluation_id=$3,
      updated_at=statement_timestamp() WHERE effect_id=$1`, [effectId, lease.fencing_token, preconditionId]);
    await client.query(`INSERT INTO acp.effect_receipts(receipt_id,effect_id,attempt_number,state,execution_record,attempted_at,provenance_id)
      VALUES($1,$2,1,'unknown_outcome','{"private":"synthetic-private-execution-must-not-leak"}',statement_timestamp(),$3)`, [receiptId, effectId, provenanceId]);
    await control(client, true, null); await client.query("COMMIT");
  } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; }
  finally { client.release(true); }
  assert.equal((await pool.query("SELECT state FROM acp.effect_proposals WHERE effect_id=$1", [effectId])).rows[0]?.state, "unknown_outcome");
  assert.equal((await pool.query("SELECT effects_paused FROM acp.runtime_controls WHERE scope_type='global' AND scope_id='global'")).rows[0]?.effects_paused, true);
  return { projectId, receiptId, effectId, evidenceId };
}
export async function reconcile(pool: Pick<Pool, "query">, source: Awaited<ReturnType<typeof unknownReceipt>>, outcome: "applied" | "not_applied" | "inconclusive") {
  const evidenceId = createStableId("evidence"), reconciliationId = createStableId("reconciliation");
  const clock = (await pool.query("SELECT acp.readiness_timestamp(statement_timestamp()) AS at")).rows[0].at as string;
  await clone(pool, "evidence_records", "evidence_id", legacy("evd"), { evidence_id: evidenceId, source_ref: `synthetic:reconcile:${source.receiptId}`,
    content_hash: "sha256:synthetic-reconciliation", observed_at: clock, retrieved_at: clock });
  await pool.query(`INSERT INTO acp.effect_reconciliations(reconciliation_id,effect_id,unknown_receipt_id,outcome,observed_state,evidence_ids,reconciled_at,provenance_id)
    VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,statement_timestamp(),$7)`, [reconciliationId, source.effectId, source.receiptId, outcome,
    JSON.stringify({ outcome, sourceRef: `synthetic:reconcile:${source.receiptId}`, observedDigest: "sha256:synthetic-reconciliation", observedAt: clock }), JSON.stringify([evidenceId]), provenanceId]);
}
