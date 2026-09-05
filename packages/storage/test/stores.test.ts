import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canonicalJsonDigest,
  createStableId,
  effectProposalDigest,
} from "@acp/domain";
import type { QueryResult, QueryResultRow } from "pg";

import type {
  ConnectionPool,
  TransactionClient,
} from "../src/database.ts";
import { PostgresControlStore } from "../src/control-store.ts";
import { PostgresEffectStore } from "../src/effect-store.ts";
import { PostgresLeaseStore } from "../src/lease-store.ts";
import { PostgresMissionStore } from "../src/mission-store.ts";
import { PostgresRuntimeStore } from "../src/runtime-store.ts";

type Response =
  | { readonly rows?: readonly QueryResultRow[]; readonly rowCount?: number }
  | Error;

class ScriptedPool implements ConnectionPool, TransactionClient {
  readonly queries: { readonly text: string; readonly values: readonly unknown[] }[] = [];
  released = false;
  private readonly responses: Response[];

  constructor(responses: Response[]) {
    this.responses = responses;
  }

  async connect(): Promise<TransactionClient> {
    return this;
  }

  release(): void {
    this.released = true;
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<R>> {
    this.queries.push({ text, values });
    if (text.startsWith("BEGIN") || text === "COMMIT" || text === "ROLLBACK") {
      return result<R>([]);
    }
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    if (response === undefined) {
      throw new Error(`No scripted response for query: ${text}`);
    }
    return result<R>(response.rows ?? [], response.rowCount);
  }
}

describe("PostgreSQL stores", () => {
  it("creates a mission and its initial event in one transaction", async () => {
    const missionId = createStableId("mission");
    const projectId = createStableId("project");
    const completionContractId = createStableId("completionContract");
    const updatedAt = new Date("2026-09-04T12:00:00.000Z");
    const pool = new ScriptedPool([
      {
        rows: [
          {
            mission_id: missionId,
            project_id: projectId,
            state: "received",
            completion_contract_id: completionContractId,
            completion_contract_version: "1.0.0",
            completed_by_evaluation_id: null,
            updated_at: updatedAt,
          },
        ],
      },
      { rows: [{ event_id: createStableId("event") }] },
    ]);
    const store = new PostgresMissionStore(pool);

    const mission = await store.createMission(
      {
        missionId,
        projectId,
        workflowId: createStableId("workflow"),
        workflowVersion: "1.0.0",
        workflowBindingId: createStableId("workflowBinding"),
        completionContractId,
        completionContractVersion: "1.0.0",
        state: "received",
        requestedScope: "Deliver the synthetic issue.",
      },
      {
        eventId: createStableId("event"),
        missionId,
        eventType: "mission.received",
        eventVersion: "1.0.0",
        idempotencyKey: "synthetic:issue:1",
        payload: { source: "synthetic" },
        occurredAt: "2026-09-04T12:00:00.000Z",
        provenanceId: createStableId("provenance"),
      },
    );

    assert.equal(mission.state, "received");
    assert.deepEqual(
      pool.queries.map((query) => query.text.trim().split(/\s+/u)[0]),
      ["BEGIN", "INSERT", "INSERT", "COMMIT"],
    );
    assert.equal(pool.released, true);
  });

  it("rolls back the mission when its event cannot be appended", async () => {
    const missionId = createStableId("mission");
    const projectId = createStableId("project");
    const pool = new ScriptedPool([
      {
        rows: [
          {
            mission_id: missionId,
            project_id: projectId,
            state: "received",
            completion_contract_id: createStableId("completionContract"),
            completion_contract_version: "1.0.0",
            completed_by_evaluation_id: null,
            updated_at: new Date(),
          },
        ],
      },
      { rows: [], rowCount: 0 },
    ]);
    const store = new PostgresMissionStore(pool);

    await assert.rejects(
      store.createMission(
        {
          missionId,
          projectId,
          workflowId: createStableId("workflow"),
          workflowVersion: "1.0.0",
          workflowBindingId: createStableId("workflowBinding"),
          completionContractId: createStableId("completionContract"),
          completionContractVersion: "1.0.0",
          state: "received",
          requestedScope: "Deliver the synthetic issue.",
        },
        {
          eventId: createStableId("event"),
          missionId,
          eventType: "mission.received",
          eventVersion: "1.0.0",
          idempotencyKey: "synthetic:issue:1",
          payload: {},
          occurredAt: "2026-09-04T12:00:00.000Z",
          provenanceId: createStableId("provenance"),
        },
      ),
      /idempotency key already exists/,
    );
    assert.equal(pool.queries.at(-1)?.text, "ROLLBACK");
    assert.equal(pool.released, true);
  });

  it("rejects noncanonical lease keys before database access", async () => {
    const pool = new ScriptedPool([]);
    const store = new PostgresLeaseStore(pool);

    await assert.rejects(
      store.acquire({
        leaseId: createStableId("lease"),
        leaseKey: "Repo: ACP ",
        missionId: createStableId("mission"),
        nodeId: createStableId("node"),
        ownerRunId: createStableId("run"),
        state: "active",
        ttlSeconds: 300,
        recoveryState: {},
      }),
      /canonical lowercase resource key/,
    );
    assert.equal(pool.queries.length, 0);
  });

  it("bounds lease duration using a server-timed TTL", async () => {
    const pool = new ScriptedPool([]);
    const store = new PostgresLeaseStore(pool, 60);
    await assert.rejects(
      store.acquire({
        leaseId: createStableId("lease"),
        leaseKey: "effect:one",
        missionId: createStableId("mission"),
        nodeId: createStableId("node"),
        ownerRunId: createStableId("run"),
        state: "active",
        ttlSeconds: 61,
        recoveryState: {},
      }),
      /between 1 and 60 seconds/,
    );
    assert.equal(pool.queries.length, 0);
  });

  it("returns the existing effect for a duplicate adapter idempotency key", async () => {
    const existingEffectId = createStableId("effect");
    const proposal = {
      effectId: createStableId("effect"),
      missionId: createStableId("mission"),
      projectId: createStableId("project"),
      type: "synthetic.write",
      adapterId: "synthetic",
      adapterVersion: "1.0.0",
      adapterAccountId: "test-account",
      target: { type: "record", externalId: "one", displayName: "One" },
      payload: { value: 1 },
      preview: "Write one synthetic record.",
      riskClass: "R1" as const,
      rationale: "Exercise idempotent persistence.",
      evidenceIds: [createStableId("evidence")],
      idempotencyKey: "synthetic:one",
      requiredPreconditions: [],
      verificationPlan: [{ type: "read", expected: { value: 1 } }],
      proposedByRunId: createStableId("run"),
    };
    const pool = new ScriptedPool([
      { rows: [], rowCount: 0 },
      {
        rows: [{
          effect_id: existingEffectId,
          state: "verified",
          proposal_digest: effectProposalDigest(proposal),
        }],
      },
    ]);
    const store = new PostgresEffectStore(pool);
    const recorded = await store.recordProposal(
      proposal,
      createStableId("provenance"),
    );

    assert.deepEqual(recorded, {
      effectId: existingEffectId,
      state: "verified",
      duplicate: true,
    });

    const divergentPool = new ScriptedPool([
      { rows: [], rowCount: 0 },
      {
        rows: [{
          effect_id: existingEffectId,
          state: "verified",
          proposal_digest: effectProposalDigest(proposal),
        }],
      },
    ]);
    await assert.rejects(
      new PostgresEffectStore(divergentPool).recordProposal(
        { ...proposal, payload: { value: 2 } },
        createStableId("provenance"),
      ),
      /aliases a different proposal/,
    );
  });

  it("begins effect execution behind the shared authority fence", async () => {
    const pool = new ScriptedPool([
      { rows: [] },
      { rows: [], rowCount: 1 },
    ]);
    await new PostgresEffectStore(pool).beginExecution({
      effectId: createStableId("effect"),
      leaseId: createStableId("lease"),
      ownerRunId: createStableId("run"),
      fencingToken: "1",
      preconditionEvaluationId: createStableId("executionPreconditionEvaluation"),
      transitionProvenanceId: createStableId("provenance"),
    });

    assert.equal(pool.queries[0]?.text, "BEGIN");
    assert.equal(
      pool.queries[1]?.text,
      "SELECT acp.acquire_effect_authority_lock()",
    );
    assert.equal(pool.queries.at(-1)?.text, "COMMIT");
  });

  it("refuses to unpause effects without an authorization reference", async () => {
    const pool = new ScriptedPool([]);
    const store = new PostgresControlStore(pool);
    await assert.rejects(
      store.setControl({
        controlEventId: createStableId("runtimeControlEvent"),
        scope: { type: "global", id: "global" },
        effectsPaused: false,
        reason: "Enable the approved synthetic adapter.",
        updatedBy: "operator:david",
        occurredAt: "2026-09-04T12:00:00Z",
        expectedUpdatedAt: "2026-09-04T11:00:00Z",
        provenanceId: createStableId("provenance"),
      }),
      /authorization reference/,
    );
    assert.equal(pool.queries.length, 0);
  });

  it("records an immutable exact-scope unpause authorization", async () => {
    const pool = new ScriptedPool([
      { rows: [] },
      { rows: [], rowCount: 1 },
    ]);
    const authorizationId = createStableId("runtimeControlAuthorization");
    await new PostgresControlStore(pool).recordAuthorization({
      authorizationId,
      scope: { type: "global", id: "global" },
      authorizedBy: "operator:david",
      reason: "Consistency checks passed.",
      validFrom: "2026-09-04T11:00:00.000Z",
      expiresAt: "2026-09-04T13:00:00.000Z",
      provenanceId: createStableId("provenance"),
    });

    assert.match(
      pool.queries[2]?.text ?? "",
      /INSERT INTO acp\.runtime_control_authorizations/u,
    );
    assert.equal(pool.queries[2]?.values[0], authorizationId);
  });

  it("records a control event before applying its single-use projection", async () => {
    const controlEventId = createStableId("runtimeControlEvent");
    const authorizationId = createStableId("runtimeControlAuthorization");
    const provenanceId = createStableId("provenance");
    const priorTime = new Date("2026-09-04T11:00:00.000Z");
    const pool = new ScriptedPool([
      { rows: [] },
      {
        rows: [{
          scope_type: "global",
          scope_id: "global",
          effects_paused: true,
          reason: "Initial safety default.",
          updated_by: "migration:0001",
          updated_at: priorTime,
          authorization_id: null,
        }],
      },
      { rows: [], rowCount: 1 },
      { rows: [{ set_config: controlEventId }] },
      { rows: [], rowCount: 1 },
    ]);

    await new PostgresControlStore(pool).setControl({
      controlEventId,
      scope: { type: "global", id: "global" },
      effectsPaused: false,
      reason: "Enable the approved synthetic adapter.",
      updatedBy: "operator:david",
      occurredAt: "2026-09-04T12:00:00.000Z",
      expectedUpdatedAt: priorTime.toISOString(),
      authorizationId,
      provenanceId,
    });

    const eventIndex = pool.queries.findIndex((query) =>
      query.text.includes("INSERT INTO acp.runtime_control_events"),
    );
    const updateIndex = pool.queries.findIndex((query) =>
      query.text.includes("UPDATE acp.runtime_controls"),
    );
    assert.ok(eventIndex > 0 && updateIndex > eventIndex);
    assert.equal(pool.queries[updateIndex]?.values.at(-1), controlEventId);
    assert.equal(pool.queries.at(-1)?.text, "COMMIT");
  });

  it("rejects a control event that does not advance the projection time", async () => {
    const priorTime = new Date("2026-09-04T12:00:00.000Z");
    const pool = new ScriptedPool([
      { rows: [] },
      {
        rows: [{
          scope_type: "global",
          scope_id: "global",
          effects_paused: true,
          reason: "Initial safety default.",
          updated_by: "migration:0001",
          updated_at: priorTime,
          authorization_id: null,
        }],
      },
    ]);

    await assert.rejects(
      new PostgresControlStore(pool).setControl({
        controlEventId: createStableId("runtimeControlEvent"),
        scope: { type: "global", id: "global" },
        effectsPaused: true,
        reason: "Reject a replayed event time.",
        updatedBy: "operator:david",
        occurredAt: priorTime.toISOString(),
        expectedUpdatedAt: priorTime.toISOString(),
        provenanceId: createStableId("provenance"),
      }),
      /advance monotonically/,
    );
    assert.equal(pool.queries.at(-1)?.text, "ROLLBACK");
  });

  it("rejects a verified receipt without read-back evidence", async () => {
    const pool = new ScriptedPool([]);
    await assert.rejects(
      new PostgresEffectStore(pool).recordReceipt({
        receiptId: createStableId("receipt"),
        effectId: createStableId("effect"),
        attemptNumber: 1,
        state: "verified",
        executionRecord: {},
        attemptedAt: "2026-09-04T12:00:00.000Z",
        provenanceId: createStableId("provenance"),
      }),
      /verification evidence and time/,
    );
    assert.equal(pool.queries.length, 0);
  });

  it("rejects a subscription replay with different mission identity", async () => {
    const subscriptionId = createStableId("subscription");
    const persistedMissionId = createStableId("mission");
    const nodeId = createStableId("node");
    const provenanceId = createStableId("provenance");
    const expiresAt = "2026-09-05T12:00:00.000Z";
    const semanticDigest = "sha256:approval-wait";
    const pool = new ScriptedPool([
      { rows: [], rowCount: 0 },
      {
        rows: [{
          state: "waiting",
          subscription_id: subscriptionId,
          mission_id: persistedMissionId,
          node_id: nodeId,
          expires_at: new Date(expiresAt),
          semantic_digest: semanticDigest,
          provenance_id: provenanceId,
        }],
      },
    ]);
    const store = new PostgresRuntimeStore(pool);
    await assert.rejects(
      store.updateSubscription({
        subscriptionId,
        missionId: createStableId("mission"),
        nodeId,
        dbosWorkflowId: "acp:mission:one",
        topic: "approval",
        state: "waiting",
        occurredAt: "2026-09-04T12:00:00Z",
        expiresAt,
        semanticDigest,
        provenanceId,
      }),
      /identity does not match/,
    );
    assert.equal(pool.queries.at(-1)?.text, "ROLLBACK");
  });

  it("accepts only an exact workflow-run identity on a duplicate insert", async () => {
    const run = {
      workflowExecutionId: createStableId("workflowExecution"),
      missionId: createStableId("mission"),
      dbosWorkflowId: "acp:mission:duplicate",
      workflowId: createStableId("workflow"),
      workflowVersion: "1.0.0",
      workflowBindingId: createStableId("workflowBinding"),
      dbosApplicationVersion: "sha256:worker",
      graphRevision: "sha256:graph",
      provenanceId: createStableId("provenance"),
    };
    const persisted = {
      workflow_execution_id: run.workflowExecutionId,
      mission_id: run.missionId,
      dbos_workflow_id: run.dbosWorkflowId,
      workflow_id: run.workflowId,
      workflow_version: run.workflowVersion,
      workflow_binding_id: run.workflowBindingId,
      dbos_application_version: run.dbosApplicationVersion,
      graph_revision: run.graphRevision,
      state: "running",
      provenance_id: run.provenanceId,
    };
    const exactPool = new ScriptedPool([
      { rows: [], rowCount: 0 },
      { rows: [persisted] },
    ]);

    assert.equal(
      await new PostgresRuntimeStore(exactPool).createWorkflowRun(run),
      false,
    );

    const divergentPool = new ScriptedPool([
      { rows: [], rowCount: 0 },
      { rows: [{ ...persisted, graph_revision: "sha256:different" }] },
    ]);
    await assert.rejects(
      new PostgresRuntimeStore(divergentPool).createWorkflowRun(run),
      /aliases a different persisted execution/,
    );
  });

  it("projects workflow cancellation atomically and replays it idempotently", async () => {
    const workflowExecutionId = createStableId("workflowExecution");
    const missionId = createStableId("mission");
    const eventId = createStableId("event");
    const provenanceId = createStableId("provenance");
    const occurredAt = "2026-09-04T12:00:00.000Z";
    const cancellation = {
      identity: {
        workflowExecutionId,
        missionId,
        dbosWorkflowId: "acp:mission:cancelled",
      },
      eventId,
      idempotencyKey: "acp:mission:cancelled:mission:cancelled",
      reason: "Operator cancelled delivery.",
      requestedBy: "operator:david",
      occurredAt,
      provenanceId,
    };
    const firstPool = new ScriptedPool([
      { rows: [{ state: "running" }] },
      { rows: [{ state: "executing" }] },
      { rows: [] },
      { rows: [], rowCount: 1 },
      { rows: [{ event_id: eventId }] },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);

    assert.deepEqual(
      await new PostgresRuntimeStore(firstPool).projectWorkflowCancellation(
        cancellation,
      ),
      {
        replayed: false,
        effectiveMissionState: "cancelled",
        effectiveWorkflowRunState: "cancelled",
      },
    );
    assert.equal(firstPool.queries.at(-1)?.text, "COMMIT");
    assert.match(
      firstPool.queries.find((query) =>
        query.text.includes("UPDATE acp.mission_workflow_runs"),
      )?.text ?? "",
      /transition_provenance_id/,
    );

    const replayPool = new ScriptedPool([
      { rows: [{ state: "cancelled" }] },
      { rows: [{ state: "cancelled" }] },
      {
        rows: [{
          event_id: eventId,
          event_digest: canonicalJsonDigest({
            eventVersion: "1.0.0",
            payload: {
              dbosWorkflowId: cancellation.identity.dbosWorkflowId,
              workflowExecutionId,
              reason: cancellation.reason,
              requestedBy: cancellation.requestedBy,
              effectiveMissionState: "cancelled",
              effectiveWorkflowRunState: "cancelled",
            },
            occurredAt,
            provenanceId,
          }),
        }],
      },
      { rows: [], rowCount: 0 },
    ]);
    assert.deepEqual(
      await new PostgresRuntimeStore(replayPool).projectWorkflowCancellation(
        cancellation,
      ),
      {
        replayed: true,
        effectiveMissionState: "cancelled",
        effectiveWorkflowRunState: "cancelled",
      },
    );
  });

  it("records a durable cancellation intent before DBOS cancellation", async () => {
    const pool = new ScriptedPool([{
      rows: [{ event_id: createStableId("event") }],
      rowCount: 1,
    }]);
    const target = {
      workflowExecutionId: createStableId("workflowExecution"),
      missionId: createStableId("mission"),
      dbosWorkflowId: "acp:mission:cancellation-intent",
      workflowVersion: "1.0.0",
      graphRevision: "sha256:graph",
      provenanceId: createStableId("provenance"),
    };
    const recorded = await new PostgresRuntimeStore(pool)
      .recordWorkflowCancellationIntent({
        target,
        eventId: createStableId("event"),
        idempotencyKey: `${target.dbosWorkflowId}:mission:cancellation-requested`,
        reason: "Operator requested cancellation.",
        requestedBy: "operator:david",
        occurredAt: "2026-09-04T12:00:00.000Z",
      });

    assert.equal(recorded, true);
    assert.match(pool.queries[0]?.text ?? "", /mission\.cancellation-requested/u);
  });

  it("preserves a terminal mission while projecting workflow cancellation", async () => {
    const workflowExecutionId = createStableId("workflowExecution");
    const missionId = createStableId("mission");
    const cancellation = {
      identity: {
        workflowExecutionId,
        missionId,
        dbosWorkflowId: "acp:mission:terminal-race",
      },
      eventId: createStableId("event"),
      idempotencyKey: "acp:mission:terminal-race:cancellation",
      reason: "Cancellation raced terminal failure.",
      requestedBy: "operator:david",
      occurredAt: "2026-09-04T12:00:00.000Z",
      provenanceId: createStableId("provenance"),
    };
    const pool = new ScriptedPool([
      { rows: [{ state: "running" }] },
      { rows: [{ state: "failed" }] },
      { rows: [] },
      { rows: [{ event_id: cancellation.eventId }] },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);

    assert.deepEqual(
      await new PostgresRuntimeStore(pool).projectWorkflowCancellation(cancellation),
      {
        replayed: false,
        effectiveMissionState: "failed",
        effectiveWorkflowRunState: "cancelled",
      },
    );
    assert.equal(
      pool.queries.some((query) => query.text.includes("UPDATE acp.missions")),
      false,
    );
    assert.equal(pool.queries.at(-1)?.text, "COMMIT");
  });

  it("preserves terminal workflow and mission winners during cancellation races", async () => {
    const cancellation = {
      identity: {
        workflowExecutionId: createStableId("workflowExecution"),
        missionId: createStableId("mission"),
        dbosWorkflowId: "acp:mission:terminal-workflow-race",
      },
      eventId: createStableId("event"),
      idempotencyKey: "acp:mission:terminal-workflow-race:cancellation",
      reason: "DBOS cancellation raced ACP failure persistence.",
      requestedBy: "operator:david",
      occurredAt: "2026-09-04T12:00:00.000Z",
      provenanceId: createStableId("provenance"),
    };
    const pool = new ScriptedPool([
      { rows: [{ state: "error" }] },
      { rows: [{ state: "failed" }] },
      { rows: [] },
      { rows: [{ event_id: cancellation.eventId }] },
      { rows: [], rowCount: 1 },
    ]);

    assert.deepEqual(
      await new PostgresRuntimeStore(pool).projectWorkflowCancellation(cancellation),
      {
        replayed: false,
        effectiveMissionState: "failed",
        effectiveWorkflowRunState: "error",
      },
    );
    assert.equal(
      pool.queries.some((query) => query.text.includes("UPDATE acp.missions")),
      false,
    );
    assert.equal(
      pool.queries.some((query) => query.text.includes("UPDATE acp.mission_workflow_runs")),
      false,
    );
    assert.equal(pool.queries.at(-1)?.text, "COMMIT");
  });

  it("projects and idempotently replays an ordinary DBOS terminal failure", async () => {
    const target = {
      workflowExecutionId: createStableId("workflowExecution"),
      missionId: createStableId("mission"),
      dbosWorkflowId: "acp:mission:dbos-error",
      workflowVersion: "1.0.0",
      graphRevision: "sha256:graph",
      provenanceId: createStableId("provenance"),
    };
    const failure = {
      target,
      dbosApplicationVersion: "sha256:worker-v1",
      dbosStatus: "ERROR" as const,
      eventId: createStableId("event"),
      idempotencyKey: `${target.dbosWorkflowId}:mission:workflow-error`,
      occurredAt: "2026-09-04T12:00:00.000Z",
    };
    const persistedRun = {
      state: "running",
      workflow_version: target.workflowVersion,
      dbos_application_version: failure.dbosApplicationVersion,
      graph_revision: target.graphRevision,
      provenance_id: target.provenanceId,
    };
    const firstPool = new ScriptedPool([
      { rows: [persistedRun] },
      { rows: [{ state: "executing" }] },
      { rows: [] },
      { rows: [], rowCount: 1 },
      { rows: [{ event_id: failure.eventId }], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);

    assert.deepEqual(
      await new PostgresRuntimeStore(firstPool).projectWorkflowTerminalFailure(
        failure,
      ),
      {
        replayed: false,
        effectiveMissionState: "failed",
        effectiveWorkflowRunState: "error",
      },
    );
    assert.ok(firstPool.queries.some((query) =>
      query.text.includes("mission.workflow-error") ||
      query.values.includes("mission.workflow-error")
    ));

    const eventDigest = canonicalJsonDigest({
      eventVersion: "1.0.0",
      payload: {
        dbosWorkflowId: target.dbosWorkflowId,
        workflowExecutionId: target.workflowExecutionId,
        dbosApplicationVersion: failure.dbosApplicationVersion,
        dbosStatus: failure.dbosStatus,
        recoveryAttempts: 0,
        effectiveMissionState: "failed",
        effectiveWorkflowRunState: "error",
      },
      occurredAt: failure.occurredAt,
      provenanceId: target.provenanceId,
    });
    const replayPool = new ScriptedPool([
      { rows: [{ ...persistedRun, state: "error" }] },
      { rows: [{ state: "failed" }] },
      { rows: [{ event_id: failure.eventId, event_digest: eventDigest }] },
      { rows: [], rowCount: 0 },
    ]);
    assert.deepEqual(
      await new PostgresRuntimeStore(replayPool).projectWorkflowTerminalFailure(
        failure,
      ),
      {
        replayed: true,
        effectiveMissionState: "failed",
        effectiveWorkflowRunState: "error",
      },
    );
  });

  it("preserves terminal ACP winners while recording a DBOS terminal failure", async () => {
    const target = {
      workflowExecutionId: createStableId("workflowExecution"),
      missionId: createStableId("mission"),
      dbosWorkflowId: "acp:mission:dbos-error-race",
      workflowVersion: "1.0.0",
      graphRevision: "sha256:graph",
      provenanceId: createStableId("provenance"),
    };
    const failure = {
      target,
      dbosApplicationVersion: "sha256:worker-v1",
      dbosStatus: "ERROR" as const,
      eventId: createStableId("event"),
      idempotencyKey: `${target.dbosWorkflowId}:mission:workflow-error`,
      occurredAt: "2026-09-04T12:00:00.000Z",
    };
    const pool = new ScriptedPool([
      {
        rows: [{
          state: "success",
          workflow_version: target.workflowVersion,
          dbos_application_version: failure.dbosApplicationVersion,
          graph_revision: target.graphRevision,
          provenance_id: target.provenanceId,
        }],
      },
      { rows: [{ state: "complete_for_scope" }] },
      { rows: [] },
      { rows: [{ event_id: failure.eventId }], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);

    assert.deepEqual(
      await new PostgresRuntimeStore(pool).projectWorkflowTerminalFailure(failure),
      {
        replayed: false,
        effectiveMissionState: "complete_for_scope",
        effectiveWorkflowRunState: "success",
      },
    );
    assert.equal(
      pool.queries.some((query) => query.text.includes("UPDATE acp.missions")),
      false,
    );
    assert.equal(
      pool.queries.some((query) =>
        query.text.includes("UPDATE acp.mission_workflow_runs"),
      ),
      false,
    );
  });
});

function result<R extends QueryResultRow>(
  rows: readonly QueryResultRow[],
  rowCount = rows.length,
): QueryResult<R> {
  return {
    command: "",
    rowCount,
    oid: 0,
    fields: [],
    rows: rows as R[],
  };
}
