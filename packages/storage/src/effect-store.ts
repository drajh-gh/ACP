import {
  canonicalJsonDigest,
  effectProposalDigest,
  parseVerificationRecord,
  transitionEffectState,
  type EffectProposal,
  type EffectState,
  type JsonValue,
  type StableId,
  type VerificationRecord,
} from "@acp/domain";
import type { QueryResultRow } from "pg";

import type { ConnectionPool } from "./database.ts";
import { acquireEffectAuthorityLock, withTransaction } from "./database.ts";

export interface PersistedEffectProposal {
  readonly effectId: StableId<"effect">;
  readonly state: EffectState;
  readonly duplicate: boolean;
}

export interface EffectReceiptInsert {
  readonly receiptId: StableId<"receipt">;
  readonly effectId: StableId<"effect">;
  readonly attemptNumber: number;
  readonly state: "applied" | "verified" | "failed" | "unknown_outcome" | "rolled_back";
  readonly executionRecord: Readonly<Record<string, JsonValue>>;
  readonly verificationRecord?: VerificationRecord;
  readonly externalId?: string;
  readonly attemptedAt: string;
  readonly verifiedAt?: string;
  readonly provenanceId: StableId<"provenance">;
}

export interface EffectReconciliationInsert {
  readonly reconciliationId: StableId<"reconciliation">;
  readonly effectId: StableId<"effect">;
  readonly unknownReceiptId: StableId<"receipt">;
  readonly outcome: "applied" | "not_applied" | "inconclusive";
  readonly observedState: Readonly<Record<string, JsonValue>>;
  readonly evidenceIds: readonly StableId<"evidence">[];
  readonly reconciledAt: string;
  readonly provenanceId: StableId<"provenance">;
}

export interface EffectExecutionGate {
  readonly effectId: StableId<"effect">;
  readonly leaseId: StableId<"lease">;
  readonly ownerRunId: StableId<"run">;
  readonly fencingToken: string;
  readonly preconditionEvaluationId: StableId<"executionPreconditionEvaluation">;
  readonly transitionProvenanceId: StableId<"provenance">;
}

export interface ExecutionPreconditionResult {
  readonly approvedSnapshotId: StableId<"preconditionSnapshot">;
  readonly approvedDigest: string;
  readonly observedDigest: string;
  readonly matched: boolean;
}

export interface ExecutionPreconditionEvaluationInsert {
  readonly executionPreconditionEvaluationId: StableId<"executionPreconditionEvaluation">;
  readonly effectId: StableId<"effect">;
  readonly approvalId: StableId<"approval">;
  readonly approvalEvaluationId: StableId<"approvalEvaluation">;
  readonly leaseId: StableId<"lease">;
  readonly fencingToken: string;
  readonly observedTargetDigest: string;
  readonly preconditionResults: readonly ExecutionPreconditionResult[];
  readonly result: "passed" | "failed";
  readonly evaluatedAt: string;
  readonly validUntil: string;
  readonly provenanceId: StableId<"provenance">;
}

interface EffectRow extends QueryResultRow {
  readonly effect_id: StableId<"effect">;
  readonly state: EffectState;
  readonly proposal_digest: string;
}

interface ReconciliationRow extends QueryResultRow {
  readonly outcome: "applied" | "not_applied" | "inconclusive";
}

export class PostgresEffectStore {
  private readonly pool: ConnectionPool;

  constructor(pool: ConnectionPool) {
    this.pool = pool;
  }

