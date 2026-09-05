import { DBOSClient, type WorkflowHandle } from "@dbos-inc/dbos-sdk";
import {
  assessRuntimeCompatibility,
  createStableId,
  parseRuntimeHello,
  type RuntimeHello,
  type StableId,
} from "@acp/domain";
import {
  PostgresEffectStore,
  PostgresMissionStore,
  PostgresRuntimeStore,
} from "@acp/storage";
import type { Pool, QueryResultRow } from "pg";

import type {
  DeliveryNodeResult,
  IssueDeliveryDependencies,
  IssueDeliveryController,
  IssueDeliveryInput,
} from "./issue-delivery.ts";
import {
  approvalSubscriptionSemanticDigest,
  issueDeliveryWorkflowName,
  missionControlQueueName,
  parseIssueDeliveryCancellation,
  parseIssueDeliveryInput,
} from "./issue-delivery.ts";

export interface PostgresDependencyOptions {
  readonly missionStore: PostgresMissionStore;
  readonly runtimeStore: PostgresRuntimeStore;
  readonly effectStore: PostgresEffectStore;
  readonly executeDeliveryNode: (
    input: IssueDeliveryInput,
    context: { readonly abortSignal: AbortSignal },
  ) => Promise<DeliveryNodeResult>;
}

export interface PostgresIssueDeliverySubmitterOptions {
  readonly pool: Pool;
  readonly dbosClient: DBOSClient;
  readonly dbosApplicationVersion: string;
  readonly runtimeHello: RuntimeHello;
}

interface WorkflowSubmissionRow extends QueryResultRow {
  readonly workflow_execution_id: StableId<"workflowExecution">;
  readonly mission_id: StableId<"mission">;
  readonly dbos_workflow_id: string;
  readonly workflow_version: string;
  readonly dbos_application_version: string;
  readonly graph_revision: string;
  readonly provenance_id: StableId<"provenance">;
}

interface RuntimeAdmissionRow extends QueryResultRow {
  readonly workflow_id: StableId<"workflow">;
  readonly workflow_version: string;
  readonly api_version: string;
  readonly worker_implementation_version: string;
  readonly database_schema_version: string;
}

interface MigrationVersionRow extends QueryResultRow {
  readonly version: string;
}

interface ActiveWorkflowReconciliationRow extends QueryResultRow {
  readonly workflow_execution_id: StableId<"workflowExecution">;
  readonly dbos_workflow_id: string;
}

interface CancellationIntentRow extends QueryResultRow {
  readonly intent_event_id: StableId<"event">;
  readonly mission_id: StableId<"mission">;
  readonly payload: unknown;
  readonly occurred_at: Date;
  readonly provenance_id: StableId<"provenance">;
  readonly dbos_workflow_id: string;
}

export interface PostgresIssueDeliveryMaintenanceOptions {
  readonly pool: Pool;
  readonly dbosClient: DBOSClient;
  readonly controller: IssueDeliveryController;
  readonly batchSize?: number;
}

export interface IssueDeliveryMaintenance {
  reconcileWorkflows(): Promise<WorkflowReconciliationResult>;
}

export interface WorkflowReconciliationResult {
  readonly reconciled: number;
  readonly errors: readonly Error[];
}

