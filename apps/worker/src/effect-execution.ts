import {
  parseVerificationRecord,
  type EffectProposal,
  type EffectState,
  type JsonValue,
  type StableId,
  type VerificationRecord,
} from "@acp/domain";
import type {
  EffectExecutionGate,
  EffectReceiptInsert,
  EffectReconciliationInsert,
} from "@acp/storage";

export interface EffectAdapterContext {
  readonly abortSignal: AbortSignal;
}

export interface EffectAdapterExecutionResult {
  readonly executionRecord: Readonly<Record<string, JsonValue>>;
  readonly externalId?: string;
}

export type EffectReconciliationOutcome =
  | "applied"
  | "not_applied"
  | "inconclusive";

export interface EffectAdapterReconciliationResult {
  readonly outcome: EffectReconciliationOutcome;
  readonly observedState: Readonly<Record<string, JsonValue>> & {
    readonly outcome: EffectReconciliationOutcome;
    readonly sourceRef: string;
    readonly observedDigest: string;
    readonly observedAt: string;
  };
  readonly evidenceIds: readonly StableId<"evidence">[];
}

export interface DeterministicEffectAdapter {
  execute(
    proposal: EffectProposal,
    context: EffectAdapterContext,
  ): Promise<EffectAdapterExecutionResult>;
  reconcile(
    proposal: EffectProposal,
    context: EffectAdapterContext,
  ): Promise<EffectAdapterReconciliationResult>;
  verify(
    proposal: EffectProposal,
    context: EffectAdapterContext,
  ): Promise<VerificationRecord>;
}

export interface EffectExecutionPersistence {
  beginExecution(gate: EffectExecutionGate): Promise<void>;
  recordReceipt(receipt: EffectReceiptInsert): Promise<void>;
  recordReconciliation(
    reconciliation: EffectReconciliationInsert,
  ): Promise<void>;
  transition(
    effectId: StableId<"effect">,
    nextState: EffectState,
    transitionProvenanceId: StableId<"provenance">,
  ): Promise<EffectState>;
}

export interface EffectExecutionAttempt {
  readonly proposal: EffectProposal;
  readonly gate: EffectExecutionGate;
  readonly receiptId: StableId<"receipt">;
  readonly attemptNumber: number;
  readonly attemptedAt: string;
  readonly provenanceId: StableId<"provenance">;
}

export interface EffectReconciliationAttempt {
  readonly proposal: EffectProposal;
  readonly reconciliationId: StableId<"reconciliation">;
  readonly unknownReceiptId: StableId<"receipt">;
  readonly reconciledAt: string;
  readonly provenanceId: StableId<"provenance">;
}

export interface EffectVerificationAttempt {
  readonly proposal: EffectProposal;
  readonly receiptId: StableId<"receipt">;
  readonly attemptNumber: number;
  readonly attemptedAt: string;
  readonly verifiedAt: string;
  readonly provenanceId: StableId<"provenance">;
}

export type EffectAttemptState = "applied" | "failed" | "unknown_outcome";

export class ClassifiedEffectExecutionError extends Error {
  readonly receiptState: "failed" | "unknown_outcome";
  readonly executionRecord: Readonly<Record<string, JsonValue>>;
  readonly externalId?: string;

  constructor(
    message: string,
    receiptState: "failed" | "unknown_outcome",
    executionRecord: Readonly<Record<string, JsonValue>>,
    externalId?: string,
  ) {
    super(message);
    this.name = "ClassifiedEffectExecutionError";
    this.receiptState = receiptState;
    this.executionRecord = executionRecord;
    if (externalId !== undefined) this.externalId = externalId;
  }
}

export class EffectExecutionService {
  private readonly persistence: EffectExecutionPersistence;
  private readonly adapter: DeterministicEffectAdapter;

  constructor(
    persistence: EffectExecutionPersistence,
    adapter: DeterministicEffectAdapter,
  ) {
    this.persistence = persistence;
    this.adapter = adapter;
  }

  async execute(
    attempt: EffectExecutionAttempt,
    context: EffectAdapterContext,
  ): Promise<EffectAttemptState> {
    if (attempt.gate.effectId !== attempt.proposal.effectId) {
      throw new Error("execution gate effect does not match the proposal");
    }
    await this.persistence.beginExecution(attempt.gate);

    let receiptState: EffectAttemptState;
    let executionRecord: Readonly<Record<string, JsonValue>>;
    let externalId: string | undefined;
    try {
      const result = await this.adapter.execute(attempt.proposal, context);
      receiptState = "applied";
      executionRecord = result.executionRecord;
      externalId = result.externalId;
    } catch (error) {
      if (error instanceof ClassifiedEffectExecutionError) {
        receiptState = error.receiptState;
        executionRecord = error.executionRecord;
        externalId = error.externalId;
      } else {
        receiptState = "unknown_outcome";
        executionRecord = {
          classification: "unclassified_adapter_exception",
          errorType: error instanceof Error ? error.name : typeof error,
        };
      }
    }

    await this.persistence.recordReceipt({
      receiptId: attempt.receiptId,
      effectId: attempt.proposal.effectId,
      attemptNumber: attempt.attemptNumber,
      state: receiptState,
      executionRecord,
      ...(externalId === undefined ? {} : { externalId }),
      attemptedAt: attempt.attemptedAt,
      provenanceId: attempt.provenanceId,
    });
    return receiptState;
  }

  async reconcile(
    attempt: EffectReconciliationAttempt,
    context: EffectAdapterContext,
  ): Promise<EffectReconciliationOutcome> {
    const result = await this.adapter.reconcile(attempt.proposal, context);
    if (result.observedState.outcome !== result.outcome) {
      throw new Error("adapter reconciliation outcome conflicts with observed state");
    }
    if (result.evidenceIds.length === 0) {
      throw new Error("adapter reconciliation requires observation evidence");
    }

    await this.persistence.recordReconciliation({
      reconciliationId: attempt.reconciliationId,
      effectId: attempt.proposal.effectId,
      unknownReceiptId: attempt.unknownReceiptId,
      outcome: result.outcome,
      observedState: result.observedState,
      evidenceIds: result.evidenceIds,
      reconciledAt: attempt.reconciledAt,
      provenanceId: attempt.provenanceId,
    });

    if (result.outcome === "applied") {
      await this.persistence.transition(
        attempt.proposal.effectId,
        "applied",
        attempt.provenanceId,
      );
    } else if (result.outcome === "not_applied") {
      await this.persistence.transition(
        attempt.proposal.effectId,
        "revalidating",
        attempt.provenanceId,
      );
    }
    return result.outcome;
  }

  async verify(
    attempt: EffectVerificationAttempt,
    context: EffectAdapterContext,
  ): Promise<void> {
    await this.persistence.transition(
      attempt.proposal.effectId,
      "verifying",
      attempt.provenanceId,
    );
    const verificationRecord = parseVerificationRecord(
      await this.adapter.verify(attempt.proposal, context),
    );
    await this.persistence.recordReceipt({
      receiptId: attempt.receiptId,
      effectId: attempt.proposal.effectId,
      attemptNumber: attempt.attemptNumber,
      state: "verified",
      executionRecord: { classification: "independent_readback" },
      verificationRecord,
      attemptedAt: attempt.attemptedAt,
      verifiedAt: attempt.verifiedAt,
      provenanceId: attempt.provenanceId,
    });
  }
}
