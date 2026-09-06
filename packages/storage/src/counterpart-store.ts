import {
  canonicalJsonDigest,
  createStableId,
  parseStableId,
  type MissionState,
  type StableId,
  type ProjectReadinessQuery,
  type ProjectProfileProposalQuery,
} from "@acp/domain";
import type { QueryResultRow } from "pg";

import type { ConnectionPool, QueryExecutor } from "./database.ts";
import { withIsolatedTransaction } from "./isolated-transaction.ts";
import { counterpartMissionStatusSql } from "./counterpart-status-query.ts";
import { getProjectReadiness as readProjectReadiness, type ProjectReadinessPersistence } from "./readiness-store.ts";
import { getProjectProfileProposal as readProjectProfileProposal, getProfileConfirmationRequest as readProfileConfirmationRequest,
  type ProjectProfileProposalPersistence } from "./profile-proposal-store.ts";
import { counterpartStatusCollectionLimit,counterpartStatusEnvironmentLimit,counterpartStatusMaximumBytes,
  parseCounterpartMissionStatus,type CounterpartMissionStatus } from "./counterpart-status.ts";
import type { CounterpartMissionCreation, CounterpartMissionProjection, CounterpartMissionSummary } from "./counterpart-mission-projection.ts";
export type { CounterpartMissionCreation, CounterpartMissionNodeProjection, CounterpartMissionProjection, CounterpartMissionSummary } from "./counterpart-mission-projection.ts";

export interface CounterpartMissionCreate {
  readonly clientRequestId: string;
  readonly projectId: StableId<"project">;
  readonly objective: string;
  readonly requestedScope: string;
  /** Legacy wire name for an exact canonical workflow ID, never a name alias. */
  readonly workflowKey?: string;
}

export interface CounterpartMissionPersistence extends ProjectReadinessPersistence, ProjectProfileProposalPersistence {
  createMission(input: CounterpartMissionCreate): Promise<CounterpartMissionCreation>;
  getMission(
    missionId: StableId<"mission">,
  ): Promise<CounterpartMissionProjection | undefined>;
  getMissionStatus(missionId:StableId<"mission">):Promise<CounterpartMissionStatus|undefined>;
  listActiveMissions(
    projectId?: StableId<"project">,
    limit?: number,
  ): Promise<readonly CounterpartMissionSummary[]>;
}

interface BindingRow extends QueryResultRow {
  readonly binding_id: StableId<"workflowBinding">;
  readonly workflow_id: StableId<"workflow">;
  readonly workflow_version: string;
  readonly completion_contract_id: StableId<"completionContract">;
  readonly completion_contract_version: string;
}

