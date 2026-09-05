import type {
  MissionState,
  StableId,
  JsonValue,
} from "@acp/domain";
import { canonicalJsonDigest, transitionMissionState } from "@acp/domain";
import type { QueryResultRow } from "pg";

import type { ConnectionPool, QueryExecutor } from "./database.ts";
import { withTransaction } from "./database.ts";

export interface MissionInsert {
  readonly missionId: StableId<"mission">;
  readonly projectId: StableId<"project">;
  readonly intakeId?: StableId<"intake">;
  readonly workflowId: StableId<"workflow">;
  readonly workflowVersion: string;
  readonly workflowBindingId: StableId<"workflowBinding">;
  readonly completionContractId: StableId<"completionContract">;
  readonly completionContractVersion: string;
  readonly state: Exclude<MissionState, "complete_for_scope">;
  readonly requestedScope: string;
}

export interface MissionEventInsert {
  readonly eventId: StableId<"event">;
  readonly missionId: StableId<"mission">;
  readonly eventType: string;
  readonly eventVersion: string;
  readonly idempotencyKey: string;
  readonly payload: JsonValue;
  readonly occurredAt: string;
  readonly provenanceId: StableId<"provenance">;
}

export interface MissionSnapshot {
  readonly missionId: StableId<"mission">;
  readonly projectId: StableId<"project">;
  readonly state: MissionState;
  readonly completionContractId: StableId<"completionContract">;
  readonly completionContractVersion: string;
  readonly completedByEvaluationId: StableId<"completionEvaluation"> | null;
  readonly updatedAt: Date;
}

export interface MissionTransition {
  readonly missionId: StableId<"mission">;
  readonly expectedState: MissionState;
  readonly nextState: MissionState;
  readonly completedByEvaluationId?: StableId<"completionEvaluation">;
  readonly event: MissionEventInsert;
}

export interface MissionTransitionResult {
  readonly mission: MissionSnapshot;
  readonly replayed: boolean;
}

interface MissionRow extends QueryResultRow {
  readonly mission_id: StableId<"mission">;
  readonly project_id: StableId<"project">;
  readonly state: MissionState;
  readonly completion_contract_id: StableId<"completionContract">;
  readonly completion_contract_version: string;
  readonly completed_by_evaluation_id: StableId<"completionEvaluation"> | null;
  readonly updated_at: Date;
}

interface MissionEventRow extends QueryResultRow {
  readonly event_id: string;
  readonly event_digest: string;
}

export class PostgresMissionStore {
  private readonly pool: ConnectionPool;

  constructor(pool: ConnectionPool) {
    this.pool = pool;
  }

