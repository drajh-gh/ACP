import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import { canonicalJsonDigest, createStableId } from "@acp/domain";
import type { Pool, QueryResult, QueryResultRow } from "pg";

import {
  createPostgresIssueDeliveryMaintenance,
  createPostgresIssueDeliverySubmitter,
} from "../src/postgres-dependencies.ts";
import {
  issueDeliveryWorkflowName,
  type IssueDeliveryController,
  type IssueDeliveryInput,
} from "../src/issue-delivery.ts";

type Response = {
  readonly rows?: readonly QueryResultRow[];
  readonly rowCount?: number;
};

class ScriptedPool {
  readonly queries: string[] = [];
  readonly values: unknown[][] = [];
  private readonly responses: Response[];

  constructor(responses: Response[]) {
    this.responses = responses;
  }

  async connect(): Promise<this> {
    return this;
  }

  release(): void {}

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<R>> {
    this.queries.push(text);
    this.values.push([...values]);
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
      return result<R>([]);
    }
    const response = this.responses.shift();
    if (response === undefined) throw new Error(`No scripted response for ${text}`);
    return result<R>(response.rows ?? [], response.rowCount);
  }
}

function input(): IssueDeliveryInput {
  return {
    missionId: createStableId("mission"),
    approvalNodeId: createStableId("node"),
    approvalSubscriptionId: createStableId("subscription"),
    workflowExecutionId: createStableId("workflowExecution"),
    dbosWorkflowId: "acp:mission:cancellation-test",
    workflowVersion: "1.0.0",
    graphRevision: "sha256:graph",
    provenanceId: createStableId("provenance"),
    approvalExpiresAt: "2026-09-05T12:00:00.000Z",
  };
}

function dbosStatus(
  workflowInput: IssueDeliveryInput,
  status = "PENDING",
  applicationVersion = "sha256:worker",
) {
  return {
    workflowID: workflowInput.dbosWorkflowId,
    workflowName: issueDeliveryWorkflowName,
    applicationName: "acp-worker",
    applicationVersion,
    input: [workflowInput],
    status,
    createdAt: Date.parse("2026-09-04T12:00:00.000Z"),
  };
}

function persistedRun(
  workflowInput: IssueDeliveryInput,
  state = "running",
  dbosApplicationVersion = "sha256:worker",
) {
  return {
    workflow_execution_id: workflowInput.workflowExecutionId,
    mission_id: workflowInput.missionId,
    dbos_workflow_id: workflowInput.dbosWorkflowId,
    workflow_version: workflowInput.workflowVersion,
    dbos_application_version: dbosApplicationVersion,
    graph_revision: workflowInput.graphRevision,
    provenance_id: workflowInput.provenanceId,
    state,
  };
}

function runtimeHello(workflowId = createStableId("workflow")) {
  return {
    protocolVersion: "1.0.0",
    apiVersion: "1.0.0",
    workerImplementationVersion: "1.0.0",
    databaseSchemaVersion: "0002",
    workflowVersions: [{ workflowId, version: "1.0.0" }],
  };
}

function cancellation(workflowInput: IssueDeliveryInput) {
  return {
    input: workflowInput,
    eventId: createStableId("event"),
    reason: "Operator cancelled delivery.",
    requestedBy: "operator:david",
    occurredAt: "2026-09-04T12:00:00.000Z",
  };
}