export function createPostgresIssueDeliveryDependencies(
  options: PostgresDependencyOptions,
): IssueDeliveryDependencies {
  return {
    executeDeliveryNode: options.executeDeliveryNode,
    async resolveApproval(request): Promise<boolean> {
      return options.effectStore.authorizeFromPersistedApproval(
        request.effectId,
        request.approvalId,
        request.input.missionId,
        request.input.provenanceId,
      );
    },
    async persistWorkflowState(update): Promise<void> {
      await options.runtimeStore.setWorkflowRunState(
        {
          workflowExecutionId: update.input.workflowExecutionId,
          missionId: update.input.missionId,
          dbosWorkflowId: update.input.dbosWorkflowId,
        },
        update.state,
        new Date().toISOString(),
        update.input.provenanceId,
      );
    },
    async persistMissionState(update): Promise<void> {
      const mission = await options.missionStore.getMission(update.input.missionId);
      if (mission === undefined) throw new Error("mission does not exist");
      await options.missionStore.transitionMission({
        missionId: update.input.missionId,
        expectedState: mission.state,
        nextState: update.state,
        event: {
          eventId: update.eventId,
          missionId: update.input.missionId,
          eventType: `mission.${update.state}`,
          eventVersion: "1.0.0",
          idempotencyKey: update.idempotencyKey,
          payload: {
            dbosWorkflowId: update.input.dbosWorkflowId,
            workflowExecutionId: update.input.workflowExecutionId,
          },
          occurredAt: update.occurredAt,
          provenanceId: update.input.provenanceId,
        },
      });
    },
    async persistSubscription(update): Promise<void> {
      await options.runtimeStore.updateSubscription({
        subscriptionId: update.input.approvalSubscriptionId,
        missionId: update.input.missionId,
        nodeId: update.input.approvalNodeId,
        dbosWorkflowId: update.input.dbosWorkflowId,
        topic: update.topic,
        state: update.state,
        occurredAt: new Date().toISOString(),
        expiresAt: update.input.approvalExpiresAt,
        semanticDigest: approvalSubscriptionSemanticDigest(
          update.input,
          update.topic,
        ),
        provenanceId: update.input.provenanceId,
      });
    },
  };
}