  async createMission(
    mission: MissionInsert,
    initialEvent: MissionEventInsert,
  ): Promise<MissionSnapshot> {
    if (initialEvent.missionId !== mission.missionId) {
      throw new Error("initial event mission does not match the mission being created");
    }

    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query<MissionRow>(
        `INSERT INTO acp.missions (
           mission_id, project_id, intake_id, workflow_id, workflow_version,
           workflow_binding_id, completion_contract_id,
           completion_contract_version, state, requested_scope,
           transition_provenance_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING mission_id, project_id, state, completion_contract_id,
                   completion_contract_version, completed_by_evaluation_id,
                   updated_at`,
        [
          mission.missionId,
          mission.projectId,
          mission.intakeId ?? null,
          mission.workflowId,
          mission.workflowVersion,
          mission.workflowBindingId,
          mission.completionContractId,
          mission.completionContractVersion,
          mission.state,
          mission.requestedScope,
          initialEvent.provenanceId,
        ],
      );
      await insertMissionEvent(client, initialEvent);
      return mapMission(requireRow(inserted.rows[0], "mission insert"));
    });
  }

  async appendEvent(event: MissionEventInsert): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<MissionEventRow>(
        missionEventInsertSql,
        missionEventValues(event),
      );
      if (result.rowCount === 1) return true;
      await assertEventReplayMatches(client, event);
      return false;
    });
  }

  async getMission(
    missionId: StableId<"mission">,
  ): Promise<MissionSnapshot | undefined> {
    const result = await this.pool.query<MissionRow>(
      `SELECT mission_id, project_id, state, completion_contract_id,
              completion_contract_version, completed_by_evaluation_id,
              updated_at
       FROM acp.missions
       WHERE mission_id = $1`,
      [missionId],
    );
    return result.rows[0] === undefined ? undefined : mapMission(result.rows[0]);
  }

  async transitionMission(
    transition: MissionTransition,
  ): Promise<MissionTransitionResult> {
    if (transition.event.missionId !== transition.missionId) {
      throw new Error("transition event mission does not match the mission being changed");
    }
    if (
      transition.nextState === "complete_for_scope" &&
      transition.completedByEvaluationId === undefined
    ) {
      throw new Error("scoped completion requires a completion evaluation");
    }
    if (
      transition.nextState !== "complete_for_scope" &&
      transition.completedByEvaluationId !== undefined
    ) {
      throw new Error("only scoped completion may reference a completion evaluation");
    }

    return withTransaction(this.pool, async (client) => {
      const locked = await client.query<MissionRow>(
        `SELECT mission_id, project_id, state, completion_contract_id,
                completion_contract_version, completed_by_evaluation_id,
                updated_at
         FROM acp.missions
         WHERE mission_id = $1
         FOR UPDATE`,
        [transition.missionId],
      );
      const current = requireRow(locked.rows[0], "mission transition");

      const existingEvent = await client.query<MissionEventRow>(
        `SELECT event_id, event_digest
         FROM acp.mission_events
         WHERE mission_id = $1 AND event_type = $2 AND idempotency_key = $3`,
        [
          transition.missionId,
          transition.event.eventType,
          transition.event.idempotencyKey,
        ],
      );
      if (existingEvent.rowCount === 1) {
        if (existingEvent.rows[0]?.event_digest !== missionEventDigest(transition.event)) {
          throw new Error("replayed mission event does not match original event");
        }
        if (current.state !== transition.nextState) {
          throw new Error("replayed mission event does not match current state");
        }
        return { mission: mapMission(current), replayed: true };
      }
      if (current.state !== transition.expectedState) {
        throw new Error(
          `mission state changed: expected ${transition.expectedState}, found ${current.state}`,
        );
      }
      transitionMissionState(current.state, transition.nextState);

      const updated = await client.query<MissionRow>(
        `UPDATE acp.missions
         SET state = $2,
             completed_by_evaluation_id = $3,
             transition_provenance_id = $4,
             updated_at = statement_timestamp()
         WHERE mission_id = $1
         RETURNING mission_id, project_id, state, completion_contract_id,
                   completion_contract_version, completed_by_evaluation_id,
                   updated_at`,
        [
          transition.missionId,
          transition.nextState,
          transition.completedByEvaluationId ?? null,
          transition.event.provenanceId,
        ],
      );
      await insertMissionEvent(client, transition.event);
      return {
        mission: mapMission(requireRow(updated.rows[0], "mission update")),
        replayed: false,
      };
    });
  }

  async listRunnableMissions(limit = 100): Promise<readonly MissionSnapshot[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("runnable mission limit must be between 1 and 1000");
    }
    const result = await this.pool.query<MissionRow>(
      `SELECT mission_id, project_id, state, completion_contract_id,
              completion_contract_version, completed_by_evaluation_id,
              updated_at
       FROM acp.missions
       WHERE state IN ('ready', 'executing', 'verifying', 'awaiting_external')
       ORDER BY updated_at, mission_id
       LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapMission);
  }
}

const missionEventInsertSql = `INSERT INTO acp.mission_events (
  event_id, mission_id, event_type, event_version, idempotency_key,
  event_digest, payload, occurred_at, provenance_id
) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
ON CONFLICT (mission_id, event_type, idempotency_key) DO NOTHING
RETURNING event_id, event_digest`;

async function insertMissionEvent(
  client: QueryExecutor,
  event: MissionEventInsert,
): Promise<void> {
  const result = await client.query(missionEventInsertSql, missionEventValues(event));
  if (result.rowCount !== 1) {
    throw new Error("mission event idempotency key already exists");
  }
}

function missionEventValues(event: MissionEventInsert): unknown[] {
  return [
    event.eventId,
    event.missionId,
    event.eventType,
    event.eventVersion,
    event.idempotencyKey,
    missionEventDigest(event),
    JSON.stringify(event.payload),
    event.occurredAt,
    event.provenanceId,
  ];
}

function missionEventDigest(event: MissionEventInsert): string {
  return canonicalJsonDigest({
    eventVersion: event.eventVersion,
    payload: event.payload,
    occurredAt: event.occurredAt,
    provenanceId: event.provenanceId,
  });
}

async function assertEventReplayMatches(
  client: QueryExecutor,
  event: MissionEventInsert,
): Promise<void> {
  const existing = await client.query<MissionEventRow>(
    `SELECT event_id, event_digest
     FROM acp.mission_events
     WHERE mission_id = $1 AND event_type = $2 AND idempotency_key = $3`,
    [event.missionId, event.eventType, event.idempotencyKey],
  );
  if (existing.rows[0]?.event_digest !== missionEventDigest(event)) {
    throw new Error("mission event idempotency key aliases a different event");
  }
}

function mapMission(row: MissionRow): MissionSnapshot {
  return {
    missionId: row.mission_id,
    projectId: row.project_id,
    state: row.state,
    completionContractId: row.completion_contract_id,
    completionContractVersion: row.completion_contract_version,
    completedByEvaluationId: row.completed_by_evaluation_id,
    updatedAt: row.updated_at,
  };
}

function requireRow<T>(row: T | undefined, operation: string): T {
  if (row === undefined) throw new Error(`${operation} did not return a row`);
  return row;
}
