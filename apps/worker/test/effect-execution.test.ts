import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canonicalJsonDigest,
  createStableId,
  transitionEffectState,
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

import {
  ClassifiedEffectExecutionError,
  EffectExecutionService,
  type DeterministicEffectAdapter,
  type EffectAdapterContext,
  type EffectExecutionPersistence,
} from "../src/effect-execution.ts";

interface SyntheticTarget {
  readonly records: Map<string, JsonValue>;
  mutationCount: number;
}

class SyntheticEffectAdapter implements DeterministicEffectAdapter {
  readonly target: SyntheticTarget;
  readonly loseFirstResponse: boolean;
  executionCalls = 0;

  constructor(target: SyntheticTarget, loseFirstResponse = false) {
    this.target = target;
    this.loseFirstResponse = loseFirstResponse;
  }

  async execute(
    proposal: EffectProposal,
    context: EffectAdapterContext,
  ) {
    context.abortSignal.throwIfAborted();
    this.executionCalls += 1;
    if (!this.target.records.has(proposal.idempotencyKey)) {
      this.target.records.set(proposal.idempotencyKey, proposal.payload);
      this.target.mutationCount += 1;
    }
    const executionRecord = {
      operation: "synthetic.write",
      idempotencyKey: proposal.idempotencyKey,
      mutationAccepted: true,
    } as const;
    if (this.loseFirstResponse) {
      throw new ClassifiedEffectExecutionError(
        "synthetic response lost after commit",
        "unknown_outcome",
        executionRecord,
        proposal.target.externalId,
      );
    }
    return { executionRecord, externalId: proposal.target.externalId };
  }

  async reconcile(
    proposal: EffectProposal,
    context: EffectAdapterContext,
  ) {
    context.abortSignal.throwIfAborted();
    const observed = this.target.records.get(proposal.idempotencyKey);
    const outcome = observed === undefined ? "not_applied" as const : "applied" as const;
    return {
      outcome,
      observedState: {
        outcome,
        sourceRef: `synthetic:${proposal.target.externalId}`,
        observedDigest: canonicalJsonDigest(observed ?? null),
        observedAt: "2026-09-04T12:00:02.000Z",
        value: observed ?? null,
      },
      evidenceIds: [createStableId("evidence")],
    };
  }

  async verify(
    proposal: EffectProposal,
    context: EffectAdapterContext,
  ): Promise<VerificationRecord> {
    context.abortSignal.throwIfAborted();
    const observed = this.target.records.get(proposal.idempotencyKey);
    assert.deepEqual(observed, proposal.payload);
    return {
      result: "passed",
      steps: proposal.verificationPlan.map((step, stepIndex) => ({
        stepIndex,
        type: step.type,
        expected: step.expected,
        observed: observed ?? null,
        observedDigest: canonicalJsonDigest(observed ?? null),
        matched: true,
        observedAt: "2026-09-04T12:00:03.000Z",
        evidenceIds: [createStableId("evidence")],
      })),
    };
  }
}

class MemoryEffectPersistence implements EffectExecutionPersistence {
  state: EffectState = "revalidating";
  readonly receipts: EffectReceiptInsert[] = [];
  readonly reconciliations: EffectReconciliationInsert[] = [];

  async beginExecution(_gate: EffectExecutionGate): Promise<void> {
    if (this.state !== "revalidating") {
      throw new Error("effect execution gate was not satisfied");
    }
    this.state = transitionEffectState(this.state, "executing");
  }

  async recordReceipt(receipt: EffectReceiptInsert): Promise<void> {
    if (this.receipts.some((item) => item.attemptNumber === receipt.attemptNumber)) {
      throw new Error("duplicate receipt attempt");
    }
    this.receipts.push(receipt);
    this.state = transitionEffectState(this.state, receipt.state, {
      ...(receipt.state === "verified"
        ? { verifiedReceiptId: receipt.receiptId }
        : {}),
    });
  }

  async recordReconciliation(
    reconciliation: EffectReconciliationInsert,
  ): Promise<void> {
    const unknownReceipt = this.receipts.find(
      (receipt) => receipt.receiptId === reconciliation.unknownReceiptId,
    );
    if (unknownReceipt?.state !== "unknown_outcome") {
      throw new Error("reconciliation requires the unknown receipt");
    }
    this.reconciliations.push(reconciliation);
  }