export function createPostgresIssueDeliverySubmitter(
  options: PostgresIssueDeliverySubmitterOptions,
): IssueDeliveryController {
  const runtimeStore = new PostgresRuntimeStore(options.pool);
  const runtimeHello = parseRuntimeHello(options.runtimeHello);

  return {
    async submit(submittedInput): Promise<WorkflowHandle<DeliveryNodeResult>> {
      const input = parseIssueDeliveryInput(submittedInput);
      const connection = await options.pool.connect();
      try {
        await connection.query("BEGIN");
        await connection.query(
          "SELECT pg_advisory_xact_lock(hashtext($1))",
          [input.dbosWorkflowId],
        );
        const existing = await connection.query<WorkflowSubmissionRow>(
          `SELECT workflow_execution_id, mission_id, dbos_workflow_id,
                  workflow_version, dbos_application_version, graph_revision,
                  provenance_id
           FROM acp.mission_workflow_runs
           WHERE dbos_workflow_id = $1
           FOR UPDATE`,
          [input.dbosWorkflowId],
        );
        if (existing.rows[0] !== undefined) {
          assertSubmissionMatches(existing.rows[0], input);
          const dbosStatus = await options.dbosClient.getWorkflow(
            input.dbosWorkflowId,
          );
          if (dbosStatus === undefined) {
            throw new Error("ACP workflow projection has no matching DBOS workflow");
          }
          assertDbosWorkflowMatches(
            dbosStatus,
            input,
            existing.rows[0].dbos_application_version,
          );
          await connection.query("COMMIT");
          return options.dbosClient.retrieveWorkflow<DeliveryNodeResult>(
            input.dbosWorkflowId,
          );
        }

        await assertNewSubmissionRuntimeCompatible(
          connection,
          input,
          runtimeHello,
        );

        const inserted = await connection.query(
          `INSERT INTO acp.mission_workflow_runs (
             workflow_execution_id, mission_id, dbos_workflow_id, workflow_id,
             workflow_version, workflow_binding_id, dbos_application_version,
             graph_revision, state, provenance_id, transition_provenance_id
           )
           SELECT $1, mission.mission_id, $2, mission.workflow_id,
                  mission.workflow_version, mission.workflow_binding_id, $3,
                  $4, 'pending', $5, $5
           FROM acp.missions AS mission
           WHERE mission.mission_id = $6
             AND mission.workflow_version = $7
             AND mission.state IN ('ready', 'planning')
           RETURNING workflow_execution_id`,
          [
            input.workflowExecutionId,
            input.dbosWorkflowId,
            options.dbosApplicationVersion,
            input.graphRevision,
            input.provenanceId,
            input.missionId,
            input.workflowVersion,
          ],
        );
        if (inserted.rowCount !== 1) {
          throw new Error("mission workflow binding does not match submission");
        }

        const handle = await options.dbosClient.enqueueInTransaction(
          connection,
          {
            workflowName: issueDeliveryWorkflowName,
            queueName: missionControlQueueName,
            workflowID: input.dbosWorkflowId,
            deduplicationID: input.workflowExecutionId,
            appVersion: options.dbosApplicationVersion,
            applicationName: "acp-worker",
            attributes: {
              missionId: input.missionId,
              workflowVersion: input.workflowVersion,
              graphRevision: input.graphRevision,
            },
          },
          input,
        );
        await connection.query("COMMIT");
        return handle as WorkflowHandle<DeliveryNodeResult>;
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    },
    async cancel(cancellation): Promise<void> {
      const parsed = parseIssueDeliveryCancellation(cancellation);
      const persisted = await runtimeStore.assertWorkflowRunControlTarget(
        workflowControlTarget(parsed.input),
      );
      const status = await options.dbosClient.getWorkflow(
        parsed.input.dbosWorkflowId,
      );
      assertDbosWorkflowMatches(
        status,
        parsed.input,
        persisted.dbosApplicationVersion,
      );
      if (isDbosTerminalFailure(status?.status)) {
        await projectTerminalFailure(runtimeStore, parsed.input, status);
        throw new Error(
          status.status === "MAX_RECOVERY_ATTEMPTS_EXCEEDED"
            ? "terminal DBOS workflow exhausted its recovery attempts"
            : "terminal DBOS workflow failed",
        );
      }
      if (status?.status !== "CANCELLED") {
        if (status?.status === "SUCCESS") {
          throw new Error(`terminal DBOS workflow cannot be cancelled from ${status.status}`);
        }
        if (persisted.state === "success" || persisted.state === "error") {
          throw new Error(`terminal workflow run cannot be cancelled from ${persisted.state}`);
        }
        await recordCancellationIntent(runtimeStore, parsed);
        await options.dbosClient.cancelWorkflow(parsed.input.dbosWorkflowId, {
          cancelChildren: true,
        });
      } else {
        await recordCancellationIntent(runtimeStore, parsed);
      }
      await reconcileCancellationProjection(
        options.dbosClient,
        runtimeStore,
        parsed,
        persisted.dbosApplicationVersion,
      );
    },
    async reconcileCancellation(cancellation): Promise<void> {
      const parsed = parseIssueDeliveryCancellation(cancellation);
      const persisted = await runtimeStore.assertWorkflowRunControlTarget(
        workflowControlTarget(parsed.input),
      );
      const status = await options.dbosClient.getWorkflow(
        parsed.input.dbosWorkflowId,
      );
      assertDbosWorkflowMatches(
        status,
        parsed.input,
        persisted.dbosApplicationVersion,
      );
      if (status?.status !== "CANCELLED") throw new Error("DBOS workflow cancellation is not durable");
      await recordCancellationIntent(runtimeStore, parsed);
      await reconcileCancellationProjection(
        options.dbosClient,
        runtimeStore,
        parsed,
        persisted.dbosApplicationVersion,
      );
    },
    async reconcileStatus(submittedInput): Promise<void> {
      const input = parseIssueDeliveryInput(submittedInput);
      const persisted = await runtimeStore.assertWorkflowRunControlTarget(
        workflowControlTarget(input),
      );
      const status = await options.dbosClient.getWorkflow(input.dbosWorkflowId);
      assertDbosWorkflowMatches(status, input, persisted.dbosApplicationVersion);
      if (isDbosTerminalFailure(status?.status)) {
        await projectTerminalFailure(runtimeStore, input, status);
      }
    },
  };
}

export function createPostgresIssueDeliveryMaintenance(
  options: PostgresIssueDeliveryMaintenanceOptions,
): IssueDeliveryMaintenance {
  const batchSize = options.batchSize ?? 100;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new TypeError("workflow reconciliation batch size must be between 1 and 1000");
  }

  let terminalCursor: string | undefined;
  let cancellationCursor: string | undefined;

  return {
    async reconcileWorkflows(): Promise<WorkflowReconciliationResult> {
      let candidates = await loadTerminalReconciliationBatch(
        options.pool,
        terminalCursor,
        batchSize,
      );
      if (candidates.length === 0 && terminalCursor !== undefined) {
        terminalCursor = undefined;
        candidates = await loadTerminalReconciliationBatch(
          options.pool,
          terminalCursor,
          batchSize,
        );
      }
      let reconciled = 0;
      const errors: Error[] = [];
      for (const candidate of candidates) {
        try {
          const status = await options.dbosClient.getWorkflow(
            candidate.dbos_workflow_id,
          );
          if (!isDbosTerminalFailure(status?.status)) continue;
          if (
            status.workflowID !== candidate.dbos_workflow_id ||
            !Array.isArray(status.input) ||
            status.input.length !== 1
          ) {
            throw new Error("terminal DBOS workflow cannot be reconciled to its ACP run");
          }
          const input = parseIssueDeliveryInput(status.input[0]);
          if (input.dbosWorkflowId !== candidate.dbos_workflow_id) {
            throw new Error("terminal DBOS workflow cannot be reconciled to its ACP run");
          }
          await options.controller.reconcileStatus(input);
          reconciled += 1;
        } catch (error) {
          errors.push(reconciliationItemError(
            "terminal workflow",
            candidate.dbos_workflow_id,
            error,
          ));
        } finally {
          terminalCursor = candidate.workflow_execution_id;
        }
      }

      let intents = await loadCancellationIntentBatch(
        options.pool,
        cancellationCursor,
        batchSize,
      );
      if (intents.length === 0 && cancellationCursor !== undefined) {
        cancellationCursor = undefined;
        intents = await loadCancellationIntentBatch(
          options.pool,
          cancellationCursor,
          batchSize,
        );
      }
      for (const intent of intents) {
        try {
          const status = await options.dbosClient.getWorkflow(intent.dbos_workflow_id);
          if (
            status === undefined ||
            !Array.isArray(status.input) ||
            status.input.length !== 1
          ) {
            continue;
          }
          const input = parseIssueDeliveryInput(status.input[0]);
          assertCancellationIntentMatches(intent, input, status.workflowID);
          const cancellation = {
            input,
            eventId: createStableId("event"),
            reason: cancellationIntentString(intent.payload, "reason"),
            requestedBy: cancellationIntentString(intent.payload, "requestedBy"),
            occurredAt: intent.occurred_at.toISOString(),
          };
          if (status.status === "CANCELLED") {
            await options.controller.reconcileCancellation(cancellation);
            reconciled += 1;
          } else if (isDbosTerminalFailure(status.status)) {
            await options.controller.reconcileStatus(input);
            reconciled += 1;
          } else if (status.status !== "SUCCESS") {
            await options.controller.cancel(cancellation);
            reconciled += 1;
          }
        } catch (error) {
          errors.push(reconciliationItemError(
            "cancellation intent",
            intent.dbos_workflow_id,
            error,
          ));
        } finally {
          cancellationCursor = intent.intent_event_id;
        }
      }
      return { reconciled, errors };
    },
  };
}