  async recordProposal(
    proposal: EffectProposal,
    provenanceId: StableId<"provenance">,
  ): Promise<PersistedEffectProposal> {
    const proposalDigest = effectProposalDigest(proposal);
    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query<EffectRow>(
        `INSERT INTO acp.effect_proposals (
           effect_id, mission_id, project_id, effect_type, adapter_id,
           adapter_version, adapter_account_id, target,
           payload, preview, risk_class, rationale, evidence_ids,
           candidate_revision, idempotency_key, proposal_digest, payload_digest,
           required_preconditions,
           verification_plan, rollback_plan, proposed_by_run_id, state,
           provenance_id, transition_provenance_id
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12,
           $13::jsonb, $14, $15, $16, $17, $18::jsonb, $19::jsonb, $20::jsonb,
           $21, 'proposed', $22, $22
         )
         ON CONFLICT (adapter_id, adapter_account_id, idempotency_key) DO NOTHING
         RETURNING effect_id, state, proposal_digest`,
        [
          proposal.effectId,
          proposal.missionId,
          proposal.projectId,
          proposal.type,
          proposal.adapterId,
          proposal.adapterVersion,
          proposal.adapterAccountId,
          JSON.stringify(proposal.target),
          JSON.stringify(proposal.payload),
          proposal.preview,
          proposal.riskClass,
          proposal.rationale,
          JSON.stringify(proposal.evidenceIds),
          proposal.candidateRevision ?? null,
          proposal.idempotencyKey,
          proposalDigest,
          canonicalJsonDigest(proposal.payload),
          JSON.stringify(proposal.requiredPreconditions),
          JSON.stringify(proposal.verificationPlan),
          proposal.rollbackPlan === undefined
            ? null
            : JSON.stringify(proposal.rollbackPlan),
          proposal.proposedByRunId,
          provenanceId,
        ],
      );
      if (inserted.rows[0] !== undefined) {
        return { ...mapEffect(inserted.rows[0]), duplicate: false };
      }

      const existing = await client.query<EffectRow>(
        `SELECT effect_id, state, proposal_digest
         FROM acp.effect_proposals
         WHERE adapter_id = $1 AND adapter_account_id = $2 AND idempotency_key = $3`,
        [proposal.adapterId, proposal.adapterAccountId, proposal.idempotencyKey],
      );
      const row = existing.rows[0];
      if (row === undefined) {
        throw new Error("effect idempotency conflict could not be read back");
      }
      if (row.proposal_digest !== proposalDigest) {
        throw new Error("effect idempotency key aliases a different proposal");
      }
      return { ...mapEffect(row), duplicate: true };
    });
  }

  async transition(
    effectId: StableId<"effect">,
    nextState: EffectState,
    transitionProvenanceId: StableId<"provenance">,
  ): Promise<EffectState> {
    return withTransaction(this.pool, async (client) => {
      await acquireEffectAuthorityLock(client);
      const locked = await client.query<EffectRow>(
        "SELECT effect_id, state FROM acp.effect_proposals WHERE effect_id = $1 FOR UPDATE",
        [effectId],
      );
      const current = locked.rows[0];
      if (current === undefined) throw new Error("effect does not exist");

      let reconciliationOutcome: ReconciliationRow["outcome"] | undefined;
      if (current.state === "unknown_outcome") {
        const reconciliation = await client.query<ReconciliationRow>(
          `SELECT reconciliation.outcome
           FROM LATERAL (
             SELECT receipt_id, effect_id
             FROM acp.effect_receipts
             WHERE effect_id = $1 AND state = 'unknown_outcome'
             ORDER BY attempt_number DESC
             LIMIT 1
           ) AS receipt
           LEFT JOIN acp.effect_reconciliations AS reconciliation
             ON reconciliation.unknown_receipt_id = receipt.receipt_id
            AND reconciliation.effect_id = receipt.effect_id`,
          [effectId],
        );
        reconciliationOutcome = reconciliation.rows[0]?.outcome;
      }
      transitionEffectState(current.state, nextState, {
        ...(reconciliationOutcome === undefined ? {} : { reconciliationOutcome }),
      });
      const updated = await client.query<EffectRow>(
        `UPDATE acp.effect_proposals
         SET state = $2, transition_provenance_id = $3,
             updated_at = statement_timestamp()
         WHERE effect_id = $1
         RETURNING effect_id, state`,
        [effectId, nextState, transitionProvenanceId],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new Error("effect transition did not return a row");
      return row.state;
    });
  }

  async authorizeFromPersistedApproval(
    effectId: StableId<"effect">,
    approvalId: StableId<"approval">,
    missionId: StableId<"mission">,
    transitionProvenanceId: StableId<"provenance">,
  ): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      await acquireEffectAuthorityLock(client);
      const locked = await client.query<EffectRow>(
        `SELECT effect_id, state, proposal_digest
         FROM acp.effect_proposals
         WHERE effect_id = $1 AND mission_id = $2
         FOR UPDATE`,
        [effectId, missionId],
      );
      const effect = locked.rows[0];
      if (effect === undefined) return false;
      const coverage = await client.query(
        `SELECT 1
         FROM acp.effect_approval_evaluations AS evaluation
         JOIN acp.approval_envelopes AS approval
           ON approval.approval_id = evaluation.approval_id
          WHERE evaluation.effect_id = $1
            AND evaluation.approval_id = $2
            AND evaluation.result = 'covered'
            AND NOT EXISTS (
              SELECT 1
              FROM acp.effect_approval_evaluations AS newer_evaluation
              WHERE newer_evaluation.effect_id = evaluation.effect_id
                AND newer_evaluation.approval_id = evaluation.approval_id
                AND (
                  newer_evaluation.evaluated_at > evaluation.evaluated_at
                  OR (
                    newer_evaluation.evaluated_at = evaluation.evaluated_at
                    AND newer_evaluation.recorded_order > evaluation.recorded_order
                  )
                )
            )
            AND approval.valid_from <= statement_timestamp()
           AND approval.expires_at > statement_timestamp()
           AND approval.revoked_at IS NULL
           AND (approval.mission_id IS NULL OR approval.mission_id = $3)
         LIMIT 1`,
        [effectId, approvalId, missionId],
      );
      if (coverage.rowCount !== 1) return false;
      if (effect.state === "previewed") {
        await client.query(
          `UPDATE acp.effect_proposals
           SET state = 'authorized', transition_provenance_id = $2,
               updated_at = statement_timestamp()
           WHERE effect_id = $1`,
          [effectId, transitionProvenanceId],
        );
        return true;
      }
      return ["authorized", "revalidating", "executing"].includes(effect.state);
    });
  }

  async recordExecutionPreconditionEvaluation(
    evaluation: ExecutionPreconditionEvaluationInsert,
  ): Promise<void> {
    if (!/^[1-9][0-9]*$/u.test(evaluation.fencingToken)) {
      throw new TypeError("fencing token must be a positive decimal integer");
    }
    if (evaluation.observedTargetDigest.trim().length === 0) {
      throw new TypeError("observed target digest must be non-empty");
    }
    const evaluatedAt = Date.parse(evaluation.evaluatedAt);
    const validUntil = Date.parse(evaluation.validUntil);
    if (
      Number.isNaN(evaluatedAt) ||
      Number.isNaN(validUntil) ||
      validUntil <= evaluatedAt
    ) {
      throw new TypeError("precondition evaluation validity must end after evaluation");
    }
    if (
      evaluation.result === "passed" &&
      evaluation.preconditionResults.some((precondition) => !precondition.matched)
    ) {
      throw new Error("a passing evaluation cannot contain a failed precondition");
    }
    await withTransaction(this.pool, async (client) => {
      await acquireEffectAuthorityLock(client);
      const result = await client.query(
         `INSERT INTO acp.execution_precondition_evaluations (
          execution_precondition_evaluation_id, effect_id, approval_id,
          approval_evaluation_id, lease_id, fencing_token, proposal_digest, payload_digest,
          observed_target_digest, precondition_results, result, evaluated_at,
          valid_until, provenance_id
        )
        SELECT $1, effect.effect_id, $3, $4, $5, $6,
               effect.proposal_digest, effect.payload_digest, $7, $8::jsonb,
               $9, $10, $11, $12
        FROM acp.effect_proposals AS effect
        WHERE effect.effect_id = $2
         AND effect.state = 'revalidating'`,
      [
        evaluation.executionPreconditionEvaluationId,
        evaluation.effectId,
        evaluation.approvalId,
        evaluation.approvalEvaluationId,
        evaluation.leaseId,
        evaluation.fencingToken,
        evaluation.observedTargetDigest,
        JSON.stringify(evaluation.preconditionResults),
        evaluation.result,
        evaluation.evaluatedAt,
        evaluation.validUntil,
        evaluation.provenanceId,
        ],
      );
      if (result.rowCount !== 1) {
        throw new Error("effect is not awaiting execution revalidation");
      }
    });
  }

  async beginExecution(gate: EffectExecutionGate): Promise<void> {
    if (!/^[1-9][0-9]*$/u.test(gate.fencingToken)) {
      throw new TypeError("fencing token must be a positive decimal integer");
    }
    await withTransaction(this.pool, async (client) => {
      await acquireEffectAuthorityLock(client);
      const result = await client.query(
        `UPDATE acp.effect_proposals AS effect
       SET state = 'executing',
           execution_fencing_token = $4,
           execution_precondition_evaluation_id = $5,
           transition_provenance_id = $6,
           updated_at = statement_timestamp()
       WHERE effect.effect_id = $1
         AND effect.state = 'revalidating'
         AND EXISTS (
           SELECT 1 FROM acp.resource_leases AS lease
           WHERE lease.lease_id = $2
             AND lease.owner_run_id = $3
             AND lease.fencing_token = $4
             AND lease.lease_key = 'effect:' || effect.effect_id::text
             AND lease.mission_id = effect.mission_id
             AND lease.state IN ('active', 'recovering')
             AND lease.expires_at > statement_timestamp()
         )
         AND EXISTS (
           SELECT 1
           FROM acp.execution_precondition_evaluations AS evaluation
           WHERE evaluation.execution_precondition_evaluation_id = $5
             AND evaluation.effect_id = effect.effect_id
             AND evaluation.lease_id = $2
             AND evaluation.fencing_token = $4
             AND evaluation.result = 'passed'
             AND evaluation.valid_until > statement_timestamp()
             AND evaluation.proposal_digest = effect.proposal_digest
             AND evaluation.payload_digest = effect.payload_digest
         )`,
        [
          gate.effectId,
          gate.leaseId,
          gate.ownerRunId,
          gate.fencingToken,
          gate.preconditionEvaluationId,
          gate.transitionProvenanceId,
        ],
      );
      if (result.rowCount !== 1) {
        throw new Error("effect execution gate was not satisfied");
      }
    });
  }

  async recordReceipt(receipt: EffectReceiptInsert): Promise<void> {
    if (
      receipt.state === "verified" &&
      (receipt.verificationRecord === undefined || receipt.verifiedAt === undefined)
    ) {
      throw new Error("a verified receipt requires verification evidence and time");
    }
    const verificationRecord = receipt.verificationRecord === undefined
      ? undefined
      : parseVerificationRecord(receipt.verificationRecord);
    if (receipt.state !== "verified" && receipt.verifiedAt !== undefined) {
      throw new Error("only a verified receipt may carry a verification time");
    }
    if (receipt.state !== "verified" && verificationRecord !== undefined) {
      throw new Error("only a verified receipt may carry passed verification evidence");
    }
    await this.pool.query(
      `INSERT INTO acp.effect_receipts (
         receipt_id, effect_id, attempt_number, state, execution_record,
         verification_record, external_id, attempted_at, verified_at,
         provenance_id
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10)`,
      [
        receipt.receiptId,
        receipt.effectId,
        receipt.attemptNumber,
        receipt.state,
        JSON.stringify(receipt.executionRecord),
        verificationRecord === undefined
          ? null
          : JSON.stringify(verificationRecord),
        receipt.externalId ?? null,
        receipt.attemptedAt,
        receipt.verifiedAt ?? null,
        receipt.provenanceId,
      ],
    );
  }

  async recordReconciliation(
    reconciliation: EffectReconciliationInsert,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO acp.effect_reconciliations (
         reconciliation_id, effect_id, unknown_receipt_id, outcome,
         observed_state, evidence_ids, reconciled_at, provenance_id
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)`,
      [
        reconciliation.reconciliationId,
        reconciliation.effectId,
        reconciliation.unknownReceiptId,
        reconciliation.outcome,
        JSON.stringify(reconciliation.observedState),
        JSON.stringify(reconciliation.evidenceIds),
        reconciliation.reconciledAt,
        reconciliation.provenanceId,
      ],
    );
  }
}

function mapEffect(row: EffectRow): Omit<PersistedEffectProposal, "duplicate"> {
  return { effectId: row.effect_id, state: row.state };
}
