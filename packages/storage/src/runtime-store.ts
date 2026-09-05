import { canonicalJsonDigest, type StableId } from "@acp/domain";
import type { QueryResultRow } from "pg";

import type { ConnectionPool } from "./database.ts";
import { withTransaction } from "./database.ts";

export type WorkflowRunState =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "cancelled";
export type SubscriptionState = "waiting" | "received" | "expired" | "cancelled";

export interface WorkflowRunInsert {
  readonly workflowExecutionId: StableId<"workflowExecution">;
  readonly missionId: StableId<"mission">;
  readonly dbosWorkflowId: string;
  readonly workflowId: StableId<"workflow">;
  readonly workflowVersion: string;
  readonly workflowBindingId: StableId<"workflowBinding">;
  readonly dbosApplicationVersion: string;
  readonly graphRevision: string;
  readonly provenanceId: StableId<"provenance">;
}

export interface SubscriptionUpdate {
  readonly subscriptionId: StableId<"subscription">;
  readonly missionId: StableId<"mission">;
  readonly nodeId: StableId<"node">;
  readonly dbosWorkflowId: string;
  readonly topic: string;
  readonly state: SubscriptionState;
  readonly occurredAt: string;
  readonly expiresAt: string;
  readonly semanticDigest: string;
  readonly provenanceId: StableId<"provenance">;
}

interface WorkflowRunRow extends QueryResultRow {
  readonly workflow_execution_id: StableId<"workflowExecution">;
  readonly state: WorkflowRunState;
  readonly mission_id: StableId<"mission">;
  readonly dbos_workflow_id: string;
  readonly workflow_id: StableId<"workflow">;
  readonly workflow_version: string;
  readonly workflow_binding_id: StableId<"workflowBinding">;
  readonly dbos_application_version: string;
  readonly graph_revision: string;
  readonly provenance_id: StableId<"provenance">;
}

interface SubscriptionRow extends QueryResultRow {
  readonly state: SubscriptionState;
  readonly subscription_id: StableId<"subscription">;
  readonly mission_id: StableId<"mission">;
  readonly node_id: StableId<"node">;
  readonly expires_at: Date;
  readonly semantic_digest: string;
  readonly provenance_id: StableId<"provenance">;
}

interface MissionStateRow extends QueryResultRow {
  readonly state: string;
}

interface CancellationEventRow extends QueryResultRow {
  readonly event_id: StableId<"event">;
  readonly event_digest: string;
}

export interface WorkflowRunIdentity {
  readonly workflowExecutionId: StableId<"workflowExecution">;
  readonly missionId: StableId<"mission">;
  readonly dbosWorkflowId: string;
}

export interface WorkflowCancellationTarget extends WorkflowRunIdentity {
  readonly workflowVersion: string;
  readonly graphRevision: string;
  readonly provenanceId: StableId<"provenance">;
}

export interface PersistedWorkflowControlTarget {
  readonly state: WorkflowRunState;
  readonly dbosApplicationVersion: string;
}

export interface WorkflowCancellationProjection {
  readonly identity: WorkflowRunIdentity;
  readonly eventId: StableId<"event">;
  readonly idempotencyKey: string;
  readonly reason: string;
  readonly requestedBy: string;
  readonly occurredAt: string;
  readonly provenanceId: StableId<"provenance">;
}

export interface WorkflowCancellationIntent {
  readonly target: WorkflowCancellationTarget;
  readonly eventId: StableId<"event">;
  readonly idempotencyKey: string;
  readonly reason: string;
  readonly requestedBy: string;
  readonly occurredAt: string;
}

export interface WorkflowCancellationResult {
  readonly replayed: boolean;
  readonly effectiveMissionState: string;
  readonly effectiveWorkflowRunState: WorkflowRunState;
}

export type DbosTerminalFailureStatus =
  | "ERROR"
  | "MAX_RECOVERY_ATTEMPTS_EXCEEDED";