function reconciliationItemError(
  kind: string,
  dbosWorkflowId: string,
  cause: unknown,
): Error {
  return new Error(
    `${kind} reconciliation failed for ${dbosWorkflowId}`,
    { cause },
  );
}

async function loadTerminalReconciliationBatch(
  pool: Pool,
  cursor: string | undefined,
  batchSize: number,
): Promise<ActiveWorkflowReconciliationRow[]> {
  const result = await pool.query<ActiveWorkflowReconciliationRow>(
    `SELECT run.workflow_execution_id, run.dbos_workflow_id
     FROM acp.mission_workflow_runs AS run
     JOIN acp.missions AS mission ON mission.mission_id = run.mission_id
     WHERE ($1::text IS NULL OR run.workflow_execution_id::text > $1)
       AND (
         run.state IN ('pending', 'running')
         OR (
           run.state = 'error'
           AND (
             mission.state NOT IN ('complete_for_scope', 'failed', 'cancelled')
             OR EXISTS (
               SELECT 1 FROM acp.durable_subscriptions AS subscription
               WHERE subscription.mission_id = run.mission_id
                 AND subscription.dbos_workflow_id = run.dbos_workflow_id
                 AND subscription.state = 'waiting'
             )
             OR NOT EXISTS (
               SELECT 1 FROM acp.mission_events AS event
               WHERE event.mission_id = run.mission_id
                 AND event.event_type IN (
                   'mission.workflow-error',
                   'mission.workflow-recovery-exhausted'
                 )
                 AND event.payload ->> 'dbosWorkflowId' = run.dbos_workflow_id
             )
           )
         )
       )
     ORDER BY run.workflow_execution_id
     LIMIT $2`,
    [cursor ?? null, batchSize],
  );
  return result.rows;
}