describe("PostgreSQL DBOS submission and cancellation", () => {
  it("does not cancel when DBOS input aliases another mission", async () => {
    const workflowInput = input();
    let cancellationCalls = 0;
    const dbosClient = {
      getWorkflow: async () => dbosStatus({
        ...workflowInput,
        missionId: createStableId("mission"),
      }),
      cancelWorkflow: async () => { cancellationCalls += 1; },
    } as unknown as DBOSClient;
    const pool = new ScriptedPool([{ rows: [persistedRun(workflowInput)] }]);
    const controller = createPostgresIssueDeliverySubmitter({
      pool: pool as unknown as Pool,
      dbosClient,
      dbosApplicationVersion: "sha256:worker",
      runtimeHello: runtimeHello(),
    });

    await assert.rejects(
      controller.cancel(cancellation(workflowInput)),
      /aliases a different workflow execution/,
    );
    assert.equal(cancellationCalls, 0);
    assert.equal(pool.queries.length, 1);
  });

  it("does not cancel when the exact ACP run is absent", async () => {
    const workflowInput = input();
    let cancellationCalls = 0;
    const dbosClient = {
      getWorkflow: async () => dbosStatus(workflowInput),
      cancelWorkflow: async () => { cancellationCalls += 1; },
    } as unknown as DBOSClient;
    const pool = new ScriptedPool([{ rows: [] }]);
    const controller = createPostgresIssueDeliverySubmitter({
      pool: pool as unknown as Pool,
      dbosClient,
      dbosApplicationVersion: "sha256:worker",
      runtimeHello: runtimeHello(),
    });

    await assert.rejects(
      controller.cancel(cancellation(workflowInput)),
      /does not match the persisted workflow run/,
    );
    assert.equal(cancellationCalls, 0);
  });

  it("does not record stop authority for a rejected cancellation of a successful workflow", async () => {
    const workflowInput = input();
    const pool = new ScriptedPool([{ rows: [persistedRun(workflowInput, "running")] }]);
    const controller = createPostgresIssueDeliverySubmitter({ pool: pool as unknown as Pool,
      dbosClient: { getWorkflow: async () => dbosStatus(workflowInput, "SUCCESS"),
        cancelWorkflow: async () => { throw new Error("must not cancel"); } } as unknown as DBOSClient,
      dbosApplicationVersion: "sha256:worker", runtimeHello: runtimeHello() });
    await assert.rejects(controller.cancel(cancellation(workflowInput)), /cannot be cancelled/);
    assert.ok(!pool.queries.some((query) => query.includes("mission.cancellation-requested")));
  });

  it("cancellation reconciliation requires durable DBOS cancellation before recording intent", async () => {
    const workflowInput = input();
    const pool = new ScriptedPool([{ rows: [persistedRun(workflowInput, "running")] }]);
    const controller = createPostgresIssueDeliverySubmitter({ pool: pool as unknown as Pool,
      dbosClient: { getWorkflow: async () => dbosStatus(workflowInput, "PENDING") } as unknown as DBOSClient,
      dbosApplicationVersion: "sha256:worker", runtimeHello: runtimeHello() });
    await assert.rejects(controller.reconcileCancellation(cancellation(workflowInput)), /not durable/);
    assert.ok(!pool.queries.some((query) => query.includes("mission.cancellation-requested")));
  });

  it("cancels children only after exact identity checks and projects the result", async () => {
    const workflowInput = input();
    const statuses = [
      dbosStatus(workflowInput, "PENDING", "sha256:worker-v1"),
      dbosStatus(workflowInput, "CANCELLED", "sha256:worker-v1"),
    ];
    const cancellationOptions: unknown[] = [];
    const dbosClient = {
      getWorkflow: async () => statuses.shift(),
      cancelWorkflow: async (_id: string, options: unknown) => {
        cancellationOptions.push(options);
      },
    } as unknown as DBOSClient;
    const storedRun = persistedRun(workflowInput, "running", "sha256:worker-v1");
    const pool = new ScriptedPool([
      { rows: [storedRun] },
      { rows: [{ event_id: createStableId("event") }], rowCount: 1 },
      { rows: [storedRun] },
      { rows: [{ state: "executing" }] },
      { rows: [] },
      { rows: [], rowCount: 1 },
      { rows: [{ event_id: createStableId("event") }] },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    const controller = createPostgresIssueDeliverySubmitter({
      pool: pool as unknown as Pool,
      dbosClient,
      dbosApplicationVersion: "sha256:worker-v2",
      runtimeHello: runtimeHello(),
    });

    await controller.cancel(cancellation(workflowInput));
    assert.deepEqual(cancellationOptions, [{ cancelChildren: true }]);
    assert.ok(pool.queries.some((query) => query.includes("mission.cancellation-requested")));
    assert.ok(pool.queries.some((query) => query.includes("mission.cancellation-recorded")));
  });

  it("reconciles an idempotent DBOS cancellation retry without overwriting terminal ACP state", async () => {
    const workflowInput = input();
    const statuses = [
      dbosStatus(workflowInput, "CANCELLED"),
      dbosStatus(workflowInput, "CANCELLED"),
    ];
    let cancellationCalls = 0;
    const dbosClient = {
      getWorkflow: async () => statuses.shift(),
      cancelWorkflow: async () => { cancellationCalls += 1; },
    } as unknown as DBOSClient;
    const storedRun = persistedRun(workflowInput, "error");
    const pool = new ScriptedPool([
      { rows: [storedRun] },
      { rows: [{ event_id: createStableId("event") }], rowCount: 1 },
      { rows: [storedRun] },
      { rows: [{ state: "failed" }] },
      { rows: [] },
      { rows: [{ event_id: createStableId("event") }], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
    const controller = createPostgresIssueDeliverySubmitter({
      pool: pool as unknown as Pool,
      dbosClient,
      dbosApplicationVersion: "sha256:worker",
      runtimeHello: runtimeHello(),
    });

    await controller.cancel(cancellation(workflowInput));

    assert.equal(cancellationCalls, 0);
    assert.ok(pool.queries.some((query) => query.includes("mission.cancellation-recorded")));
    assert.ok(!pool.queries.some((query) => query.includes("UPDATE acp.mission_workflow_runs")));
    assert.equal(pool.queries.at(-1), "COMMIT");
  });

  it("retrieves a duplicate workflow pinned to an older application version", async () => {
    const workflowInput = input();
    const handle = { getResult: async () => ({ status: "succeeded" }) };
    let enqueueCalls = 0;
    const dbosClient = {
      getWorkflow: async () => dbosStatus(
        workflowInput,
        "PENDING",
        "sha256:worker-v1",
      ),
      retrieveWorkflow: () => handle,
      enqueueInTransaction: async () => {
        enqueueCalls += 1;
        return handle;
      },
    } as unknown as DBOSClient;
    const pool = new ScriptedPool([
      { rows: [] },
      { rows: [persistedRun(workflowInput, "running", "sha256:worker-v1")] },
    ]);
    const controller = createPostgresIssueDeliverySubmitter({
      pool: pool as unknown as Pool,
      dbosClient,
      dbosApplicationVersion: "sha256:worker-v2",
      runtimeHello: runtimeHello(),
    });

    const retrieved = await controller.submit(workflowInput);

    assert.equal(retrieved, handle);
    assert.equal(enqueueCalls, 0);
    assert.equal(pool.queries.at(-1), "COMMIT");
  });

  it("projects DBOS recovery exhaustion as failure and refuses cancellation", async () => {
    const workflowInput = input();
    let cancellationCalls = 0;
    const dbosClient = {
      getWorkflow: async () => ({
        ...dbosStatus(workflowInput, "MAX_RECOVERY_ATTEMPTS_EXCEEDED"),
        recoveryAttempts: 10,
      }),
      cancelWorkflow: async () => { cancellationCalls += 1; },
    } as unknown as DBOSClient;
    const storedRun = persistedRun(workflowInput, "running");
    const pool = new ScriptedPool([
      { rows: [storedRun] },
      { rows: [storedRun] },
      { rows: [{ state: "executing" }] },
      { rows: [] },
      { rows: [], rowCount: 1 },
      { rows: [{ event_id: createStableId("event") }], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    const controller = createPostgresIssueDeliverySubmitter({
      pool: pool as unknown as Pool,
      dbosClient,
      dbosApplicationVersion: "sha256:worker",
      runtimeHello: runtimeHello(),
    });

    await assert.rejects(
      controller.cancel(cancellation(workflowInput)),
      /exhausted its recovery attempts/,
    );

    assert.equal(cancellationCalls, 0);
    assert.ok(!pool.queries.some((query) => query.includes("mission.cancellation-requested")));
    assert.ok(pool.values.some((values) =>
      values.includes("mission.workflow-recovery-exhausted"),
    ));
    assert.ok(pool.queries.some((query) => query.includes("SET state = 'error'")));
    assert.equal(pool.queries.at(-1), "COMMIT");
  });

  it("projects an ordinary DBOS error as failure and refuses cancellation", async () => {
    const workflowInput = input();
    let cancellationCalls = 0;
    const dbosClient = {
      getWorkflow: async () => dbosStatus(workflowInput, "ERROR"),
      cancelWorkflow: async () => { cancellationCalls += 1; },
    } as unknown as DBOSClient;
    const storedRun = persistedRun(workflowInput, "running");
    const pool = new ScriptedPool([
      { rows: [storedRun] },
      { rows: [storedRun] },
      { rows: [{ state: "executing" }] },
      { rows: [] },
      { rows: [], rowCount: 1 },
      { rows: [{ event_id: createStableId("event") }], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    const controller = createPostgresIssueDeliverySubmitter({
      pool: pool as unknown as Pool,
      dbosClient,
      dbosApplicationVersion: "sha256:worker",
      runtimeHello: runtimeHello(),
    });

    await assert.rejects(
      controller.cancel(cancellation(workflowInput)),
      /terminal DBOS workflow failed/,
    );

    assert.equal(cancellationCalls, 0);
    assert.ok(!pool.queries.some((query) => query.includes("mission.cancellation-requested")));
    assert.ok(pool.values.some((values) => values.includes("mission.workflow-error")));
    assert.ok(pool.queries.some((query) => query.includes("SET state = 'error'")));
    assert.equal(pool.queries.at(-1), "COMMIT");
  });

  it("repairs a partial DBOS failure whose ACP run is already error", async () => {
    const workflowInput = input();
    let cancellationCalls = 0;
    const dbosClient = {
      getWorkflow: async () => dbosStatus(workflowInput, "ERROR"),
      cancelWorkflow: async () => { cancellationCalls += 1; },
    } as unknown as DBOSClient;
    const storedRun = persistedRun(workflowInput, "error");
    const pool = new ScriptedPool([
      {
        rows: [{
          workflow_execution_id: workflowInput.workflowExecutionId,
          dbos_workflow_id: workflowInput.dbosWorkflowId,
        }],
      },
      { rows: [storedRun] },
      { rows: [storedRun] },
      { rows: [{ state: "executing" }] },
      { rows: [] },
      { rows: [], rowCount: 1 },
      { rows: [{ event_id: createStableId("event") }], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [] },
    ]);
    const controller = createPostgresIssueDeliverySubmitter({
      pool: pool as unknown as Pool,
      dbosClient,
      dbosApplicationVersion: "sha256:worker",
      runtimeHello: runtimeHello(),
    });
    const maintenance = createPostgresIssueDeliveryMaintenance({
      pool: pool as unknown as Pool,
      dbosClient,
      controller,
      batchSize: 25,
    });

    assert.deepEqual(await maintenance.reconcileWorkflows(), {
      reconciled: 1,
      errors: [],
    });
    assert.equal(cancellationCalls, 0);
    assert.ok(pool.values.some((values) => values.includes("mission.workflow-error")));
    assert.ok(pool.queries.some((query) => query.includes("UPDATE acp.missions")));
    assert.ok(pool.queries.some((query) => query.includes("run.state = 'error'")));
    assert.match(pool.queries[0] ?? "", /state IN \('pending', 'running'\)/u);
  });

  it("advances bounded reconciliation past nonterminal workflows", async () => {
    const first = input();
    const second: IssueDeliveryInput = {
      ...input(),
      dbosWorkflowId: "acp:mission:later-terminal",
    };
    const reconciled: IssueDeliveryInput[] = [];
    const dbosClient = {
      getWorkflow: async (workflowId: string) => workflowId === first.dbosWorkflowId
        ? dbosStatus(first, "PENDING")
        : dbosStatus(second, "ERROR"),
    } as unknown as DBOSClient;
    const controller = {
      reconcileStatus: async (candidate: IssueDeliveryInput) => {
        reconciled.push(candidate);
      },
    } as unknown as IssueDeliveryController;
    const pool = new ScriptedPool([
      {
        rows: [{
          workflow_execution_id: first.workflowExecutionId,
          dbos_workflow_id: first.dbosWorkflowId,
        }],
      },
      { rows: [] },
      {
        rows: [{
          workflow_execution_id: second.workflowExecutionId,
          dbos_workflow_id: second.dbosWorkflowId,
        }],
      },
      { rows: [] },
    ]);
    const maintenance = createPostgresIssueDeliveryMaintenance({
      pool: pool as unknown as Pool,
      dbosClient,
      controller,
      batchSize: 1,
    });

    assert.deepEqual(await maintenance.reconcileWorkflows(), {
      reconciled: 0,
      errors: [],
    });
    assert.deepEqual(await maintenance.reconcileWorkflows(), {
      reconciled: 1,
      errors: [],
    });
    assert.deepEqual(reconciled, [second]);
  });

  it("isolates a poisoned item without starving later reconciliation", async () => {
    const poisoned = input();
    const valid: IssueDeliveryInput = {
      ...input(),
      dbosWorkflowId: "acp:mission:valid-after-poison",
    };
    const reconciled: IssueDeliveryInput[] = [];
    const dbosClient = {
      getWorkflow: async (workflowId: string) => workflowId === poisoned.dbosWorkflowId
        ? { ...dbosStatus(poisoned, "ERROR"), input: [] }
        : dbosStatus(valid, "ERROR"),
    } as unknown as DBOSClient;
    const controller = {
      reconcileStatus: async (candidate: IssueDeliveryInput) => {
        reconciled.push(candidate);
      },
    } as unknown as IssueDeliveryController;
    const batch = [
      {
        workflow_execution_id: poisoned.workflowExecutionId,
        dbos_workflow_id: poisoned.dbosWorkflowId,
      },
      {
        workflow_execution_id: valid.workflowExecutionId,
        dbos_workflow_id: valid.dbosWorkflowId,
      },
    ];
    const pool = new ScriptedPool([
      { rows: batch },
      { rows: [] },
      { rows: [] },
      { rows: batch },
      { rows: [] },
    ]);
    const maintenance = createPostgresIssueDeliveryMaintenance({
      pool: pool as unknown as Pool,
      dbosClient,
      controller,
      batchSize: 2,
    });

    const first = await maintenance.reconcileWorkflows();
    const second = await maintenance.reconcileWorkflows();
    assert.equal(first.reconciled, 1);
    assert.equal(first.errors.length, 1);
    assert.match(first.errors[0]?.message ?? "", /poisoned item|terminal workflow/u);
    assert.equal(second.reconciled, 1);
    assert.equal(second.errors.length, 1);
    assert.deepEqual(reconciled, [valid, valid]);
  });

  it("reconciles a durable cancellation intent after DBOS already cancelled", async () => {
    const workflowInput = input();
    const occurredAt = "2026-09-04T12:00:00.000Z";
    const intentEventId = createStableId("event");
    const intentPayload = {
      dbosWorkflowId: workflowInput.dbosWorkflowId,
      workflowExecutionId: workflowInput.workflowExecutionId,
      workflowVersion: workflowInput.workflowVersion,
      graphRevision: workflowInput.graphRevision,
      reason: "Operator cancelled delivery.",
      requestedBy: "operator:david",
    };
    const intentDigest = canonicalJsonDigest({
      eventVersion: "1.0.0",
      payload: intentPayload,
      occurredAt,
      provenanceId: workflowInput.provenanceId,
    });
    let cancellationCalls = 0;
    const dbosClient = {
      getWorkflow: async () => dbosStatus(workflowInput, "CANCELLED"),
      cancelWorkflow: async () => { cancellationCalls += 1; },
    } as unknown as DBOSClient;
    const storedRun = persistedRun(workflowInput, "running");
    const pool = new ScriptedPool([
      { rows: [] },
      {
        rows: [{
          intent_event_id: intentEventId,
          mission_id: workflowInput.missionId,
          payload: intentPayload,
          occurred_at: new Date(occurredAt),
          provenance_id: workflowInput.provenanceId,
          dbos_workflow_id: workflowInput.dbosWorkflowId,
        }],
      },
      { rows: [storedRun] },
      { rows: [], rowCount: 0 },
      { rows: [{ event_id: intentEventId, event_digest: intentDigest }] },
      { rows: [storedRun] },
      { rows: [{ state: "executing" }] },
      { rows: [] },
      { rows: [], rowCount: 1 },
      { rows: [{ event_id: createStableId("event") }], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    const controller = createPostgresIssueDeliverySubmitter({
      pool: pool as unknown as Pool,
      dbosClient,
      dbosApplicationVersion: "sha256:worker",
      runtimeHello: runtimeHello(),
    });
    const maintenance = createPostgresIssueDeliveryMaintenance({
      pool: pool as unknown as Pool,
      dbosClient,
      controller,
    });

    assert.deepEqual(await maintenance.reconcileWorkflows(), {
      reconciled: 1,
      errors: [],
    });
    assert.equal(cancellationCalls, 0);
    assert.ok(pool.queries.some((query) => query.includes("mission.cancellation-recorded")));
    assert.equal(pool.queries.at(-1), "COMMIT");
  });

  it("does not enqueue a workflow for a non-runnable mission", async () => {
    const workflowInput = input();
    const workflowId = createStableId("workflow");
    let enqueueCalls = 0;
    const dbosClient = {
      enqueueInTransaction: async () => {
        enqueueCalls += 1;
        return {};
      },
    } as unknown as DBOSClient;
    const pool = new ScriptedPool([
      { rows: [] },
      { rows: [] },
      { rows: [{
        workflow_id: workflowId,
        workflow_version: workflowInput.workflowVersion,
        api_version: "1.0.0",
        worker_implementation_version: "1.0.0",
        database_schema_version: "0002",
      }] },
      { rows: [{ version: "0002" }] },
      { rows: [], rowCount: 0 },
    ]);
    const controller = createPostgresIssueDeliverySubmitter({
      pool: pool as unknown as Pool,
      dbosClient,
      dbosApplicationVersion: "sha256:worker",
      runtimeHello: runtimeHello(workflowId),
    });

    await assert.rejects(
      controller.submit(workflowInput),
      /binding does not match submission/,
    );
    assert.equal(enqueueCalls, 0);
    assert.equal(pool.queries.at(-1), "ROLLBACK");
    assert.ok(pool.queries.some((query) => query.includes("mission.state IN ('ready', 'planning')")));
  });

  it("fails closed before projection or enqueue when runtime versions are incompatible", async () => {
    const workflowInput = input();
    const workflowId = createStableId("workflow");
    let enqueueCalls = 0;
    const dbosClient = {
      enqueueInTransaction: async () => {
        enqueueCalls += 1;
        return {};
      },
    } as unknown as DBOSClient;
    const pool = new ScriptedPool([
      { rows: [] },
      { rows: [] },
      { rows: [{
        workflow_id: workflowId,
        workflow_version: workflowInput.workflowVersion,
        api_version: "1.0.0",
        worker_implementation_version: "0.9.0",
        database_schema_version: "0002",
      }] },
      { rows: [{ version: "0002" }] },
    ]);
    const controller = createPostgresIssueDeliverySubmitter({
      pool: pool as unknown as Pool,
      dbosClient,
      dbosApplicationVersion: "sha256:worker",
      runtimeHello: runtimeHello(workflowId),
    });

    await assert.rejects(
      controller.submit(workflowInput),
      /worker_implementation_version_mismatch/,
    );

    assert.equal(enqueueCalls, 0);
    assert.equal(pool.queries.at(-1), "ROLLBACK");
    assert.ok(!pool.queries.some((query) => query.includes("INSERT INTO acp.mission_workflow_runs")));
  });
});

function result<R extends QueryResultRow>(
  rows: readonly QueryResultRow[],
  rowCount = rows.length,
): QueryResult<R> {
  return {
    command: "TEST",
    rowCount,
    oid: 0,
    fields: [],
    rows: rows as R[],
  };
}