interface MissionRow extends QueryResultRow {
  readonly mission_id: StableId<"mission">;
  readonly project_id: StableId<"project">;
  readonly state: MissionState;
  readonly requested_scope: string;
  readonly workflow_id: StableId<"workflow">;
  readonly workflow_version: string;
  readonly completion_contract_id: StableId<"completionContract">;
  readonly completion_contract_version: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface MissionNodeRow extends QueryResultRow {
  readonly node_id: StableId<"node">;
  readonly node_type: string;
  readonly worker_role: string;
  readonly state: string;
  readonly graph_revision: string;
}

interface RequestRow extends MissionRow {
  readonly request_digest: string;
}

interface TimestampRow extends QueryResultRow {
  readonly occurred_at: Date;
}

export class PostgresCounterpartMissionStore
  implements CounterpartMissionPersistence {
  private readonly pool: ConnectionPool;
  private readonly provenanceId: StableId<"provenance">;

  constructor(
    pool: ConnectionPool,
    provenanceId: StableId<"provenance">,
  ) {
    this.pool = pool;
    this.provenanceId = parseStableId(provenanceId, "provenance");
  }

  async createMission(
    input: CounterpartMissionCreate,
  ): Promise<CounterpartMissionCreation> {
    const normalized = normalizeCreation(input);
    const requestDigest = canonicalJsonDigest({
      clientRequestId: normalized.clientRequestId,
      projectId: normalized.projectId,
      objective: normalized.objective,
      requestedScope: normalized.requestedScope,
      ...(normalized.workflowKey === undefined
        ? {}
        : { workflowKey: normalized.workflowKey }),
    });

    return withIsolatedTransaction(this.pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`acp:counterpart:${normalized.clientRequestId}`],
      );
      const prior = await client.query<RequestRow>(
        `SELECT ${missionProjectionColumns}, request.request_digest
         FROM acp.missions AS mission
         JOIN acp.counterpart_mission_requests AS request
           ON request.mission_id = mission.mission_id
         WHERE request.client_request_id = $1`,
        [normalized.clientRequestId],
      );
      const previous = prior.rows[0];
      if (previous !== undefined) {
        if (previous.request_digest !== requestDigest) {
          throw new Error(
            "counterpart client request identifier aliases different mission terms",
          );
        }
        return {
          mission: await mapProjectionWithNodes(client, previous),
          replayed: true,
        };
      }

      const bindings = await client.query<BindingRow>(
        `SELECT binding.binding_id, binding.workflow_id,
                binding.workflow_version, binding.completion_contract_id,
                binding.completion_contract_version
         FROM acp.project_workflow_bindings AS binding
         JOIN acp.workflow_definitions AS workflow
           ON workflow.workflow_id = binding.workflow_id
          AND workflow.version = binding.workflow_version
         JOIN acp.runtime_provenance AS provenance
           ON provenance.provenance_id = $3
          AND provenance.workflow_binding_id = binding.binding_id
          AND provenance.workflow_id = binding.workflow_id
          AND provenance.workflow_version = binding.workflow_version
          AND provenance.project_profile_id = binding.profile_id
          AND provenance.project_profile_version = binding.profile_version
          AND provenance.policy_id = binding.policy_id
          AND provenance.policy_version = binding.policy_version
          AND provenance.completion_contract_id = binding.completion_contract_id
          AND provenance.completion_contract_version =
                binding.completion_contract_version
         WHERE binding.project_id = $1
           AND binding.active_from <= statement_timestamp()
           AND (
             binding.retired_at IS NULL
             OR binding.retired_at > statement_timestamp()
           )
           AND ($2::text IS NULL OR workflow.workflow_id::text = $2::text)
         ORDER BY binding.active_from DESC, binding.binding_id
         FOR SHARE OF binding, provenance`,
        [
          normalized.projectId,
          normalized.workflowKey ?? null,
          this.provenanceId,
        ],
      );
      if (bindings.rows.length === 0) {
        throw new Error(
          "no active workflow binding matches the project and runtime provenance",
        );
      }
      if (bindings.rows.length > 1) {
        throw new Error(
          "multiple active workflow bindings match; provide an exact workflow key",
        );
      }
      const binding = bindings.rows[0];
      if (binding === undefined) throw new Error("workflow binding disappeared");

      const clock = await client.query<TimestampRow>(
        "SELECT statement_timestamp() AS occurred_at",
      );
      const occurredAt = requireRow(clock.rows[0], "database clock")
        .occurred_at.toISOString();
      const missionId = createStableId("mission");
      const eventId = createStableId("event");
      const eventPayload = {
        origin: "codex",
        clientRequestId: normalized.clientRequestId,
        objective: normalized.objective,
        requestedScope: normalized.requestedScope,
        ...(normalized.workflowKey === undefined
          ? {}
          : { workflowKey: normalized.workflowKey }),
      } as const;
      const eventDigest = canonicalJsonDigest({
        eventVersion: "1.0.0",
        payload: eventPayload,
        occurredAt,
        provenanceId: this.provenanceId,
      });

      const inserted = await client.query<MissionRow>(
        `INSERT INTO acp.missions (
           mission_id, project_id, intake_id, workflow_id, workflow_version,
           workflow_binding_id, completion_contract_id,
           completion_contract_version, state, requested_scope,
           transition_provenance_id
         ) VALUES (
           $1, $2, NULL, $3, $4, $5, $6, $7, 'received', $8, $9
         )
         RETURNING mission_id, project_id, state, requested_scope, workflow_id,
                   workflow_version, completion_contract_id,
                   completion_contract_version, created_at, updated_at`,
        [
          missionId,
          normalized.projectId,
          binding.workflow_id,
          binding.workflow_version,
          binding.binding_id,
          binding.completion_contract_id,
          binding.completion_contract_version,
          normalized.requestedScope,
          this.provenanceId,
        ],
      );
      await client.query(
        `INSERT INTO acp.mission_events (
           event_id, mission_id, event_type, event_version, idempotency_key,
           event_digest, payload, occurred_at, provenance_id
         ) VALUES ($1, $2, 'mission.received', '1.0.0', $3, $4, $5::jsonb, $6, $7)`,
        [
          eventId,
          missionId,
          normalized.clientRequestId,
          eventDigest,
          JSON.stringify(eventPayload),
          occurredAt,
          this.provenanceId,
        ],
      );
      await client.query(
        `INSERT INTO acp.counterpart_mission_requests (
           client_request_id, request_digest, mission_id, provenance_id
         ) VALUES ($1, $2, $3, $4)`,
        [
          normalized.clientRequestId,
          requestDigest,
          missionId,
          this.provenanceId,
        ],
      );
      return {
        mission: await mapProjectionWithNodes(
          client,
          requireRow(inserted.rows[0], "mission insert"),
        ),
        replayed: false,
      };
    });
  }

  async getMission(
    missionId: StableId<"mission">,
  ): Promise<CounterpartMissionProjection | undefined> {
    const parsed = parseStableId(missionId, "mission");
    const result = await this.pool.query<MissionRow>(
      `${missionProjectionSql} WHERE mission.mission_id = $1`,
      [parsed],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : mapProjectionWithNodes(this.pool, row);
  }

  async listActiveMissions(
    projectId?: StableId<"project">,
    limit = 50,
  ): Promise<readonly CounterpartMissionSummary[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new RangeError("mission list limit must be between 1 and 200");
    }
    const parsedProject = projectId === undefined
      ? undefined
      : parseStableId(projectId, "project");
    const result = await this.pool.query<MissionRow>(
      `${missionProjectionSql}
       WHERE mission.state NOT IN ('complete_for_scope', 'failed', 'cancelled')
         AND ($1::text IS NULL OR mission.project_id = $1)
       ORDER BY mission.updated_at DESC, mission.mission_id
       LIMIT $2`,
      [parsedProject ?? null, limit],
    );
    return result.rows.map(mapSummary);
  }

  async getMissionStatus(missionId:StableId<"mission">):Promise<CounterpartMissionStatus|undefined> {
    const parsed=parseStableId(missionId,"mission");
    const row=(await this.pool.query(counterpartMissionStatusSql,
      [parsed,counterpartStatusCollectionLimit,counterpartStatusEnvironmentLimit,counterpartStatusMaximumBytes])).rows[0];
    if(!row) return undefined;
    if(row.status_error==="too_large") throw new Error("mission status exceeds bounded snapshot; no partial status returned");
    if(row.status_error!==null) throw new Error("mission status contains invalid or undisclosable references");
    const status=parseCounterpartMissionStatus(row.snapshot);
    if(status.missionId!==parsed) throw new Error("mission status identity mismatch");
    return status;
  }

  async getProjectReadiness(query: ProjectReadinessQuery) {
    return readProjectReadiness(this.pool, query);
  }
  async getProjectProfileProposal(query: ProjectProfileProposalQuery) {
    return readProjectProfileProposal(this.pool, query);
  }
  async getProfileConfirmationRequest(query: ProjectProfileProposalQuery) {
    return readProfileConfirmationRequest(this.pool, query);
  }
}