async function loadCancellationIntentBatch(
  pool: Pool,
  cursor: string | undefined,
  batchSize: number,
): Promise<CancellationIntentRow[]> {
  const result = await pool.query<CancellationIntentRow>(
    `SELECT intent.event_id AS intent_event_id, intent.mission_id,
            intent.payload, intent.occurred_at, intent.provenance_id,
            run.dbos_workflow_id
     FROM acp.mission_events AS intent
     JOIN acp.mission_workflow_runs AS run
       ON run.mission_id = intent.mission_id
      AND run.workflow_execution_id::text =
            intent.payload ->> 'workflowExecutionId'
      AND run.dbos_workflow_id = intent.payload ->> 'dbosWorkflowId'
     WHERE intent.event_type = 'mission.cancellation-requested'
       AND ($1::text IS NULL OR intent.event_id::text > $1)
       AND run.state IN ('pending', 'running', 'cancelled')
       AND NOT EXISTS (
         SELECT 1 FROM acp.mission_events AS projected
         WHERE projected.mission_id = intent.mission_id
           AND projected.event_type = 'mission.cancellation-recorded'
           AND projected.payload ->> 'dbosWorkflowId' = run.dbos_workflow_id
       )
     ORDER BY intent.event_id
     LIMIT $2`,
    [cursor ?? null, batchSize],
  );
  return result.rows;
}

async function assertNewSubmissionRuntimeCompatible(
  connection: Pick<Pool, "query">,
  input: IssueDeliveryInput,
  configuredHello: RuntimeHello,
): Promise<void> {
  const admission = await connection.query<RuntimeAdmissionRow>(
    `SELECT mission.workflow_id, mission.workflow_version,
            provenance.api_version, provenance.worker_implementation_version,
            provenance.database_schema_version
     FROM acp.missions AS mission
     JOIN acp.runtime_provenance AS provenance
       ON provenance.provenance_id = $2
      AND provenance.workflow_binding_id = mission.workflow_binding_id
      AND provenance.workflow_id = mission.workflow_id
      AND provenance.workflow_version = mission.workflow_version
      AND provenance.completion_contract_id = mission.completion_contract_id
      AND provenance.completion_contract_version = mission.completion_contract_version
     WHERE mission.mission_id = $1`,
    [input.missionId, input.provenanceId],
  );
  const pinned = admission.rows[0];
  if (pinned === undefined || pinned.workflow_version !== input.workflowVersion) {
    throw new Error("runtime compatibility rejected: mission provenance is missing or mismatched");
  }
  const migration = await connection.query<MigrationVersionRow>(
    `SELECT version
     FROM acp.schema_migrations
     ORDER BY version DESC
     LIMIT 1`,
  );
  const installedDatabaseSchemaVersion = migration.rows[0]?.version;
  if (installedDatabaseSchemaVersion === undefined) {
    throw new Error("runtime compatibility rejected: database migration status is missing");
  }

  const observedHello: RuntimeHello = {
    ...configuredHello,
    databaseSchemaVersion: installedDatabaseSchemaVersion,
  };
  const configuredAssessment = assessRuntimeCompatibility(
    configuredHello,
    observedHello,
  );
  const pinnedAssessment = assessRuntimeCompatibility(
    {
      protocolVersion: configuredHello.protocolVersion,
      apiVersion: pinned.api_version,
      workerImplementationVersion: pinned.worker_implementation_version,
      databaseSchemaVersion: pinned.database_schema_version,
      workflowVersions: [{
        workflowId: pinned.workflow_id,
        version: pinned.workflow_version,
      }],
    },
    observedHello,
  );
  const reasons = [
    ...configuredAssessment.reasons,
    ...pinnedAssessment.reasons,
  ];
  if (reasons.length > 0) {
    throw new Error(`runtime compatibility rejected: ${JSON.stringify(reasons)}`);
  }
}