  async transition(
    _effectId: StableId<"effect">,
    nextState: EffectState,
    _transitionProvenanceId: StableId<"provenance">,
  ): Promise<EffectState> {
    const reconciliation = this.reconciliations.at(-1);
    this.state = transitionEffectState(this.state, nextState, {
      ...(reconciliation === undefined
        ? {}
        : { reconciliationOutcome: reconciliation.outcome }),
    });
    return this.state;
  }
}

describe("deterministic effect execution", () => {
  it("reconciles a lost response without repeating the remote mutation", async () => {
    const proposal = syntheticProposal();
    const provenanceId = createStableId("provenance");
    const gate: EffectExecutionGate = {
      effectId: proposal.effectId,
      leaseId: createStableId("lease"),
      ownerRunId: createStableId("run"),
      fencingToken: "1",
      preconditionEvaluationId: createStableId("executionPreconditionEvaluation"),
      transitionProvenanceId: provenanceId,
    };
    const target: SyntheticTarget = { records: new Map(), mutationCount: 0 };
    const persistence = new MemoryEffectPersistence();
    const firstAdapter = new SyntheticEffectAdapter(target, true);
    const firstService = new EffectExecutionService(persistence, firstAdapter);
    const context = { abortSignal: new AbortController().signal };

    assert.equal(
      await firstService.execute(
        {
          proposal,
          gate,
          receiptId: createStableId("receipt"),
          attemptNumber: 1,
          attemptedAt: "2026-09-04T12:00:01.000Z",
          provenanceId,
        },
        context,
      ),
      "unknown_outcome",
    );
    assert.equal(persistence.state, "unknown_outcome");
    assert.equal(target.mutationCount, 1);

    await assert.rejects(
      firstService.execute(
        {
          proposal,
          gate,
          receiptId: createStableId("receipt"),
          attemptNumber: 2,
          attemptedAt: "2026-09-04T12:00:02.000Z",
          provenanceId,
        },
        context,
      ),
      /execution gate was not satisfied/,
    );
    assert.equal(firstAdapter.executionCalls, 1);
    assert.equal(target.mutationCount, 1);

    const recoveredAdapter = new SyntheticEffectAdapter(target);
    const recoveredService = new EffectExecutionService(
      persistence,
      recoveredAdapter,
    );
    const unknownReceiptId = persistence.receipts[0]!.receiptId;
    assert.equal(
      await recoveredService.reconcile(
        {
          proposal,
          reconciliationId: createStableId("reconciliation"),
          unknownReceiptId,
          reconciledAt: "2026-09-04T12:00:02.000Z",
          provenanceId,
        },
        context,
      ),
      "applied",
    );

    await recoveredService.verify(
      {
        proposal,
        receiptId: createStableId("receipt"),
        attemptNumber: 2,
        attemptedAt: "2026-09-04T12:00:03.000Z",
        verifiedAt: "2026-09-04T12:00:04.000Z",
        provenanceId,
      },
      context,
    );

    assert.equal(persistence.state, "verified");
    assert.equal(target.mutationCount, 1);
    assert.equal(firstAdapter.executionCalls, 1);
    assert.equal(recoveredAdapter.executionCalls, 0);
    assert.equal(persistence.reconciliations.length, 1);
    assert.equal(
      persistence.reconciliations[0]?.unknownReceiptId,
      unknownReceiptId,
    );
    assert.deepEqual(
      persistence.receipts.map((receipt) => receipt.state),
      ["unknown_outcome", "verified"],
    );
  });
});

function syntheticProposal(): EffectProposal {
  return {
    effectId: createStableId("effect"),
    missionId: createStableId("mission"),
    projectId: createStableId("project"),
    type: "synthetic.write",
    adapterId: "synthetic",
    adapterVersion: "1.0.0",
    adapterAccountId: "synthetic:test",
    target: {
      type: "record",
      externalId: "record-1",
      displayName: "Synthetic record 1",
    },
    payload: { value: 1 },
    preview: "Write the synthetic record once.",
    riskClass: "R1",
    rationale: "Prove lost-response reconciliation.",
    evidenceIds: [createStableId("evidence")],
    idempotencyKey: "synthetic:record-1",
    requiredPreconditions: [],
    verificationPlan: [{ type: "read", expected: { value: 1 } }],
    proposedByRunId: createStableId("run"),
  };
}