export interface WorkflowTerminalFailureProjection {
  readonly target: WorkflowCancellationTarget;
  readonly dbosApplicationVersion: string;
  readonly dbosStatus: DbosTerminalFailureStatus;
  readonly eventId: StableId<"event">;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
  readonly recoveryAttempts?: number;
}

const allowedWorkflowRunTransitions: Readonly<
  Record<WorkflowRunState, readonly WorkflowRunState[]>
> = {
  pending: ["running", "error", "cancelled"],
  running: ["success", "error", "cancelled"],
  success: [],
  error: [],
  cancelled: [],
};

export class PostgresRuntimeStore {
  private readonly pool: ConnectionPool;

  constructor(pool: ConnectionPool) {
    this.pool = pool;
  }

  async createWorkflowRun(run: WorkflowRunInsert): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO acp.mission_workflow_runs (
         workflow_execution_id, mission_id, dbos_workflow_id, workflow_id,
         workflow_version, workflow_binding_id, dbos_application_version,
         graph_revision, state, provenance_id, transition_provenance_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $9)
       ON CONFLICT DO NOTHING
       RETURNING workflow_execution_id`,
      [
        run.workflowExecutionId,
        run.missionId,
        run.dbosWorkflowId,
        run.workflowId,
        run.workflowVersion,
        run.workflowBindingId,
        run.dbosApplicationVersion,
        run.graphRevision,
        run.provenanceId,
      ],
    );
    if (result.rowCount === 1) return true;

    const existing = await this.pool.query<WorkflowRunRow>(
      `SELECT workflow_execution_id, mission_id, dbos_workflow_id, workflow_id,
              workflow_version, workflow_binding_id, dbos_application_version,
              graph_revision, state, provenance_id
       FROM acp.mission_workflow_runs
       WHERE workflow_execution_id = $1 OR dbos_workflow_id = $2`,
      [run.workflowExecutionId, run.dbosWorkflowId],
    );
    const existingRun = existing.rows.length === 1 ? existing.rows[0] : undefined;
    if (existingRun === undefined || !workflowRunMatches(existingRun, run)) {
      throw new Error("workflow identity aliases a different persisted execution");
    }
    return false;
  }

  async assertWorkflowRunControlTarget(
    target: WorkflowCancellationTarget,
  ): Promise<PersistedWorkflowControlTarget> {
    const result = await this.pool.query<WorkflowRunRow>(
      `SELECT workflow_execution_id, mission_id, dbos_workflow_id, workflow_id,
              workflow_version, workflow_binding_id, dbos_application_version,
              graph_revision, state, provenance_id
       FROM acp.mission_workflow_runs
       WHERE workflow_execution_id = $1
         AND mission_id = $2
         AND dbos_workflow_id = $3`,
      [target.workflowExecutionId, target.missionId, target.dbosWorkflowId],
    );
    const run = result.rows[0];
    if (
      run === undefined ||
      run.workflow_version !== target.workflowVersion ||
      run.graph_revision !== target.graphRevision ||
      run.provenance_id !== target.provenanceId
    ) {
      throw new Error("cancellation target does not match the persisted workflow run");
    }
    return {
      state: run.state,
      dbosApplicationVersion: run.dbos_application_version,
    };
  }

  async setWorkflowRunState(
    identity: WorkflowRunIdentity,
    nextState: Exclude<WorkflowRunState, "pending">,
    occurredAt: string,
    transitionProvenanceId: StableId<"provenance">,
  ): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const locked = await client.query<WorkflowRunRow>(
        `SELECT state, mission_id, dbos_workflow_id
         FROM acp.mission_workflow_runs
         WHERE workflow_execution_id = $1
           AND mission_id = $2
           AND dbos_workflow_id = $3
         FOR UPDATE`,
        [identity.workflowExecutionId, identity.missionId, identity.dbosWorkflowId],
      );
      const current = locked.rows[0]?.state;
      if (current === undefined) throw new Error("workflow run does not exist");
      if (current === nextState) return;
      if (!allowedWorkflowRunTransitions[current].includes(nextState)) {
        throw new Error(`illegal workflow run transition: ${current} -> ${nextState}`);
      }
      await client.query(
        `UPDATE acp.mission_workflow_runs
         SET state = $2,
             completed_at = CASE WHEN $2 IN ('success', 'error', 'cancelled') THEN $3::timestamptz ELSE NULL END,
             transition_provenance_id = $6
         WHERE workflow_execution_id = $1 AND mission_id = $4 AND dbos_workflow_id = $5`,
        [
          identity.workflowExecutionId,
          nextState,
          occurredAt,
          identity.missionId,
          identity.dbosWorkflowId,
          transitionProvenanceId,
        ],
      );
    });
  }

  async updateSubscription(update: SubscriptionUpdate): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      if (update.state === "waiting") {
        const inserted = await client.query(
          `INSERT INTO acp.durable_subscriptions (
             subscription_id, mission_id, node_id, dbos_workflow_id, topic,
             state, created_at, expires_at, semantic_digest, provenance_id,
             transition_provenance_id
           ) VALUES ($1, $2, $3, $4, $5, 'waiting', $6, $7, $8, $9, $9)
           ON CONFLICT (dbos_workflow_id, topic) DO NOTHING
           RETURNING subscription_id`,
          [
            update.subscriptionId,
            update.missionId,
            update.nodeId,
            update.dbosWorkflowId,
            update.topic,
            update.occurredAt,
            update.expiresAt,
            update.semanticDigest,
            update.provenanceId,
          ],
        );
        if (inserted.rowCount === 1) return;
      }

      const existing = await client.query<SubscriptionRow>(
        `SELECT state, subscription_id, mission_id, node_id, expires_at,
                semantic_digest, provenance_id
         FROM acp.durable_subscriptions
         WHERE dbos_workflow_id = $1 AND topic = $2 FOR UPDATE`,
        [update.dbosWorkflowId, update.topic],
      );
      const existingSubscription = existing.rows[0];
      const current = existingSubscription?.state;
      const identityMatches =
        existingSubscription?.subscription_id === update.subscriptionId &&
        existingSubscription.mission_id === update.missionId &&
        existingSubscription.node_id === update.nodeId &&
        existingSubscription.expires_at instanceof Date &&
        existingSubscription.expires_at.toISOString() === update.expiresAt &&
        existingSubscription.semantic_digest === update.semanticDigest &&
        existingSubscription.provenance_id === update.provenanceId;
      if (!identityMatches) {
        throw new Error("subscription identity does not match persisted wait");
      }
      if (current === update.state) return;
      if (current !== "waiting" || update.state === "waiting") {
        throw new Error(`illegal subscription transition: ${current ?? "missing"} -> ${update.state}`);
      }
      await client.query(
        `UPDATE acp.durable_subscriptions
         SET state = $3, resolved_at = $4, transition_provenance_id = $8
         WHERE dbos_workflow_id = $1 AND topic = $2
           AND subscription_id = $5 AND mission_id = $6 AND node_id = $7`,
        [
          update.dbosWorkflowId,
          update.topic,
          update.state,
          update.occurredAt,
          update.subscriptionId,
          update.missionId,
          update.nodeId,
          update.provenanceId,
        ],
      );
    });
  }

  async recordWorkflowCancellationIntent(
    intent: WorkflowCancellationIntent,
  ): Promise<boolean> {
    if (intent.idempotencyKey.trim().length === 0) {
      throw new Error("cancellation intent idempotency key must not be empty");
    }
    if (intent.reason.trim().length === 0) {
      throw new Error("cancellation intent reason must not be empty");
    }
    if (intent.requestedBy.trim().length === 0) {
      throw new Error("cancellation intent requester must not be empty");
    }
    const payload = cancellationIntentEventPayload(intent);
    const digest = canonicalJsonDigest({
      eventVersion: "1.0.0",
      payload,
      occurredAt: intent.occurredAt,
      provenanceId: intent.target.provenanceId,
    });
    const inserted = await this.pool.query(
      `INSERT INTO acp.mission_events (
         event_id, mission_id, event_type, event_version, idempotency_key,
         event_digest, payload, occurred_at, provenance_id
       ) SELECT $1::acp.stable_id, $2::acp.stable_id, 'mission.cancellation-requested', '1.0.0',
                 $3, $4, $5::jsonb, $6::timestamptz, $7::acp.stable_id
         FROM acp.mission_workflow_runs
         WHERE workflow_execution_id = $8 AND mission_id = $2::acp.stable_id AND dbos_workflow_id = $9
           AND workflow_version = $10 AND graph_revision = $11 AND provenance_id = $7::acp.stable_id
       ON CONFLICT (mission_id, event_type, idempotency_key) DO NOTHING
       RETURNING event_id`,
      [
        intent.eventId,
        intent.target.missionId,
        intent.idempotencyKey,
        digest,
        JSON.stringify(payload),
        intent.occurredAt,
        intent.target.provenanceId,
        intent.target.workflowExecutionId,
        intent.target.dbosWorkflowId,
        intent.target.workflowVersion,
        intent.target.graphRevision,
      ],
    );
    if (inserted.rowCount === 1) return true;

    const prior = await this.pool.query<CancellationEventRow>(
      `SELECT event_id, event_digest
       FROM acp.mission_events
       WHERE mission_id = $1
         AND event_type = 'mission.cancellation-requested'
         AND idempotency_key = $2`,
      [intent.target.missionId, intent.idempotencyKey],
    );
    if (prior.rows[0]?.event_digest !== digest) {
      throw new Error("cancellation intent idempotency key aliases a different event");
    }
    return false;
  }

  async projectWorkflowCancellation(
    cancellation: WorkflowCancellationProjection,
  ): Promise<WorkflowCancellationResult> {
    if (cancellation.idempotencyKey.trim().length === 0) {
      throw new Error("cancellation idempotency key must not be empty");
    }
    if (cancellation.reason.trim().length === 0) {
      throw new Error("cancellation reason must not be empty");
    }
    if (cancellation.requestedBy.trim().length === 0) {
      throw new Error("cancellation requester must not be empty");
    }

    return withTransaction(this.pool, async (client) => {
      const runResult = await client.query<WorkflowRunRow>(
        `SELECT workflow_execution_id, mission_id, dbos_workflow_id, workflow_id,
                workflow_version, workflow_binding_id, dbos_application_version,
                graph_revision, state, provenance_id
         FROM acp.mission_workflow_runs
         WHERE workflow_execution_id = $1
           AND mission_id = $2
           AND dbos_workflow_id = $3
         FOR UPDATE`,
        [
          cancellation.identity.workflowExecutionId,
          cancellation.identity.missionId,
          cancellation.identity.dbosWorkflowId,
        ],
      );
      const run = runResult.rows[0];
      if (run === undefined) throw new Error("workflow run does not exist");
      const effectiveWorkflowRunState =
        run.state === "success" || run.state === "error"
          ? run.state
          : "cancelled";

      const missionResult = await client.query<MissionStateRow>(
        `SELECT state FROM acp.missions WHERE mission_id = $1 FOR UPDATE`,
        [cancellation.identity.missionId],
      );
      const missionState = missionResult.rows[0]?.state;
      if (missionState === undefined) throw new Error("mission does not exist");
      const effectiveMissionState =
        missionState === "complete_for_scope" || missionState === "failed"
          ? missionState
          : "cancelled";

      const priorEvent = await client.query<CancellationEventRow>(
        `SELECT event_id, event_digest
         FROM acp.mission_events
         WHERE mission_id = $1
           AND event_type = 'mission.cancellation-recorded'
           AND idempotency_key = $2`,
        [cancellation.identity.missionId, cancellation.idempotencyKey],
      );
      if (
        priorEvent.rows[0] !== undefined &&
        priorEvent.rows[0].event_digest !== cancellationEventDigest(
          cancellation,
          effectiveMissionState,
          effectiveWorkflowRunState,
        )
      ) {
        throw new Error("cancellation idempotency key aliases a different event");
      }

      if (effectiveMissionState === "cancelled" && missionState !== "cancelled") {
        await client.query(
          `UPDATE acp.missions
           SET state = 'cancelled', completed_by_evaluation_id = NULL,
               transition_provenance_id = $2,
               updated_at = statement_timestamp()
           WHERE mission_id = $1`,
          [cancellation.identity.missionId, cancellation.provenanceId],
        );
      }

      if (priorEvent.rows[0] === undefined) {
        const event = await client.query(
          `INSERT INTO acp.mission_events (
             event_id, mission_id, event_type, event_version, idempotency_key,
             event_digest, payload, occurred_at, provenance_id
           ) VALUES ($1, $2, 'mission.cancellation-recorded', '1.0.0', $3, $4, $5::jsonb, $6, $7)
           ON CONFLICT (mission_id, event_type, idempotency_key) DO NOTHING
           RETURNING event_id`,
          [
            cancellation.eventId,
            cancellation.identity.missionId,
            cancellation.idempotencyKey,
            cancellationEventDigest(
              cancellation,
              effectiveMissionState,
              effectiveWorkflowRunState,
            ),
            JSON.stringify(cancellationEventPayload(
              cancellation,
              effectiveMissionState,
              effectiveWorkflowRunState,
            )),
            cancellation.occurredAt,
            cancellation.provenanceId,
          ],
        );
        if (event.rowCount !== 1) {
          throw new Error("cancellation event collision must be reconciled");
        }
      }

      if (effectiveWorkflowRunState === "cancelled" && run.state !== "cancelled") {
        await client.query(
          `UPDATE acp.mission_workflow_runs
           SET state = 'cancelled', completed_at = $4::timestamptz,
               transition_provenance_id = $5
           WHERE workflow_execution_id = $1
             AND mission_id = $2
             AND dbos_workflow_id = $3`,
          [
            cancellation.identity.workflowExecutionId,
            cancellation.identity.missionId,
            cancellation.identity.dbosWorkflowId,
            cancellation.occurredAt,
            cancellation.provenanceId,
          ],
        );
      }

      await client.query(
        `UPDATE acp.durable_subscriptions
         SET state = 'cancelled', resolved_at = $3::timestamptz,
             transition_provenance_id = $4
         WHERE mission_id = $1 AND dbos_workflow_id = $2 AND state = 'waiting'`,
        [
          cancellation.identity.missionId,
          cancellation.identity.dbosWorkflowId,
          cancellation.occurredAt,
          cancellation.provenanceId,
        ],
      );

      return {
        replayed:
          run.state === effectiveWorkflowRunState &&
          missionState === effectiveMissionState &&
          priorEvent.rows[0] !== undefined,
        effectiveMissionState,
        effectiveWorkflowRunState,
      };
    });
  }

  async projectWorkflowTerminalFailure(
    failure: WorkflowTerminalFailureProjection,
  ): Promise<WorkflowCancellationResult> {
    if (failure.idempotencyKey.trim().length === 0) {
      throw new Error("terminal workflow failure idempotency key must not be empty");
    }
    if (
      failure.recoveryAttempts !== undefined &&
      (!Number.isInteger(failure.recoveryAttempts) || failure.recoveryAttempts < 0)
    ) {
      throw new Error("recovery attempt count must be a nonnegative integer");
    }

    const eventType = failure.dbosStatus === "MAX_RECOVERY_ATTEMPTS_EXCEEDED"
      ? "mission.workflow-recovery-exhausted"
      : "mission.workflow-error";

    return withTransaction(this.pool, async (client) => {
      const runResult = await client.query<WorkflowRunRow>(
        `SELECT workflow_execution_id, mission_id, dbos_workflow_id, workflow_id,
                workflow_version, workflow_binding_id, dbos_application_version,
                graph_revision, state, provenance_id
         FROM acp.mission_workflow_runs
        WHERE workflow_execution_id = $1
           AND mission_id = $2
           AND dbos_workflow_id = $3
         FOR UPDATE`,
        [
          failure.target.workflowExecutionId,
          failure.target.missionId,
          failure.target.dbosWorkflowId,
        ],
      );
      const run = runResult.rows[0];
      if (
        run === undefined ||
        run.workflow_version !== failure.target.workflowVersion ||
        run.dbos_application_version !== failure.dbosApplicationVersion ||
        run.graph_revision !== failure.target.graphRevision ||
        run.provenance_id !== failure.target.provenanceId
      ) {
        throw new Error("terminal workflow failure target does not match the persisted workflow run");
      }
      const effectiveWorkflowRunState =
        run.state === "pending" || run.state === "running" ? "error" : run.state;

      const missionResult = await client.query<MissionStateRow>(
        `SELECT state FROM acp.missions WHERE mission_id = $1 FOR UPDATE`,
        [failure.target.missionId],
      );
      const missionState = missionResult.rows[0]?.state;
      if (missionState === undefined) throw new Error("mission does not exist");
      const effectiveMissionState =
        missionState === "complete_for_scope" ||
        missionState === "failed" ||
        missionState === "cancelled"
          ? missionState
          : "failed";
      const eventPayload = terminalFailureEventPayload(
        failure,
        effectiveMissionState,
        effectiveWorkflowRunState,
      );
      const eventDigest = canonicalJsonDigest({
        eventVersion: "1.0.0",
        payload: eventPayload,
        occurredAt: failure.occurredAt,
        provenanceId: failure.target.provenanceId,
      });
      const priorEvent = await client.query<CancellationEventRow>(
        `SELECT event_id, event_digest
         FROM acp.mission_events
         WHERE mission_id = $1
           AND event_type = $2
           AND idempotency_key = $3`,
        [failure.target.missionId, eventType, failure.idempotencyKey],
      );
      if (
        priorEvent.rows[0] !== undefined &&
        priorEvent.rows[0].event_digest !== eventDigest
      ) {
        throw new Error("terminal workflow failure idempotency key aliases a different event");
      }

      if (effectiveMissionState === "failed" && missionState !== "failed") {
        await client.query(
          `UPDATE acp.missions
           SET state = 'failed', completed_by_evaluation_id = NULL,
               transition_provenance_id = $2,
               updated_at = statement_timestamp()
           WHERE mission_id = $1`,
          [failure.target.missionId, failure.target.provenanceId],
        );
      }
      if (priorEvent.rows[0] === undefined) {
        const event = await client.query(
          `INSERT INTO acp.mission_events (
             event_id, mission_id, event_type, event_version, idempotency_key,
             event_digest, payload, occurred_at, provenance_id
           ) VALUES ($1, $2, $3, '1.0.0', $4, $5, $6::jsonb, $7, $8)
           ON CONFLICT (mission_id, event_type, idempotency_key) DO NOTHING
           RETURNING event_id`,
          [
            failure.eventId,
            failure.target.missionId,
            eventType,
            failure.idempotencyKey,
            eventDigest,
            JSON.stringify(eventPayload),
            failure.occurredAt,
            failure.target.provenanceId,
          ],
        );
        if (event.rowCount !== 1) {
          throw new Error("terminal workflow failure event collision must be reconciled");
        }
      }
      if (effectiveWorkflowRunState === "error" && run.state !== "error") {
        await client.query(
          `UPDATE acp.mission_workflow_runs
           SET state = 'error', completed_at = $4::timestamptz,
               transition_provenance_id = $5
          WHERE workflow_execution_id = $1
             AND mission_id = $2
             AND dbos_workflow_id = $3`,
          [
            failure.target.workflowExecutionId,
            failure.target.missionId,
            failure.target.dbosWorkflowId,
            failure.occurredAt,
            failure.target.provenanceId,
          ],
        );
      }
      await client.query(
        `UPDATE acp.durable_subscriptions
         SET state = 'cancelled', resolved_at = $3::timestamptz,
             transition_provenance_id = $4
         WHERE mission_id = $1 AND dbos_workflow_id = $2 AND state = 'waiting'`,
        [
          failure.target.missionId,
          failure.target.dbosWorkflowId,
          failure.occurredAt,
          failure.target.provenanceId,
        ],
      );

      return {
        replayed:
          run.state === effectiveWorkflowRunState &&
          missionState === effectiveMissionState &&
          priorEvent.rows[0] !== undefined,
        effectiveMissionState,
        effectiveWorkflowRunState,
      };
    });
  }
}

function workflowRunMatches(row: WorkflowRunRow, run: WorkflowRunInsert): boolean {
  return (
    row.workflow_execution_id === run.workflowExecutionId &&
    row.mission_id === run.missionId &&
    row.dbos_workflow_id === run.dbosWorkflowId &&
    row.workflow_id === run.workflowId &&
    row.workflow_version === run.workflowVersion &&
    row.workflow_binding_id === run.workflowBindingId &&
    row.dbos_application_version === run.dbosApplicationVersion &&
    row.graph_revision === run.graphRevision &&
    row.provenance_id === run.provenanceId
  );
}

function cancellationEventDigest(
  cancellation: WorkflowCancellationProjection,
  effectiveMissionState: string,
  effectiveWorkflowRunState: WorkflowRunState,
): string {
  return canonicalJsonDigest({
    eventVersion: "1.0.0",
    payload: cancellationEventPayload(
      cancellation,
      effectiveMissionState,
      effectiveWorkflowRunState,
    ),
    occurredAt: cancellation.occurredAt,
    provenanceId: cancellation.provenanceId,
  });
}

function cancellationEventPayload(
  cancellation: WorkflowCancellationProjection,
  effectiveMissionState: string,
  effectiveWorkflowRunState: WorkflowRunState,
): Record<string, string> {
  return {
    dbosWorkflowId: cancellation.identity.dbosWorkflowId,
    workflowExecutionId: cancellation.identity.workflowExecutionId,
    reason: cancellation.reason,
    requestedBy: cancellation.requestedBy,
    effectiveMissionState,
    effectiveWorkflowRunState,
  };
}

function cancellationIntentEventPayload(
  intent: WorkflowCancellationIntent,
): Record<string, string> {
  return {
    dbosWorkflowId: intent.target.dbosWorkflowId,
    workflowExecutionId: intent.target.workflowExecutionId,
    workflowVersion: intent.target.workflowVersion,
    graphRevision: intent.target.graphRevision,
    reason: intent.reason,
    requestedBy: intent.requestedBy,
  };
}

function terminalFailureEventPayload(
  failure: WorkflowTerminalFailureProjection,
  effectiveMissionState: string,
  effectiveWorkflowRunState: WorkflowRunState,
): Record<string, string | number> {
  return {
    dbosWorkflowId: failure.target.dbosWorkflowId,
    workflowExecutionId: failure.target.workflowExecutionId,
    dbosApplicationVersion: failure.dbosApplicationVersion,
    dbosStatus: failure.dbosStatus,
    recoveryAttempts: failure.recoveryAttempts ?? 0,
    effectiveMissionState,
    effectiveWorkflowRunState,
  };
}