function assertSubmissionMatches(
  row: WorkflowSubmissionRow,
  input: IssueDeliveryInput,
): void {
  if (
    row.workflow_execution_id !== input.workflowExecutionId ||
    row.mission_id !== input.missionId ||
    row.dbos_workflow_id !== input.dbosWorkflowId ||
    row.workflow_version !== input.workflowVersion ||
    row.dbos_application_version.trim().length === 0 ||
    row.graph_revision !== input.graphRevision ||
    row.provenance_id !== input.provenanceId
  ) {
    throw new Error("DBOS workflow id aliases a different ACP submission");
  }
}

function workflowControlTarget(input: IssueDeliveryInput) {
  return {
    workflowExecutionId: input.workflowExecutionId,
    missionId: input.missionId,
    dbosWorkflowId: input.dbosWorkflowId,
    workflowVersion: input.workflowVersion,
    graphRevision: input.graphRevision,
    provenanceId: input.provenanceId,
  };
}

async function recordCancellationIntent(
  runtimeStore: PostgresRuntimeStore,
  cancellation: ReturnType<typeof parseIssueDeliveryCancellation>,
): Promise<void> {
  await runtimeStore.recordWorkflowCancellationIntent({
    target: workflowControlTarget(cancellation.input),
    eventId: cancellation.eventId,
    idempotencyKey: `${cancellation.input.dbosWorkflowId}:mission:cancellation-requested`,
    reason: cancellation.reason,
    requestedBy: cancellation.requestedBy,
    occurredAt: cancellation.occurredAt,
  });
}

function assertCancellationIntentMatches(
  intent: CancellationIntentRow,
  input: IssueDeliveryInput,
  dbosWorkflowId: string,
): void {
  if (
    dbosWorkflowId !== intent.dbos_workflow_id ||
    input.missionId !== intent.mission_id ||
    input.provenanceId !== intent.provenance_id ||
    input.dbosWorkflowId !== intent.dbos_workflow_id ||
    cancellationIntentString(intent.payload, "workflowExecutionId") !==
      input.workflowExecutionId ||
    cancellationIntentString(intent.payload, "workflowVersion") !==
      input.workflowVersion ||
    cancellationIntentString(intent.payload, "graphRevision") !==
      input.graphRevision
  ) {
    throw new Error("cancellation intent does not match the DBOS workflow input");
  }
}

function cancellationIntentString(payload: unknown, field: string): string {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    typeof (payload as Record<string, unknown>)[field] !== "string" ||
    ((payload as Record<string, string>)[field]?.trim().length ?? 0) === 0
  ) {
    throw new Error(`cancellation intent ${field} is missing`);
  }
  return (payload as Record<string, string>)[field] ?? "";
}

function assertDbosWorkflowMatches(
  status: Awaited<ReturnType<DBOSClient["getWorkflow"]>>,
  input: IssueDeliveryInput,
  dbosApplicationVersion: string,
): void {
  if (
    status === undefined ||
    status.workflowName !== issueDeliveryWorkflowName ||
    status.applicationName !== "acp-worker" ||
    status.applicationVersion !== dbosApplicationVersion ||
    !Array.isArray(status.input) ||
    status.input.length !== 1
  ) {
    throw new Error("DBOS workflow id aliases a different workflow execution");
  }

  let persistedInput: IssueDeliveryInput;
  try {
    persistedInput = parseIssueDeliveryInput(status.input[0]);
  } catch {
    throw new Error("DBOS workflow id aliases a different workflow execution");
  }
  if (!issueDeliveryInputsMatch(persistedInput, input)) {
    throw new Error("DBOS workflow id aliases a different workflow execution");
  }
}