const missionProjectionColumns = `mission.mission_id, mission.project_id,
  mission.state, mission.requested_scope, mission.workflow_id,
  mission.workflow_version, mission.completion_contract_id,
  mission.completion_contract_version, mission.created_at, mission.updated_at`;
const missionProjectionSql = `SELECT ${missionProjectionColumns}
FROM acp.missions AS mission`;

function normalizeCreation(input: CounterpartMissionCreate): CounterpartMissionCreate {
  const clientRequestId = boundedText(
    input.clientRequestId,
    "client request identifier",
    200,
  );
  const objective = boundedText(input.objective, "mission objective", 4_000);
  const requestedScope = boundedText(
    input.requestedScope,
    "requested completion scope",
    4_000,
  );
  const workflowKey = input.workflowKey === undefined
    ? undefined
    : parseStableId(input.workflowKey, "workflow");
  return {
    clientRequestId,
    projectId: parseStableId(input.projectId, "project"),
    objective,
    requestedScope,
    ...(workflowKey === undefined ? {} : { workflowKey }),
  };
}

async function mapProjectionWithNodes(
  executor: QueryExecutor,
  row: MissionRow,
): Promise<CounterpartMissionProjection> {
  const nodes = await executor.query<MissionNodeRow>(
    `SELECT node_id, node_type, worker_role, state, graph_revision
     FROM acp.mission_nodes
     WHERE mission_id = $1
     ORDER BY node_id`,
    [row.mission_id],
  );
  return {
    ...mapSummary(row),
    nodes: nodes.rows.map((node) => ({
      nodeId: node.node_id,
      nodeType: node.node_type,
      workerRole: node.worker_role,
      state: node.state,
      graphRevision: node.graph_revision,
    })),
  };
}

function mapSummary(row: MissionRow): CounterpartMissionSummary {
  return {
    missionId: row.mission_id,
    projectId: row.project_id,
    state: row.state,
    requestedScope: row.requested_scope,
    workflowId: row.workflow_id,
    workflowVersion: row.workflow_version,
    completionContractId: row.completion_contract_id,
    completionContractVersion: row.completion_contract_version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function boundedText(value: string, label: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new TypeError(`${label} must not be empty`);
  if (trimmed.length > maximum) {
    throw new RangeError(`${label} exceeds ${maximum} characters`);
  }
  return trimmed;
}

function requireRow<T>(row: T | undefined, operation: string): T {
  if (row === undefined) throw new Error(`${operation} did not return a row`);
  return row;
}