function issueDeliveryInputsMatch(
  persisted: IssueDeliveryInput,
  submitted: IssueDeliveryInput,
): boolean {
  return (
    persisted.missionId === submitted.missionId &&
    persisted.approvalNodeId === submitted.approvalNodeId &&
    persisted.approvalSubscriptionId === submitted.approvalSubscriptionId &&
    persisted.workflowExecutionId === submitted.workflowExecutionId &&
    persisted.dbosWorkflowId === submitted.dbosWorkflowId &&
    persisted.workflowVersion === submitted.workflowVersion &&
    persisted.graphRevision === submitted.graphRevision &&
    persisted.provenanceId === submitted.provenanceId &&
    persisted.approvalExpiresAt === submitted.approvalExpiresAt
  );
}

async function reconcileCancellationProjection(
  dbosClient: DBOSClient,
  runtimeStore: PostgresRuntimeStore,
  cancellation: ReturnType<typeof parseIssueDeliveryCancellation>,
  dbosApplicationVersion: string,
): Promise<void> {
  const status = await dbosClient.getWorkflow(cancellation.input.dbosWorkflowId);
  assertDbosWorkflowMatches(
    status,
    cancellation.input,
    dbosApplicationVersion,
  );
  if (status?.status !== "CANCELLED") {
    throw new Error(
      `DBOS workflow cancellation is not durable: ${status?.status ?? "missing"}`,
    );
  }
  await runtimeStore.projectWorkflowCancellation({
    identity: {
      workflowExecutionId: cancellation.input.workflowExecutionId,
      missionId: cancellation.input.missionId,
      dbosWorkflowId: cancellation.input.dbosWorkflowId,
    },
    eventId: createStableId("event"),
    idempotencyKey: `${cancellation.input.dbosWorkflowId}:mission:cancelled`,
    reason: cancellation.reason,
    requestedBy: cancellation.requestedBy,
    occurredAt: cancellation.occurredAt,
    provenanceId: cancellation.input.provenanceId,
  });
}

function isDbosTerminalFailure(
  status: string | undefined,
): status is "ERROR" | "MAX_RECOVERY_ATTEMPTS_EXCEEDED" {
  return status === "ERROR" || status === "MAX_RECOVERY_ATTEMPTS_EXCEEDED";
}

async function projectTerminalFailure(
  runtimeStore: PostgresRuntimeStore,
  input: IssueDeliveryInput,
  status: NonNullable<Awaited<ReturnType<DBOSClient["getWorkflow"]>>>,
): Promise<void> {
  const statusTime = status.completedAt ?? status.updatedAt ?? status.createdAt;
  if (!Number.isFinite(statusTime)) {
    throw new Error("terminal DBOS workflow has no valid status timestamp");
  }
  if (!isDbosTerminalFailure(status.status)) {
    throw new Error("DBOS workflow status is not a terminal failure");
  }
  const eventSuffix = status.status === "MAX_RECOVERY_ATTEMPTS_EXCEEDED"
    ? "workflow-recovery-exhausted"
    : "workflow-error";
  await runtimeStore.projectWorkflowTerminalFailure({
    target: workflowControlTarget(input),
    dbosApplicationVersion: status.applicationVersion ?? "",
    dbosStatus: status.status,
    eventId: createStableId("event"),
    idempotencyKey: `${input.dbosWorkflowId}:mission:${eventSuffix}`,
    occurredAt: new Date(statusTime).toISOString(),
    ...(status.recoveryAttempts === undefined
      ? {}
      : { recoveryAttempts: status.recoveryAttempts }),
  });
}
